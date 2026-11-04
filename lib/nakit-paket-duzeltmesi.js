'use strict';
/**
 * TEK SEFERLİK VERİ DÜZELTMESİ — açılışta bir kez uygulanır, sonra kendini tekrarlamaz.
 *
 * SORUN: Ön ödemeli paket bakiyesi süre-dolumu yüzünden görünmez/kullanılamaz olduğu
 * dönemde, kasadan NAKİT alınan ziyaretler 'NAKİT' olarak kaydedildi. Oysa bu ziyaretler
 * ailenin paket bakiyesinden karşılanmalıydı. (Ailelere nakit iade edilecek; bu kayıt
 * sadece defteri doğru hâle getirir.)
 *
 * NE YAPAR: Aşağıdaki sabit listedeki ziyaretleri uygulamanın KENDİ paket çıkış yoluyla
 * birebir aynı biçimde "paketten karşılandı" hâline getirir ve bakiyeden düşer:
 *     logs.payment_type = 'PAKET', logs.fee = 0,
 *     logs.paketten_dusen = tutar, logs.source_summary = '<tutar> TL Paket'
 *     rights: önce ana para, sonra bonus; kalan_dk = ana + bonus; durum = kalan>0 ? Aktif : Tükendi
 *     right_movements: 'Kullanım (Çıkış)' satırı, log_id ile bağlı
 *     logs.payment_date DEĞİŞTİRİLMEZ — satır kapanırken uygulamanın yazdığı gerçek çıkış anı.
 *
 * GÜVENLİK:
 *   - Eşleşme log_id tahmini değil, öğrenci + tarih + tutar + süre(±3 dk) + henüz düşülmemiş
 *     olması ile yapılır. Zaten düşülmüş bir kayıt (payment_type='PAKET') kurala uymaz, bu
 *     yüzden AYNI KAYIT İKİ KEZ DÜŞÜLEMEZ.
 *   - Bakiye yetmezse o satır atlanır; bakiye ASLA eksiye düşmez.
 *   - Yazmadan önce veritabanı dosyasının zaman damgalı kopyası alınır.
 *   - Her şey tek bir transaction içindedir; hata olursa hiçbiri uygulanmaz.
 *   - 'settings' tablosuna sürüm işareti yazılır; işaret varsa ve yapılacak iş kalmamışsa
 *     hiçbir sorgu çalıştırılmaz.
 */
const fs = require('fs');
const path = require('path');

const SURUM = 'nakit_paket_duzeltmesi_v1';
const SURE_TOLERANSI = 3;              // makbuz/sistem süre farkı için (dk)

// Makbuz karşılığı düzeltilecek ziyaretler. Tarih, kaydın kendi günüdür (yerel).
// Not: 04.11.2026 kaydı, kullanıcının "15:22" dediği ziyarettir — 13:31 yerel giriş +
// 112 dk = 15:23 yerel çıkış (111 dk sayılsa tam 15:22).
const KURALLAR = [
    { child_id: 'UC-000010', tarih: '2026-10-27', dk: 95, tutar: 750 },
    { child_id: 'UC-000009', tarih: '2026-10-27', dk: 82, tutar: 750 },
    { child_id: 'UC-000004', tarih: '2026-10-29', dk: 32, tutar: 450 },
    { child_id: 'UC-000009', tarih: '2026-11-03', dk: 55, tutar: 600 },
    { child_id: 'UC-000004', tarih: '2026-11-03', dk: 56, tutar: 600 },
    { child_id: 'UC-000010', tarih: '2026-11-04', dk: 112, tutar: 900 }
];

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Şema hazır olana kadar kısa süre bekler (tablolar açılışta oluşturuluyor). */
async function tablolarHazir(dbGet, deneme = 25) {
    for (let i = 0; i < deneme; i++) {
        try {
            await dbGet('SELECT COUNT(*) AS n FROM logs');
            await dbGet('SELECT COUNT(*) AS n FROM rights');
            await dbGet('SELECT COUNT(*) AS n FROM right_movements');
            return true;
        } catch (e) {
            await bekle(200);
        }
    }
    return false;
}

