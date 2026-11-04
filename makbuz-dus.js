'use strict';
/**
 * Elle verilen makbuz listesine göre PAKET bakiyesinden düşer.
 *
 * Kural (kullanıcı talimatı):
 *   - Listedeki her satır için bakiyeden düşülecek.
 *   - Sistemde eşleşen kayıt VARSA onun bilgisi kullanılır (kendi tarihi).
 *   - Eşleşen kayıt YOKSA bugünün tarih/saati ile yeni kayıt açılır.
 *   - Zaten bakiyeden düşülmüş bir kayıt varsa TEKRAR DÜŞÜLMEZ (çift ücret olmasın).
 *
 * Girdi: makbuz-dus.json (yanında) —
 *   [ { "child_id": "UC-000009", "dk": 82, "tutar": 750 }, ... ]
 *
 *   node makbuz-dus.js            -> gösterim (hiç yazmaz)
 *   node makbuz-dus.js --uygula   -> uygular (önce database.db.yedek-<tarih>)
 *
 * Bakiye yetmezse satır atlanır ve raporlanır; bakiye ASLA eksiye düşmez.
 * Bu betik uygulamanın klasöründe çalıştırılır.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.DB_PATH || path.join(__dirname, 'database.db');
const GIRDI = process.argv.find((a) => a.endsWith('.json')) || path.join(__dirname, 'makbuz-dus.json');
const UYGULA = process.argv.includes('--uygula');
const ISLENEN = GIRDI.replace(/\.json$/, '') + '-islenen.json';
const SURE_TOLERANS = 8;                 // makbuzdaki süre ile sistemdeki süre bu kadar farklı olabilir

if (!fs.existsSync(DB)) { console.error('Veritabanı bulunamadı: ' + DB); process.exit(1); }
if (!fs.existsSync(GIRDI)) { console.error('Girdi dosyası bulunamadı: ' + GIRDI); process.exit(1); }

const db = new sqlite3.Database(DB);
const all = (s, p = []) => new Promise((r, j) => db.all(s, p, (e, x) => (e ? j(e) : r(x))));
const get = (s, p = []) => new Promise((r, j) => db.get(s, p, (e, x) => (e ? j(e) : r(x))));
const run = (s, p = []) => new Promise((r, j) => db.run(s, p, function (e) { return e ? j(e) : r(this); }));
const pad = (v, n, sag) => { const t = String(v == null ? '' : v); return sag ? t.padStart(n) : t.padEnd(n); };
const bugun = () => new Date().toISOString();

/** Paket bakiyesinden düşer (önce ana para, sonra bonus) — uygulamanın çıkış kuralıyla aynı. */
async function bakiyedenDus(child_id, tutar, log_id, aciklama) {
    const rights = await all(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'
                              AND (durum = 'Aktif' OR durum = 'Süresi Doldu') AND kalan_dk > 0
                              ORDER BY tanim_tarihi ASC`, [child_id]);
    const toplam = rights.reduce((t, r) => t + Number(r.kalan_dk || 0), 0);
    if (toplam < tutar) return { ok: false, sebep: 'yetersiz bakiye (' + toplam + ' TL)', toplam };

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
                   VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem', ?, ?, 'Sistem')`,
            ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), bugun(), child_id, r.hak_id,
             -used, avail, yeni, aciklama, log_id]);
    }
    return { ok: true, toplam, kalan: toplam - tutar };
}

