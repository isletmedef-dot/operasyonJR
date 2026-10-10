const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const ptp = require('pdf-to-printer');

const app = express();
const PORT = 3000;

const https = require('https');


function sendTelegramNotification(message) {
    const token = appSettings.telegram_token;
    const chatId = appSettings.telegram_chat_id;
    if (!token || !chatId) return;
    
    const data = JSON.stringify({ chat_id: chatId, text: message });
    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {
        // Node.js'te socketin askıda kalmaması ve ECONNRESET hatası vermemesi için
        // gelen yanıt verisini (data event) mutlaka tüketmek gerekir.
        res.on('data', () => {}); 
        res.on('end', () => {});
    });

    req.on('error', (e) => console.error("Telegram Hatası:", e.message));
    req.write(data);
    req.end();
}


app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

process.on('uncaughtException', (err) => {
    console.error('[HATA YAKALANDI - SUNUCU KAPANMADI]:', err.message);
});

let appSettings = { base_rate: 300, hourly_rate: 500, extra_rate: 150, telafi_expiry_days: 30, package_expiry_days: 30, exit_tolerance_minutes: 5, telegram_token: '', telegram_chat_id: '' };

const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("DB Bağlantı Hatası:", err.message);
    else console.log("Yerel SQLite Veritabanı Hazır.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bonus_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, sales_amount REAL, bonus_amount REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS staff (pin TEXT PRIMARY KEY, name TEXT)`);

    db.run(`ALTER TABLE logs ADD COLUMN personel TEXT`, () => {});
    db.run(`ALTER TABLE rights ADD COLUMN personel TEXT`, () => {});
    db.run(`ALTER TABLE rights ADD COLUMN kalan_ana_para REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE rights ADD COLUMN kalan_bonus REAL DEFAULT 0`, () => {});
    db.run(`ALTER TABLE right_movements ADD COLUMN personel TEXT`, () => {});
    db.run(`ALTER TABLE logs ADD COLUMN is_paused INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE logs ADD COLUMN paused_at TEXT`, () => {});
    db.run(`ALTER TABLE logs ADD COLUMN total_pause_duration INTEGER DEFAULT 0`, () => {});

    db.all('SELECT * FROM settings', (err, rows) => {
        if (!rows || rows.length === 0) {
            db.run(`INSERT INTO settings (key, value) VALUES ('base_rate', '300')`);
            db.run(`INSERT INTO settings (key, value) VALUES ('hourly_rate', '500')`);
            db.run(`INSERT INTO settings (key, value) VALUES ('extra_rate', '150')`);
            db.run(`INSERT INTO settings (key, value) VALUES ('telafi_expiry_days', '30')`);
        } else {
            let hasExpiry = false;
            let hasHourly = false;
            rows.forEach(r => {
                if (r.key === 'base_rate') appSettings.base_rate = Number(r.value);
                if (r.key === 'hourly_rate') { appSettings.hourly_rate = Number(r.value); hasHourly = true; }
                if (r.key === 'extra_rate') appSettings.extra_rate = Number(r.value);
                if (r.key === 'package_expiry_days') appSettings.package_expiry_days = Number(r.value);
                if (r.key === 'exit_tolerance_minutes') appSettings.exit_tolerance_minutes = Number(r.value);
                if (r.key === 'telafi_expiry_days') {
                    appSettings.telafi_expiry_days = Number(r.value);
                    hasExpiry = true;
                }
                if (r.key === 'telegram_token') appSettings.telegram_token = r.value;
                if (r.key === 'telegram_chat_id') appSettings.telegram_chat_id = r.value;
            });
            if (!hasExpiry) db.run(`INSERT INTO settings (key, value) VALUES ('telafi_expiry_days', '30')`);
            if (!hasHourly) {
                db.run(`INSERT INTO settings (key, value) VALUES ('hourly_rate', '500')`);
                appSettings.hourly_rate = 500;
            }
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS students (child_id TEXT PRIMARY KEY, cari_turu TEXT, student_name TEXT NOT NULL, birth_date TEXT, parent_name TEXT, parent_phone TEXT NOT NULL, note TEXT, created_at TEXT, status TEXT DEFAULT 'Aktif', rfid_id TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (log_id TEXT PRIMARY KEY, tarih TEXT, child_id TEXT, student_name TEXT, parent_name TEXT, action TEXT, entry_time TEXT, duration_min INTEGER DEFAULT 0, paketten_dusen INTEGER DEFAULT 0, personel TEXT, status TEXT, payment_status TEXT, fee REAL DEFAULT 0, payment_type TEXT, payment_date TEXT, source_summary TEXT, hak_id TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS rights (hak_id TEXT PRIMARY KEY, child_id TEXT, hak_tipi TEXT, miktar_dk INTEGER, kalan_dk INTEGER, kaynak TEXT, tanim_tarihi TEXT, son_kullanma TEXT, durum TEXT DEFAULT 'Aktif', satis_tutari REAL DEFAULT 0, odeme_tipi TEXT, not_alani TEXT, personel TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS right_movements (hareket_id TEXT PRIMARY KEY, tarih TEXT, child_id TEXT, hak_id TEXT, islem TEXT, hak_tipi TEXT, degisim_dk INTEGER, onceki_kalan_dk INTEGER, yeni_kalan_dk INTEGER, kaynak TEXT, aciklama TEXT, log_id TEXT, personel TEXT)`);
});

// Arka Planda KASA Yazıcısına 2 Kopya ve 3 Kat Büyütülmüş Font Gönderme Fonksiyonu
async function sendServerPrint(slipText) {
    try {
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
					@page {
					size: 80mm auto;
					margin: 0 !important;
					margin-left: 100 !important;
					}

					html, body {
					margin: 0 !important;
					padding: 0 !important;
					width: 80mm !important;
					}

					body {
					font-family: Arial, sans-serif;
					font-size: 26px;
					font-weight: bold;
					line-height: 2.2;
					}

					h3 {
					font-size: 26px;
					margin: 0 0 4px 0 !important;
					padding: 0 !important;
					text-align: center;
					}

					p {
					margin: 2px 0 !important;
					padding: 0 !important;
					font-size: 20px;
					text-align: center;
					}

					@media print {
					@page {
					size: 80mm auto;
					margin: 0 !important;
					}

					html, body {
					margin: 0 !important;
					padding: 0 !important;
					}
					}
				</style>
						
            </head>
            <body>
                ${slipText}
            </body>
            </html>
        `;
        const tempHtmlPath = path.join(__dirname, `temp_slip_${Date.now()}.html`);
        fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');
        
        const options = {
            printer: "KASA",
            copies: 2
        };

        await ptp.print(tempHtmlPath, options);
        setTimeout(() => { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); }, 3000);
    } catch (err) {
        console.error("Sunucu Yazdırma Hatası:", err.message);
    }
}

let isUpdatingRights = false;
function updateExpiredRights(callback) {
    if (isUpdatingRights) {
        if (callback) callback();
        return;
    }
    isUpdatingRights = true;
    
    const today = new Date().toISOString().split('T')[0];
    
    db.run(`UPDATE rights SET durum = 'İşleniyor' WHERE durum = 'Aktif' AND hak_tipi = 'TELAFİ' AND son_kullanma < ?`, [today], function(err) {
        db.all(`SELECT child_id, SUM(kalan_dk) as total_dk FROM rights WHERE durum = 'İşleniyor' GROUP BY child_id`, [], (err, rows) => {
            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    const newLessons = Math.floor(row.total_dk / 60);
                    if (newLessons > 0) {
                        for(let i=0; i<newLessons; i++){
                            db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'TELAFİ DERSİ', 1, 1, 'Süresi Dolan Oyun Alanı Telafisi Dönüşümü', ?, 'Sistem')`,
                                ["DERS-" + Date.now() + "-" + Math.floor(Math.random()*10000), row.child_id, new Date().toISOString()]);
                        }
                    }
                });
            }
            db.run(`UPDATE rights SET kalan_dk = 0, durum = 'Süresi Doldu (Dönüştü)' WHERE durum = 'İşleniyor'`, [], () => {
                db.run(`UPDATE rights SET durum = 'Süresi Doldu' WHERE durum = 'Aktif' AND son_kullanma < ?`, [today], () => {
                    isUpdatingRights = false;
                    if (callback) callback();
                });
            });
        });
    });
}

function calculateFee(minute) {
    minute = Number(minute || 0);
    if (minute <= 0) return 0;
    
    let tol = appSettings.exit_tolerance_minutes || 0;
    let effectiveMinute = minute - tol;
    if (effectiveMinute < 1) effectiveMinute = 1;

    if (effectiveMinute <= 30) return appSettings.base_rate;
    if (effectiveMinute <= 60) return appSettings.hourly_rate;
    return appSettings.hourly_rate + (Math.ceil((effectiveMinute - 60) / 30) * appSettings.extra_rate);
}

function calculateAge(birthDateStr) {
    if (!birthDateStr) return "-";
    const d = new Date(birthDateStr);
    if (isNaN(d.getTime())) return "-";
    const today = new Date();
    let age = today.getFullYear() - d.getFullYear();
    const m = today.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
    return age < 0 ? 0 : age;
}


app.get('/api/bonus-packages', (req, res) => {
    db.all(`SELECT * FROM bonus_packages`, (err, rows) => res.json({ success: true, packages: rows || [] }));
});
app.post('/api/bonus-packages/add', (req, res) => {
    db.run(`INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)`, [req.body.sales, req.body.bonus], (err) => res.json({ success: !err }));
});
app.post('/api/bonus-packages/delete', (req, res) => {
    db.run(`DELETE FROM bonus_packages WHERE id = ?`, [req.body.id], (err) => res.json({ success: !err }));
});

app.get('/api/staff', (req, res) => {
    db.all(`SELECT pin, name FROM staff`, (err, rows) => {
        res.json({ success: true, staff: rows || [] });
    });
});

app.post('/api/staff/add', (req, res) => {
    const { pin, name } = req.body;
    if (!pin || pin.length !== 4 || !name) return res.json({ success: false, message: "Geçerli isim ve 4 haneli PIN girin." });
    db.run(`INSERT OR REPLACE INTO staff (pin, name) VALUES (?, ?)`, [pin, name], (err) => {
        res.json({ success: !err, message: err ? err.message : "Personel başarıyla kaydedildi." });
    });
});

app.post('/api/staff/delete', (req, res) => {
    db.run(`DELETE FROM staff WHERE pin = ?`, [req.body.pin], (err) => {
        res.json({ success: !err });
    });
});

app.post('/api/staff/verify', (req, res) => {
    db.get(`SELECT name FROM staff WHERE pin = ?`, [req.body.pin], (err, row) => {
        if (row) res.json({ success: true, name: row.name });
        else res.json({ success: false, message: "Hatalı veya yetkisiz PIN!" });
    });
});

app.get('/api/settings', (req, res) => res.json({ success: true, settings: appSettings }));

app.post('/api/settings/update', (req, res) => {
    const { base_rate, hourly_rate, extra_rate, telafi_expiry_days, package_expiry_days, exit_tolerance_minutes, telegram_token, telegram_chat_id } = req.body;
    appSettings.base_rate = Number(base_rate);
    appSettings.hourly_rate = Number(hourly_rate);
    appSettings.extra_rate = Number(extra_rate);
    if(telafi_expiry_days) appSettings.telafi_expiry_days = Number(telafi_expiry_days);
    if(package_expiry_days) appSettings.package_expiry_days = Number(package_expiry_days);
    if(exit_tolerance_minutes !== undefined) appSettings.exit_tolerance_minutes = Number(exit_tolerance_minutes);
    appSettings.telegram_token = telegram_token || '';
    appSettings.telegram_chat_id = telegram_chat_id || '';
    
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('base_rate', ?)`, [base_rate]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('hourly_rate', ?)`, [hourly_rate]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('extra_rate', ?)`, [extra_rate]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('telafi_expiry_days', ?)`, [appSettings.telafi_expiry_days]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('package_expiry_days', ?)`, [appSettings.package_expiry_days]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('exit_tolerance_minutes', ?)`, [appSettings.exit_tolerance_minutes]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_token', ?)`, [appSettings.telegram_token]);
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('telegram_chat_id', ?)`, [appSettings.telegram_chat_id]);
    res.json({ success: true, message: "Ayarlar güncellendi." });
});

app.post('/api/students/delete', (req, res) => {
    const { child_id } = req.body;
    if (!child_id) return res.json({ success: false, message: "Geçersiz öğrenci ID." });
    db.run(`DELETE FROM students WHERE child_id = ?`, [child_id], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        db.run(`DELETE FROM rights WHERE child_id = ?`, [child_id]);
        db.run(`DELETE FROM right_movements WHERE child_id = ?`, [child_id]);
        db.run(`DELETE FROM logs WHERE child_id = ?`, [child_id]);
        res.json({ success: true, message: "Öğrenci ve ilgili tüm kayıtlar kalıcı olarak silindi." });
    });
});

app.post('/api/students/edit', (req, res) => {
    const { child_id, student_name, parent_name, parent_phone, birth_date, rfid_id, note, cari_turu, telafi_minutes, package_minutes, telafi_dersi_count } = req.body;
    db.run(
        `UPDATE students SET student_name=?, parent_name=?, parent_phone=?, birth_date=?, rfid_id=?, note=?, cari_turu=? WHERE child_id=?`,
        [student_name, parent_name, parent_phone, birth_date, rfid_id, note, cari_turu, child_id],
        function(err) {
            if (err) return res.json({ success: false, message: err.message });
            const now = new Date().toISOString();
            const newTelafiMins = Math.max(0, Number(telafi_minutes || 0));
            const newPackageMinutes = Math.max(0, Number(package_minutes || 0));
            const newTelafiDersiCount = Math.max(0, Number(telafi_dersi_count || 0));
            
            db.all(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ' AND durum = 'Aktif'`, [child_id], (err, currentTelafis) => {
                if (currentTelafis && currentTelafis.length > 0) {
                    db.run(`UPDATE rights SET kalan_dk = ?, miktar_dk = ? WHERE hak_id = ?`, [newTelafiMins, newTelafiMins, currentTelafis[0].hak_id]);
                    for (let i = 1; i < currentTelafis.length; i++) db.run(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [currentTelafis[i].hak_id]);
                } else if (newTelafiMins > 0) {
                    const expDate = new Date();
                    expDate.setDate(expDate.getDate() + appSettings.telafi_expiry_days);
                    db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, personel) VALUES (?, ?, 'TELAFİ', ?, ?, 'Dramatik Oyun Alanı Telafisi', ?, ?, 'Sistem')`,
                        ["HAK-EDT-" + Date.now(), child_id, newTelafiMins, newTelafiMins, now, expDate.toISOString().split('T')[0]]);
                }
                
                db.all(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET' AND durum = 'Aktif'`, [child_id], (err, currentPackages) => {
                    if (currentPackages && currentPackages.length > 0) {
                        db.run(`UPDATE rights SET kalan_dk = ?, miktar_dk = ? WHERE hak_id = ?`, [newPackageMinutes, newPackageMinutes, currentPackages[0].hak_id]);
                        for (let i = 1; i < currentPackages.length; i++) db.run(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [currentPackages[i].hak_id]);
                    } else if (newPackageMinutes > 0) {
                        db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'PAKET', ?, ?, 'Yönetici Düzenlemesi', ?, 'Sistem')`,
                            ["PAK-EDT-" + Date.now(), child_id, newPackageMinutes, newPackageMinutes, now]);
                    }
                    
                    db.all(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ' AND durum = 'Aktif'`, [child_id], (err, currentDersler) => {
                        const currentCount = (currentDersler || []).length;
                        if (newTelafiDersiCount < currentCount) {
                            const toDisable = currentDersler.slice(0, currentCount - newTelafiDersiCount);
                            toDisable.forEach(r => db.run(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [r.hak_id]));
                        } else if (newTelafiDersiCount > currentCount) {
                            for (let i = 0; i < (newTelafiDersiCount - currentCount); i++) {
                                db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'TELAFİ DERSİ', 1, 1, 'Yönetici Düzenlemesi', ?, 'Sistem')`,
                                    ["DERS-EDT-" + Date.now() + i, child_id, now]);
                            }
                        }
                        res.json({ success: true, message: "Öğrenci bilgileri ve hakları güncellendi." });
                    });
                });
            });
        }
    );
});

app.get('/api/students', (req, res) => {
    db.all(`SELECT * FROM students ORDER BY created_at DESC`, (err, rows) => {
        res.json({ success: true, students: (rows || []).map(r => ({ ...r, age: calculateAge(r.birth_date), created_at_fmt: r.created_at ? new Date(r.created_at).toLocaleDateString('tr-TR') : '-' })) });
    });
});

app.get('/api/students/search', (req, res) => {
    const q = String(req.query.q || "").toLowerCase().trim();
    db.all(`SELECT * FROM students WHERE LOWER(student_name) LIKE ? OR LOWER(parent_name) LIKE ? OR parent_phone LIKE ? OR rfid_id = ? ORDER BY created_at DESC LIMIT 20`, 
    [`%${q}%`, `%${q}%`, `%${q}%`, q], (err, rows) => {
        res.json({ success: true, students: (rows || []).map(r => ({ ...r, age: calculateAge(r.birth_date) })) });
    });
});

app.get('/api/students/get/:child_id', (req, res) => {
    updateExpiredRights(() => {
        db.get(`SELECT * FROM students WHERE child_id = ?`, [req.params.child_id], (err, student) => {
            if (!student) return res.json({ success: false, message: "Öğrenci bulunamadı." });
            db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [req.params.child_id], (err, activeLog) => {
                db.all(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0`, [req.params.child_id], (err, rights) => {
                    let telafiMinutes = 0, packageMinutes = 0, telafiDersiCount = 0;
                    (rights || []).forEach(r => { 
                        if (r.hak_tipi === 'TELAFİ') telafiMinutes += r.kalan_dk; 
                        if (r.hak_tipi === 'PAKET') packageMinutes += r.kalan_dk; 
                        if (r.hak_tipi === 'TELAFİ DERSİ') telafiDersiCount += r.kalan_dk; 
                    });
                    res.json({ 
                        success: true, 
                        student: { 
                            ...student, 
                            age: calculateAge(student.birth_date), 
                            inside: !!activeLog, 
                            entry_time: activeLog ? new Date(activeLog.entry_time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : null, 
                            rights_summary: { telafi_minutes: telafiMinutes, package_minutes: packageMinutes, telafi_dersi_count: telafiDersiCount }
                        } 
                    });
                });
            });
        });
    });
});

app.post('/api/students/create', (req, res) => {
    const { cari_turu, student_name, birth_date, parent_name, parent_phone, note, start_entry, rfid_id, personel } = req.body;
    db.get(`SELECT CAST(REPLACE(child_id, 'UC-', '') AS INTEGER) as num FROM students ORDER BY num DESC LIMIT 1`, (err, row) => {
        let nextNum = 1;
        if (row && row.num) {
            nextNum = row.num + 1;
        }
        const childId = "UC-" + String(nextNum).padStart(6, '0');
        const now = new Date().toISOString();
        
        db.run(
            `INSERT INTO students (child_id, cari_turu, student_name, birth_date, parent_name, parent_phone, note, created_at, status, rfid_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', ?)`,
            [childId, cari_turu || 'Dramatik Oyun Alanı', student_name, birth_date, parent_name, parent_phone, note, now, rfid_id],
            function (err) {
                if (err) return res.json({ success: false, message: "Kayıt hatası: " + err.message });
                
                if (start_entry) {
                    const logId = "LOG-" + Date.now();
                    const dateStr = now.split('T')[0];
                    db.run(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time, status, personel) VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, 'AÇIK', ?)`,
                        [logId, dateStr, childId, student_name, parent_name, now, personel || 'Sistem']);
                    
                    sendServerPrint(`
                        <h3>ÜRETEN ÇOCUK</h3>
                        <p style="text-align:center;">Giriş İşlemi</p>
                        <hr style="border:1px dashed #000;">
                        <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                        <p><b>Öğrenci:</b> ${student_name} (${childId})</p>
                        <p><b>Veli Tel:</b> ${parent_phone}</p>
                        <p><b>Personel:</b> ${personel || 'Sistem'}</p>
                    `);
                }
                res.json({ success: true, child_id: childId, student_name: student_name, message: "Öğrenci kaydedildi." });
            }
        );
    });
});

app.post('/api/rfid/scan', (req, res) => {
    db.get(`SELECT * FROM students WHERE rfid_id = ?`, [req.body.rfid_id], (err, student) => {
        if (!student || !student.rfid_id) return res.json({ success: false, message: "Bu karta tanımlı öğrenci bulunamadı." });
        db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [student.child_id], (err, activeLog) => {
            res.json({ success: true, action: activeLog ? 'EXIT' : 'ENTRY', child_id: student.child_id });
        });
    });
});

app.get('/api/inside', (req, res) => {
    updateExpiredRights(() => {
        db.all(`SELECT * FROM logs WHERE status = 'AÇIK'`, (err, rows) => {
            const now = new Date();
            Promise.all((rows || []).map(r => new Promise((resolve) => {
                const entryDate = new Date(r.entry_time);
                let currentPauseDk = 0;
                if (r.is_paused === 1 && r.paused_at) {
                    currentPauseDk = Math.floor((now - new Date(r.paused_at)) / 60000);
                }
                const totalPause = (r.total_pause_duration || 0) + currentPauseDk;
                const sureDk = Math.max(0, Math.floor((now - entryDate) / 60000) - totalPause);
                
                db.get(`SELECT parent_phone FROM students WHERE child_id = ?`, [r.child_id], (err, stu) => {
                    db.all(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0`, [r.child_id], (err, rights) => {
                        let telafiMinutes = 0; let packageMinutes = 0;
                        (rights || []).forEach(rg => { if (rg.hak_tipi === 'TELAFİ') telafiMinutes += rg.kalan_dk; if (rg.hak_tipi === 'PAKET') packageMinutes += rg.kalan_dk; });
                        resolve({ 
                            child_id: r.child_id, student_name: r.student_name, parent_name: r.parent_name, parent_phone: stu ? stu.parent_phone : '', 
                            entry_time_fmt: entryDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }), 
                            entry_timestamp: entryDate.getTime(), sure_dk: sureDk, estimated_fee: calculateFee(sureDk), 
                            telafi_minutes: telafiMinutes, package_minutes: packageMinutes, warning: sureDk >= 60, alarm: sureDk >= 120, is_paused: r.is_paused === 1 
                        });
                    });
                });
            }))).then(result => res.json({ success: true, children: result.sort((a, b) => b.sure_dk - a.sure_dk) }));
        });
    });
});