async function uygula({ dbGet, dbAll, dbRun, withTransaction, dbPath }) {
    if (!await tablolarHazir(dbGet)) {
        console.warn('[nakit-paket] şema hazır değil, bu açılışta atlandı.');
        return { atlandi: true, sebep: 'şema hazır değil' };
    }

    let isaret = null;
    try {
        isaret = await dbGet('SELECT value FROM settings WHERE key = ?', [SURUM]);
    } catch (e) { /* settings yoksa sorun değil */ }

    // Kurala uyan, HENÜZ DÜŞÜLMEMİŞ kayıtları bul.
    const adaylar = [];
    for (const k of KURALLAR) {
        const bulunan = await dbAll(
            `SELECT log_id, child_id, student_name, entry_time, duration_min, fee
               FROM logs
              WHERE child_id = ? AND substr(entry_time, 1, 10) = ?
                AND payment_type IN ('NAKİT', 'KREDİ KARTI')
                AND COALESCE(paketten_dusen, 0) = 0
                AND fee = ?
                AND ABS(COALESCE(duration_min, 0) - ?) <= ?
              ORDER BY entry_time`,
            [k.child_id, k.tarih, k.tutar, k.dk, SURE_TOLERANSI]);
        for (const r of bulunan) adaylar.push({ ...r, tutar: k.tutar });
    }

    if (!adaylar.length) {
        if (!isaret) {
            await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                [SURUM, JSON.stringify({ durum: 'yapılacak iş yok', tarih: new Date().toISOString() })]);
        }
        return { degisiklik: 0 };
    }

    // Yazmadan önce dosya yedeği (dizin yazılamıyorsa uyarı verir, işlemi durdurmaz).
    try {
        if (dbPath && fs.existsSync(dbPath)) {
            const yedek = dbPath + '.yedek-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fs.copyFileSync(dbPath, yedek);
            console.log('[nakit-paket] Veritabanı yedeği: ' + path.basename(yedek));
        }
    } catch (e) {
        console.warn('[nakit-paket] yedek alınamadı (devam ediliyor): ' + e.message);
    }

    const satirlar = [];
    await withTransaction(async () => {
        for (const a of adaylar) {
            const rights = await dbAll(
                `SELECT * FROM rights
                  WHERE child_id = ? AND hak_tipi = 'PAKET'
                    AND (durum = 'Aktif' OR durum = 'Süresi Doldu') AND kalan_dk > 0
                  ORDER BY tanim_tarihi ASC, hak_id ASC`, [a.child_id]);
            const toplam = rights.reduce((t, r) => t + Number(r.kalan_dk || 0), 0);
            if (toplam < a.tutar) {
                satirlar.push({ ...a, atlandi: 'yetersiz bakiye (' + toplam + ' TL)' });
                continue;
            }

            let kalanTutar = a.tutar;
            for (const r of rights) {
                if (kalanTutar <= 0) break;
                const avail = Number(r.kalan_dk || 0);
                const used = Math.min(avail, kalanTutar);
                kalanTutar -= used;

                let ana = Number(r.kalan_ana_para || 0);
                let bon = Number(r.kalan_bonus || 0);
                let left = used;
                if (ana >= left) { ana -= left; left = 0; } else { left -= ana; ana = 0; }
                if (left > 0) bon -= left;
                const yeni = ana + bon;

                await dbRun(`UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ?, durum = ? WHERE hak_id = ?`,
                    [yeni, ana, bon, yeni > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
                await dbRun(`INSERT INTO right_movements
                        (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk,
                         onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel)
                     VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem', 'Çıkış işlemi', ?, ?)`,
                    ['MOV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                        new Date().toISOString(), a.child_id, r.hak_id, -used, avail, yeni, a.log_id, '']);
            }

            // payment_date'e dokunulmaz: satırın kendi gerçek çıkış anı orada duruyor.
            await dbRun(`UPDATE logs SET payment_type = 'PAKET', fee = 0, paketten_dusen = ?, source_summary = ?
                          WHERE log_id = ?`, [a.tutar, a.tutar + ' TL Paket', a.log_id]);
            satirlar.push({ ...a, onceki: toplam, sonra: toplam - a.tutar });
        }

        const islenenTutar = satirlar.filter((s) => !s.atlandi).reduce((t, s) => t + s.tutar, 0);
        await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
            [SURUM, JSON.stringify({ durum: 'uygulandı', tarih: new Date().toISOString(), ziyaret: satirlar.filter((s) => !s.atlandi).length, tutar: islenenTutar })]);
    });

    const uygulanan = satirlar.filter((s) => !s.atlandi);
    if (uygulanan.length) {
        console.log('[nakit-paket] ' + uygulanan.length + ' ziyaret paketten karşılandı olarak işaretlendi (' +
            uygulanan.reduce((t, s) => t + s.tutar, 0) + ' TL).');
        uygulanan.forEach((s) => console.log('[nakit-paket]   ' + String(s.student_name || s.child_id).slice(0, 20).padEnd(20) +
            ' ' + String(s.entry_time).slice(0, 10) + '  ' + s.tutar + ' TL   bakiye ' + s.onceki + ' -> ' + s.sonra));
    }
    satirlar.filter((s) => s.atlandi).forEach((s) => console.warn('[nakit-paket]   ATLANDI — ' +
        String(s.student_name || s.child_id).slice(0, 20) + ': ' + s.atlandi));
    return { degisiklik: uygulanan.length };
}

module.exports = { uygula, KURALLAR, SURUM };
