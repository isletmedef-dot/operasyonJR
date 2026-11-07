'use strict';
/**
 * TEK SEFERLİK DÖKÜM DÜZELTMESİ (2. aşama) — açılışta bir kez uygulanır.
 *
 * Kaynak: kasadaki termal döküm fişlerinde el yazısıyla işaretlenen satırlar.
 * Fişlerde "✓" ve "?" işaretli satırlara DOKUNULMAZ. Yalnızca "x" işaretliler düzeltilir.
 *
 * A) İlk bakiye düzeltmesi: paketin ilk bakiyesi (dökümde "İlk bakiye") SUM(rights.miktar_dk)
 *    ile yazdırılır. Yanlış yazılmış olanlar doğru paket değerine çekilir; fark hem
 *    miktar_dk hem kalan_dk hem kalan_bonus'a eklenir (kalan = ana + bonus kuralı korunur),
 *    böylece aile ödediği değeri kullanabilir. Defterde iz kaydı bırakılır.
 *
 * B) Silinecek kayıtlar: yalnızca BAKİYEDEN DÜŞÜLMEMİŞ satırlar silinir
 *    (paketten_dusen = 0). Bakiye düşmüş bir satırı silmek parayı geri getirmez, bu yüzden
 *    asla silinmez; satır + ona bağlı hareket kayıtları birlikte kaldırılır.
 *
 * C) Yanlış tutar: eski dakika-modeliyle 1 TL/dk hesaplanmış satırın tutarı düzeltilir ve
 *    aradaki fark bakiyeden düşülür.
 *
 * D) Nakit -> paket: bakiyesi görünmediği dönemde kasadan nakit alınmış ziyaretler
 *    "paketten karşılandı" hâline getirilir (uygulamanın kendi paket çıkış yoluyla aynı).
 *
 * GÜVENLİK: eşleşme öğrenci + tarih + süre (±3 dk) + (varsa) tutar ile yapılır; her kural
 * en fazla bir kaydı işler ve birden çok eşleşme olursa hiçbirine dokunup uyarı basar.
 * Zaten düzeltilmiş bir kayıt kurala uymaz → aynı düzeltme İKİ KEZ UYGULANAMAZ.
 * Bakiye asla eksiye düşmez; yazmadan önce veritabanı dosyasının kopyası alınır;
 * her şey tek transaction içindedir.
 */
const fs = require('fs');
const path = require('path');

const SURUM = 'dokum_duzeltmesi_v1';
const TOL = 3;                          // süre toleransı (dk)

// A) İlk bakiye düzeltmeleri  (fişte "İlk bakiye" satırı x -> hedef)
const ILK_BAKIYE = [
    { child_id: 'UC-000004', hedef: 20000 },     // Göksu Sümer        18.800 -> 20.000
    { child_id: 'UC-000010', hedef: 10000 },     // han selman         9.250  -> 10.000
    { child_id: 'UC-000009', hedef: 10000 },     // selin ada          9.100  -> 10.000
    { child_id: 'UC-000011', hedef: 10000 },     // Çiçek nil Rakıcı   8.650  -> 10.000
    { child_id: 'UC-000008', hedef: 10000 }      // MİRA ALTUNTAŞ      8.800  -> 10.000
];

// B) Silinecek satırlar  (fişte x -> sil)
const SIL = [
    { child_id: 'UC-000004', tarih: '2026-09-07', dk: 7236 },   // Göksu: 120 sa 38 dk (unutulan çıkış)
    { child_id: 'UC-000010', tarih: '2026-11-06', dk: 1 },      // han selman: 1 dk iptal
    { child_id: 'UC-000016', tarih: '2026-10-18', dk: 1 }       // Kuzey: 1 dk
];

// C) Yanlış tutar düzeltmesi  (fişte x -> doğru tutar)
const TUTAR = [
    { child_id: 'UC-000018', tarih: '2026-11-01', dk: 59, eski: 59, yeni: 600 }  // Zeyd Aslan
];

// D) Nakit -> paket  (fişte x -> pakete geçir)
const PAKETE_GECIR = [
    { child_id: 'UC-000004', tarih: '2026-11-05', dk: 51, tutar: 600 },   // Göksu
    { child_id: 'UC-000008', tarih: '2026-10-28', dk: 85, tutar: 750 }    // MİRA
];

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (v, n, sag) => { const t = String(v == null ? '' : v); return sag ? t.padStart(n) : t.padEnd(n); };

async function tablolarHazir(dbGet, deneme = 25) {
    for (let i = 0; i < deneme; i++) {
        try {
            await dbGet('SELECT COUNT(*) AS n FROM logs');
            await dbGet('SELECT COUNT(*) AS n FROM rights');
            await dbGet('SELECT COUNT(*) AS n FROM right_movements');
            await dbGet('SELECT COUNT(*) AS n FROM settings');
            return true;
        } catch (e) { await bekle(200); }
    }
    return false;
}