app.post('/api/entry/pause-toggle', (req, res) => {
    const { child_id } = req.body;
    db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id], (err, log) => {
        if (!log) return res.json({ success: false, message: "Kayıt bulunamadı." });
        const now = new Date();
        
        if (log.is_paused === 1) {
            let pausedDk = 0;
            if (log.paused_at) {
                pausedDk = Math.floor((now - new Date(log.paused_at)) / 60000);
            }
            const newTotalPause = (log.total_pause_duration || 0) + pausedDk;
            db.run(`UPDATE logs SET is_paused = 0, paused_at = NULL, total_pause_duration = ? WHERE log_id = ?`, [newTotalPause, log.log_id], () => {
                res.json({ success: true, message: "Devam ediliyor." });
            });
        } else {
            db.run(`UPDATE logs SET is_paused = 1, paused_at = ? WHERE log_id = ?`, [now.toISOString(), log.log_id], () => {
                res.json({ success: true, message: "Duraklatıldı." });
            });
        }
    });
});

app.post('/api/entry/start', (req, res) => {
    const { child_id, personel } = req.body;
    db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id], (err, activeLog) => {
        if (activeLog) return res.json({ success: false, message: "Çocuk zaten içeride." });
        db.get(`SELECT * FROM students WHERE child_id = ?`, [child_id], (err, student) => {
            const now = new Date().toISOString();
            const logId = "LOG-" + Date.now();
            const dateStr = now.split('T')[0];
            db.run(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time, status, personel) VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, 'AÇIK', ?)`,
                [logId, dateStr, student.child_id, student.student_name, student.parent_name, now, personel || ''], (err) => {
                    if (!err) {
                        sendServerPrint(`
                            <h3>ÜRETEN ÇOCUK</h3>
                            <p style="text-align:center;">Giriş İşlemi</p>
                            <hr style="border:1px dashed #000;">
                            <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                            <p><b>Öğrenci:</b> ${student.student_name} (${student.child_id})</p>
                            <p><b>Veli Tel:</b> ${student.parent_phone}</p>
                            <p><b>Personel:</b> ${personel || 'Sistem'}</p>
                        `);
                    }
                    res.json({ success: !err, message: err ? err.message : "Giriş işlemi başlatıldı." });
                });
        });
    });
});

app.get('/api/exit/preview/:child_id', (req, res) => {
    db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [req.params.child_id], (err, log) => {
        if (!log) return res.json({ success: false, message: "Çocuk içeride görünmüyor." });
        const now = new Date();
        let currentPauseDk = 0;
        if (log.is_paused === 1 && log.paused_at) {
            currentPauseDk = Math.floor((now - new Date(log.paused_at)) / 60000);
        }
        const totalPause = (log.total_pause_duration || 0) + currentPauseDk;
        const sureDk = Math.max(1, Math.ceil((now - new Date(log.entry_time)) / 60000) - totalPause);
        
        db.all(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0`, [req.params.child_id], (err, rights) => {
            let telafiMinutes = 0, packageMinutes = 0;
            (rights || []).forEach(r => { 
                if (r.hak_tipi === 'TELAFİ') telafiMinutes += r.kalan_dk; 
                if (r.hak_tipi === 'PAKET') packageMinutes += r.kalan_dk; 
            });
            res.json({ success: true, child_id: req.params.child_id, student_name: log.student_name, sure_dk: sureDk, fee: calculateFee(sureDk), telafi_minutes: telafiMinutes, package_minutes: packageMinutes });
        });
    });
});

