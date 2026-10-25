/**
 * Google E-Tablolar'dan ders programı okuma ve doğrulama.
 *
 * Bu modül VERİTABANINA DOKUNMAZ. Üç iş yapar:
 *   1) E-tabloyu ağdan indirir (xlsx olarak veya sekme başına CSV),
 *   2) başlık adına göre sütunları eşler (sütun sırası önemli değil),
 *   3) satırları doğrular ve uygulamaya verilecek bir plan üretir.
 *
 * Veritabanına yazma işini server.js tek bir işlem (transaction) içinde yapar.
 * Böylece ayrıştırma mantığı veritabanı olmadan test edilebilir.
 */

const TABS = { dersler: 'Dersler', program: 'Program', kayitlar: 'Kayitlar' };

const DAY_NAMES = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

// Başlık karşılaştırması için sadeleştirme: Türkçe harfler ASCII'ye iner, noktalama gider.
// "Ders Adı", "ders adi", "DERS  ADI" -> "ders adi"
function fold(s) {
    return String(s == null ? '' : s)
        .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/I/g, 'i')
        .replace(/ş/g, 's').replace(/Ş/g, 's')
        .replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/Ü/g, 'u')
        .replace(/ö/g, 'o').replace(/Ö/g, 'o')
        .replace(/ç/g, 'c').replace(/Ç/g, 'c')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');   // boşluklar da atılır: "Lego WeDo" == "lego we do"
}

// Sekme başlığı -> iç alan adı. Aynı alana birden çok yazım kabul edilir.
const FIELD_ALIASES = {
    dersler: {
        'dersadi': 'name', 'ders': 'name', 'dersinadi': 'name',
        'aylikucret': 'monthly_fee', 'aylikucreti': 'monthly_fee', 'aylik': 'monthly_fee',
        'donemlikucret': 'term_fee', 'donemlikucreti': 'term_fee', 'donemlik': 'term_fee',
        'durum': 'status', 'aciklama': 'description', 'not': 'description',
    },
    program: {
        'dersadi': 'class_name', 'ders': 'class_name',
        'gun': 'day', 'gunler': 'day',
        'baslangic': 'start', 'baslangicsaati': 'start', 'baslama': 'start',
        'bitis': 'end', 'bitissaati': 'end',
        'kontenjan': 'capacity', 'kapasite': 'capacity',
        'durum': 'status',
    },
    kayitlar: {
        'adsoyad': 'student_name', 'ad': 'student_name', 'isim': 'student_name',
        'ogrenci': 'student_name', 'ogrenciadi': 'student_name',
        'kartno': 'rfid', 'kart': 'rfid', 'rfid': 'rfid', 'kartnumarasi': 'rfid',
        'dersadi': 'class_name', 'ders': 'class_name',
        'gun': 'day',
        'baslangic': 'start', 'baslangicsaati': 'start',
        'baslangictarihi': 'start_date', 'baslamatarihi': 'start_date',
        'bitistarihi': 'end_date', 'ayrilmatarihi': 'end_date',
        'odemetipi': 'payment_type', 'odeme': 'payment_type',
        'durum': 'status',
        'not': 'note', 'aciklama': 'note',
    },
};

const REQUIRED_FIELDS = {
    dersler: ['name'],
    program: ['class_name', 'day', 'start', 'end'],
    kayitlar: ['class_name', 'day', 'start'],
};

// ---------------------------------------------------------------- değer çözümleyiciler

/** Gün adı / kısaltma / rakam -> 1..7 (Pazartesi..Pazar). Tanınmazsa null. */
function parseDay(value) {
    const f = fold(value);
    if (!f) return null;
    if (/^[1-7]$/.test(f)) return Number(f);
    const map = {
        pazartesi: 1, pzt: 1, pt: 1,
        sali: 2, sal: 2,
        carsamba: 3, car: 3, crs: 3,
        persembe: 4, per: 4, prs: 4,
        cuma: 5, cum: 5,
        cumartesi: 6, cmt: 6,
        pazar: 7, paz: 7,
    };
    return map[f] || null;
}

