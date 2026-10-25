#!/usr/bin/env node
'use strict';
/**
 * Tek seferlik kayıt/bakiye düzeltmesi. Düzeltmeler duzeltme-plan.json dosyasındadır.
 *
 *   node duzeltme.js            -> SADECE PLAN (varsayılan; hiçbir şey yazılmaz)
 *   node duzeltme.js --uygula   -> uygular (önce database.db.yedek-<tarih> kopyası alınır)
 *
 * NE DÜZELTİYOR
 *  1) Eski sürüm ziyaret tutarını dakika başına 1 birim düşüyordu; paketler ÖN ÖDEMELİ
 *     olduğu için bu, bakiyenin eksik düşülmesi demekti. Onaylanan kayıtlar tarifeye çevrilir.
 *  2) 1-2 dakikalık yanlış okutmalar ve unutulan çıkışlardan kalan 800+ dakikalık kayıtlar silinir,
 *     yerine gerçek kullanım (1 saat) yazılır.
 *  3) Her paketin bakiyesi İLK VERİLEN tutardan yeniden hesaplanır:
 *        kalan = ilk verilen (10.000 / 20.000 ...) - tarifeye göre toplam kullanım
 *     Böylece dökümde "ilk 10.000 · kullanım X · kalan Y" satırları birbirini tutar.
 *
 * TASARIM KARARLARI
 *  - logs.fee PAKET kayıtlarında 0 kalır: ön ödemeli pakette kasadan tahsilat yoktur,
 *    tutar gelir sayılmaz. Ziyaretin tutarı logs.paketten_dusen alanındadır.
 *  - "iyi_nimet": true olan kayıt görünür ama tutarı düşülmez (işletme üstlenir).
 *  - İlk verilen bakiye right_movements (islem='Tanımlama') kaydından okunur; yoksa miktar_dk.
 *  - Her değişiklik için right_movements satırı yazılır (islem='Düzeltme') ve neden yazılır.
 *  - Aynı çocukta birden fazla paket varsa yalnızca EN BÜYÜĞÜ yeniden hesaplanır; kullanım
 *    o pakete yazılır, diğer paketlerin bakiyesi korunur.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const KOK = __dirname;
const DB = process.env.DB_PATH || path.join(KOK, 'database.db');
const PLAN = JSON.parse(fs.readFileSync(path.join(KOK, 'duzeltme-plan.json'), 'utf8'));
const UYGULA = process.argv.indexOf('--uygula') !== -1;
const PERSONEL = 'Yönetici Düzeltmesi';
const KAYNAK = 'Yönetici Düzeltmesi';

const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));
const yuvarla = (v) => Math.round(Number(v) * 100) / 100;

/** Uygulamanın PAKET kuralı: düşümde önce ana para, sonra bonus. tutar negatifse geri verir. */
function bakiyeUygula(ana, bonus, tutar) {
    let yAna = Number(ana || 0);
    let yBon = Number(bonus || 0);
    let kalan = Number(tutar);
    if (kalan >= 0) {
        if (yAna >= kalan) { yAna -= kalan; kalan = 0; } else { kalan -= yAna; yAna = 0; }
        if (kalan > 0) yBon -= kalan;
    } else {
        yAna += -kalan;
    }
    return { ana: yuvarla(yAna), bonus: yuvarla(yBon) };
}