app.post('/api/exit/finalize', (req, res) => {
    const { child_id, payment_type, personel } = req.body;
    updateExpiredRights(() => {
        db.get(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id], (err, log) => {
            if (!log) return res.json({ success: false, message: "Aktif giriş bulunamadı." });
            const now = new Date();
            let currentPauseDk = 0;
            if (log.is_paused === 1 && log.paused_at) {
                currentPauseDk = Math.floor((now - new Date(log.paused_at)) / 60000);
            }
            const totalPause = (log.total_pause_duration || 0) + currentPauseDk;
            const sureDk = Math.max(1, Math.ceil((now - new Date(log.entry_time)) / 60000) - totalPause);
            let fee = calculateFee(sureDk);
            let sourceSummary = "";

            if (payment_type === 'HAK') {
                db.all(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0 AND hak_tipi = 'TELAFİ' ORDER BY tanim_tarihi ASC`, [child_id], (err, rights) => {
                    let totalAvailable = 0;
                    (rights || []).forEach(r => totalAvailable += r.kalan_dk);
                    if (totalAvailable < sureDk) return res.json({ success: false, message: "Yeterli telafi bakiyesi (dakika) yok." });

                    let remainingDuration = sureDk, telafiUsed = 0;
                    (rights || []).forEach(r => {
                        if (remainingDuration <= 0) return;
                        const avail = Number(r.kalan_dk || 0), used = Math.min(avail, remainingDuration);
                        remainingDuration -= used; 
                        telafiUsed += used;
                        const newRem = avail - used;
                        db.run(`UPDATE rights SET kalan_dk = ?, durum = ? WHERE hak_id = ?`, [newRem, newRem > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
                        db.run(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel) VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'TELAFİ', ?, ?, ?, 'Sistem', 'Çıkış işlemi', ?, ?)`,
                            ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, r.hak_id, -used, avail, newRem, log.log_id, personel || '']);
                    });
                    
                    db.run(`UPDATE logs SET duration_min = ?, fee = 0, payment_type = ?, payment_date = ?, status = 'KAPALI', paketten_dusen = ?, source_summary = ?, personel = ? WHERE log_id = ?`,
                        [sureDk, payment_type, now.toISOString(), telafiUsed, telafiUsed + ' Dk Telafi', personel || '', log.log_id], () => {
                            sendServerPrint(`
                                <h3>ÜRETEN ÇOCUK</h3>
                                <p style="text-align:center;">Çıkış İşlemi</p>
                                <hr style="border:1px dashed #000;">
                                <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                                <p><b>Öğrenci:</b> ${log.student_name} (${log.child_id})</p>
                                <p><b>Süre / Tutar:</b> ${sureDk} Dk / 0 TL</p>
                                <p><b>Ödeme Tipi:</b> HAK (Telafi)</p>
                                <p><b>Personel:</b> ${personel || 'Sistem'}</p>
                            `);
                            res.json({ success: true, message: "Çıkış başarılı." });
                        });
                });
            } else if (payment_type === 'PAKET') {
                db.all(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0 AND hak_tipi = 'PAKET' ORDER BY tanim_tarihi ASC`, [child_id], (err, rights) => {
                    let totalAvailableTL = 0;
                    (rights || []).forEach(r => totalAvailableTL += r.kalan_dk);
                    if (totalAvailableTL < fee) return res.json({ success: false, message: "Yeterli paket bakiyesi (TL) yok." });

                    let remainingFee = fee, packageUsed = 0;
                    (rights || []).forEach(r => {
                        if (remainingFee <= 0) return;
                        const avail = Number(r.kalan_dk || 0), used = Math.min(avail, remainingFee);
                        remainingFee -= used;
                        packageUsed += used;

                        let yAna = Number(r.kalan_ana_para || 0);
                        let yBon = Number(r.kalan_bonus || 0);
                        let left = used;

                        if (yAna >= left) { yAna -= left; left = 0; }
                        else { left -= yAna; yAna = 0; }
                        if (left > 0) { yBon -= left; }

                        const newRem = yAna + yBon;
                        db.run(`UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ?, durum = ? WHERE hak_id = ?`, [newRem, yAna, yBon, newRem > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
                        db.run(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel) VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem', 'Çıkış işlemi', ?, ?)`,
                            ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, r.hak_id, -used, avail, newRem, log.log_id, personel || '']);
                    });

                    db.run(`UPDATE logs SET duration_min = ?, fee = 0, payment_type = ?, payment_date = ?, status = 'KAPALI', paketten_dusen = ?, source_summary = ?, personel = ? WHERE log_id = ?`,
                        [sureDk, payment_type, now.toISOString(), packageUsed, packageUsed + ' TL Paket', personel || '', log.log_id], () => {
                            sendServerPrint(`
                                <h3>ÜRETEN ÇOCUK</h3>
                                <p style="text-align:center;">Çıkış İşlemi</p>
                                <hr style="border:1px dashed #000;">
                                <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                                <p><b>Öğrenci:</b> ${log.student_name} (${log.child_id})</p>
                                <p><b>Süre / Tutar:</b> ${sureDk} Dk / 0 TL (Paketten Karşılandı)</p>
                                <p><b>Ödeme Tipi:</b> PAKET</p>
                                <p><b>Personel:</b> ${personel || 'Sistem'}</p>
                            `);
                            res.json({ success: true, message: "Çıkış başarılı." });
                        });
                });
            } else {
                if (payment_type === 'ÜCRETSİZ') fee = 0;
                sourceSummary = payment_type === 'ÜCRETSİZ' ? 'ÜCRETSİZ' : (payment_type + ' Tahsilatı');
                db.run(`UPDATE logs SET duration_min = ?, fee = ?, payment_type = ?, payment_date = ?, status = 'KAPALI', source_summary = ?, personel = ? WHERE log_id = ?`,
                    [sureDk, fee, payment_type, now.toISOString(), sourceSummary, personel || '', log.log_id], () => {
                        sendServerPrint(`
                            <h3>ÜRETEN ÇOCUK</h3>
                            <p style="text-align:center;">Çıkış İşlemi</p>
                            <hr style="border:1px dashed #000;">
                            <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                            <p><b>Öğrenci:</b> ${log.student_name} (${log.child_id})</p>
                            <p><b>Süre / Tutar:</b> ${sureDk} Dk / ${fee} TL</p>
                            <p><b>Ödeme Tipi:</b> ${payment_type}</p>
                            <p><b>Personel:</b> ${personel || 'Sistem'}</p>
                        `);
                        res.json({ success: true, message: "Çıkış başarılı." });
                    });
            }
        });
    });
});

