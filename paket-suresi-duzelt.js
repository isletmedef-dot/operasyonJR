'use strict';
/**
 * Süresi dolmuş işaretlenmiş ama BAKİYESİ OLAN paketleri tekrar 'Aktif' yapar.
 *
 * NEDEN: Paket bakiyesi ön ödemeli paradır. Eski sürümdeki süre taraması PAKET haklarını da
 * 'Süresi Doldu' yapıyordu; bakiye silinmiyordu ama profilden kayboluyor ve çıkışta
 * kullanılamıyordu. Sunucu artık paketlere dokunmuyor (bkz. server.js — süre taraması),
 * yani bakiyeler kendiliğinden görünür ve harcanabilir hâle geldi.
 *
 * Bu betik yalnızca eski taramanın bıraktığı DURUM kaydını temizler (kozmetik + kayıt düzeni).
 * Çalıştırmasanız da bakiye çalışır. Tekrar tekrar çalıştırmak zararsızdır; bakiyeye dokunmaz.
 *
 *   node paket-suresi-duzelt.js             -> sadece gösterir, hiçbir şey yazmaz
 *   node paket-suresi-duzelt.js --uygula    -> uygular (önce database.db.yedek-<tarih> alır)
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB = process.env.DB_PATH || path.join(__dirname, 'database.db');
const UYGULA = process.argv.includes('--uygula');

if (!fs.existsSync(DB)) {
    console.error('Veritabanı bulunamadı: ' + DB);
    console.error('Bu betiği uygulamanın klasöründe (baslat.bat ile aynı yerde) çalıştırın.');
    process.exit(1);
}

const db = new sqlite3.Database(DB);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res(this); }));

(async () => {
    const list = await all(
        `SELECT r.hak_id, r.child_id, r.kalan_dk, r.son_kullanma, s.student_name
           FROM rights r LEFT JOIN students s ON s.child_id = r.child_id
          WHERE r.hak_tipi = 'PAKET' AND r.durum = 'Süresi Doldu' AND r.kalan_dk > 0
          ORDER BY r.son_kullanma ASC`);

    if (!list.length) {
        console.log('Düzeltilecek kayıt yok — süresi dolmuş işaretlenmiş, bakiyesi olan paket bulunmuyor. (Bu iyi haber.)');
        db.close();
        return;
    }

    const toplam = list.reduce((t, p) => t + Number(p.kalan_dk || 0), 0);
    console.log('Süresi dolmuş işaretlenmiş, bakiyesi olan paketler:\n');
    for (const p of list) {
        console.log('  ' + String(p.student_name || p.child_id).slice(0, 22).padEnd(22) +
            ' ' + String(p.kalan_dk).padStart(8) + ' TL   (son kullanma ' + (p.son_kullanma || '-') + ')');
    }
    console.log('\n  TOPLAM: ' + toplam + ' TL ön ödemeli bakiye');
    console.log('  Bu paketler bakiyeleri durduğu için ARTIK ÇALIŞIYOR; bu betik sadece durumlarını düzeltir.\n');

    if (!UYGULA) {
        console.log('Gösterim modu — hiçbir şey yazılmadı. Uygulamak için:  node paket-suresi-duzelt.js --uygula');
        db.close();
        return;
    }

    const yedek = DB + '.yedek-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(DB, yedek);
    console.log('Yedek alındı: ' + path.basename(yedek) + '\n');

    for (const p of list) {
        await run("UPDATE rights SET durum = 'Aktif' WHERE hak_id = ?", [p.hak_id]);
        // İz kaydı: ileride "bu paket neden 'Aktif' oldu" sorusu kalmasın
        await run(`INSERT INTO right_movements
                     (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk,
                      onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel)
                   VALUES (?, ?, ?, ?, ?, 'PAKET', 0, ?, ?, ?, ?, ?)`,
            ['HAR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), new Date().toISOString(),
             p.child_id, p.hak_id, 'Süre Sonu Düzeltmesi',
             Number(p.kalan_dk), Number(p.kalan_dk), 'paket-suresi-duzelt.js',
             'Paket bakiyesi (ön ödemeli) süre sonu işareti kaldırıldı — ' + p.kalan_dk + ' TL tekrar kullanılabilir.',
             'Sistem']);
        console.log('  ✔ ' + String(p.student_name || p.child_id).slice(0, 22).padEnd(22) + ' -> Aktif');
    }
    console.log('\nTamam. ' + list.length + ' paket geri açıldı. Uygulamayı yeniden başlatın.');
    db.close();
})().catch((e) => { console.error('HATA: ' + e.message); db.close(); process.exit(1); });
