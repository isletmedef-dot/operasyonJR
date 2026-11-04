'use strict';
/**
 * Nakit alınmış ama BAKİYESİ OLAN ziyaretleri "paketten düşülmüş" kaydına çevirir.
 *
 * Amaç: bakiyesi görünmediği/kullanılamadığı için kasadan nakit alınan ziyaretleri,
 * aile parasını geri aldığında defterde doğru göstermek: ziyaret bakiyeden düşülür,
 * nakit tahsilat kaydı oluşmaz.
 *
 * Girdi: paket-odenis.json (bu dosyanın yanında) — makbuzlardan çıkarılan liste:
 *   [
 *     { "child_id": "UC-000004", "tarih": "2026-10-28", "tutar": 750,
 *       "log_id": null, "sure_dk": null, "aciklama": "kasadan nakit alındı" }
 *   ]
 *   - child_id yerine "ad": "Göksu Sümer" de yazılabilir.
 *   - log_id verilirse o kayıt çevrilir; verilmezse tarih+tutar ile eşleşen kayıt aranır.
 *   - Eşleşen kayıt bulunursa ÇEVRİLİR (ziyaret zaten var, nakdi pakete çevrilir).
 *   - Bulunamazsa YENİ PAKET kaydı eklenir (gerçek ama sisteme girilmemiş kullanım).
 *
 * Çalıştırma:
 *   node nakit-pakete-cevir.js              -> sadece gösterir (hiç yazmaz)
 *   node nakit-pakete-cevir.js --uygula     -> uygular (önce database.db.yedek-<tarih>)
 *
 * Bakiye yetmezse o satır ATLANIR ve raporlanır — asla bakiyeyi eksiye düşürmez.
 * Uygulamayı uygulama klasöründe çalıştırın.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.DB_PATH || path.join(__dirname, 'database.db');
const GIRDI = process.argv.find((a) => a.endsWith('.json')) || path.join(__dirname, 'paket-odenis.json');
const UYGULA = process.argv.includes('--uygula');
const ISLENEN = GIRDI.replace(/\.json$/, '') + '-islenen.json';

if (!fs.existsSync(DB)) { console.error('Veritabanı bulunamadı: ' + DB); process.exit(1); }
if (!fs.existsSync(GIRDI)) {
    console.error('Girdi dosyası bulunamadı: ' + GIRDI);
    console.error('Makbuzlardan çıkarılmış listeyi bu adda oluşturun (aşağıda örnek var).');
    process.exit(1);
}

const db = new sqlite3.Database(DB);
const all = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, x) => (e ? j(e) : r(x))));
const get = (s, p = []) => new Promise((r, j) => db.get(s, p, (e, x) => (e ? j(e) : r(x))));
const run = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { return e ? j(e) : r(this); }));
const pad = (v, n, sag) => { const t = String(v == null ? '' : v); return sag ? t.padStart(n) : t.padEnd(n); };
const norm = (s) => String(s || '').toLocaleUpperCase('tr-TR').trim().replace(/\s+/g, ' ');
const bugun = () => new Date().toISOString();

/** Paket bakiyesinden düşer (önce ana para, sonra bonus) — uygulamanın çıkış yoluyla aynı kural. */
async function bakiyedenDus(child_id, tutar, log_id) {
    const rights = await all(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'
                              AND (durum = 'Aktif' OR durum = 'Süresi Doldu') AND kalan_dk > 0
                              ORDER BY tanim_tarihi ASC`, [child_id]);
    const toplam = rights.reduce((t, r) => t + Number(r.kalan_dk || 0), 0);
    if (toplam < tutar) return { ok: false, sebep: 'yetersiz bakiye', toplam, kalan: toplam - tutar };

    let kalanTutar = tutar;
    for (const r of rights) {
        if (kalanTutar <= 0) break;
        const avail = Number(r.kalan_dk || 0);
        const used = Math.min(avail, kalanTutar);
        kalanTutar -= used;

        let yAna = Number(r.kalan_ana_para || 0), yBon = Number(r.kalan_bonus || 0), left = used;
        if (yAna >= left) { yAna -= left; left = 0; } else { left -= yAna; yAna = 0; }
        if (left > 0) yBon -= left;
        const yeni = yAna + yBon;

        await run(`UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ?, durum = ? WHERE hak_id = ?`,
            [yeni, yAna, yBon, yeni > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
        await run(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk,
                     onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel)
                   VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem',
                           'Nakit ödeme paket bakiyesine çevrildi', ?, 'Sistem')`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), bugun(), child_id, r.hak_id,
             -used, avail, yeni, log_id]);
    }
    return { ok: true, toplam, kalan: toplam - tutar };
}