app.post('/api/print/status', async (req, res) => {
    const { student_name, child_id, parent_phone, entry_time_fmt, sure_dk, estimated_fee } = req.body;
    await sendServerPrint(`
        <h3>ÜRETEN ÇOCUK</h3>
        <p style="text-align:center;">Anlık Durum Fişi</p>
        <hr style="border:1px dashed #000;">
        <p><b>Öğrenci:</b> ${student_name} (${child_id})</p>
        <p><b>Veli Tel:</b> ${parent_phone}</p>
        <p><b>Giriş Saati:</b> ${entry_time_fmt}</p>
        <p><b>İçerideki Süre:</b> ${sure_dk} dakika</p>
        <p><b>Güncel Tutar:</b> <b>${estimated_fee} TL</b></p>
    `);
    res.json({ success: true });
});

app.get('/api/rights/get/:child_id', (req, res) => {
    updateExpiredRights(() => {
        db.get(`SELECT * FROM students WHERE child_id = ?`, [req.params.child_id], (err, student) => {
            db.all(`SELECT * FROM right_movements WHERE child_id = ? ORDER BY tarih DESC`, [req.params.child_id], (err, movements) => {
                db.all(`SELECT * FROM rights WHERE child_id = ?`, [req.params.child_id], (err, rights) => {
                    let telafiMinutes = 0, packageMinutes = 0, telafiDersiCount = 0;
                    (rights || []).forEach(r => { 
                        if (r.durum === 'Aktif' && r.kalan_dk > 0) { 
                            if (r.hak_tipi === 'TELAFİ') telafiMinutes += r.kalan_dk; 
                            if (r.hak_tipi === 'PAKET') packageMinutes += r.kalan_dk; 
                            if (r.hak_tipi === 'TELAFİ DERSİ') telafiDersiCount += r.kalan_dk; 
                        } 
                    });
                    res.json({ success: true, student: student, telafi_minutes: telafiMinutes, package_minutes: packageMinutes, telafi_dersi_count: telafiDersiCount, movements: (movements || []).map(m => ({ ...m, created_at_fmt: new Date(m.tarih).toLocaleString('tr-TR') })) });
                });
            });
        });
    });
});