async function hareketYaz(db, h) {
    await run(db, `INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk,
                      onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel)
                  VALUES (?, ?, ?, ?, 'Düzeltme', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['DUZ-' + Date.now() + '-' + Math.floor(Math.random() * 100000), new Date().toISOString(),
            h.child_id, h.hak_id, h.hak_tipi || 'PAKET', yuvarla(h.degisim), yuvarla(h.onceki), yuvarla(h.yeni),
            KAYNAK, h.aciklama, h.log_id || null, PERSONEL]);
}

(async () => {
    if (!fs.existsSync(DB)) { console.error('Veritabanı bulunamadı: ' + DB); process.exit(1); }
    console.log('=== DÜZELTME ' + (UYGULA ? '— UYGULANIYOR' : '— SADECE PLAN') + ' ===');
    console.log('  veritabanı: ' + DB + '\n');

    if (UYGULA) {
        const yedek = DB + '.yedek-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.copyFileSync(DB, yedek);
        console.log('  yedek: ' + yedek + '\n');
    }

    const db = new sqlite3.Database(DB);
    await run(db, 'PRAGMA busy_timeout = 5000');
    let hareketSayisi = 0;

    await run(db, 'BEGIN IMMEDIATE');
    try {
        // ---- 1) Tutar düzeltmeleri ------------------------------------------
        console.log('--- 1) TUTAR DÜZELTMELERİ (tarifeye çevrilir) ---');
        for (const d of PLAN.tutar) {
            const log = await get(db, 'SELECT * FROM logs WHERE log_id = ?', [d.log_id]);
            if (!log) { console.log('  ATLANDI (kayıt yok): ' + d.log_id); continue; }
            const eski = Number(log.paketten_dusen || 0);
            console.log(`  ${String(log.tarih).slice(0, 10)} ${String(log.student_name).slice(0, 18).padEnd(18)} ` +
                `${String(eski).padStart(7)} -> ${String(d.yeni_tutar).padStart(7)} TL` + (d.yeni_sure ? `  (süre -> ${d.yeni_sure} dk)` : ''));
            {
                await run(db, 'UPDATE logs SET paketten_dusen = ?, source_summary = ?, duration_min = COALESCE(?, duration_min) WHERE log_id = ?',
                    [Number(d.yeni_tutar), Number(d.yeni_tutar) + ' TL Paket', d.yeni_sure || null, d.log_id]);
                // Ziyaretin KENDİ hareketi de yazılır: dökümde o satırın "Kalan Bakiye" değeri
                // eski (dakika bazlı) hareketten değil bu düzeltmeden okunsun diye.
                const hak = await get(db, `SELECT * FROM rights WHERE child_id = ? AND hak_tipi='PAKET' AND durum='Aktif'
                                           ORDER BY miktar_dk DESC LIMIT 1`, [log.child_id]);
                if (hak) {
                    const yeniBakiye = bakiyeUygula(hak.kalan_ana_para, hak.kalan_bonus, Number(d.yeni_tutar) - eski);
                    const yeniKalan = yuvarla(yeniBakiye.ana + yeniBakiye.bonus);
                    await run(db, 'UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ? WHERE hak_id = ?',
                        [yeniKalan, yeniBakiye.ana, yeniBakiye.bonus, hak.hak_id]);
                    await hareketYaz(db, { child_id: log.child_id, hak_id: hak.hak_id, log_id: d.log_id,
                        degisim: -(Number(d.yeni_tutar) - eski), onceki: Number(hak.kalan_dk), yeni: yeniKalan, aciklama: d.aciklama });
                    hareketSayisi++;
                }
            }
        }

        // ---- 2) Silmeler -----------------------------------------------------
        console.log('\n--- 2) SİLİNEN KAYITLAR ---');
        for (const d of PLAN.sil) {
            const log = await get(db, 'SELECT * FROM logs WHERE log_id = ?', [d.log_id]);
            if (!log) { console.log('  ATLANDI (kayıt yok): ' + d.log_id); continue; }
            console.log(`  ${String(log.tarih).slice(0, 10)} ${String(log.student_name).slice(0, 18).padEnd(18)} ` +
                `${String(log.duration_min).padStart(6)} dk  ${String(log.payment_type).padEnd(9)} silindi`);
            {
                await hareketYaz(db, { child_id: log.child_id, hak_id: null, log_id: d.log_id, degisim: 0,
                    onceki: 0, yeni: 0, aciklama: d.aciklama });
                await run(db, 'DELETE FROM logs WHERE log_id = ?', [d.log_id]);
                hareketSayisi++;
            }
        }

        // ---- 3) Yeni kayıtlar ------------------------------------------------
        console.log('\n--- 3) YENİ KAYITLAR ---');
        for (const y of PLAN.yeni) {
            const stu = await get(db, 'SELECT * FROM students WHERE child_id = ?', [y.child]);
            if (!stu) { console.log('  ATLANDI (öğrenci yok): ' + y.child); continue; }
            const dusen = y.iyi_nimet ? 0 : Number(y.tutar);
            console.log(`  ${y.tarih} ${String(stu.student_name).slice(0, 18).padEnd(18)} ${String(y.sure).padStart(4)} dk  ` +
                (y.iyi_nimet ? `${y.tutar} TL — İŞLETME ÜSTLENDİ (düşülmez)` : `${dusen} TL paketten düşülür`));
            {
                const logId = 'DUZ-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
                await run(db, `INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time,
                                  duration_min, paketten_dusen, personel, status, fee, payment_type, payment_date, source_summary)
                              VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, ?, ?, ?, 'KAPALI', 0, 'PAKET', ?, ?)`,
                    [logId, y.tarih, y.child, stu.student_name, stu.parent_name || '', y.giris, Number(y.sure), dusen,
                        PERSONEL, y.giris, dusen > 0 ? dusen + ' TL Paket' : 'İyi niyet (ücretsiz)']);
                await hareketYaz(db, { child_id: y.child, hak_id: null, log_id: logId, degisim: -dusen, onceki: 0, yeni: 0, aciklama: y.aciklama });
                hareketSayisi++;
            }
        }

        // ---- 4) Bakiyeleri ilk verilen tutardan yeniden hesapla --------------
        console.log('\n--- 4) BAKİYE YENİDEN HESABI (ilk verilen - tarifeye göre kullanım) ---');
        console.log('   * "ara bakiye" = 1-3. aşamalar uygulandıktan sonraki değer; "yeni kalan" esas alınır.');
        console.log('   öğrenci            | ilk verilen | tarifeye göre kullanım | ara bakiye* | yeni kalan');
        const paketler = await all(db, `SELECT * FROM rights WHERE hak_tipi='PAKET' AND durum='Aktif'`);
        const cocuklar = [...new Set(paketler.map((p) => p.child_id))];

        for (const cid of cocuklar) {
            const stu = await get(db, 'SELECT * FROM students WHERE child_id = ?', [cid]);
            // Aynı çocukta birden fazla paket varsa en büyüğü esas alınır.
            const adaylar = paketler.filter((p) => p.child_id === cid);
            const esas = adaylar.reduce((a, b) => (Number(b.miktar_dk || 0) > Number(a.miktar_dk || 0) ? b : a), adaylar[0]);
            const tanim = await get(db, `SELECT degisim_dk FROM right_movements WHERE hak_id = ? AND islem='Tanımlama' ORDER BY rowid ASC LIMIT 1`, [esas.hak_id]);
            const ilk = tanim && tanim.degisim_dk != null ? Number(tanim.degisim_dk) : Number(esas.miktar_dk || 0);
            const kullanim = await get(db, `SELECT COALESCE(SUM(paketten_dusen),0) AS toplam FROM logs
                                            WHERE child_id = ? AND payment_type = 'PAKET' AND status = 'KAPALI'`, [cid]);
            const toplamKullanim = yuvarla(kullanim.toplam);
            const yeniKalan = yuvarla(Math.max(0, ilk - toplamKullanim));
            const eskiKalan = yuvarla(esas.kalan_dk);
            const fark = yuvarla(yeniKalan - eskiKalan);
            const etiket = (stu ? stu.student_name : cid).slice(0, 18).padEnd(18);
            console.log(`   ${etiket} | ${String(ilk).padStart(11)} | ${String(toplamKullanim).padStart(22)} | ${String(eskiKalan).padStart(13)} | ${String(yeniKalan).padStart(9)}` +
                (Math.abs(fark) > 0.001 ? `   (${fark > 0 ? '+' : ''}${fark})` : '   değişiklik yok'));

            if (Math.abs(fark) > 0.001 || Number(esas.miktar_dk) !== ilk) {
                {
                    // Uygulamanın kendi modeli: önce ÖDENEN tutar (satis_tutari) harcanır,
                    // promosyon bonusu en sona kalır. Böylece ana/bonus ayrımı da doğru kalır.
                    const odenen = Number(esas.satis_tutari || 0) || Number(esas.kalan_ana_para || 0);
                    const yeniAna = Math.max(0, Math.round(odenen - toplamKullanim));
                    const yeniBonus = Math.round(yeniKalan - yeniAna);
                    await run(db, 'UPDATE rights SET miktar_dk = ?, kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ? WHERE hak_id = ?',
                        [ilk, yeniKalan, yeniAna, yeniBonus, esas.hak_id]);
                    await hareketYaz(db, {
                        child_id: cid, hak_id: esas.hak_id, degisim: fark, onceki: eskiKalan, yeni: yeniKalan,
                        aciklama: 'Bakiye yeniden hesaplandı: ilk verilen ' + ilk + ' TL - tarifeye göre toplam kullanım ' +
                            toplamKullanim + ' TL = ' + yeniKalan + ' TL. (Eski sürüm ziyaretleri dakika başına 1 birim düşüyordu.)',
                    });
                    hareketSayisi++;
                }
            }
        }

        // ---- 5) Kontroller ---------------------------------------------------
        console.log('\n--- 5) KONTROL ---');
        const bozuk = await all(db, `SELECT hak_id FROM rights WHERE hak_tipi='PAKET'
                                     AND ABS(kalan_dk - (COALESCE(kalan_ana_para,0) + COALESCE(kalan_bonus,0))) > 0.01`);
        console.log(bozuk.length ? '  UYARI: ' + bozuk.length + ' pakette kalan_dk ≠ ana+bonus' : '  kalan_dk = ana_para + bonus ✓');
        const negatif = await all(db, `SELECT s.student_name FROM rights r JOIN students s ON s.child_id=r.child_id
                                       WHERE r.hak_tipi='PAKET' AND r.durum='Aktif' AND r.kalan_dk < 0`);
        console.log(negatif.length ? '  UYARI: negatif bakiye: ' + negatif.map((n) => n.student_name).join(', ') : '  negatif bakiye yok ✓');

        if (UYGULA) await run(db, 'COMMIT'); else await run(db, 'ROLLBACK');
    } catch (e) {
        await run(db, 'ROLLBACK').catch(() => {});
        console.error('\nHATA — hiçbir değişiklik yazılmadı: ' + e.message);
        process.exit(1);
    }

    console.log('\n  ' + (UYGULA ? 'DURUM: uygulandı. yazılan hareket: ' + hareketSayisi
        : 'DURUM: sadece plan — hiçbir şey yazılmadı. Uygulamak için --uygula ekleyin.'));
    db.close();
})();