/**
 * Saat -> günün kaçıncı dakikası. Kabul edilenler:
 *   "13:00"  "13:00:00"  "9:05"  13.00 (Türkçe yazım)  0,541666 (Excel saat serisi)  13 (tam saat)
 */
function parseClock(value) {
    if (value == null || value === '') return null;

    if (value instanceof Date) return value.getUTCHours() * 60 + value.getUTCMinutes();

    if (typeof value === 'number' && isFinite(value)) {
        if (value > 0 && value < 1) return Math.round(value * 1440);   // Excel saat serisi
        if (value >= 1 && value < 24) return Math.round(value * 60);   // sadece saat yazılmış
        return null;
    }

    let s = String(value).trim();
    if (!s) return null;

    const ampm = /([ap])\.?m\.?/i.exec(s);
    s = s.replace(/([ap])\.?m\.?/i, '').trim();

    let m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
    if (m) {
        let hh = Number(m[1]); const mm = Number(m[2]);
        if (ampm) {
            const pm = ampm[1].toLowerCase() === 'p';
            if (pm && hh < 12) hh += 12;
            if (!pm && hh === 12) hh = 0;
        }
        if (hh > 23 || mm > 59) return null;
        return hh * 60 + mm;
    }

    // Türkçe "13.00" yazımı. Dikkat: "0,541666" bu kalıba girmez (ondalık kısmı uzun),
    // o yüzden aşağıdaki seri yorumuna düşer.
    m = /^(\d{1,2})[.,](\d{2})$/.exec(s);
    if (m) {
        const hh = Number(m[1]); const mm = Number(m[2]);
        if (hh <= 23 && mm <= 59) return hh * 60 + mm;
    }

    // Sayı olarak gelmiş seri (CSV yolunda metinleşmiş olabilir): "0,541666" / "0.541666"
    const asNum = Number(String(s).replace(',', '.'));
    if (isFinite(asNum) && asNum > 0 && asNum < 1) return Math.round(asNum * 1440);

    return null;
}

/** Dakika -> "HH:MM" */
function minutesToClock(mins) {
    if (mins == null) return '';
    const hh = Math.floor(mins / 60); const mm = mins % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** Tarih -> "YYYY-MM-DD". Kabul: "2026-10-24", "24.10.2026", "24/10/2026", Date nesnesi, Excel serisi. */
function parseDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date && !isNaN(value)) {
        return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
    }
    if (typeof value === 'number' && value > 1000 && value < 100000) {
        // Excel tarih serisi (1899-12-30 temel alınır)
        const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    const s = String(value).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);     // "2026-10-24" ve tam ISO zaman damgası
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
    if (m) {
        const dd = Number(m[1]); const mm = Number(m[2]); const yy = Number(m[3]);
        if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
            return yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
        }
    }
    return null;
}