app.post('/api/rights/add-telafi', (req, res) => {
    const { child_id, minutes, source, note, personel } = req.body;
    const mins = Math.max(1, Number(minutes || 60));
    const kaynakText = source || 'Dramatik Oyun Alanı Telafisi';
    const now = new Date();
    
    const expDate = new Date(now);
    expDate.setDate(expDate.getDate() + (appSettings.telafi_expiry_days || 30));
    const expiry_str = expDate.toISOString().split('T')[0];
    
    const hakId = "HAK-" + Date.now();
    db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, not_alani, personel) VALUES (?, ?, 'TELAFİ', ?, ?, ?, ?, ?, ?, ?)`,
        [hakId, child_id, mins, mins, kaynakText, now.toISOString(), expiry_str, note || '', personel || ''], () => {
            db.run(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel) VALUES (?, ?, ?, ?, 'Tanımlama', 'TELAFİ', ?, 0, ?, ?, ?, ?)`,
                ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, hakId, mins, mins, kaynakText, 'Telafi Dakikası Eklendi', personel || ''], () => {
                    res.json({ success: true, message: `${mins} Dakika telafi hakkı eklendi. Kaynak: ${kaynakText}. SKT: ${expiry_str}` });
                });
        });
});

app.post('/api/rights/add-package', (req, res) => {
    const { child_id, price, bonus, payment_type, source, note, personel } = req.body;
    const anaPara = Math.max(0, Number(price || 0));
    const bonusPara = Math.max(0, Number(bonus || 0));
    const totalTL = anaPara + bonusPara;
    if (totalTL <= 0) return res.json({ success: false, message: "Geçerli bir tutar giriniz." });

    const now = new Date();
    const expDate = new Date(now);
    expDate.setDate(expDate.getDate() + (appSettings.package_expiry_days || 30));
    const expiry_str = expDate.toISOString().split('T')[0];
    
    const nowStr = now.toISOString();
    const hakId = "PAK-" + Date.now();

    db.run(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para, kalan_bonus, kaynak, tanim_tarihi, son_kullanma, satis_tutari, odeme_tipi, not_alani, personel) VALUES (?, ?, 'PAKET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [hakId, child_id, totalTL, totalTL, anaPara, bonusPara, source || 'Satış', nowStr, expiry_str, anaPara, payment_type || 'NAKİT', note || '', personel || ''], () => {
            db.run(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel) VALUES (?, ?, ?, ?, 'Tanımlama', 'PAKET', ?, 0, ?, ?, ?, ?)`,
                ["MOV-" + Date.now() + Math.random(), now, child_id, hakId, totalTL, totalTL, source || 'Satış', 'Paket Satışı', personel || ''], () => {
                    
                    db.get(`SELECT student_name FROM students WHERE child_id = ?`, [child_id], (err, row) => {
                        const stuName = row ? row.student_name : child_id;
                        const msg = `📦 YENİ PAKET SATIŞI\n\nÖğrenci: ${stuName}\nSatış Tutarı: ${anaPara} TL\nBonus Tutarı: ${bonusPara} TL\nToplam Bakiye: ${totalTL} TL\nÖdeme Tipi: ${payment_type}\nPersonel: ${personel || 'Sistem'}\nTarih: ${new Date().toLocaleString('tr-TR')}`;
                        sendTelegramNotification(msg);
                    });

                    res.json({ success: true, message: `Paket tanımlandı: ${totalTL} TL (${anaPara} TL + ${bonusPara} TL Bonus).` });
                });
        });
});

app.get('/api/reports/summary', (req, res) => {
    const todayStr = new Date().toISOString().split('T')[0];
    db.get(`SELECT COUNT(*) as c FROM logs WHERE status = 'AÇIK'`, (err, rIn) => {
        db.all(`SELECT * FROM logs WHERE tarih = ? AND status = 'KAPALI'`, [todayStr], (err, tLogs) => {
            let cash = 0, card = 0, free = 0;
            (tLogs || []).forEach(l => {
                if (l.payment_type === 'NAKİT') cash += l.fee;
                else if (l.payment_type === 'KREDİ KARTI') card += l.fee;
                else free++;
            });
            res.json({ 
                success: true, 
                inside_count: rIn ? rIn.c : 0, 
                today: { entries: (tLogs || []).length, cash, card, free }, 
                today_logs: (tLogs || []).map(l => ({ 
                    ...l, 
                    entry_time: new Date(l.entry_time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }), 
                    exit_time: new Date(l.payment_date).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) 
                })) 
            });
        });
    });
});


async function generateExcelBuffer() {

    const workbook = new ExcelJS.Workbook();
    
    const s1 = workbook.addWorksheet('Kayıtlı Öğrenciler');
    s1.columns = [{ header: 'Çocuk ID', key: 'child_id' }, { header: 'Öğrenci Adı', key: 'student_name' }, { header: 'Cari Türü', key: 'cari_turu' }, { header: 'Veli', key: 'parent_name' }, { header: 'Telefon', key: 'parent_phone' }, { header: 'Kayıt Tarihi', key: 'created_at' }];
    const students = await new Promise(r => db.all(`SELECT * FROM students`, (err, rows) => r(rows || [])));
    students.forEach(s => s1.addRow({ ...s, created_at: s.created_at ? new Date(s.created_at).toLocaleDateString() : '' }));

    const s2 = workbook.addWorksheet('Giriş Çıkış Logları');
    s2.columns = [{ header: 'Log ID', key: 'log_id' }, { header: 'Tarih', key: 'tarih' }, { header: 'Öğrenci', key: 'student_name' }, { header: 'Süre (Dk)', key: 'duration_min' }, { header: 'Tutar (TL)', key: 'fee' }, { header: 'Ödeme', key: 'payment_type' }, { header: 'Personel', key: 'personel' }];
    const logs = await new Promise(r => db.all(`SELECT * FROM logs ORDER BY entry_time DESC`, (err, rows) => r(rows || [])));
    logs.forEach(l => s2.addRow({ ...l, tarih: l.entry_time ? new Date(l.entry_time).toLocaleString() : '' }));

    const s3 = workbook.addWorksheet('Hak ve Paketler');
    s3.columns = [{ header: 'Hak ID', key: 'hak_id' }, { header: 'Çocuk ID', key: 'child_id' }, { header: 'Hak Tipi', key: 'hak_tipi' }, { header: 'Kalan Dk/Adet', key: 'kalan_dk' }, { header: 'Personel', key: 'personel' }];
    const rights = await new Promise(r => db.all(`SELECT * FROM rights ORDER BY tanim_tarihi DESC`, (err, rows) => r(rows || [])));
    rights.forEach(rt => s3.addRow(rt));

    const s4 = workbook.addWorksheet('Hak Hareketleri');
    s4.columns = [{ header: 'Tarih', key: 'tarih' }, { header: 'Çocuk ID', key: 'child_id' }, { header: 'İşlem', key: 'islem' }, { header: 'Değişim', key: 'degisim_dk' }, { header: 'Açıklama', key: 'aciklama' }, { header: 'Personel', key: 'personel' }];
    const movements = await new Promise(r => db.all(`SELECT * FROM right_movements ORDER BY tarih DESC`, (err, rows) => r(rows || [])));
    movements.forEach(m => s4.addRow({ ...m, tarih: m.tarih ? new Date(m.tarih).toLocaleString() : '' }));

    
    return await workbook.xlsx.writeBuffer();
}

app.get('/api/export/excel', async (req, res) => {
    try {
        const buffer = await generateExcelBuffer();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Ureten_Cocuk_Tum_Kayitlar.xlsx');
        res.send(buffer);
    } catch(e) {
        res.status(500).send("Hata: " + e.message);
    }
});



function sendTelegramDocument(caption, filename, fileBuffer) {
    const token = appSettings.telegram_token;
    const chatId = appSettings.telegram_chat_id;
    if (!token || !chatId) return;

    const boundary = '----TelegramBotBoundary' + Date.now();
    let postDataStart = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
    );
    let postDataEnd = Buffer.from(`\r\n--${boundary}--\r\n`);

    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendDocument`,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': postDataStart.length + fileBuffer.length + postDataEnd.length
        }
    };

    const req = https.request(options, (res) => {
        res.on('data', () => {}); 
        res.on('end', () => {});
    });

    req.on('error', (e) => console.error("Telegram Belge Gönderme Hatası:", e.message));
    req.write(postDataStart);
    req.write(fileBuffer);
    req.write(postDataEnd);
    req.end();
}