async function uygula({ dbGet, dbAll, dbRun, withTransaction, dbPath }) {
    if (!await tablolarHazir(dbGet)) {
        console.warn('[dokum] şema hazır değil, bu açılışta atlandı.');
        return { atlandi: true, sebep: 'şema hazır değil' };
    }

    let isaret = null;
    try { isaret = await dbGet('SELECT value FROM settings WHERE key = ?', [SURUM]); } catch (e) { /* yok */ }

    // ---- Plan: hangi kural hangi kayda dokunacak ----
    const plan = { ilkBakiye: [], sil: [], tutar: [], paket: [], atlanan: [] };

    for (const k of ILK_BAKIYE) {
        const rights = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'
                                    ORDER BY miktar_dk DESC, tanim_tarihi ASC`, [k.child_id]);
        if (!rights.length) { plan.atlanan.push('ilk bakiye ' + k.child_id + ': paket hakkı yok'); continue; }
        const toplam = rights.reduce((t, r) => t + Number(r.miktar_dk || 0), 0);
        const fark = k.hedef - toplam;
        if (Math.round(fark * 100) === 0) continue;                     // zaten doğru -> dokunma
        plan.ilkBakiye.push({ ...k, hak: rights[0], toplam, fark });
    }

    for (const k of SIL) {
        const rows = await dbAll(`SELECT * FROM logs WHERE child_id = ? AND substr(entry_time,1,10) = ?
                                    AND ABS(COALESCE(duration_min,0) - ?) <= ? ORDER BY entry_time`,
            [k.child_id, k.tarih, k.dk, TOL]);
        if (!rows.length) continue;
        const guvenli = rows.filter((r) => Number(r.paketten_dusen || 0) === 0);
        if (rows.length !== 1) {
            plan.atlanan.push('sil ' + k.child_id + ' ' + k.tarih + ': ' + rows.length + ' eşleşme (tek kayıt bekleniyor)');
            continue;
        }
        if (!guvenli.length) {
            plan.atlanan.push('sil ' + k.child_id + ' ' + k.tarih + ': kayıtta bakiyeden düşme var, silinmez');
            continue;
        }
        plan.sil.push({ ...k, log: rows[0] });
    }

    for (const k of TUTAR) {
        const rows = await dbAll(`SELECT * FROM logs WHERE child_id = ? AND substr(entry_time,1,10) = ?
                                    AND ABS(COALESCE(duration_min,0) - ?) <= ? AND COALESCE(paketten_dusen,0) = ?`,
            [k.child_id, k.tarih, k.dk, TOL, k.eski]);
        if (!rows.length) continue;
        if (rows.length !== 1) { plan.atlanan.push('tutar ' + k.child_id + ' ' + k.tarih + ': ' + rows.length + ' eşleşme'); continue; }
        plan.tutar.push({ ...k, log: rows[0], fark: k.yeni - k.eski });
    }

    for (const k of PAKETE_GECIR) {
        const rows = await dbAll(`SELECT * FROM logs WHERE child_id = ? AND substr(entry_time,1,10) = ?
                                    AND ABS(COALESCE(duration_min,0) - ?) <= ?
                                    AND payment_type IN ('NAKİT','KREDİ KARTI') AND COALESCE(paketten_dusen,0) = 0
                                  ORDER BY entry_time`, [k.child_id, k.tarih, k.dk, TOL]);
        if (!rows.length) continue;
        if (rows.length !== 1) { plan.atlanan.push('pakete geçir ' + k.child_id + ' ' + k.tarih + ': ' + rows.length + ' eşleşme'); continue; }
        plan.paket.push({ ...k, log: rows[0] });
    }

    const isVar = plan.ilkBakiye.length || plan.sil.length || plan.tutar.length || plan.paket.length;
    if (!isVar) {
        if (!isaret) {
            await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                [SURUM, JSON.stringify({ durum: 'yapılacak iş yok', tarih: new Date().toISOString() })]);
        }
        plan.atlanan.forEach((a) => console.warn('[dokum] atlandı — ' + a));
        return { degisiklik: 0 };
    }

    try {
        if (dbPath && fs.existsSync(dbPath)) {
            const yedek = dbPath + '.yedek-dokum-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fs.copyFileSync(dbPath, yedek);
            console.log('[dokum] Veritabanı yedeği: ' + path.basename(yedek));
        }
    } catch (e) { console.warn('[dokum] yedek alınamadı (devam ediliyor): ' + e.message); }

    const satirlar = [];

    /** Paket bakiyesinden düşer (önce ana para, sonra bonus). */
    async function bakiyedenDus(child_id, tutar, log_id, aciklama) {
        const rights = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'
                                    AND (durum = 'Aktif' OR durum = 'Süresi Doldu') AND kalan_dk > 0
                                    ORDER BY tanim_tarihi ASC, hak_id ASC`, [child_id]);
        const toplam = rights.reduce((t, r) => t + Number(r.kalan_dk || 0), 0);
        if (toplam < tutar) return { ok: false, sebep: 'yetersiz bakiye (' + toplam + ' TL)', toplam };
        let kalanTutar = tutar;
        for (const r of rights) {
            if (kalanTutar <= 0) break;
            const avail = Number(r.kalan_dk || 0);
            const used = Math.min(avail, kalanTutar);
            kalanTutar -= used;
            let ana = Number(r.kalan_ana_para || 0), bon = Number(r.kalan_bonus || 0), left = used;
            if (ana >= left) { ana -= left; left = 0; } else { left -= ana; ana = 0; }
            if (left > 0) bon -= left;
            const yeni = ana + bon;
            await dbRun(`UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ?, durum = ? WHERE hak_id = ?`,
                [yeni, ana, bon, yeni > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
            await dbRun(`INSERT INTO right_movements
                    (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk,
                     yeni_kalan_dk, kaynak, aciklama, log_id, personel)
                 VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem', ?, ?, 'Sistem')`,
                ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), new Date().toISOString(),
                    child_id, r.hak_id, -used, avail, yeni, aciklama, log_id]);
        }
        return { ok: true, toplam, kalan: toplam - tutar };
    }

    await withTransaction(async () => {
        // A) İlk bakiye
        for (const p of plan.ilkBakiye) {
            const r = p.hak;
            const eskiKalan = Number(r.kalan_dk || 0);
            const yeniMiktar = Number(r.miktar_dk || 0) + p.fark;
            const yeniKalan = eskiKalan + p.fark;
            await dbRun(`UPDATE rights SET miktar_dk = ?, kalan_dk = ?, kalan_bonus = ? WHERE hak_id = ?`,
                [yeniMiktar, yeniKalan, Number(r.kalan_bonus || 0) + p.fark, r.hak_id]);
            await dbRun(`INSERT INTO right_movements
                    (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk,
                     yeni_kalan_dk, kaynak, aciklama, log_id, personel)
                 VALUES (?, ?, ?, ?, 'Bakiye Düzeltmesi', 'PAKET', ?, ?, ?, 'Sistem', ?, NULL, 'Sistem')`,
                ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), new Date().toISOString(),
                    p.child_id, r.hak_id, p.fark, eskiKalan, yeniKalan,
                    'Paket ilk bakiyesi düzeltildi (' + p.toplam + ' -> ' + p.hedef + ' TL).']);
            satirlar.push('İlk bakiye ' + p.child_id + ': ' + p.toplam + ' -> ' + p.hedef +
                ' TL (bakiye ' + eskiKalan + ' -> ' + yeniKalan + ')');
        }

        // B) Silme (kayıt + varsa ona bağlı hareketler)
        for (const p of plan.sil) {
            await dbRun(`DELETE FROM right_movements WHERE log_id = ?`, [p.log.log_id]);
            await dbRun(`DELETE FROM logs WHERE log_id = ?`, [p.log.log_id]);
            satirlar.push('Silindi ' + p.child_id + ': ' + String(p.log.entry_time).slice(0, 10) +
                ' ' + p.log.duration_min + ' dk (' + p.log.payment_type + ') log_id=' + p.log.log_id);
        }

        // C) Tutar düzeltmesi
        for (const p of plan.tutar) {
            const sonuc = await bakiyedenDus(p.child_id, p.fark, p.log.log_id, 'Tutar düzeltmesi (' + p.eski + ' -> ' + p.yeni + ' TL)');
            if (!sonuc.ok) { satirlar.push('ATLANDI tutar ' + p.child_id + ': ' + sonuc.sebep); continue; }
            await dbRun(`UPDATE logs SET paketten_dusen = ?, source_summary = ? WHERE log_id = ?`,
                [p.yeni, p.yeni + ' TL Paket', p.log.log_id]);
            satirlar.push('Tutar ' + p.child_id + ' ' + p.tarih + ': ' + p.eski + ' -> ' + p.yeni + ' TL');
        }

        // D) Nakit -> paket
        for (const p of plan.paket) {
            const sonuc = await bakiyedenDus(p.child_id, p.tutar, p.log.log_id, 'Nakit ödeme paket bakiyesine çevrildi');
            if (!sonuc.ok) { satirlar.push('ATLANDI paket ' + p.child_id + ': ' + sonuc.sebep); continue; }
            // payment_date'e dokunulmaz: satırın kendi gerçek çıkış anı orada duruyor.
            await dbRun(`UPDATE logs SET payment_type = 'PAKET', fee = 0, paketten_dusen = ?, source_summary = ?
                          WHERE log_id = ?`, [p.tutar, p.tutar + ' TL Paket', p.log.log_id]);
            satirlar.push('Pakete geçirildi ' + p.child_id + ' ' + p.tarih + ': ' + p.tutar + ' TL');
        }

        await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
            [SURUM, JSON.stringify({ durum: 'uygulandı', tarih: new Date().toISOString(), satirlar })]);
    });

    console.log('[dokum] ' + satirlar.length + ' düzeltme uygulandı.');
    satirlar.forEach((s) => console.log('[dokum]   ' + s));
    plan.atlanan.forEach((a) => console.warn('[dokum] atlandı — ' + a));
    return { degisiklik: satirlar.length };
}

module.exports = { uygula, ILK_BAKIYE, SIL, TUTAR, PAKETE_GECIR, SURUM };