/** "1.200", "1.200,50", "1200 TL", "900" -> sayı. Çözülemezse null. */
function parseMoney(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    let s = String(value).replace(/[^\d.,-]/g, '').trim();
    if (!s) return null;
    const hasDot = s.includes('.'); const hasComma = s.includes(',');
    if (hasDot && hasComma) {
        s = (s.lastIndexOf(',') > s.lastIndexOf('.')) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (hasComma) {
        s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (hasDot) {
        s = /\.\d{3}(\.|$)/.test(s) ? s.replace(/\./g, '') : s;
    }
    const n = Number(s);
    return isFinite(n) ? n : null;
}

function normStatus(value, fallback = 'Aktif') {
    const f = fold(value);
    if (!f) return fallback;
    if (f.startsWith('pasif') || f === 'kapali' || f === 'iptal' || f === 'hayir' || f === 'no') return 'Pasif';
    if (f.startsWith('aktif') || f === 'acik' || f === 'evet' || f === 'yes') return 'Aktif';
    return fallback;
}

/** Ödeme tipi: AYLIK / DÖNEMLİK. Boş -> null. Tanınmazsa 'GECERSIZ'. */
function normPaymentType(value) {
    const f = fold(value);
    if (!f) return null;
    if (f.startsWith('aylik') || f === 'ay' || f === 'monthly') return 'AYLIK';
    if (f.startsWith('donemlik') || f.startsWith('donem') || f === 'term') return 'DÖNEMLİK';
    return 'GECERSIZ';
}

// ---------------------------------------------------------------- sekme -> kayıt dönüşümü

function cellText(v) {
    if (v == null) return '';
    // Tarih/sayı hücreleri ham kalır: çözümleyiciler gerçek tipi görmeli.
    // (Excel'de 13:00 bir saat serisidir; metne çevrilirse bilgi kaybolur.)
    if (v instanceof Date) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
        if (v.text != null) return String(v.text);
        if (v.result != null) return v.result;
        return '';
    }
    return String(v);
}

/** Bir sekmenin satırlarını (2 boyutlu dizi) nesnelere çevirir. Başlık satırı aranır. */
function rowsToRecords(rows, tabKey, errors, tabLabel) {
    const alias = FIELD_ALIASES[tabKey];
    const out = [];
    if (!rows || !rows.length) return out;

    // Başlık satırı: ilk satırlar boş olabilir; tanınan alan sayısı en çok olan satırı seç.
    let headerIdx = -1; let headerMap = null; let best = 0;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const map = {};
        (rows[i] || []).forEach((h, j) => {
            const key = alias[fold(h)];
            if (key && map[key] === undefined) map[key] = j;
        });
        const hits = Object.keys(map).length;
        const need = REQUIRED_FIELDS[tabKey].filter((f) => map[f] !== undefined).length;
        if (hits > best && need === REQUIRED_FIELDS[tabKey].length) { best = hits; headerIdx = i; headerMap = map; }
    }
    if (headerIdx < 0) {
        errors.push({ sekme: tabLabel, satir: 1, sutun: '', kod: 'BASLIK_YOK', mesaj: 'Başlık satırı bulunamadı (' + REQUIRED_FIELDS[tabKey].map((f) => f).join(', ') + ' sütunları gerekli).' });
        return out;
    }

    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const rec = {};
        let empty = true;
        Object.keys(headerMap).forEach((field) => {
            const val = row[headerMap[field]];
            rec[field] = (val === undefined || val === null) ? '' : cellText(val);
            if (typeof val === 'number' || (val instanceof Date)) rec[field + '__raw'] = val;
            if (fold(rec[field]) !== '') empty = false;
        });
        if (empty) continue;                                   // boş satır
        if (Object.keys(alias).includes(fold(row[headerMap[Object.keys(headerMap)[0]]]))) continue; // tekrar eden başlık
        rec.__satir = i + 1;                                   // kullanıcıya 1 tabanlı satır no
        out.push(rec);
    }
    return out;
}

function err(errors, sekme, satir, sutun, kod, mesaj) {
    errors.push({ sekme, satir, sutun, kod, mesaj });
}

/**
 * Sekme satırlarını doğrular ve uygulanacak planı üretir.
 * Döner: { classes, sessions, registrations, errors, ozet }
 */