(async () => {
    const liste = JSON.parse(fs.readFileSync(GIRDI, 'utf8'));
    if (!Array.isArray(liste) || !liste.length) { console.error('Girdi boş.'); process.exit(1); }

    const islenen = fs.existsSync(ISLENEN) ? JSON.parse(fs.readFileSync(ISLENEN, 'utf8')) : [];
    const islenenAnahtar = new Set(islenen.map((x) => x.anahtar));

    const plan = [];
    for (const e of liste) {
        const tutar = Number(e.tutar);
        let child_id = e.child_id;
        if (!child_id && e.ad) {
            const s = await get('SELECT child_id FROM students WHERE student_name = ?', [e.ad]);
            child_id = s && s.child_id;
        }
        if (!child_id || !(tutar > 0)) { plan.push({ ...e, karar: 'ATLA', sebep: 'öğrenci/tutar belirsiz' }); continue; }

        const ogr = await get('SELECT * FROM students WHERE child_id = ?', [child_id]);
        if (!ogr) { plan.push({ ...e, karar: 'ATLA', sebep: 'öğrenci yok' }); continue; }

        // Zaten çevrilmiş mi?
        const zaten = await get(`SELECT log_id FROM logs WHERE child_id = ? AND payment_type = 'PAKET'
                                   AND paketten_dusen = ? AND substr(entry_time,1,10) = ?`, [child_id, tutar, e.tarih]);
        if (zaten) { plan.push({ ...e, child_id, karar: 'ZATEN', sebep: 'bu kayıt zaten paketten düşülmüş' }); continue; }

        // Çevrilecek kayıt: o gün o tutarda nakit/kart/ücretsiz kapanmış ziyaret
        const adaylar = await all(`SELECT * FROM logs WHERE child_id = ? AND substr(entry_time,1,10) = ?
                                     AND (payment_type IN ('NAKİT','KREDİ KARTI','NAKIT') OR payment_type IS NULL OR payment_type = 'ÜCRETSİZ')
                                     AND COALESCE(paketten_dusen,0) = 0 ORDER BY ABS(COALESCE(fee,0) - ?) ASC`,
            [child_id, e.tarih, tutar]);
        let hedef = e.log_id ? await get('SELECT * FROM logs WHERE log_id = ?', [e.log_id]) : null;
        if (!hedef && adaylar.length === 1) hedef = adaylar[0];
        if (!hedef && adaylar.length > 1 && Number(adaylar[0].fee) === tutar) hedef = adaylar[0];

        const bakiye = await all(`SELECT SUM(kalan_dk) t FROM rights WHERE child_id = ? AND hak_tipi='PAKET'
                                    AND (durum='Aktif' OR durum='Süresi Doldu')`, [child_id]);
        const mevcut = Number((bakiye[0] || {}).t || 0);

        plan.push({
            ...e, child_id, ogrenci: ogr.student_name, bakiye: mevcut,
            karar: hedef ? 'DÖNÜŞTÜR' : (adaylar.length > 1 ? 'BELİRSİZ' : 'YENİ'),
            hedef: hedef ? hedef.log_id : null,
            aday_sayisi: adaylar.length,
            sebep: hedef ? 'mevcut kaydın nakdi pakete çevrilecek'
                : (adaylar.length > 1 ? adaylar.length + ' aday kayıt var, seçim gerekli'
                    : 'eşleşen kayıt yok, yeni paket kaydı eklenecek'),
            yeterli: mevcut >= tutar,
        });
    }

    // Rapor
    console.log('\nMakbuzdan çıkarılan ödemeler — plan\n');
    const satir = (a, b, c, d, e, f) => '  ' + pad(a, 11) + ' ' + pad(b, 20) + ' ' + pad(c, 11) + ' ' + pad(d, 8, true) + ' ' + pad(e, 10, true) + '  ' + f;
    console.log(satir('kart', 'öğrenci', 'tarih', 'tutar', 'bakiye', 'karar'));
    console.log('  ' + '-'.repeat(84));
    let donustur = 0, yeni = 0, belirsiz = 0, atlanan = 0, dusulecekTutar = 0;
    for (const p of plan) {
        const karar = p.karar + (p.karar === 'DÖNÜŞTÜR' || p.karar === 'YENİ'
            ? (p.yeterli ? '' : ' (BAKİYE YETMEZ)') : '');
        console.log(satir(p.child_id || '-', String(p.ogrenci || p.ad || '-').slice(0, 20),
            p.tarih || '-', p.tutar || '-', p.bakiye != null ? p.bakiye : '-', karar));
        if (p.karar === 'DÖNÜŞTÜR') { donustur++; if (p.yeterli) dusulecekTutar += Number(p.tutar); else atlanan++; }
        else if (p.karar === 'YENİ') { yeni++; if (p.yeterli) dusulecekTutar += Number(p.tutar); else atlanan++; }
        else if (p.karar === 'BELİRSİZ') belirsiz++;
        else if (p.karar === 'ATLA') atlanan++;
    }
    console.log('  ' + '-'.repeat(84));
    console.log('  çevrilecek mevcut kayıt: %d   yeni paket kaydı: %d   belirsiz: %d   atlanan: %d', donustur, yeni, belirsiz, atlanan);
    console.log('  bakiyelerden düşülecek toplam: %s TL', dusulecekTutar);
    console.log('  (bu tutar kadarlık NAKİT/KART tahsilatı defterden çıkar; iadeyi siz yapacaksınız)');

    if (!UYGULA) {
        console.log('\nGösterim modu — hiçbir şey yazılmadı. Uygulamak için:  node nakit-pakete-cevir.js --uygula\n');
        db.close();
        return;
    }

    const yedek = DB + '.yedek-' + bugun().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(DB, yedek);
    console.log('\nYedek alındı: ' + path.basename(yedek) + '\n');

    for (const p of plan) {
        if ((p.karar !== 'DÖNÜŞTÜR' && p.karar !== 'YENİ') || !p.yeterli) continue;
        const anahtar = p.child_id + '|' + p.tarih + '|' + p.tutar;
        if (islenenAnahtar.has(anahtar)) continue;

        const sonuc = await bakiyedenDus(p.child_id, Number(p.tutar), p.hedef);
        if (!sonuc.ok) { console.log('  ✖ %s %s TL — %s', p.ogrenci, p.tutar, sonuc.sebep); continue; }

        if (p.hedef) {
            await run(`UPDATE logs SET payment_type = 'PAKET', fee = 0, paketten_dusen = ?, source_summary = ?,
                         payment_date = ? WHERE log_id = ?`,
                [Number(p.tutar), Number(p.tutar) + ' TL Paket', bugun(), p.hedef]);
            console.log('  ✔ ' + pad(String(p.ogrenci).slice(0, 20), 20) + ' ' + p.tarih + '  ' + pad(p.tutar, 7, true) + ' TL  nakit -> paket  (kayıt ' + p.hedef + ')');
        } else {
            const sure = Number(p.sure_dk || 0);
            await run(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time,
                         duration_min, paketten_dusen, personel, status, payment_status, fee, payment_type,
                         payment_date, source_summary)
                       VALUES (?, ?, ?, ?, ?, 'ÇIKIŞ', ?, ?, ?, 'Sistem', 'KAPALI', 'ÖDENDİ', 0, 'PAKET', ?, ?)`,
                ['LOG-PKT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                    p.tarih.split('-').reverse().join('.'), p.child_id, p.ogrenci, p.parent_name || '',
                    p.tarih + 'T12:00:00', sure, Number(p.tutar), bugun(), Number(p.tutar) + ' TL Paket']);
            console.log('  ✔ ' + pad(String(p.ogrenci).slice(0, 20), 20) + ' ' + p.tarih + '  ' + pad(p.tutar, 7, true) + ' TL  yeni paket kaydı');
        }
        islenen.push({ anahtar, tarih: bugun(), tutar: p.tutar, child_id: p.child_id, log_id: p.hedef || null });
        islenenAnahtar.add(anahtar);
    }

    fs.writeFileSync(ISLENEN, JSON.stringify(islenen, null, 2));
    console.log('\nTamam. İşlenenler kaydedildi: ' + path.basename(ISLENEN) + ' (tekrar çalıştırmak zararsız).');
    console.log('Uygulamayı yeniden başlatın.\n');
    db.close();
})().catch((e) => { console.error('HATA: ' + e.message); db.close(); process.exit(1); });