async function sendDailyReport() {
    const todayStr = new Date().toISOString().split('T')[0];
    const dateFormatted = new Date().toLocaleDateString('tr-TR');
    
    db.get(`SELECT COUNT(*) as c FROM logs WHERE status = 'AÇIK'`, (err, rIn) => {
        db.all(`SELECT * FROM logs WHERE tarih = ? AND status = 'KAPALI'`, [todayStr], async (err, tLogs) => {
            let cash = 0, card = 0, free = 0;
            (tLogs || []).forEach(l => {
                if (l.payment_type === 'NAKİT') cash += l.fee;
                else if (l.payment_type === 'KREDİ KARTI') card += l.fee;
                else free++;
            });
            
            const insideCount = rIn ? rIn.c : 0;
            const exitCount = (tLogs || []).length;
            
            const message = `📋 Bugünün Özeti (${dateFormatted})\n\n` +
                            `🏃 Şu An İçeride: ${insideCount}\n` +
                            `🚪 Bugün Çıkan: ${exitCount}\n` +
                            `💵 Nakit (TL): ${cash}\n` +
                            `💳 Kart (TL): ${card}\n` +
                            `🎁 Ücretsiz / Hak: ${free}\n\n` +
                            `Günün detaylı dökümü ve tüm veritabanı yedeği Excel dosyası olarak ektedir.`;
                            
            try {
                const excelBuffer = await generateExcelBuffer();
                const filename = `Ureten_Cocuk_Rapor_${dateFormatted.replace(/\./g, '-')}.xlsx`;
                sendTelegramDocument(message, filename, excelBuffer);
            } catch(e) {
                console.error("Rapor oluşturma hatası:", e);
            }
        });
    });
}

function scheduleDailyReport() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const timeToMidnight = nextMidnight.getTime() - now.getTime();
    
    setTimeout(() => {
        sendDailyReport();
        // Bir sonraki gün için tetikleyiciyi başlat (24 saatte bir)
        setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
    }, timeToMidnight);
    
    console.log("Gün sonu raporlayıcısı başlatıldı. (Yaklaşık " + Math.round(timeToMidnight/60000) + " dakika sonra tetiklenecek)");
}


scheduleDailyReport();
app.listen(PORT, '0.0.0.0', () => console.log(`Üreten Çocuk Yerel Sunucusu Çalışıyor: http://localhost:${PORT}`));