function buildPlan(tabRows, tabs = TABS) {
    const errors = [];
    const L = tabs;
    const dersler = rowsToRecords(tabRows[L.dersler], 'dersler', errors, L.dersler);
    const program = rowsToRecords(tabRows[L.program], 'program', errors, L.program);
    const kayitlar = rowsToRecords(tabRows[L.kayitlar], 'kayitlar', errors, L.kayitlar);

    // --- Dersler
    const classes = []; const classByName = {};
    dersler.forEach((r) => {
        const name = String(r.name || '').trim();
        const satir = r.__satir;
        if (!name) return err(errors, L.dersler, satir, 'Ders Adı', 'BOS_DERS_ADI', 'Ders adı boş.');
        const key = fold(name);
        if (classByName[key]) return err(errors, L.dersler, satir, 'Ders Adı', 'MUKERRER_DERS', `"${name}" dersi birden fazla kez tanımlanmış.`);
        const monthly = parseMoney(r.monthly_fee);
        const term = parseMoney(r.term_fee);
        if (r.monthly_fee !== '' && monthly === null) err(errors, L.dersler, satir, 'Aylık Ücret', 'GECERSIZ_UCRET', `"${r.monthly_fee}" sayı olarak okunamadı.`);
        if (r.term_fee !== '' && term === null) err(errors, L.dersler, satir, 'Dönemlik Ücret', 'GECERSIZ_UCRET', `"${r.term_fee}" sayı olarak okunamadı.`);
        const cls = {
            name, key, monthly_fee: monthly == null ? 0 : monthly, term_fee: term == null ? 0 : term,
            status: normStatus(r.status), description: String(r.description || '').trim(),
        };
        classByName[key] = cls;
        classes.push(cls);
    });

    // --- Program
    const sessions = []; const seenSession = {};
    program.forEach((r) => {
        const satir = r.__satir;
        const cname = String(r.class_name || '').trim();
        const ckey = fold(cname);
        if (!cname) return err(errors, L.program, satir, 'Ders Adı', 'BOS_DERS_ADI', 'Ders adı boş.');
        if (!classByName[ckey]) return err(errors, L.program, satir, 'Ders Adı', 'BILINMEYEN_DERS', `"${cname}" dersi ${L.dersler} sekmesinde tanımlı değil.`);
        const day = parseDay(r.day);
        if (!day) return err(errors, L.program, satir, 'Gün', 'GECERSIZ_GUN', `"${r.day}" geçerli bir gün değil.`);
        const start = parseClock(r.start);
        if (start === null) return err(errors, L.program, satir, 'Başlangıç', 'GECERSIZ_SAAT', `"${r.start}" geçerli bir saat değil (13:00 bekleniyor).`);
        const end = parseClock(r.end);
        if (end === null) return err(errors, L.program, satir, 'Bitiş', 'GECERSIZ_SAAT', `"${r.end}" geçerli bir saat değil (14:00 bekleniyor).`);
        if (end <= start) return err(errors, L.program, satir, 'Bitiş', 'BITIS_SAAT', 'Bitiş saati başlangıçtan sonra olmalı.');
        let capacity = r.capacity === '' ? 10 : Number(String(r.capacity).replace(',', '.'));
        if (!isFinite(capacity) || capacity <= 0) capacity = 10;
        const skey = ckey + '|' + day + '|' + start;
        if (seenSession[skey]) return err(errors, L.program, satir, 'Başlangıç', 'MUKERRER_SEANS', `"${cname}" ${DAY_NAMES[day - 1]} ${minutesToClock(start)} seansı tekrar tanımlanmış.`);
        const session = {
            key: skey, class_key: ckey, class_name: classByName[ckey].name,
            day, start, end, capacity: Math.floor(capacity), status: normStatus(r.status),
        };
        seenSession[skey] = session;
        sessions.push(session);
    });

    // --- Kayıtlar
    const registrations = []; const seenReg = {};
    const capacityUsed = {};
    kayitlar.forEach((r) => {
        const satir = r.__satir;
        const name = String(r.student_name || '').trim();
        const rfid = String(r.rfid || '').trim();
        if (!name && !rfid) return err(errors, L.kayitlar, satir, 'Ad Soyad', 'BOS_OGRENCI', 'Ad Soyad veya Kart No yazılmalı.');
        const cname = String(r.class_name || '').trim();
        const ckey = fold(cname);
        if (!cname) return err(errors, L.kayitlar, satir, 'Ders Adı', 'BOS_DERS_ADI', 'Ders adı boş.');
        if (!classByName[ckey]) return err(errors, L.kayitlar, satir, 'Ders Adı', 'BILINMEYEN_DERS', `"${cname}" dersi ${L.dersler} sekmesinde tanımlı değil.`);
        const day = parseDay(r.day);
        if (!day) return err(errors, L.kayitlar, satir, 'Gün', 'GECERSIZ_GUN', `"${r.day}" geçerli bir gün değil.`);
        const start = parseClock(r.start);
        if (start === null) return err(errors, L.kayitlar, satir, 'Başlangıç', 'GECERSIZ_SAAT', `"${r.start}" geçerli bir saat değil.`);
        const skey = ckey + '|' + day + '|' + start;
        const session = seenSession[skey];
        if (!session) return err(errors, L.kayitlar, satir, 'Başlangıç', 'BILINMEYEN_SEANS', `${DAY_NAMES[day - 1]} ${minutesToClock(start)} saatinde "${cname}" seansı ${L.program} sekmesinde yok.`);
        const startDate = parseDate(r.start_date);
        if (r.start_date !== '' && r.start_date !== undefined && startDate === null) err(errors, L.kayitlar, satir, 'Başlangıç Tarihi', 'GECERSIZ_TARIH', `"${r.start_date}" tarih olarak okunamadı (2026-10-24 bekleniyor).`);
        const endDate = parseDate(r.end_date);
        if (r.end_date !== '' && r.end_date !== undefined && endDate === null) err(errors, L.kayitlar, satir, 'Bitiş Tarihi', 'GECERSIZ_TARIH', `"${r.end_date}" tarih olarak okunamadı.`);
        if (startDate && endDate && endDate < startDate) err(errors, L.kayitlar, satir, 'Bitiş Tarihi', 'TARIH_SIRASI', 'Bitiş tarihi başlangıçtan önce.');
        const payment = normPaymentType(r.payment_type);
        if (payment === 'GECERSIZ') err(errors, L.kayitlar, satir, 'Ödeme Tipi', 'GECERSIZ_ODEME', `"${r.payment_type}" tanınmadı (AYLIK veya DÖNEMLİK).`);

        const studentKey = rfid ? 'k:' + fold(rfid) : 'a:' + fold(name);
        const rkey = studentKey + '|' + skey;
        if (seenReg[rkey]) return err(errors, L.kayitlar, satir, 'Ad Soyad', 'MUKERRER_KAYIT', `${name || rfid} aynı seansa birden fazla yazılmış.`);

        capacityUsed[skey] = (capacityUsed[skey] || 0) + 1;
        if (capacityUsed[skey] > session.capacity) {
            err(errors, L.kayitlar, satir, 'Ad Soyad', 'KONTENJAN_ASIMI', `"${cname}" ${DAY_NAMES[day - 1]} ${minutesToClock(start)} kontenjanı (${session.capacity}) aşıldı.`);
        }

        const reg = {
            key: rkey, student_key: studentKey, student_name: name, rfid,
            session_key: skey, class_name: session.class_name, day, start,
            start_date: startDate, end_date: endDate,
            payment_type: payment === 'GECERSIZ' ? null : payment,
            status: normStatus(r.status), note: String(r.note || '').trim(),
        };
        seenReg[rkey] = reg;
        registrations.push(reg);
    });

    return {
        classes, sessions, registrations, errors,
        ozet: {
            ders: classes.length, seans: sessions.length, kayit: registrations.length,
            hata: errors.length,
            pasif_ders: classes.filter((c) => c.status === 'Pasif').length,
            pasif_seans: sessions.filter((s) => s.status === 'Pasif').length,
            pasif_kayit: registrations.filter((r) => r.status === 'Pasif').length,
        },
    };
}