(async () => {
    const liste = JSON.parse(fs.readFileSync(GIRDI, 'utf8'));
    const islenen = fs.existsSync(ISLENEN) ? JSON.parse(fs.readFileSync(ISLENEN, 'utf8')) : [];
    const islenenAnahtar = new Set(islenen.map((x) => x.anahtar));

    const plan = [];
    for (const e of liste) {
        const dk = Number(e.dk), tutar = Number(e.tutar);
        let child_id = e.child_id;
        if (!child_id && e.ad) {
            const s = await get('SELECT child_id FROM students WHERE student_name = ?', [e.ad]);
            child_id = s && s.child_id;
        }
        if (!child_id || !(tutar > 0)) { plan.push({ ...e, karar: 'ATLA', sebep: 'öğrenci/tutar belirsiz' }); continue; }
        const ogr = await get('SELECT student_name FROM students WHERE child_id = ?', [child_id]);
        if (!ogr) { plan.push({ ...e, child_id, karar: 'ATLA', sebep: 'öğrenci kaydı yok' }); continue; }

        // Aday kayıtlar: aynı öğrenci, kapanmış, süresi ya da tutarı uyan
        const adaylar = await all(`SELECT * FROM logs WHERE child_id = ? AND status <> 'AÇIK'
                                     AND (ABS(COALESCE(duration_min,0) - ?) <= ? OR COALESCE(fee,0) = ?
                                          OR COALESCE(paketten_dusen,0) = ?)
                                   ORDER BY ABS(COALESCE(duration_min,0) - ?) ASC`, [child_id, dk, SURE_TOLERANS, tutar, tutar, dk]);

        const zaten = adaylar.find((a) => Number(a.paketten_dusen || 0) === tutar);       // aynı tutar düşülmüş
        const cevrilecek = adaylar.find((a) => Number(a.paketten_dusen || 0) === 0 && a.payment_type !== 'PAKET');
        const bakiye = await get(`SELECT COALESCE(SUM(kalan_dk),0) t FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'
                                    AND (durum = 'Aktif' OR durum = 'Süresi Doldu')`, [child_id]);
        const mevcut = Number(bakiye.t || 0);

        let karar, sebep, hedef = null;
        if (zaten) { karar = 'ZATEN'; sebep = 'bu tutar zaten bakiyeden düşülmüş (' + (zaten.entry_time || '').slice(0, 10) + ')'; }
        else if (cevrilecek) { karar = 'DÖNÜŞTÜR'; hedef = cevrilecek.log_id; sebep = 'sistemdeki kayıt (' + (cevrilecek.entry_time || '').slice(0, 10) + ', ' + cevrilecek.payment_type + ') bakiyeden düşülecek'; }
        else { karar = 'YENİ'; sebep = 'eşleşen kayıt yok — bugünün tarihiyle yeni kayıt'; }

        plan.push({ ...e, child_id, ogrenci: ogr.student_name, dk, tutar, bakiye: mevcut, karar, sebep, hedef,
            yeterli: mevcut >= tutar, sonrasi: karar === 'ZATEN' ? mevcut : mevcut - tutar });
    }

    const satir = (a, b, c, d, e, f, g) => '  ' + pad(a, 11) + ' ' + pad(b, 19) + ' ' + pad(c, 5, true) + ' ' +
        pad(d, 8, true) + ' ' + pad(e, 10, true) + ' ' + pad(f, 6) + '  ' + g;
    console.log('\nListe uygulanıyor — plan\n');
    console.log(satir('kart', 'öğrenci', 'süre', 'tutar', 'bakiye', 'sonra', 'karar'));
    console.log('  ' + '-'.repeat(92));
    let toplamDusulecek = 0;
    const proj = {};                       // aynı öğrencide düşüşler birikmeli
    for (const p of plan) {
        if (proj[p.child_id] === undefined) proj[p.child_id] = p.bakiye;
        const once = proj[p.child_id];
        const dusecek = (p.karar === 'YENİ' || p.karar === 'DÖNÜŞTÜR') && p.yeterli;
        const sonra = p.karar === 'ZATEN' ? '(değişmez)' : (dusecek ? once - p.tutar : 'YETERSİZ');
        if (dusecek) { proj[p.child_id] = once - p.tutar; toplamDusulecek += p.tutar; }
        console.log(satir(p.child_id || '-', String(p.ogrenci || '-').slice(0, 19), p.dk, p.tutar, once, sonra, p.karar));
    }
    console.log('  ' + '-'.repeat(92));
    for (const p of plan) console.log('  · ' + (p.ogrenci || p.child_id) + ': ' + p.sebep);
    console.log('\n  bakiyelerden toplam düşülecek: ' + toplamDusulecek + ' TL');
    console.log('  (ZATEN yazan satırlar zaten düşülmüş — tekrar düşülmez, çift ücret olmaz)');

    if (!UYGULA) { console.log('\nGösterim modu — hiçbir şey yazılmadı. Uygulamak için:  node makbuz-dus.js --uygula\n'); db.close(); return; }

    const yedek = DB + '.yedek-' + bugun().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(DB, yedek);
    console.log('\nYedek alındı: ' + path.basename(yedek) + '\n');

    for (const p of plan) {
        if (p.karar === 'ZATEN' || p.karar === 'ATLA') continue;
        if (!p.yeterli) { console.log('  ✖ ' + pad(p.ogrenci, 19) + ' ' + pad(p.tutar, 8, true) + ' TL — bakiye yetmez, atlandı'); continue; }
        const anahtar = p.child_id + '|' + p.dk + '|' + p.tutar;
        if (islenenAnahtar.has(anahtar)) continue;

        const sonuc = await bakiyedenDus(p.child_id, p.tutar, p.hedef, 'Makbuz karşılığı bakiyeden düşüldü (' + p.dk + ' dk)');
        if (!sonuc.ok) { console.log('  ✖ ' + pad(p.ogrenci, 19) + ' ' + sonuc.sebep); continue; }

        if (p.hedef) {
            await run(`UPDATE logs SET payment_type = 'PAKET', fee = 0, paketten_dusen = ?, source_summary = ?, payment_date = ?
                       WHERE log_id = ?`, [p.tutar, p.tutar + ' TL Paket', bugun(), p.hedef]);
            console.log('  ✔ ' + pad(p.ogrenci, 19) + ' ' + pad(p.tutar, 8, true) + ' TL  sistemdeki kayıt bakiyeden düşüldü');
        } else {
            const ogr = await get('SELECT * FROM students WHERE child_id = ?', [p.child_id]);
            await run(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time,
                         duration_min, paketten_dusen, personel, status, payment_status, fee, payment_type, payment_date, source_summary)
                       VALUES (?, ?, ?, ?, ?, 'ÇIKIŞ', ?, ?, ?, 'Sistem', 'KAPALI', 'ÖDENDİ', 0, 'PAKET', ?, ?)`,
                ['LOG-PKT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), bugun().split('T')[0].split('-').reverse().join('.'),
                    p.child_id, ogr ? ogr.student_name : '', ogr ? ogr.parent_name : '', bugun(), p.dk, p.tutar,
                    bugun(), p.tutar + ' TL Paket']);
            console.log('  ✔ ' + pad(p.ogrenci, 19) + ' ' + pad(p.tutar, 8, true) + ' TL  yeni paket kaydı (bugün)');
        }
        islenen.push({ anahtar, tarih: bugun(), child_id: p.child_id, dk: p.dk, tutar: p.tutar, log_id: p.hedef || null });
        islenenAnahtar.add(anahtar);
    }
    fs.writeFileSync(ISLENEN, JSON.stringify(islenen, null, 2));
    console.log('\nTamam. İşlenenler: ' + path.basename(ISLENEN) + ' (tekrar çalıştırmak zararsız). Uygulamayı yeniden başlatın.\n');
    db.close();
})().catch((e) => { console.error('HATA: ' + e.message); db.close(); process.exit(1); });