// ---------------------------------------------------------------- ağ erişimi

function extractSpreadsheetId(urlOrId) {
    const s = String(urlOrId == null ? '' : urlOrId).trim();
    if (!s) return null;
    if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;                       // çıplak kimlik
    const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(s);
    return m ? m[1] : null;
}

const EXPORT_URL = (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`;
const GVIZ_URL = (id, tab) => `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
const VALUES_URL = (id, tab, key) => `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}?key=${encodeURIComponent(key)}`;

/** xlsx ikilisini {sekme: satırlar} sözlüğüne çevirir. */
async function parseXlsxTabs(buffer, exceljsLib) {
    const ExcelJS = exceljsLib || require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const out = {};
    wb.eachSheet((ws) => {
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
            const vals = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
                let v = cell.value;
                if (v && typeof v === 'object' && Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
                vals.push(v == null ? '' : v);
            });
            rows.push(vals);
        });
        out[ws.name] = rows;
    });
    return out;
}

/** İki satırlık CSV'yi (tırnak destekli) 2 boyutlu diziye çevirir. */
function parseCsv(text) {
    const rows = []; let row = []; let cur = ''; let inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else if (c !== '\r') cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * E-tabloyu indirir ve sekme satırlarını döner.
 * Sıra: API anahtarı varsa Sheets API -> yoksa xlsx indirme -> olmazsa sekme başına CSV.
 */
async function fetchTabs({ url, apiKey = '', tabs = TABS, fetchImpl = null, exceljsLib = null, log = () => {} }) {
    const doFetch = fetchImpl || fetch;
    const id = extractSpreadsheetId(url);
    if (!id) throw new Error('E-tablo bağlantısı okunamadı. Admin panelinden tam bağlantıyı yapıştırın.');

    const wanted = [tabs.dersler, tabs.program, tabs.kayitlar];
    let lastError = null;

    if (apiKey) {
        try {
            const out = {};
            for (const t of wanted) {
                const r = await doFetch(VALUES_URL(id, t, apiKey));
                const j = await r.json();
                if (!r.ok) throw new Error(`Sheets API hatası (${t}): ${(j && j.error && j.error.message) || r.status}`);
                out[t] = j.values || [];
            }
            return { tabs: out, source: 'api' };
        } catch (e) { lastError = e; log('Sheets API başarısız: ' + e.message); }
    }

    let xlsxErr = null;
    try {
        const r = await doFetch(EXPORT_URL(id));
        if (!r.ok) throw new Error('xlsx indirilemedi (HTTP ' + r.status + ')');
        const buf = Buffer.from(await r.arrayBuffer());
        const all = await parseXlsxTabs(buf, exceljsLib);
        const out = {};
        wanted.forEach((t) => { out[t] = all[t] || []; });
        if (!wanted.some((t) => (out[t] || []).length > 0)) {
            const names = Object.keys(all).join(', ') || '(hiç sekme yok)';
            throw new Error('"' + wanted.join(' / ') + '" sekmeleri boş ya da yok. E-tablodaki sekmeler: ' + names);
        }
        return { tabs: out, source: 'xlsx' };
    } catch (e) { xlsxErr = e; lastError = e; log('xlsx indirme başarısız: ' + e.message); }

    try {
        const out = {};
        for (const t of wanted) {
            const r = await doFetch(GVIZ_URL(id, t));
            if (!r.ok) throw new Error('CSV indirilemedi (HTTP ' + r.status + ')');
            out[t] = parseCsv(await r.text());
        }
        // Boş ama "başarılı" bir eşitleme en tehlikeli sonuçtur: sekme adı yanlışsa
        // hiçbir şey olmaz ve kimse fark etmez. Bu yüzden açıkça hata verilir.
        if (!wanted.some((t) => (out[t] || []).length > 0)) {
            throw new Error('CSV yolu da boş döndü' + (xlsxErr ? ' (' + xlsxErr.message + ')' : ''));
        }
        return { tabs: out, source: 'csv' };
    } catch (e) { lastError = e; }

    throw new Error(
        'E-tablo okunamadı: ' + (lastError ? lastError.message : 'bilinmeyen hata') +
        ' — E-tablo "Bağlantıya sahip olan herkes: Görüntüleyici" olarak paylaşılmış olmalı.'
    );
}

module.exports = {
    TABS, DAY_NAMES,
    fold, parseDay, parseClock, parseDate, parseMoney, minutesToClock,
    normStatus, normPaymentType,
    rowsToRecords, buildPlan,
    extractSpreadsheetId, parseCsv, parseXlsxTabs, fetchTabs,
    EXPORT_URL, GVIZ_URL, VALUES_URL,
};
