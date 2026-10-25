// Ders saatleri Türkiye saatine göre yorumlanır. Sunucu başka bir saat diliminde
// ayarlıysa (örneğin Europe/Berlin) ders pencereleri bir saat kayar ve okuyucu yanlış
// saatte yoklama yazar. Bu yüzden süreç saat dilimi en başta sabitlenir.
// Farklı bir dilim gerekiyorsa OPERASYON_TZ ortam değişkeni verilir.
if (!process.env.OPERASYON_TZ) process.env.TZ = 'Europe/Istanbul';

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const ptp = require('pdf-to-printer');
const sheetsLib = require('./lib/sheets');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATABASE_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');
const PRINTER_NAME = process.env.PRINTER_NAME || 'KASA';
const PRINT_COPIES = process.env.PRINT_COPIES ? Number(process.env.PRINT_COPIES) : 2;
const SLIP_TMP_DIR = process.env.SLIP_TMP_DIR || __dirname;

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


// Arayüz aynı Express sunucusundan servis ediliyor (sayfalar göreli URL kullanıyor), yani CORS
// gerekmiyor. Önceden app.use(cors()) API'yi ağdaki her kaynağa açıyordu.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Terminal başında kimse olmadığı için süreç ölmüyor; ama hata sessizce yutulmuyor.
process.on('uncaughtException', (err) => {
    console.error('[HATA YAKALANDI - SUNUCU KAPANMADI]:', (err && err.stack) || err);
});

// SQLite geri çağrıları içinde fırlatılan hatalar buraya düşer; eskiden hiçbir iz kalmıyordu.
process.on('unhandledRejection', (reason) => {
    console.error('[YAKALANMAYAN PROMISE HATASI]:', (reason && reason.stack) || reason);
});

// Uygulama ayarlarının varsayılanları. Veritabanında eksik olan anahtarlar açılışta eklenir.
const SETTING_DEFAULTS = {
    base_rate: 300, hourly_rate: 500, extra_rate: 150,
    telafi_expiry_days: 30, package_expiry_days: 30, exit_tolerance_minutes: 5,
    point_tl_rate: 1,          // 1 puan kaç TL indirim eder
    oyun_alani_seans_dk: 60,   // derse gelmeyen çocuğa tanımlanan oyun alanı seansı (dakika)
    class_early_minutes: 15,   // ders yoklaması: ders başlangıcından kaç dk önce kabul edilir
    class_late_minutes: 15,    // ders yoklaması: ders bitişinden kaç dk sonra kabul edilir

    // --- Sınıf arayüzü (ikinci port) ---
    classroom_port: 3001,            // sınıf tabletinin bağlandığı port
    rfid_dedup_seconds: 5,           // aynı kart bu süre içinde tekrar okutulursa yok sayılır
    tap_prompt_seconds: 45,          // tablette "Ders / Oyun Alanı" seçimi ne kadar açık kalır

    // --- Google E-Tablo eşitlemesi ---
    sheets_enabled: 0,               // 1 ise düzenli aralıklarla eşitlenir
    sheets_sync_minutes: 5,          // eşitleme aralığı (dakika)
    sheets_tab_dersler: 'Dersler',
    sheets_tab_program: 'Program',
    sheets_tab_kayitlar: 'Kayitlar'
};
// Bunların varsayılanı veritabanına yazılmaz, sadece okunur.
const SETTING_OPTIONAL = [
    'telegram_token', 'telegram_chat_id',
    // Bunlar boş olabilir ve veritabanına yalnızca değiştirilirse yazılır.
    'sheets_url', 'sheets_api_key', 'classroom_reader_token',
    'sheets_last_sync', 'sheets_last_status'
];

let appSettings = {
    ...SETTING_DEFAULTS, telegram_token: '', telegram_chat_id: '',
    sheets_url: '', sheets_api_key: '', classroom_reader_token: '',
    sheets_last_sync: '', sheets_last_status: ''
};

const db = new sqlite3.Database(DATABASE_PATH, (err) => {
    if (err) console.error("DB Bağlantı Hatası:", err.message);
    else console.log("Yerel SQLite Veritabanı Hazır.");
});

// Bir yazma işlemi sürerken başka bir bağlantı/ifade erişirse SQLite anında SQLITE_BUSY döner.
// Kısa süre beklemek bu geçici çakışmaları hataya dönüşmeden çözer.
db.configure('busyTimeout', 5000);

// Dinleyicisi olmayan bir 'error' olayı süreç seviyesinde yakalanmamış istisnaya dönüşür.
db.on('error', (e) => console.error('[DB HATASI]:', (e && e.message) || e));

// Eksik kolonu yalnızca gerçekten yoksa ekler (eski veritabanları için güvenli migrasyon).
function addColumnIfMissing(table, column, definition, done) {
    db.all(`PRAGMA table_info(${table})`, (err, cols) => {
        if (err || !cols) { if (done) done(); return; }
        if (cols.some(c => c.name === column)) { if (done) done(); return; }
        db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (e) => {
            if (e) console.error(`Şema güncelleme uyarısı (${table}.${column}):`, e.message);
            if (done) done();
        });
    });
}

// Migrasyon adımlarını SIRAYLA işler: bir kolon eklendikten sonra sıradakine geçer, böylece
// sona bağlanan veri düzeltmesi/indeksler tüm kolonlar hazır olmadan asla çalışmaz.
function runSchemaSteps(steps, done) {
    let i = 0;
    const next = () => {
        if (i >= steps.length) { if (done) done(); return; }
        const [table, column, definition] = steps[i++];
        addColumnIfMissing(table, column, definition, next);
    };
    next();
}

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS bonus_packages (id INTEGER PRIMARY KEY AUTOINCREMENT, sales_amount REAL, bonus_amount REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS staff (pin TEXT PRIMARY KEY, name TEXT)`);

    // Şema migrasyonları ve indeksler, tablolar oluşturulduktan SONRA uygulanır (aşağıya bakınız).


    db.all('SELECT * FROM settings', (err, rows) => {
        const stored = {};
        (rows || []).forEach(r => { stored[r.key] = r.value; });

        // Bilinen tüm ayarları belleğe al; veritabanında olmayanları varsayılanıyla ekle.
        Object.keys(SETTING_DEFAULTS).forEach(key => {
            if (stored[key] !== undefined) {
                appSettings[key] = typeof SETTING_DEFAULTS[key] === 'number' ? Number(stored[key]) : stored[key];
            } else {
                db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [key, String(SETTING_DEFAULTS[key])]);
                appSettings[key] = SETTING_DEFAULTS[key];
            }
        });
        SETTING_OPTIONAL.forEach(key => {
            if (stored[key] !== undefined) appSettings[key] = stored[key];
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS students (child_id TEXT PRIMARY KEY, cari_turu TEXT, student_name TEXT NOT NULL, birth_date TEXT, parent_name TEXT, parent_phone TEXT NOT NULL, note TEXT, created_at TEXT, status TEXT DEFAULT 'Aktif', rfid_id TEXT, wallet_balance INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (log_id TEXT PRIMARY KEY, tarih TEXT, child_id TEXT, student_name TEXT, parent_name TEXT, action TEXT, entry_time TEXT, duration_min INTEGER DEFAULT 0, paketten_dusen INTEGER DEFAULT 0, personel TEXT, status TEXT, payment_status TEXT, fee REAL DEFAULT 0, payment_type TEXT, payment_date TEXT, source_summary TEXT, hak_id TEXT, is_paused INTEGER DEFAULT 0, paused_at TEXT, total_pause_duration INTEGER DEFAULT 0, kullanilan_puan INTEGER DEFAULT 0, puan_indirimi REAL DEFAULT 0, kazanilan_puan INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS rights (hak_id TEXT PRIMARY KEY, child_id TEXT, hak_tipi TEXT, miktar_dk INTEGER, kalan_dk INTEGER, kaynak TEXT, tanim_tarihi TEXT, son_kullanma TEXT, durum TEXT DEFAULT 'Aktif', satis_tutari REAL DEFAULT 0, odeme_tipi TEXT, not_alani TEXT, personel TEXT, kalan_ana_para REAL DEFAULT 0, kalan_bonus REAL DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS right_movements (hareket_id TEXT PRIMARY KEY, tarih TEXT, child_id TEXT, hak_id TEXT, islem TEXT, hak_tipi TEXT, degisim_dk INTEGER, onceki_kalan_dk INTEGER, yeni_kalan_dk INTEGER, kaynak TEXT, aciklama TEXT, log_id TEXT, personel TEXT)`);

    // --- Planlı ders (kurs) modülü ---
    // kaynak: 'MANUEL' (kasiyer açtı) veya 'SHEET' (e-tablodan geldi). Eşitleme yalnızca
    // kendi oluşturduğu satırlara dokunur; kasiyerin verisi e-tablo hatasıyla silinemez.
    db.run(`CREATE TABLE IF NOT EXISTS classes (class_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, monthly_fee REAL DEFAULT 0, term_fee REAL DEFAULT 0, status TEXT DEFAULT 'Aktif', kaynak TEXT DEFAULT 'MANUEL', sheet_key TEXT, son_gorulme TEXT, created_at TEXT)`);
    // sessions = haftalık ders saatleri (day_of_week: 1=Pazartesi ... 7=Pazar)
    db.run(`CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, class_id TEXT NOT NULL, day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, capacity INTEGER DEFAULT 0, status TEXT DEFAULT 'Aktif', kaynak TEXT DEFAULT 'MANUEL', sheet_key TEXT, son_gorulme TEXT, created_at TEXT)`);
    // class_registrations = öğrencinin bir ders saatine kaydı (AYLIK / DÖNEMLİK)
    // odeme_durumu: kasiyer tahsilat yapınca 'ODENDI' olur. Eşitlenen yeni kayıt 'BEKLIYOR'
    // olarak açılır ve eşitleme bu alanı ASLA geri almaz (ödeme durumu kaybolmasın).
    db.run(`CREATE TABLE IF NOT EXISTS class_registrations (reg_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, session_id TEXT NOT NULL, payment_type TEXT NOT NULL, fee REAL DEFAULT 0, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'Aktif', not_alani TEXT, personel TEXT, kaynak TEXT DEFAULT 'MANUEL', sheet_key TEXT, son_gorulme TEXT, odeme_durumu TEXT, sheet_not TEXT, created_at TEXT)`);
    // class_attendance = her ders için yoklama kaydı (GELDİ / GELMEDİ)
    db.run(`CREATE TABLE IF NOT EXISTS class_attendance (attendance_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, session_id TEXT NOT NULL, class_id TEXT, tarih TEXT NOT NULL, durum TEXT NOT NULL, giris_zamani TEXT, cikis_zamani TEXT, telafi_hak_id TEXT, personel TEXT, created_at TEXT)`);

    // --- E-tablo eşitleme kaydı: her eşitlemenin sonucu ve satır hataları ---
    db.run(`CREATE TABLE IF NOT EXISTS sheets_sync_log (sync_id TEXT PRIMARY KEY, tarih TEXT, kaynak TEXT, durum TEXT, ders INTEGER DEFAULT 0, seans INTEGER DEFAULT 0, kayit INTEGER DEFAULT 0, eklenen INTEGER DEFAULT 0, guncellenen INTEGER DEFAULT 0, pasif INTEGER DEFAULT 0, atlanan INTEGER DEFAULT 0, hata INTEGER DEFAULT 0, uyari INTEGER DEFAULT 0, sure_ms INTEGER DEFAULT 0, mesaj TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS sheets_sync_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_id TEXT, sekme TEXT, satir INTEGER, sutun TEXT, kod TEXT, mesaj TEXT)`);

    // --- Pasaport / görev (gamification) modülü ---
    db.run(`CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, points INTEGER DEFAULT 10, status TEXT DEFAULT 'Aktif', created_at TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS student_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, child_id TEXT NOT NULL, task_id TEXT NOT NULL, puan INTEGER DEFAULT 0, tamamlanma_tarihi TEXT, personel TEXT, note TEXT, UNIQUE (child_id, task_id))`);
    // Puan hareketleri: cüzdan bakiyesi her zaman bu defterden doğrulanabilir olmalı.
    db.run(`CREATE TABLE IF NOT EXISTS wallet_movements (hareket_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, tarih TEXT, tip TEXT NOT NULL, puan INTEGER NOT NULL, onceki_bakiye INTEGER DEFAULT 0, yeni_bakiye INTEGER DEFAULT 0, aciklama TEXT, task_id TEXT, log_id TEXT, personel TEXT)`);

    // Pasaport görevleri ilk açılışta örnek olarak tanımlanır (idempotent: sadece boşsa).
    db.get('SELECT COUNT(*) AS c FROM tasks', (err, r) => {
        if (err || !r || r.c > 0) return;
        const now = new Date().toISOString();
        [['Lego WeDo', 10], ['3D Pen', 10], ['Paper Circuits', 10]].forEach(([name, points], i) => {
            db.run(`INSERT OR IGNORE INTO tasks (task_id, name, description, points, status, created_at) VALUES (?, ?, '', ?, 'Aktif', ?)`,
                ["TSK-" + (100 + i), name, points, now]);
        });
    });

    // --- Şema migrasyonları: eski sürümlerle oluşturulmuş veritabanları için ---
    // CREATE TABLE IF NOT EXISTS mevcut bir tabloya kolon eklemez; eksik kolonlar sırayla eklenir.
    runSchemaSteps([
        ['students', 'rfid_id', 'TEXT'],
        ['logs', 'personel', 'TEXT'],
        ['logs', 'is_paused', 'INTEGER DEFAULT 0'],
        ['logs', 'paused_at', 'TEXT'],
        ['logs', 'total_pause_duration', 'INTEGER DEFAULT 0'],
        ['rights', 'personel', 'TEXT'],
        ['rights', 'kalan_ana_para', 'REAL DEFAULT 0'],
        ['rights', 'kalan_bonus', 'REAL DEFAULT 0'],
        ['right_movements', 'personel', 'TEXT'],
        // Bu sürümle gelen kolonlar
        ['students', 'wallet_balance', 'INTEGER DEFAULT 0'],
        ['logs', 'kullanilan_puan', 'INTEGER DEFAULT 0'],
        ['logs', 'puan_indirimi', 'REAL DEFAULT 0'],
        ['logs', 'kazanilan_puan', 'INTEGER DEFAULT 0'],
        // E-tablo eşitlemesi kolonları (mevcut veritabanlarında CREATE TABLE kolon eklemez)
        ['classes', 'kaynak', "TEXT DEFAULT 'MANUEL'"],
        ['classes', 'sheet_key', 'TEXT'],
        ['classes', 'son_gorulme', 'TEXT'],
        ['sessions', 'kaynak', "TEXT DEFAULT 'MANUEL'"],
        ['sessions', 'sheet_key', 'TEXT'],
        ['sessions', 'son_gorulme', 'TEXT'],
        ['class_registrations', 'kaynak', "TEXT DEFAULT 'MANUEL'"],
        ['class_registrations', 'sheet_key', 'TEXT'],
        ['class_registrations', 'son_gorulme', 'TEXT'],
        ['class_registrations', 'odeme_durumu', 'TEXT'],
        ['class_registrations', 'sheet_not', 'TEXT']
    ], () => {
        // Tüm kolonlar kesin olarak hazır olduktan sonra: veri düzeltmesi
        db.run(`UPDATE rights SET kalan_ana_para = kalan_dk, kalan_bonus = 0 WHERE (kalan_ana_para + kalan_bonus) != kalan_dk AND hak_tipi = 'PAKET'`, () => {});

        // Eski sürüm, iptal edilen çıkışları "VAZGEÇTİ Tahsilatı" olarak yazıyordu; bu metin
        // tahsilat varmış gibi okunuyor. Tutar korunur, açıklama netleştirilir.
        // (İkinci çalıştırmada LIKE artık eşleşmez, yani idempotent.)
        db.run(`UPDATE logs SET source_summary = CASE WHEN fee > 0 THEN 'İptal edildi (hesaplanan ' || printf('%g', fee) || ' TL)' ELSE 'İptal edildi' END
                WHERE payment_type = 'VAZGEÇTİ' AND (source_summary LIKE '%Tahsilatı%' OR source_summary = 'VAZGEÇTİ' OR source_summary = '')`, () => {});

        // --- Sorgu indeksleri: sıcak sorgular tam tablo taraması yapmasın ---
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_child_status ON logs (child_id, status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_status ON logs (status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_logs_tarih_status ON logs (tarih, status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_rights_child ON rights (child_id, hak_tipi, durum)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_right_movements_child ON right_movements (child_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_right_movements_log ON right_movements (log_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_right_movements_hak ON right_movements (hak_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_students_rfid ON students (rfid_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_rights_expiry ON rights (durum, son_kullanma)`);
        // --- Ders / görev indeksleri ---
        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_class ON sessions (class_id, day_of_week)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_regs_child ON class_registrations (child_id, status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_regs_session ON class_registrations (session_id, status)`);
        // Bir öğrencinin bir ders için bir günde tek yoklama kaydı olabilir: telafi iki kez verilemez.
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance ON class_attendance (child_id, session_id, tarih)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_tarih ON class_attendance (tarih, durum)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_student_tasks_child ON student_tasks (child_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_wallet_child ON wallet_movements (child_id, tarih)`);
        // --- E-tablo eşitleme indeksleri: doğal anahtar başına tek satır ---
        // Kısmi (partial) indeks: elle açılan kayıtların sheet_key'i NULL olduğu için etkilenmez.
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_classes_sheet ON classes (sheet_key) WHERE sheet_key IS NOT NULL`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_sheet ON sessions (sheet_key) WHERE sheet_key IS NOT NULL`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uq_regs_sheet ON class_registrations (sheet_key) WHERE sheet_key IS NOT NULL`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_sync_log_tarih ON sheets_sync_log (tarih)`);
    });
});

// --- Söz (promise) tabanlı veritabanı yardımcıları ---
// Çok adımlı yazma işlemlerini düz async/await koduyla yazabilmek için.
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

// Tüm yazmalar tek bir kilit üzerinden sıraya girer. Tek SQLite bağlantısı kullanıldığı için
// aksi hâlde başka bir isteğin ifadesi bir işlemin BEGIN/COMMIT arasına düşebilir ve o işlemle
// birlikte geri alınabilirdi.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
}

// Sıraya girmiş tüm yazmaların bittiğini garanti eder. Kapanış/test temizliğinde kullanılır:
// bekleyen bir yazma varken bağlantı kapatılırsa "database is locked" gibi geç hatalar çıkar.
function drainWrites() {
    return withWriteLock(() => {});
}

// Çok adımlı yazmaları tek atomik blokta çalıştırır: ya hepsi uygulanır ya hiçbiri.
// BEGIN IMMEDIATE yazma kilidini en baştan alır; böylece "bakiyeyi oku, sonra düş"
// yarışında iki eşzamanlı çıkışın aynı bakiyeyi iki kez harcaması engellenir.
async function withTransaction(fn) {
    return withWriteLock(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const result = await fn();
            await dbRun('COMMIT');
            return result;
        } catch (err) {
            try { await dbRun('ROLLBACK'); } catch (e) { /* yuvarlama hatası yutulur */ }
            throw err;
        }
    });
}

// =====================================================================================
// PLANLI DERSLER + PASAPORT: ortak yardımcılar
// =====================================================================================

// Yerel tarih (YYYY-MM-DD). Ders programı yerel saatle çalışır, bu yüzden UTC kullanılmaz:
// akşam 20:00'deki bir ders UTC'ye göre ertesi güne kayabilirdi.
function localDateStr(d = new Date()) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 1 = Pazartesi ... 7 = Pazar
function dayOfWeek(d = new Date()) {
    const wd = d.getDay();
    return wd === 0 ? 7 : wd;
}

function minutesOf(hhmm) {
    const parts = String(hhmm || '0:0').split(':');
    return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
}

const DAY_NAMES = ['', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

// Kayıt, verilen tarih aralığında geçerli mi? (tarihler YYYY-MM-DD veya ISO olabilir)
function registrationCoversDate(reg, dateStr) {
    const s = reg.start_date ? String(reg.start_date).slice(0, 10) : null;
    const e = reg.end_date ? String(reg.end_date).slice(0, 10) : null;
    if (s && dateStr < s) return false;
    if (e && dateStr > e) return false;
    return true;
}

// Öğrencinin ŞU AN (tolerans dahil) devam eden ders oturumu; yoksa null.
async function findCurrentClassSession(childId, now = new Date()) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const early = Number(appSettings.class_early_minutes || 0);
    const late = Number(appSettings.class_late_minutes || 0);
    const today = localDateStr(now);

    const rows = await dbAll(`
        SELECT s.*, c.name AS class_name, r.reg_id, r.payment_type
        FROM class_registrations r
        JOIN sessions s ON s.session_id = r.session_id
        JOIN classes c ON c.class_id = s.class_id
        WHERE r.child_id = ? AND r.status = 'Aktif' AND s.status = 'Aktif' AND s.day_of_week = ?`,
        [childId, dayOfWeek(now)]);

    return rows.filter(r => registrationCoversDate(r, today))
        .find(r => nowMin >= minutesOf(r.start_time) - early && nowMin <= minutesOf(r.end_time) + late) || null;
}

// Cüzdan defteri: bakiyeyi değiştirir ve hareket yazar. MUTLAKA bir işlem içinde çağrılmalıdır.
async function grantPoints(child_id, puan, aciklama, { task_id = null, log_id = null, personel = '' } = {}) {
    const delta = Number(puan || 0);
    if (!delta) return null;
    const stu = await dbGet(`SELECT wallet_balance FROM students WHERE child_id = ?`, [child_id]);
    if (!stu) throw new Error('Öğrenci bulunamadı.');
    const onceki = Number(stu.wallet_balance || 0);
    const yeni = onceki + delta;
    if (yeni < 0) throw new Error('Cüzdan bakiyesi yetersiz.');
    await dbRun(`UPDATE students SET wallet_balance = ? WHERE child_id = ?`, [yeni, child_id]);
    await dbRun(`INSERT INTO wallet_movements (hareket_id, child_id, tarih, tip, puan, onceki_bakiye, yeni_bakiye, aciklama, task_id, log_id, personel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["CZD-" + Date.now() + "-" + Math.floor(Math.random() * 10000), child_id, new Date().toISOString(),
            delta > 0 ? 'KAZANIM' : 'HARCAMA', delta, onceki, yeni, aciklama || '', task_id, log_id, personel || '']);
    return { onceki, yeni };
}

// Derse gelmeyen öğrenciye oyun alanı telafisi tanımlar. İşlem içinde çağrılır.
// Aynı gün için yoklama kaydı varsa null döner; telafi asla iki kez verilmez
// (veritabanındaki uq_attendance benzersiz indeksi bunun son garantisidir).
async function createCompensationRight(child_id, session, tarih) {
    const seans = Math.max(1, Number(appSettings.oyun_alani_seans_dk || 60));
    const now = new Date();
    const exp = new Date(now);
    exp.setDate(exp.getDate() + (appSettings.telafi_expiry_days || 30));
    const hakId = "HAK-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    const kaynak = 'Derse Katılmama Telafisi';

    await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, not_alani, personel) VALUES (?, ?, 'TELAFİ', ?, ?, ?, ?, ?, ?, 'Sistem')`,
        [hakId, child_id, seans, seans, kaynak, now.toISOString(), exp.toISOString().split('T')[0],
            (session.class_name || '') + ' - ' + tarih + ' dersine katılmadı']);
    await dbRun(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel) VALUES (?, ?, ?, ?, 'Tanımlama', 'TELAFİ', ?, 0, ?, ?, ?, 'Sistem')`,
        ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, hakId, seans, seans, kaynak, 'Ders telafisi (katılım yok)']);
    return { hakId, seans };
}

// Derse gelmeyen öğrenciye telafi: aynı gün için yoklama kaydı varsa null döner, yani
// telafi iki kez verilmez (uq_attendance benzersiz indeksi son garantidir).
async function grantAbsenceCompensation(child_id, session, tarih) {
    const existing = await dbGet(`SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ? AND tarih = ?`,
        [child_id, session.session_id, tarih]);
    if (existing) return null;

    const comp = await createCompensationRight(child_id, session, tarih);
    await dbRun(`INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum, telafi_hak_id, personel, created_at) VALUES (?, ?, ?, ?, ?, 'GELMEDİ', ?, 'Sistem', ?)`,
        ["YOK-" + Date.now(), child_id, session.session_id, session.class_id, tarih, comp.hakId, new Date().toISOString()]);
    return comp;
}

// Veliye giden metin: istenen cümle birebir korunur, üstüne kimin/hangi ders olduğu eklenir.
function absenceMessage(student, session, tarih) {
    return `📅 DERS KATILIM TELAFİSİ\n\n` +
        `Öğrenci: ${student.student_name}\n` +
        `Ders: ${session.class_name || ''}\n` +
        `Tarih: ${tarih}\n` +
        `Saat: ${session.start_time}-${session.end_time}\n\n` +
        `Derse katılamadığınız için hesabınıza 1 seanslık oyun alanı hakkı tanımlanmıştır.`;
}

// Gün içinde BİTMİŞ derslerde gelmeyenleri bulur, telafi tanımlar, veliye bildirir.
// Tekrar çalıştırılması güvenlidir: yoklama kaydı olan öğrenci atlanır.
// tarihOverride verilirse o günün tamamı işlenir (bilgisayar kapalı kaldıysa telafi kaçmasın).
async function processClassAbsences(now = new Date(), tarihOverride = null) {
    const today = tarihOverride || localDateStr(now);
    const target = tarihOverride ? new Date(tarihOverride + 'T12:00:00') : now;
    const nowMin = tarihOverride ? 24 * 60 : now.getHours() * 60 + now.getMinutes();
    const out = { tarih: today, kontrol_edilen: 0, telafi_verilen: 0, bildirim: 0, detay: [] };

    const sessions = await dbAll(`SELECT s.*, c.name AS class_name FROM sessions s JOIN classes c ON c.class_id = s.class_id WHERE s.status = 'Aktif' AND s.day_of_week = ?`, [dayOfWeek(target)]);
    for (const s of sessions) {
        if (minutesOf(s.end_time) > nowMin) continue; // ders henüz bitmedi, karar verme
        const regs = await dbAll(`SELECT r.*, st.student_name, st.parent_name, st.parent_phone FROM class_registrations r JOIN students st ON st.child_id = r.child_id WHERE r.session_id = ? AND r.status = 'Aktif'`, [s.session_id]);
        for (const r of regs) {
            if (!registrationCoversDate(r, today)) continue;
            out.kontrol_edilen++;
            let granted = null;
            try {
                granted = await withTransaction(() => grantAbsenceCompensation(r.child_id, s, today));
            } catch (e) {
                continue; // benzersiz indeks ihlali: bu yoklama zaten işlenmiş
            }
            if (!granted) continue;
            out.telafi_verilen++;
            out.detay.push({ child_id: r.child_id, student_name: r.student_name, class_name: s.class_name, hak_id: granted.hakId, seans_dk: granted.seans });
            sendTelegramNotification(absenceMessage(r, s, today));
            out.bildirim++;
        }
    }
    return out;
}

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
        const tempHtmlPath = path.join(SLIP_TMP_DIR, `temp_slip_${Date.now()}.html`);
        await fs.promises.writeFile(tempHtmlPath, htmlContent, 'utf8');
        
        const options = {
            printer: PRINTER_NAME,
            copies: PRINT_COPIES
        };

        await ptp.print(tempHtmlPath, options);
        const cleanup = setTimeout(() => { if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath); }, 3000);
        // a housekeeping timer must never keep the process (or a test runner) alive
        if (typeof cleanup.unref === 'function') cleanup.unref();
    } catch (err) {
        console.error("Sunucu Yazdırma Hatası:", err.message);
    }
}

// Bu tarayıcı neredeyse her okuma isteğinde çalışıyor (içeride.html de sürekli yokluyor).
// Önce tek indeksli sorguyla "yapılacak iş var mı?" diye bakıyoruz; yoksa hiç yazmıyoruz.
//  - 'İşleniyor': yarıda kalmış bir dönüşümü bir sonraki çalıştırmada toparlamak için.
//  - süresi geçmiş 'Aktif' kayıtlar: hak_tipi filtresi YOK, çünkü aşağıdaki son UPDATE
//    paketleri de süresi doldu olarak işaretliyor; filtre koymak davranışı değiştirirdi.
async function runExpiredRightsSweep() {
    const today = new Date().toISOString().split('T')[0];

    const guard = await dbGet(`SELECT
            (SELECT COUNT(*) FROM rights WHERE durum = 'İşleniyor') AS stuck,
            (SELECT COUNT(*) FROM rights WHERE durum = 'Aktif' AND son_kullanma IS NOT NULL AND son_kullanma < ?) AS expired`,
        [today]);
    if (!guard || (Number(guard.stuck) === 0 && Number(guard.expired) === 0)) return;

    await dbRun(`UPDATE rights SET durum = 'İşleniyor' WHERE durum = 'Aktif' AND hak_tipi = 'TELAFİ' AND son_kullanma < ?`, [today]);

    const rows = await dbAll(`SELECT child_id, SUM(kalan_dk) as total_dk FROM rights WHERE durum = 'İşleniyor' GROUP BY child_id`, []);
    for (const row of rows) {
        const newLessons = Math.floor(row.total_dk / 60);
        for (let i = 0; i < newLessons; i++) {
            await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'TELAFİ DERSİ', 1, 1, 'Süresi Dolan Oyun Alanı Telafisi Dönüşümü', ?, 'Sistem')`,
                ["DERS-" + Date.now() + "-" + Math.floor(Math.random() * 10000), row.child_id, new Date().toISOString()]);
        }
    }

    await dbRun(`UPDATE rights SET kalan_dk = 0, durum = 'Süresi Doldu (Dönüştü)' WHERE durum = 'İşleniyor'`, []);
    await dbRun(`UPDATE rights SET durum = 'Süresi Doldu' WHERE durum = 'Aktif' AND son_kullanma < ?`, [today]);
}

// Aynı anda birden fazla istek gelirse hepsi sürmekte olan taramanın bitmesini bekler
// (eskiden ikinci istek hemen cevap alıp eski bakiyeyi okuyabiliyordu).
let sweepPromise = null;
function updateExpiredRights(callback) {
    if (!sweepPromise) {
        sweepPromise = withWriteLock(runExpiredRightsSweep)
            .catch(err => console.error('[SÜRE TARAYICI HATASI]:', (err && err.stack) || err))
            .finally(() => { sweepPromise = null; });
    }
    // Aynı anda birden fazla istek gelirse hepsi sürmekte olan taramanın bitmesini bekler
    // (eskiden ikinci istek hemen cevap alıp eski bakiyeyi okuyabiliyordu).
    // sweepPromise asla reddetmez; geri çağırma hata fırlatsa bile burada yakalanır ki
    // süreç seviyesine "yakalanmayan promise hatası" kaçmasın.
    if (callback) {
        sweepPromise.then(() => {
            try { callback(); } catch (e) { console.error('[TARAMA SONRASI HATA]:', (e && e.stack) || e); }
        });
    }
    return sweepPromise;
}

function calculateFee(minute) {
    minute = Number(minute || 0);
    if (minute <= 0) return 0;
    
    let tol = Number(appSettings.exit_tolerance_minutes || 0);
    
    // Eğer içeride kalınan toplam süre, tolerans süresinden küçük veya eşitse ücret sıfırdır.
    if (minute <= tol) return 0;
    
    // Tolerans aşıldıysa, hesaplamaya tolerans süresi düşülerek başlanır.
    let effectiveMinute = minute - tol;

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
    // Tek satır olsa da kilitten geçmeli: aksi hâlde başka bir işlemin BEGIN/COMMIT arasına düşer.
    withWriteLock(() => dbRun(`INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)`, [req.body.sales, req.body.bonus]))
        .then(() => res.json({ success: true }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/bonus-packages/delete', (req, res) => {
    withWriteLock(() => dbRun(`DELETE FROM bonus_packages WHERE id = ?`, [req.body.id]))
        .then(() => res.json({ success: true }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.get('/api/staff', (req, res) => {
    db.all(`SELECT pin, name FROM staff`, (err, rows) => {
        res.json({ success: true, staff: rows || [] });
    });
});

app.post('/api/staff/add', (req, res) => {
    const { pin, name } = req.body;
    if (!pin || pin.length !== 4 || !name) return res.json({ success: false, message: "Geçerli isim ve 4 haneli PIN girin." });
    withWriteLock(() => dbRun(`INSERT OR REPLACE INTO staff (pin, name) VALUES (?, ?)`, [pin, name]))
        .then(() => res.json({ success: true, message: "Personel başarıyla kaydedildi." }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/staff/delete', (req, res) => {
    withWriteLock(() => dbRun(`DELETE FROM staff WHERE pin = ?`, [req.body.pin]))
        .then(() => res.json({ success: true }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/staff/verify', (req, res) => {
    db.get(`SELECT name FROM staff WHERE pin = ?`, [req.body.pin], (err, row) => {
        if (row) res.json({ success: true, name: row.name });
        else res.json({ success: false, message: "Hatalı veya yetkisiz PIN!" });
    });
});

app.get('/api/settings', (req, res) => res.json({ success: true, settings: appSettings }));

app.post('/api/settings/update', (req, res) => {
    // Tüm ayarları tek tek elle yazmak yerine varsayılan listesi üzerinden dolaşılır;
    // böylece yeni bir ayar eklendiğinde buranın güncellenmesi gerekmez.
    const body = req.body || {};
    const rows = [];
    Object.keys(SETTING_DEFAULTS).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            appSettings[key] = typeof SETTING_DEFAULTS[key] === 'number' ? Number(body[key]) : body[key];
            rows.push([key, body[key]]);
        }
    });
    SETTING_OPTIONAL.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            appSettings[key] = body[key] || '';
            rows.push([key, appSettings[key]]);
        }
    });

    if (rows.length === 0) return res.json({ success: true, message: "Ayarlar güncellendi." });

    withTransaction(async () => {
        for (const [key, value] of rows) {
            await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
        }
    }).then(() => res.json({ success: true, message: "Ayarlar güncellendi." }))
      .catch(err => res.json({ success: false, message: "Ayarlar kaydedilemedi: " + err.message }));
});

app.post('/api/students/delete', (req, res) => {
    const { child_id } = req.body;
    if (!child_id) return res.json({ success: false, message: "Geçersiz öğrenci ID." });

    // Dördü birlikte: yarıda kalan bir silme, öğrencisi olmayan başıboş log/hak kayıtları bırakırdı.
    withTransaction(async () => {
        await dbRun(`DELETE FROM students WHERE child_id = ?`, [child_id]);
        await dbRun(`DELETE FROM rights WHERE child_id = ?`, [child_id]);
        await dbRun(`DELETE FROM right_movements WHERE child_id = ?`, [child_id]);
        await dbRun(`DELETE FROM logs WHERE child_id = ?`, [child_id]);
    }).then(() => res.json({ success: true, message: "Öğrenci ve ilgili tüm kayıtlar kalıcı olarak silindi." }))
      .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/students/edit', async (req, res) => {
    const { child_id, student_name, parent_name, parent_phone, birth_date, rfid_id, note, cari_turu, telafi_minutes, package_minutes, telafi_dersi_count } = req.body;
    try {
        await withTransaction(async () => {
            await dbRun(
                `UPDATE students SET student_name=?, parent_name=?, parent_phone=?, birth_date=?, rfid_id=?, note=?, cari_turu=? WHERE child_id=?`,
                [student_name, parent_name, parent_phone, birth_date, rfid_id, note, cari_turu, child_id]);

            const now = new Date();
            const newTelafiMins = Math.max(0, Number(telafi_minutes || 0));
            const newPackageMinutes = Math.max(0, Number(package_minutes || 0));
            const newTelafiDersiCount = Math.max(0, Number(telafi_dersi_count || 0));

            // --- TELAFİ dakikaları: varsa güncelle, yoksa tanımla ---
            const telafis = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ' AND durum = 'Aktif'`, [child_id]);
            if (telafis.length > 0) {
                await dbRun(`UPDATE rights SET kalan_dk = ?, miktar_dk = ? WHERE hak_id = ?`, [newTelafiMins, newTelafiMins, telafis[0].hak_id]);
                for (let i = 1; i < telafis.length; i++) {
                    await dbRun(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [telafis[i].hak_id]);
                }
            } else if (newTelafiMins > 0) {
                const expDate = new Date();
                expDate.setDate(expDate.getDate() + appSettings.telafi_expiry_days);
                await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, personel) VALUES (?, ?, 'TELAFİ', ?, ?, 'Dramatik Oyun Alanı Telafisi', ?, ?, 'Sistem')`,
                    ["HAK-EDT-" + Date.now(), child_id, newTelafiMins, newTelafiMins, now.toISOString(), expDate.toISOString().split('T')[0]]);
            }

            // --- PAKET bakiyesi ---
            const packages = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET' AND durum = 'Aktif'`, [child_id]);
            if (packages.length > 0) {
                await dbRun(`UPDATE rights SET kalan_dk = ?, miktar_dk = ?, kalan_ana_para = ?, kalan_bonus = 0 WHERE hak_id = ?`,
                    [newPackageMinutes, newPackageMinutes, newPackageMinutes, packages[0].hak_id]);
                for (let i = 1; i < packages.length; i++) {
                    await dbRun(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [packages[i].hak_id]);
                }
            } else if (newPackageMinutes > 0) {
                await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para, kalan_bonus, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'PAKET', ?, ?, ?, 0, 'Yönetici Düzenlemesi', ?, 'Sistem')`,
                    ["PAK-EDT-" + Date.now(), child_id, newPackageMinutes, newPackageMinutes, newPackageMinutes, now.toISOString()]);
            }

            // --- TELAFİ DERSİ adedi ---
            const dersler = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ' AND durum = 'Aktif'`, [child_id]);
            const currentCount = dersler.length;
            if (newTelafiDersiCount < currentCount) {
                for (const r of dersler.slice(0, currentCount - newTelafiDersiCount)) {
                    await dbRun(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [r.hak_id]);
                }
            } else if (newTelafiDersiCount > currentCount) {
                for (let i = 0; i < (newTelafiDersiCount - currentCount); i++) {
                    await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, personel) VALUES (?, ?, 'TELAFİ DERSİ', 1, 1, 'Yönetici Düzenlemesi', ?, 'Sistem')`,
                        ["DERS-EDT-" + Date.now() + i, child_id, now.toISOString()]);
                }
            }
        });
        res.json({ success: true, message: "Öğrenci bilgileri ve hakları güncellendi." });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.get('/api/students', (req, res) => {
    db.all(`SELECT * FROM students ORDER BY created_at DESC`, (err, rows) => {
        res.json({ success: true, students: (rows || []).map(r => ({ ...r, age: calculateAge(r.birth_date), created_at_fmt: r.created_at ? new Date(r.created_at).toLocaleDateString('tr-TR') : '-' })) });
    });
});

app.get('/api/students/search', (req, res) => {
    const q = String(req.query.q || "").toLowerCase().trim();
    db.all(`SELECT * FROM students WHERE LOWER(student_name) LIKE ? OR LOWER(parent_name) LIKE ? OR parent_phone LIKE ? OR LOWER(rfid_id) = ? ORDER BY created_at DESC LIMIT 20`, 
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

app.post('/api/students/create', async (req, res) => {
    const { cari_turu, student_name, birth_date, parent_name, parent_phone, note, start_entry, rfid_id, personel } = req.body;
    try {
        // Sıra numarası okunup kayıt yazılana kadar geçen süre kilitli: aksi hâlde iki eşzamanlı
        // kayıt aynı UC- numarasını alabilirdi.
        const created = await withTransaction(async () => {
            const row = await dbGet(`SELECT CAST(REPLACE(child_id, 'UC-', '') AS INTEGER) as num FROM students ORDER BY num DESC LIMIT 1`);
            const nextNum = (row && row.num) ? row.num + 1 : 1;
            const childId = "UC-" + String(nextNum).padStart(6, '0');
            const now = new Date().toISOString();

            await dbRun(
                `INSERT INTO students (child_id, cari_turu, student_name, birth_date, parent_name, parent_phone, note, created_at, status, rfid_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Aktif', ?)`,
                [childId, cari_turu || 'Dramatik Oyun Alanı', student_name, birth_date, parent_name, parent_phone, note, now, rfid_id]);

            if (start_entry) {
                await dbRun(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time, status, personel) VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, 'AÇIK', ?)`,
                    ["LOG-" + Date.now(), now.split('T')[0], childId, student_name, parent_name, now, personel || 'Sistem']);
            }
            return { childId, start_entry };
        });

        if (created.start_entry) {
            await sendServerPrint(`
                <h3>ÜRETEN ÇOCUK</h3>
                <p style="text-align:center;">Giriş İşlemi</p>
                <hr style="border:1px dashed #000;">
                <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
                <p><b>Öğrenci:</b> ${student_name} (${created.childId})</p>
                <p><b>Veli Tel:</b> ${parent_phone}</p>
                <p><b>Personel:</b> ${personel || 'Sistem'}</p>
            `);
        }
        res.json({ success: true, child_id: created.childId, student_name: student_name, message: "Öğrenci kaydedildi." });
    } catch (err) {
        res.json({ success: false, message: "Kayıt hatası: " + err.message });
    }
});

app.post('/api/rfid/scan', async (req, res) => {
    const rfid = req.body && req.body.rfid_id;
    try {
        const student = await dbGet(`SELECT * FROM students WHERE rfid_id = ?`, [rfid]);
        if (!student || !student.rfid_id) return res.json({ success: false, message: "Bu karta tanımlı öğrenci bulunamadı." });

        // 1) Şu an devam eden bir ders oturumu varsa: yoklama alınır, oyun alanı hakkı DÜŞÜLMEZ.
        const now = new Date();
        const session = await findCurrentClassSession(student.child_id, now);
        if (session) {
            const marked = await withTransaction(async () => {
                const today = localDateStr(now);
                const existing = await dbGet(`SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ? AND tarih = ?`,
                    [student.child_id, session.session_id, today]);
                if (existing) {
                    if (existing.durum === 'GELDİ' && !existing.cikis_zamani) {
                        await dbRun(`UPDATE class_attendance SET cikis_zamani = ? WHERE attendance_id = ?`, [now.toISOString(), existing.attendance_id]);
                        return 'DERS_CIKIS';
                    }
                    return 'DERS_ZATEN';
                }
                await dbRun(`INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum, giris_zamani, personel, created_at) VALUES (?, ?, ?, ?, ?, 'GELDİ', ?, 'Kart', ?)`,
                    ["YOK-" + Date.now(), student.child_id, session.session_id, session.class_id, today, now.toISOString(), now.toISOString()]);
                return 'DERS_GIRIS';
            });
            return res.json({
                success: true, mode: 'DERS', action: marked,
                child_id: student.child_id, student_name: student.student_name,
                session_id: session.session_id, class_name: session.class_name,
                start_time: session.start_time, end_time: session.end_time
            });
        }

        // 2) Ders yok (boş zaman / hafta sonu): mevcut oyun alanı akışı.
        const activeLog = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [student.child_id]);
        res.json({ success: true, action: activeLog ? 'EXIT' : 'ENTRY', child_id: student.child_id });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.get('/api/inside', (req, res) => {
    updateExpiredRights(() => {
        // Önceden her içerideki çocuk için ayrı bir telefon ve hak sorgusu atılıyordu
        // (1 + 2 x N sorgu, her yoklamada). Artık çocuk sayısından bağımsız 2 sorgu.
        db.all(`SELECT l.*, s.parent_phone AS student_phone
                FROM logs l LEFT JOIN students s ON s.child_id = l.child_id
                WHERE l.status = 'AÇIK'`, [], (err, rows) => {
            if (err) return res.json({ success: false, message: err.message });
            if (!rows || rows.length === 0) return res.json({ success: true, children: [] });

            const ids = rows.map(r => r.child_id);
            const placeholders = ids.map(() => '?').join(', ');
            db.all(`SELECT child_id,
                           SUM(CASE WHEN hak_tipi = 'TELAFİ' AND durum = 'Aktif' AND kalan_dk > 0 THEN kalan_dk ELSE 0 END) AS telafi_minutes,
                           SUM(CASE WHEN hak_tipi = 'PAKET'  AND durum = 'Aktif' AND kalan_dk > 0 THEN kalan_dk ELSE 0 END) AS package_minutes
                    FROM rights WHERE child_id IN (${placeholders}) GROUP BY child_id`, ids, (err2, sums) => {
                const byChild = {};
                (sums || []).forEach(s => { byChild[s.child_id] = s; });

                const now = new Date();
                const children = rows.map(r => {
                    const entryDate = new Date(r.entry_time);
                    let currentPauseDk = 0;
                    if (r.is_paused === 1 && r.paused_at) {
                        currentPauseDk = Math.floor((now - new Date(r.paused_at)) / 60000);
                    }
                    const totalPause = (r.total_pause_duration || 0) + currentPauseDk;
                    const sureDk = Math.max(0, Math.floor((now - entryDate) / 60000) - totalPause);
                    const rights = byChild[r.child_id] || {};
                    return {
                        child_id: r.child_id, student_name: r.student_name, parent_name: r.parent_name,
                        parent_phone: r.student_phone || '',
                        entry_time_fmt: entryDate.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
                        entry_timestamp: entryDate.getTime(), sure_dk: sureDk, estimated_fee: calculateFee(sureDk),
                        telafi_minutes: rights.telafi_minutes || 0, package_minutes: rights.package_minutes || 0,
                        warning: sureDk >= 60, alarm: sureDk >= 120, is_paused: r.is_paused === 1
                    };
                });
                res.json({ success: true, children: children.sort((a, b) => b.sure_dk - a.sure_dk) });
            });
        });
    });
});

app.post('/api/entry/pause-toggle', async (req, res) => {
    const { child_id } = req.body;
    try {
        const log = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id]);
        if (!log) return res.json({ success: false, message: "Kayıt bulunamadı." });

        const now = new Date();
        if (log.is_paused === 1) {
            const pausedDk = log.paused_at ? Math.floor((now - new Date(log.paused_at)) / 60000) : 0;
            await dbRun(`UPDATE logs SET is_paused = 0, paused_at = NULL, total_pause_duration = ? WHERE log_id = ?`,
                [(log.total_pause_duration || 0) + pausedDk, log.log_id]);
            res.json({ success: true, message: "Devam ediliyor." });
        } else {
            await dbRun(`UPDATE logs SET is_paused = 1, paused_at = ? WHERE log_id = ?`, [now.toISOString(), log.log_id]);
            res.json({ success: true, message: "Duraklatıldı." });
        }
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.post('/api/entry/start', async (req, res) => {
    const { child_id, personel } = req.body;
    try {
        const activeLog = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id]);
        if (activeLog) return res.json({ success: false, message: "Çocuk zaten içeride." });

        const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [child_id]);
        if (!student) return res.json({ success: false, message: "Öğrenci bulunamadı." });

        const now = new Date().toISOString();
        await dbRun(`INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time, status, personel) VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, 'AÇIK', ?)`,
            ["LOG-" + Date.now(), now.split('T')[0], student.child_id, student.student_name, student.parent_name, now, personel || '']);

        await sendServerPrint(`
            <h3>ÜRETEN ÇOCUK</h3>
            <p style="text-align:center;">Giriş İşlemi</p>
            <hr style="border:1px dashed #000;">
            <p><b>Tarih:</b> ${new Date().toLocaleString('tr-TR')}</p>
            <p><b>Öğrenci:</b> ${student.student_name} (${student.child_id})</p>
            <p><b>Veli Tel:</b> ${student.parent_phone}</p>
            <p><b>Personel:</b> ${personel || 'Sistem'}</p>
        `);
        res.json({ success: true, message: "Giriş işlemi başlatıldı." });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
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

app.post('/api/exit/finalize', async (req, res) => {
    const { child_id, payment_type, personel, kullanilan_puan, kazanilan_puan } = req.body;
    const now = new Date();
    let outcome;

    try {
        outcome = await withTransaction(async () => {
            const log = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [child_id]);
            if (!log) throw new Error("Aktif giriş bulunamadı.");

            let currentPauseDk = 0;
            if (log.is_paused === 1 && log.paused_at) {
                currentPauseDk = Math.floor((now - new Date(log.paused_at)) / 60000);
            }
            const totalPause = (log.total_pause_duration || 0) + currentPauseDk;
            const sureDk = Math.max(1, Math.ceil((now - new Date(log.entry_time)) / 60000) - totalPause);
            let fee = calculateFee(sureDk);
            let pakettenDusen = 0;
            let sourceSummary = "";

            if (payment_type === 'HAK') {
                const rights = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0 AND hak_tipi = 'TELAFİ' ORDER BY tanim_tarihi ASC`, [child_id]);
                let totalAvailable = 0;
                rights.forEach(r => { totalAvailable += r.kalan_dk; });
                if (totalAvailable < sureDk) throw new Error("Yeterli telafi bakiyesi (dakika) yok.");

                let remainingDuration = sureDk;
                for (const r of rights) {
                    if (remainingDuration <= 0) continue;
                    const avail = Number(r.kalan_dk || 0);
                    const used = Math.min(avail, remainingDuration);
                    remainingDuration -= used;
                    pakettenDusen += used;
                    const newRem = avail - used;
                    await dbRun(`UPDATE rights SET kalan_dk = ?, durum = ? WHERE hak_id = ?`, [newRem, newRem > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
                    await dbRun(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel) VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'TELAFİ', ?, ?, ?, 'Sistem', 'Çıkış işlemi', ?, ?)`,
                        ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, r.hak_id, -used, avail, newRem, log.log_id, personel || '']);
                }
                fee = 0;
                sourceSummary = pakettenDusen + ' Dk Telafi';
            } else if (payment_type === 'PAKET') {
                const rights = await dbAll(`SELECT * FROM rights WHERE child_id = ? AND durum = 'Aktif' AND kalan_dk > 0 AND hak_tipi = 'PAKET' ORDER BY tanim_tarihi ASC`, [child_id]);
                let totalAvailableTL = 0;
                rights.forEach(r => { totalAvailableTL += r.kalan_dk; });
                if (totalAvailableTL < fee) throw new Error("Yeterli paket bakiyesi (TL) yok.");

                let remainingFee = fee;
                for (const r of rights) {
                    if (remainingFee <= 0) continue;
                    const avail = Number(r.kalan_dk || 0);
                    const used = Math.min(avail, remainingFee);
                    remainingFee -= used;
                    pakettenDusen += used;

                    // Önce ana para, sonra bonus harcanır.
                    let yAna = Number(r.kalan_ana_para || 0);
                    let yBon = Number(r.kalan_bonus || 0);
                    let left = used;
                    if (yAna >= left) { yAna -= left; left = 0; } else { left -= yAna; yAna = 0; }
                    if (left > 0) { yBon -= left; }

                    const newRem = yAna + yBon;
                    await dbRun(`UPDATE rights SET kalan_dk = ?, kalan_ana_para = ?, kalan_bonus = ?, durum = ? WHERE hak_id = ?`,
                        [newRem, yAna, yBon, newRem > 0 ? 'Aktif' : 'Tükendi', r.hak_id]);
                    await dbRun(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, log_id, personel) VALUES (?, ?, ?, ?, 'Kullanım (Çıkış)', 'PAKET', ?, ?, ?, 'Sistem', 'Çıkış işlemi', ?, ?)`,
                        ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, r.hak_id, -used, avail, newRem, log.log_id, personel || '']);
                }
                fee = 0;
                sourceSummary = pakettenDusen + ' TL Paket';
            } else if (payment_type === IPTAL_TIPI) {
                // İptal edilen ziyaret: TAHSİLAT YOKTUR, ama hesaplanan tutar silinmez.
                // Raporlar iptali payment_type üzerinden dışlar; tutar "İptal Edilen Tutar"
                // olarak görünür ki hangi işlemin ne kadarlık tahsilattan vazgeçildiği bilinsin.
                sourceSummary = 'İptal edildi (hesaplanan ' + (Math.round(fee * 100) / 100) + ' TL)';
            } else {
                if (payment_type === 'ÜCRETSİZ') fee = 0;
                sourceSummary = payment_type === 'ÜCRETSİZ' ? 'ÜCRETSİZ' : (payment_type + ' Tahsilatı');
            }

            // --- Cüzdan puanları: indirim ve/veya kazanım, hepsi aynı işlemde ---
            const rate = Number(appSettings.point_tl_rate || 1);
            let kullanilanPuan = 0;
            let puanIndirimi = 0;
            const istenenPuan = Math.max(0, Math.floor(Number(kullanilan_puan || 0)));
            // İptal edilen ziyarette puan harcanmaz: tahsilat yoksa indirim de olmaz.
            if (istenenPuan > 0 && fee > 0 && rate > 0 && payment_type !== IPTAL_TIPI) {
                const bakiyeSatir = await dbGet(`SELECT wallet_balance FROM students WHERE child_id = ?`, [child_id]);
                const bakiye = Number((bakiyeSatir || {}).wallet_balance || 0);
                // Ne bakiyeden ne de faturadan fazlası harcanabilir.
                kullanilanPuan = Math.min(istenenPuan, Math.max(0, bakiye), Math.floor(fee / rate));
                if (kullanilanPuan > 0) {
                    puanIndirimi = Math.round(kullanilanPuan * rate * 100) / 100;
                    await grantPoints(child_id, -kullanilanPuan, 'Çıkışta puan indirimi', { log_id: log.log_id, personel });
                    fee = Math.round((fee - puanIndirimi) * 100) / 100;
                    sourceSummary = sourceSummary + ' (-' + puanIndirimi + ' TL puan)';
                }
            }
            const kazanilanPuan = Math.max(0, Math.floor(Number(kazanilan_puan || 0)));
            if (kazanilanPuan > 0) {
                await grantPoints(child_id, kazanilanPuan, 'Çıkışta puan kazanımı', { log_id: log.log_id, personel });
            }
            const cuzdanSatir = await dbGet(`SELECT wallet_balance FROM students WHERE child_id = ?`, [child_id]);

            await dbRun(`UPDATE logs SET duration_min = ?, fee = ?, payment_type = ?, payment_date = ?, status = 'KAPALI', paketten_dusen = ?, source_summary = ?, personel = ?, kullanilan_puan = ?, puan_indirimi = ?, kazanilan_puan = ? WHERE log_id = ?`,
                [sureDk, fee, payment_type, now.toISOString(), pakettenDusen, sourceSummary, personel || '', kullanilanPuan, puanIndirimi, kazanilanPuan, log.log_id]);

            return {
                student_name: log.student_name, child_id: log.child_id, sure_dk: sureDk, fee, payment_type,
                kullanilanPuan, puanIndirimi, kazanilanPuan, cuzdan: Number((cuzdanSatir || {}).wallet_balance || 0)
            };
        });
    } catch (err) {
        return res.json({ success: false, message: err.message });
    }

    // Fiş, işlem KESİNLEŞTİKTEN sonra yazdırılır: yazıcı sorunu çıkışı geri almaz.
    const sureTutar = outcome.payment_type === 'HAK' ? `${outcome.sure_dk} Dk / 0 TL`
        : outcome.payment_type === 'PAKET' ? `${outcome.sure_dk} Dk / 0 TL (Paketten Karşılandı)`
        : outcome.payment_type === IPTAL_TIPI ? `${outcome.sure_dk} Dk / 0 TL (İptal Edildi)`
        : `${outcome.sure_dk} Dk / ${outcome.fee} TL`;
    const odemeTipi = outcome.payment_type === 'HAK' ? 'HAK (Telafi)'
        : outcome.payment_type === IPTAL_TIPI ? 'İPTAL' : outcome.payment_type;
    await sendServerPrint(`
        <h3>ÜRETEN ÇOCUK</h3>
        <p style="text-align:center;">Çıkış İşlemi</p>
        <hr style="border:1px dashed #000;">
        <p><b>Tarih:</b> ${now.toLocaleString('tr-TR')}</p>
        <p><b>Öğrenci:</b> ${outcome.student_name} (${outcome.child_id})</p>
        <p><b>Süre / Tutar:</b> ${sureTutar}</p>
        <p><b>Ödeme Tipi:</b> ${odemeTipi}</p>
        <p><b>Personel:</b> ${personel || 'Sistem'}</p>
        <hr style="border:1px dashed #000;">
        ${outcome.kullanilanPuan > 0 ? `<p><b>Kullanılan Puan:</b> ${outcome.kullanilanPuan} (-${outcome.puanIndirimi} TL)</p>` : ''}
        <p><b>Kazanılan Puan:</b> ${outcome.kazanilanPuan}</p>
        <p><b>Mevcut Cüzdan Bakiyesi:</b> ${outcome.cuzdan} puan</p>
    `);
    res.json({ success: true, message: "Çıkış başarılı." });
});

app.post('/api/print/status', async (req, res) => {
    const { student_name, child_id, parent_phone, entry_time_fmt, sure_dk, estimated_fee } = req.body;
    const cuzdanSatir = child_id ? await dbGet(`SELECT wallet_balance FROM students WHERE child_id = ?`, [child_id]) : null;
    const cuzdanBakiye = Number((cuzdanSatir || {}).wallet_balance || 0);
    await sendServerPrint(`
        <h3>ÜRETEN ÇOCUK</h3>
        <p style="text-align:center;">Anlık Durum Fişi</p>
        <hr style="border:1px dashed #000;">
        <p><b>Öğrenci:</b> ${student_name} (${child_id})</p>
        <p><b>Veli Tel:</b> ${parent_phone}</p>
        <p><b>Giriş Saati:</b> ${entry_time_fmt}</p>
        <p><b>İçerideki Süre:</b> ${sure_dk} dakika</p>
        <p><b>Güncel Tutar:</b> <b>${estimated_fee} TL</b></p>
        <hr style="border:1px dashed #000;">
        <p><b>Mevcut Cüzdan Bakiyesi:</b> ${cuzdanBakiye} puan</p>
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

app.post('/api/rights/add-telafi', async (req, res) => {
    const { child_id, minutes, source, note, personel } = req.body;
    const mins = Math.max(1, Number(minutes || 60));
    const kaynakText = source || 'Dramatik Oyun Alanı Telafisi';
    const now = new Date();
    const expDate = new Date(now);
    expDate.setDate(expDate.getDate() + (appSettings.telafi_expiry_days || 30));
    const expiry_str = expDate.toISOString().split('T')[0];
    const hakId = "HAK-" + Date.now();

    try {
        await withTransaction(async () => {
            await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, not_alani, personel) VALUES (?, ?, 'TELAFİ', ?, ?, ?, ?, ?, ?, ?)`,
                [hakId, child_id, mins, mins, kaynakText, now.toISOString(), expiry_str, note || '', personel || '']);
            await dbRun(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel) VALUES (?, ?, ?, ?, 'Tanımlama', 'TELAFİ', ?, 0, ?, ?, ?, ?)`,
                ["MOV-" + Date.now() + Math.random(), now.toISOString(), child_id, hakId, mins, mins, kaynakText, 'Telafi Dakikası Eklendi', personel || '']);
        });
        res.json({ success: true, message: `${mins} Dakika telafi hakkı eklendi. Kaynak: ${kaynakText}. SKT: ${expiry_str}` });
    } catch (err) {
        res.json({ success: false, message: "Telafi kaydedilemedi: " + err.message });
    }
});

app.post('/api/rights/add-package', async (req, res) => {
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

    try {
        await withTransaction(async () => {
            await dbRun(`INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para, kalan_bonus, kaynak, tanim_tarihi, son_kullanma, satis_tutari, odeme_tipi, not_alani, personel) VALUES (?, ?, 'PAKET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [hakId, child_id, totalTL, totalTL, anaPara, bonusPara, source || 'Satış', nowStr, expiry_str, anaPara, payment_type || 'NAKİT', note || '', personel || '']);
            await dbRun(`INSERT INTO right_movements (hareket_id, tarih, child_id, hak_id, islem, hak_tipi, degisim_dk, onceki_kalan_dk, yeni_kalan_dk, kaynak, aciklama, personel) VALUES (?, ?, ?, ?, 'Tanımlama', 'PAKET', ?, 0, ?, ?, ?, ?)`,
                ["MOV-" + Date.now() + Math.random(), nowStr, child_id, hakId, totalTL, totalTL, source || 'Satış', 'Paket Satışı', personel || '']);
        });

        // Bildirim, kayıt kesinleştikten sonra: satış yazılamadıysa Telegram'a da düşmemeli.
        const row = await dbGet(`SELECT student_name FROM students WHERE child_id = ?`, [child_id]);
        const stuName = row ? row.student_name : child_id;
        sendTelegramNotification(`📦 YENİ PAKET SATIŞI\n\nÖğrenci: ${stuName}\nSatış Tutarı: ${anaPara} TL\nBonus Tutarı: ${bonusPara} TL\nToplam Bakiye: ${totalTL} TL\nÖdeme Tipi: ${payment_type}\nPersonel: ${personel || 'Sistem'}\nTarih: ${new Date().toLocaleString('tr-TR')}`);

        res.json({ success: true, message: `Paket tanımlandı: ${totalTL} TL (${anaPara} TL + ${bonusPara} TL Bonus).` });
    } catch (err) {
        res.json({ success: false, message: "Paket kaydedilemedi: " + err.message });
    }
});

// İptal edilen ziyaretin ödeme tipi. Bu satırlar GELİRE ve "ücretsiz" sayısına girmez.
const IPTAL_TIPI = 'VAZGEÇTİ';

// Rapor geliri TEK yerde hesaplanır (günlük özet, Telegram raporu, Excel aynı sonucu verir).
// Ayrım payment_type üzerinden yapılır, fee üzerinden DEĞİL: eski kayıtlarda iptal
// satırlarının fee alanı dolu kalmıştır, o yüzden fee'ye güvenilmez.
function reportTotals(logs) {
    let cash = 0, card = 0, free = 0, iptal = 0, iptalTl = 0;
    (logs || []).forEach(l => {
        const tip = String(l.payment_type || '');
        if (tip === IPTAL_TIPI) { iptal++; iptalTl += Number(l.fee || 0); return; }
        if (tip === 'NAKİT') cash += Number(l.fee || 0);
        else if (tip === 'KREDİ KARTI') card += Number(l.fee || 0);
        else free++;
    });
    return { cash, card, free, iptal, iptal_tl: iptalTl, revenue: cash + card };
}

// Rapor tablolarında satırın durumu.
function logDurum(l) {
    const tip = String((l && l.payment_type) || '');
    if (tip === IPTAL_TIPI) return 'İPTAL';
    if (tip === 'ÜCRETSİZ') return 'ÜCRETSİZ';
    if (tip === 'PAKET') return 'PAKET';
    if (tip === 'HAK' || tip === 'TELAFİ') return 'HAK/TELAFİ';
    return 'TAHSİLAT';
}

app.get('/api/reports/summary', (req, res) => {
    const todayStr = new Date().toISOString().split('T')[0];
    db.get(`SELECT COUNT(*) as c FROM logs WHERE status = 'AÇIK'`, (err, rIn) => {
        db.all(`SELECT * FROM logs WHERE tarih = ? AND status = 'KAPALI'`, [todayStr], (err, tLogs) => {
            const totals = reportTotals(tLogs);
            res.json({ 
                success: true, 
                inside_count: rIn ? rIn.c : 0, 
                today: { entries: (tLogs || []).length, ...totals },
                today_logs: (tLogs || []).map(l => {
                    const durum = logDurum(l);
                    return {
                        ...l,
                        durum,
                        iptal: durum === 'İPTAL',
                        // İptalde tahsilat 0'dır; eski kayıtlarda fee dolu olsa bile gösterilmez.
                        tahsilat: durum === 'İPTAL' ? 0 : Number(l.fee || 0),
                        entry_time: new Date(l.entry_time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }),
                        exit_time: new Date(l.payment_date).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
                    };
                }) 
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
    s2.columns = [{ header: 'Log ID', key: 'log_id' }, { header: 'Tarih', key: 'tarih' }, { header: 'Öğrenci', key: 'student_name' }, { header: 'Süre (Dk)', key: 'duration_min' }, { header: 'Tutar (TL)', key: 'fee' }, { header: 'Ödeme', key: 'payment_type' }, { header: 'Durum', key: 'durum' }, { header: 'İptal Edilen Tutar (TL)', key: 'iptal_tutar' }, { header: 'Açıklama', key: 'source_summary' }, { header: 'Personel', key: 'personel' }];
    const logs = await new Promise(r => db.all(`SELECT * FROM logs ORDER BY entry_time DESC`, (err, rows) => r(rows || [])));
    logs.forEach(l => {
        const durum = logDurum(l);
        // İptal edilen ziyaretin tutarı 0 yazılır: kolon toplandığında gelire karışmasın.
        // Tahsil edilmeyen tutar ayrı kolonda referans olarak kalır.
        s2.addRow({
            ...l,
            tarih: l.entry_time ? new Date(l.entry_time).toLocaleString() : '',
            durum,
            fee: durum === 'İPTAL' ? 0 : Number(l.fee || 0),
            iptal_tutar: durum === 'İPTAL' ? Number(l.fee || 0) : '',
        });
    });

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
            const totals = reportTotals(tLogs);
            
            const insideCount = rIn ? rIn.c : 0;
            const exitCount = (tLogs || []).length;
            
            const message = `📋 Bugünün Özeti (${dateFormatted})\n\n` +
                            `🏃 Şu An İçeride: ${insideCount}\n` +
                            `🚪 Bugün Çıkan: ${exitCount}\n` +
                            `💵 Nakit (TL): ${totals.cash}\n` +
                            `💳 Kart (TL): ${totals.card}\n` +
                            `💰 Toplam Tahsilat (TL): ${totals.revenue}\n` +
                            `🎁 Ücretsiz / Hak: ${totals.free}\n` +
                            (totals.iptal > 0 ? `🚫 İptal Edilen: ${totals.iptal} (${totals.iptal_tl} TL tahsil edilmedi)\n` : '') +
                            `\n` +
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


// =====================================================================================
// PLANLI DERSLER: sınıf / ders saati / kayıt / yoklama
// =====================================================================================

app.get('/api/classes', async (req, res) => {
    try {
        const classes = await dbAll(`SELECT * FROM classes ORDER BY name`);
        const sessions = await dbAll(`SELECT * FROM sessions ORDER BY day_of_week, start_time`);
        const counts = await dbAll(`SELECT session_id, COUNT(*) AS kayitli FROM class_registrations WHERE status = 'Aktif' GROUP BY session_id`);
        const byId = {};
        counts.forEach(c => { byId[c.session_id] = c.kayitli; });
        res.json({
            success: true,
            classes: classes.map(c => ({
                ...c,
                sessions: sessions.filter(s => s.class_id === c.class_id).map(s => ({ ...s, kayitli: byId[s.session_id] || 0 }))
            }))
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/classes/add', (req, res) => {
    const { name, description, monthly_fee, term_fee } = req.body;
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'Ders adı gerekli.' });
    const classId = "CLS-" + Date.now();
    withWriteLock(() => dbRun(
        `INSERT INTO classes (class_id, name, description, monthly_fee, term_fee, status, created_at) VALUES (?, ?, ?, ?, ?, 'Aktif', ?)`,
        [classId, String(name).trim(), description || '', Number(monthly_fee || 0), Number(term_fee || 0), new Date().toISOString()]))
        .then(() => res.json({ success: true, class_id: classId, message: 'Ders oluşturuldu.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/classes/update', (req, res) => {
    const { class_id, name, description, monthly_fee, term_fee, status } = req.body;
    if (!class_id) return res.json({ success: false, message: 'Ders seçilmedi.' });
    withWriteLock(() => dbRun(
        `UPDATE classes SET name = ?, description = ?, monthly_fee = ?, term_fee = ?, status = ? WHERE class_id = ?`,
        [name, description || '', Number(monthly_fee || 0), Number(term_fee || 0), status || 'Aktif', class_id]))
        .then(() => res.json({ success: true, message: 'Ders güncellendi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/sessions/add', (req, res) => {
    const { class_id, day_of_week, start_time, end_time, capacity } = req.body;
    const dow = Number(day_of_week);
    if (!class_id || !(dow >= 1 && dow <= 7)) return res.json({ success: false, message: 'Ders ve gün seçilmeli.' });
    if (minutesOf(end_time) <= minutesOf(start_time)) return res.json({ success: false, message: 'Bitiş saati başlangıçtan sonra olmalı.' });
    const sessionId = "SES-" + Date.now();
    withWriteLock(() => dbRun(
        `INSERT INTO sessions (session_id, class_id, day_of_week, start_time, end_time, capacity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'Aktif', ?)`,
        [sessionId, class_id, dow, start_time, end_time, Number(capacity || 0), new Date().toISOString()]))
        .then(() => res.json({ success: true, session_id: sessionId, message: 'Ders saati eklendi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/sessions/delete', (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.json({ success: false, message: 'Ders saati seçilmedi.' });
    withTransaction(async () => {
        const aktif = await dbGet(`SELECT COUNT(*) AS c FROM class_registrations WHERE session_id = ? AND status = 'Aktif'`, [session_id]);
        if (aktif && aktif.c > 0) throw new Error('Bu saatte aktif kayıtlı öğrenci var; önce kayıtları iptal edin.');
        await dbRun(`DELETE FROM sessions WHERE session_id = ?`, [session_id]);
    }).then(() => res.json({ success: true, message: 'Ders saati silindi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

// Ders kaydı: ödeme ve ders saati ataması TEK işlemde yapılır.
app.post('/api/classes/register', async (req, res) => {
    const { child_id, session_id, payment_type, fee, start_date, end_date, not_alani, personel } = req.body;
    if (!child_id || !session_id) return res.json({ success: false, message: 'Öğrenci ve ders saati seçilmeli.' });
    const tip = String(payment_type || '').toUpperCase().startsWith('D') ? 'DÖNEMLİK' : 'AYLIK';
    try {
        const reg = await withTransaction(async () => {
            const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [child_id]);
            if (!student) throw new Error('Öğrenci bulunamadı.');
            const session = await dbGet(`SELECT s.*, c.name AS class_name, c.monthly_fee, c.term_fee FROM sessions s JOIN classes c ON c.class_id = s.class_id WHERE s.session_id = ?`, [session_id]);
            if (!session) throw new Error('Ders saati bulunamadı.');

            const dupe = await dbGet(`SELECT * FROM class_registrations WHERE child_id = ? AND session_id = ? AND status = 'Aktif'`, [child_id, session_id]);
            if (dupe) throw new Error('Bu öğrenci bu ders saatine zaten kayıtlı.');

            if (Number(session.capacity) > 0) {
                const cnt = await dbGet(`SELECT COUNT(*) AS c FROM class_registrations WHERE session_id = ? AND status = 'Aktif'`, [session_id]);
                if (Number(cnt.c) >= Number(session.capacity)) throw new Error('Ders saati kontenjanı dolu.');
            }

            const ucret = Number(fee !== undefined && fee !== null && fee !== '' ? fee
                : (tip === 'DÖNEMLİK' ? session.term_fee : session.monthly_fee)) || 0;
            const now = new Date();
            const regId = "KAY-" + Date.now();
            await dbRun(`INSERT INTO class_registrations (reg_id, child_id, session_id, payment_type, fee, start_date, end_date, status, not_alani, personel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Aktif', ?, ?, ?)`,
                [regId, child_id, session_id, tip, ucret,
                    start_date || localDateStr(now), end_date || null, not_alani || '', personel || '', now.toISOString()]);
            return { regId, tip, ucret, className: session.class_name, start: session.start_time, end: session.end_time, student };
        });

        sendTelegramNotification(`🎓 YENİ DERS KAYDI\n\nÖğrenci: ${reg.student.student_name}\nDers: ${reg.className}\nSaat: ${reg.start}-${reg.end}\nÖdeme: ${reg.tip}\nÜcret: ${reg.ucret} TL\nPersonel: ${personel || 'Sistem'}`);
        res.json({ success: true, reg_id: reg.regId, message: `${reg.className} dersine ${reg.tip} kayıt yapıldı.` });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.get('/api/classes/registrations', async (req, res) => {
    try {
        const childId = req.query.child_id || null;
        const rows = await dbAll(`
            SELECT r.*, st.student_name, st.parent_phone, s.day_of_week, s.start_time, s.end_time, c.name AS class_name
            FROM class_registrations r
            JOIN students st ON st.child_id = r.child_id
            JOIN sessions s ON s.session_id = r.session_id
            JOIN classes c ON c.class_id = s.class_id
            ${childId ? 'WHERE r.child_id = ?' : ''}
            ORDER BY r.created_at DESC LIMIT 200`, childId ? [childId] : []);
        res.json({
            success: true,
            registrations: rows.map(r => ({ ...r, gun_adi: DAY_NAMES[r.day_of_week] || '' }))
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/classes/registration-cancel', (req, res) => {
    const { reg_id, personel } = req.body;
    if (!reg_id) return res.json({ success: false, message: 'Kayıt seçilmedi.' });
    withWriteLock(() => dbRun(`UPDATE class_registrations SET status = 'İptal', personel = ? WHERE reg_id = ?`, [personel || '', reg_id]))
        .then(() => res.json({ success: true, message: 'Ders kaydı iptal edildi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

// Bugünün dersleri + yoklama durumu (öğretmen ekranı ve kasa bunu kullanır).
// Bugünün seansları ve yoklama durumu (kasiyer ve sınıf ekranı ortak kullanır).
async function todaySessionsData() {
    const now = new Date();
    const today = localDateStr(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const sessions = await dbAll(`SELECT s.*, c.name AS class_name FROM sessions s JOIN classes c ON c.class_id = s.class_id WHERE s.status = 'Aktif' AND s.day_of_week = ? ORDER BY s.start_time`, [dayOfWeek(now)]);
    const out = [];
    for (const s of sessions) {
        const ogrenciler = await dbAll(`
            SELECT r.reg_id, r.child_id, r.payment_type, st.student_name, st.parent_phone,
                   a.durum AS yoklama, a.giris_zamani, a.telafi_hak_id
            FROM class_registrations r
            JOIN students st ON st.child_id = r.child_id
            LEFT JOIN class_attendance a ON a.child_id = r.child_id AND a.session_id = r.session_id AND a.tarih = ?
            WHERE r.session_id = ? AND r.status = 'Aktif'
            ORDER BY st.student_name`, [today, s.session_id]);
        out.push({ ...s, gun_adi: DAY_NAMES[s.day_of_week] || '', tarih: today, ogrenciler, bitti: minutesOf(s.end_time) <= nowMin });
    }
    return { tarih: today, gun_adi: DAY_NAMES[dayOfWeek(now)] || '', sessions: out };
}

app.get('/api/classes/today', async (req, res) => {
    try {
        res.json({ success: true, ...(await todaySessionsData()) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Elle yoklama. GELMEDİ işaretlenirse telafi hakkı da tanımlanır; sonradan GELDİ'ye
// çevrilirse ve telafi kullanılmamışsa geri alınır.
app.post('/api/classes/attendance', async (req, res) => {
    const { child_id, session_id, durum, personel } = req.body;
    const yeniDurum = String(durum || '').toUpperCase().startsWith('GELME') ? 'GELMEDİ' : 'GELDİ';
    try {
        const out = await withTransaction(async () => {
            const session = await dbGet(`SELECT s.*, c.name AS class_name FROM sessions s JOIN classes c ON c.class_id = s.class_id WHERE s.session_id = ?`, [session_id]);
            if (!session) throw new Error('Ders saati bulunamadı.');
            const today = localDateStr(new Date());
            const existing = await dbGet(`SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ? AND tarih = ?`, [child_id, session_id, today]);

            if (yeniDurum === 'GELDİ') {
                if (existing) {
                    // Telafi verilmişse ve hâlâ kullanılmamışsa geri al.
                    if (existing.telafi_hak_id) {
                        const hak = await dbGet(`SELECT * FROM rights WHERE hak_id = ?`, [existing.telafi_hak_id]);
                        if (hak && hak.durum === 'Aktif' && Number(hak.kalan_dk) === Number(hak.miktar_dk)) {
                            await dbRun(`UPDATE rights SET durum = 'İptal', kalan_dk = 0 WHERE hak_id = ?`, [hak.hak_id]);
                        }
                    }
                    await dbRun(`UPDATE class_attendance SET durum = 'GELDİ', giris_zamani = COALESCE(giris_zamani, ?), telafi_hak_id = NULL, personel = ? WHERE attendance_id = ?`,
                        [new Date().toISOString(), personel || '', existing.attendance_id]);
                    return { action: 'GUNCELLENDI' };
                }
                await dbRun(`INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum, giris_zamani, personel, created_at) VALUES (?, ?, ?, ?, ?, 'GELDİ', ?, ?, ?)`,
                    ["YOK-" + Date.now(), child_id, session.session_id, session.class_id, today, new Date().toISOString(), personel || '', new Date().toISOString()]);
                return { action: 'KAYDEDILDI' };
            }

            // GELMEDİ: telafi tanımlanır. Kayıt zaten varsa (GELDİ -> GELMEDİ düzeltmesi) ve
            // telafi yoksa burada oluşturulur; ters yön telafiyi geri aldığı için iki yön simetrik.
            let hakId = existing ? (existing.telafi_hak_id || null) : null;
            let yeniTelafi = false;
            if (!hakId) {
                const comp = await createCompensationRight(child_id, session, today);
                hakId = comp.hakId;
                yeniTelafi = true;
            }
            if (existing) {
                await dbRun(`UPDATE class_attendance SET durum = 'GELMEDİ', telafi_hak_id = ?, personel = ? WHERE attendance_id = ?`,
                    [hakId, personel || '', existing.attendance_id]);
            } else {
                await dbRun(`INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum, telafi_hak_id, personel, created_at) VALUES (?, ?, ?, ?, ?, 'GELMEDİ', ?, ?, ?)`,
                    ["YOK-" + Date.now(), child_id, session.session_id, session.class_id, today, hakId, personel || '', new Date().toISOString()]);
            }
            if (yeniTelafi) {
                const stu = await dbGet(`SELECT student_name FROM students WHERE child_id = ?`, [child_id]);
                sendTelegramNotification(absenceMessage({ student_name: stu ? stu.student_name : child_id }, session, today));
            }
            return { action: existing ? 'GUNCELLENDI' : 'KAYDEDILDI', telafi: hakId };
        });
        res.json({ success: true, message: 'Yoklama kaydedildi.', ...out });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Gün sonu telafi işini elle çalıştır (bilgisayar kapalıysa telafi kaçmasın).
// body.tarih (YYYY-AA-GG) verilirse o günün tamamı işlenir.
app.post('/api/classes/process-absences', async (req, res) => {
    try {
        const tarih = (req.body && req.body.tarih) ? String(req.body.tarih).slice(0, 10) : null;
        const out = await processClassAbsences(new Date(), tarih);
        res.json({ success: true, ...out });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Ders bitimlerinden sonra yoklama/telafi işlemesi: gün içinde düzenli çalışır,
// böylece "ders biter bitmez" telafi tanımlanır (gece yarısını beklemek gerekmez).
function scheduleClassJobs() {
    const run = () => processClassAbsences()
        .then(r => { if (r && r.telafi_verilen > 0) console.log(`[DERS TELAFİ] ${r.telafi_verilen} öğrenciye 1 seans oyun alanı hakkı tanımlandı.`); })
        .catch(e => console.error('[DERS TELAFİ HATASI]:', (e && e.stack) || e));
    setTimeout(run, 60 * 1000);
    setInterval(run, 10 * 60 * 1000);
    console.log('Ders yoklama/telafi işleyicisi başlatıldı (10 dakikada bir).');
}

// =====================================================================================
// PASAPORT / GÖREV / CÜZDAN (gamification)
// =====================================================================================

app.get('/api/tasks', async (req, res) => {
    try {
        const tasks = await dbAll(`SELECT * FROM tasks ORDER BY status, name`);
        const counts = await dbAll(`SELECT task_id, COUNT(*) AS tamamlayan FROM student_tasks GROUP BY task_id`);
        const byId = {};
        counts.forEach(c => { byId[c.task_id] = c.tamamlayan; });
        res.json({ success: true, tasks: tasks.map(t => ({ ...t, tamamlayan: byId[t.task_id] || 0 })) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/tasks/add', (req, res) => {
    const { name, description, points } = req.body;
    if (!name || !String(name).trim()) return res.json({ success: false, message: 'Görev adı gerekli.' });
    const taskId = "TSK-" + Date.now();
    withWriteLock(() => dbRun(`INSERT INTO tasks (task_id, name, description, points, status, created_at) VALUES (?, ?, ?, ?, 'Aktif', ?)`,
        [taskId, String(name).trim(), description || '', Number(points || 10), new Date().toISOString()]))
        .then(() => res.json({ success: true, task_id: taskId, message: 'Görev eklendi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

app.post('/api/tasks/update', (req, res) => {
    const { task_id, name, description, points, status } = req.body;
    if (!task_id) return res.json({ success: false, message: 'Görev seçilmedi.' });
    withWriteLock(() => dbRun(`UPDATE tasks SET name = ?, description = ?, points = ?, status = ? WHERE task_id = ?`,
        [name, description || '', Number(points || 0), status || 'Aktif', task_id]))
        .then(() => res.json({ success: true, message: 'Görev güncellendi.' }))
        .catch(err => res.json({ success: false, message: err.message }));
});

// Pasaport: öğrencinin görev listesi, tamamlanma durumu, toplam puanı ve cüzdan hareketleri.
app.get('/api/passport/:child_id', async (req, res) => {
    try {
        const child_id = req.params.child_id;
        const student = await dbGet(`SELECT child_id, student_name, parent_name, parent_phone, wallet_balance FROM students WHERE child_id = ?`, [child_id]);
        if (!student) return res.json({ success: false, message: 'Öğrenci bulunamadı.' });

        const tasks = await dbAll(`
            SELECT t.task_id, t.name, t.description, t.points, t.status,
                   s.puan AS kazanilan_puan, s.tamamlanma_tarihi, s.personel AS yapan
            FROM tasks t
            LEFT JOIN student_tasks s ON s.task_id = t.task_id AND s.child_id = ?
            WHERE t.status = 'Aktif' ORDER BY t.name`, [child_id]);
        const toplam = await dbGet(`SELECT COALESCE(SUM(puan), 0) AS toplam FROM student_tasks WHERE child_id = ?`, [child_id]);
        const movements = await dbAll(`SELECT * FROM wallet_movements WHERE child_id = ? ORDER BY tarih DESC LIMIT 50`, [child_id]);

        res.json({
            success: true,
            student: { ...student, wallet_balance: Number(student.wallet_balance || 0) },
            tasks: tasks.map(t => ({ ...t, tamamlandi: !!t.tamamlanma_tarihi })),
            toplam_puan: Number(toplam.toplam || 0),
            movements
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Görevi işaretle: görev kaydı + puan + cüzdan hareketi tek işlemde yazılır.
app.post('/api/tasks/complete', async (req, res) => {
    const { child_id, task_id, personel, note } = req.body;
    if (!child_id || !task_id) return res.json({ success: false, message: 'Öğrenci ve görev seçilmeli.' });
    try {
        const out = await withTransaction(async () => {
            const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [child_id]);
            if (!student) throw new Error('Öğrenci bulunamadı.');
            const task = await dbGet(`SELECT * FROM tasks WHERE task_id = ?`, [task_id]);
            if (!task) throw new Error('Görev bulunamadı.');
            const already = await dbGet(`SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?`, [child_id, task_id]);
            if (already) throw new Error('Bu görev bu öğrenci için zaten işaretlenmiş.');

            const puan = Number(task.points || 0);
            await dbRun(`INSERT INTO student_tasks (child_id, task_id, puan, tamamlanma_tarihi, personel, note) VALUES (?, ?, ?, ?, ?, ?)`,
                [child_id, task_id, puan, new Date().toISOString(), personel || '', note || '']);
            const bal = await grantPoints(child_id, puan, 'Görev tamamlandı: ' + task.name, { task_id, personel });
            return { puan, bakiye: bal ? bal.yeni : Number(student.wallet_balance || 0), task_name: task.name };
        });
        res.json({ success: true, puan: out.puan, yeni_bakiye: out.bakiye, message: `${out.task_name} tamamlandı: +${out.puan} puan (bakiye ${out.bakiye}).` });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Yanlış işaretlemeyi geri al. Puanlar harcanmışsa işlem geri alınır (bakiye eksiye düşmez).
app.post('/api/tasks/uncomplete', async (req, res) => {
    const { child_id, task_id, personel } = req.body;
    if (!child_id || !task_id) return res.json({ success: false, message: 'Öğrenci ve görev seçilmeli.' });
    try {
        const out = await withTransaction(async () => {
            const row = await dbGet(`SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?`, [child_id, task_id]);
            if (!row) throw new Error('Bu görev bu öğrenci için işaretlenmemiş.');
            const task = await dbGet(`SELECT name FROM tasks WHERE task_id = ?`, [task_id]);
            await dbRun(`DELETE FROM student_tasks WHERE id = ?`, [row.id]);
            const bal = await grantPoints(child_id, -Number(row.puan || 0), 'Görev geri alındı: ' + ((task && task.name) || task_id), { task_id, personel });
            return { bakiye: bal ? bal.yeni : 0 };
        });
        res.json({ success: true, yeni_bakiye: out.bakiye, message: 'Görev geri alındı.' });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Öğrenci hareket dökümü (ekstre): geçmiş giriş/çıkışlar, ücretler ve her işlemden
// SONRA kalan bakiye. Tarayıcıdan yazdırılır (A4) — sade ve okunur tutulur.
//
// "Kalan bakiye" hak defterinden gelir: bir ziyaret paketten düşüldüğünde
// right_movements.yeni_kalan_dk o işlemin hemen sonrasındaki dakika bakiyesidir.
app.get('/api/students/statement/:child_id', async (req, res) => {
    try {
        const child_id = req.params.child_id;
        const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 300));
        const student = await dbGet(`SELECT child_id, student_name, parent_name, parent_phone, wallet_balance FROM students WHERE child_id = ?`, [child_id]);
        if (!student) return res.json({ success: false, message: 'Öğrenci bulunamadı.' });

        const logs = await dbAll(`
            SELECT log_id, tarih, entry_time, duration_min, total_pause_duration, fee, payment_type,
                   paketten_dusen, kullanilan_puan, puan_indirimi, kazanilan_puan, status, source_summary
            FROM logs WHERE child_id = ? ORDER BY entry_time ASC LIMIT ?`, [child_id, limit]);

        const movements = await dbAll(`SELECT log_id, yeni_kalan_dk, hak_tipi FROM right_movements
                                       WHERE child_id = ? AND log_id IS NOT NULL AND log_id <> ''`, [child_id]);
        const kalanByLog = {};
        movements.forEach((m) => { kalanByLog[m.log_id] = m; });

        const paket = await dbGet(`SELECT COALESCE(SUM(kalan_dk), 0) AS kalan_dk,
                                          COALESCE(SUM(kalan_ana_para), 0) AS ana,
                                          COALESCE(SUM(kalan_bonus), 0) AS bonus
                                   FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET' AND durum = 'Aktif'`, [child_id]);
        const telafi = await dbGet(`SELECT COALESCE(SUM(kalan_dk), 0) AS kalan_dk
                                    FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ' AND durum = 'Aktif'`, [child_id]);

        // logs.tarih eski kayıtlarda "07.09.2026" gibi yazılmış; giriş zamanı (ISO) varsa
        // tarih ondan türetilir, yoksa tarih metni normalize edilir.
        const normTarih = (t) => {
            const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(t || ''));
            return m ? (m[3] + '-' + m[2] + '-' + m[1]) : String(t || '');
        };

        const hareketler = logs.map((l, i) => {
            const mv = kalanByLog[l.log_id];
            const sure = Number(l.duration_min || 0) + Number(l.total_pause_duration || 0);
            const cikis = l.entry_time ? new Date(new Date(l.entry_time).getTime() + sure * 60000).toISOString() : null;
            // Paket/telafi ile kapatılan ziyaretlerde kasadan nakit çıkmaz.
            // VAZGEÇTİ (iptal edilen ziyaret) de tahsilat SAYILMAZ: uygulama iptali
            // "Tahsilatı" olarak yazıyor, dökümde "İptal" olarak gösterilir.
            const iptal = String(l.payment_type) === 'VAZGEÇTİ';
            const paketleKapandi = iptal || ['PAKET', 'HAK', 'TELAFİ'].indexOf(String(l.payment_type)) !== -1;
            return {
                sira: i + 1,
                tarih: l.entry_time ? localDateStr(new Date(l.entry_time)) : normTarih(l.tarih),
                giris: l.entry_time,
                cikis,
                sure_dk: Number(l.duration_min || 0),
                ucret: iptal ? 0 : Number(l.fee || 0),
                iptal,
                nakit_tl: paketleKapandi ? 0 : Number(l.fee || 0),
                odeme: l.payment_type || '-',
                paket_dk: Number(l.paketten_dusen || 0),
                puan_indirimi: Number(l.puan_indirimi || 0),
                kazanilan_puan: Number(l.kazanilan_puan || 0),
                kalan_dk: mv ? Number(mv.yeni_kalan_dk) : null,
                // Kalan bakiyenin birimi hakkın türüne bağlı: PAKET parasal (TL),
                // telafi dakika, telafi dersi saat. Aksi halde "14150" gibi çıplak
                // bir sayı anne-babaya yanlış birimle okunur.
                kalan_tipi: mv ? mv.hak_tipi : null,
                ozet: l.source_summary || '',
                durum: l.status
            };
        });

        res.json({
            success: true,
            ogrenci: { ...student, wallet_balance: Number(student.wallet_balance || 0) },
            ozet: {
                ziyaret: hareketler.length,
                nakit_tl: hareketler.reduce((a, h) => a + h.nakit_tl, 0),
                paket_dk: hareketler.reduce((a, h) => a + h.paket_dk, 0),
                puan_indirimi: hareketler.reduce((a, h) => a + h.puan_indirimi, 0),
                ilk_tarih: hareketler.length ? hareketler[0].tarih : null,
                son_tarih: hareketler.length ? hareketler[hareketler.length - 1].tarih : null
            },
            kalan: {
                paket_dk: Number(paket.kalan_dk || 0),
                paket_tl: Number(paket.ana || 0) + Number(paket.bonus || 0),
                telafi_dk: Number(telafi.kalan_dk || 0),
                puan: Number(student.wallet_balance || 0)
            },
            hareketler
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.get('/api/wallet/:child_id', async (req, res) => {
    try {
        const student = await dbGet(`SELECT child_id, student_name, wallet_balance FROM students WHERE child_id = ?`, [req.params.child_id]);
        if (!student) return res.json({ success: false, message: 'Öğrenci bulunamadı.' });
        const movements = await dbAll(`SELECT * FROM wallet_movements WHERE child_id = ? ORDER BY tarih DESC LIMIT 100`, [req.params.child_id]);
        res.json({
            success: true,
            child_id: student.child_id, student_name: student.student_name,
            wallet_balance: Number(student.wallet_balance || 0),
            tl_karsiligi: Math.round(Number(student.wallet_balance || 0) * Number(appSettings.point_tl_rate || 1) * 100) / 100,
            point_tl_rate: Number(appSettings.point_tl_rate || 1),
            movements
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Haftanın Kaşifleri: bu hafta (Pazartesi'den itibaren) en çok puan toplayan öğrenciler.
// Haftanın kaşifleri: pasaport damgalarından sayılır (kasiyer ve sınıf ekranı ortak kullanır).
async function weeklyLeaderboardData(limit = 20) {
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dayOfWeek(now) - 1), 0, 0, 0, 0);
    const rows = await dbAll(`
        SELECT st.child_id, s.student_name, COALESCE(SUM(st.puan), 0) AS toplam_puan, COUNT(*) AS adet
        FROM student_tasks st
        JOIN students s ON s.child_id = st.child_id
        WHERE st.tamamlanma_tarihi >= ?
        GROUP BY st.child_id
        ORDER BY toplam_puan DESC, s.student_name ASC
        LIMIT ?`, [monday.toISOString(), limit]);
    return {
        hafta_baslangici: monday.toISOString(),
        leaderboard: rows.map((r, i) => ({ sira: i + 1, child_id: r.child_id, student_name: r.student_name, toplam_puan: Number(r.toplam_puan), adet: r.adet }))
    };
}

app.get('/api/leaderboard/weekly', async (req, res) => {
    try {
        res.json({ success: true, ...(await weeklyLeaderboardData()) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});


// =====================================================================================
//  SINIF ARAYÜZÜ — ikinci HTTP portu (öğretmen tableti)
//
//  Sınıf portunda YALNIZCA şu uçlar bağlanır: liderlik tablosu, pasaport onayı ve
//  RFID okuyucusu. Kasiyer uçları (ders/kayıt oluşturma, elle yoklama, paket satışı,
//  çıkış/tahsilat, ayarlar, raporlar) bu uygulamaya hiç bağlanmadığı için tabletten
//  gelen istekler 404 alır. "Öğretmen elle yoklama alamaz, ders açamaz" kuralı böylece
//  kodla değil, soket seviyesinde garanti edilir.
//
//  Tek süreç, iki port: sqlite bağlantısı ve yazma kilidi (withWriteLock) süreç içinde
//  paylaşılır. İki ayrı süreç olsaydı kilitler birbirini görmez, işlem güvenliği bozulurdu.
// =====================================================================================
const classroomApp = express();
classroomApp.use(express.json());
classroomApp.disable('x-powered-by');

// Bekleyen okutmalar: tablet "Ders / Oyun Alanı" seçimini yapana kadar burada durur.
const pendingTaps = new Map();

function tapCleanup() {
    const now = Date.now();
    for (const [id, t] of pendingTaps) if (t.expires < now) pendingTaps.delete(id);
}
const tapCleanupTimer = setInterval(tapCleanup, 5000);
if (tapCleanupTimer.unref) tapCleanupTimer.unref();

function classroomAuthorized(req) {
    const token = String(appSettings.classroom_reader_token || '').trim();
    if (!token) return true;                                     // anahtar tanımlanmadıysa serbest
    const given = String(req.get('x-reader-token') || (req.body && req.body.reader_token) || '').trim();
    return given === token;
}

function normCard(v) {
    return String(v == null ? '' : v).replace(/ /g, '').toUpperCase();
}

// Kart numarasına göre öğrenci. Büyük/küçük harf ve boşluk farkları yok sayılır:
// eski kayıtlarda kart numarası karma yazılmış olabiliyor.
async function findStudentByCard(rfid) {
    const wanted = normCard(rfid);
    if (!wanted) return null;
    const rows = await dbAll(`SELECT * FROM students WHERE rfid_id IS NOT NULL AND rfid_id <> ''`);
    return rows.find(r => normCard(r.rfid_id) === wanted) || null;
}

function pendingPayload(tap, student, repeated) {
    return {
        success: true, code: 'SECIM_BEKLIYOR', repeated: !!repeated,
        tap_id: tap.tap_id,
        child_id: tap.child_id,
        student_name: tap.student_name,
        wallet_balance: Number(student && student.wallet_balance || 0),
        has_class: !!tap.session_id,
        class_name: tap.class_name,
        start_time: tap.start_time,
        end_time: tap.end_time,
        inside: !!tap.inside,
        expires_in: Math.max(0, Math.round((tap.expires - Date.now()) / 1000)),
        message: tap.student_name + ' — Ders mi, Dramatik Oyun Alanı mı?'
    };
}

// Oyun alanı GİRİŞİ. Sınıf tabletinden ÇIKIŞ yapılamaz: çıkış ve tahsilat yalnızca
// kasadan yapılır. Burada hak düşülmez, ücret hesaplanmaz.
async function classroomPlayAreaEntry(tap) {
    const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [tap.child_id]);
    if (!student) return { success: false, code: 'OGRENCI_YOK', message: 'Öğrenci bulunamadı.' };

    const activeLog = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [student.child_id]);
    if (activeLog) {
        return {
            success: false, code: 'ZATEN_ICERIDE', mode: 'OYUN', student_name: student.student_name,
            message: student.student_name + ' zaten içeride. Çıkış işlemi kasadan yapılır.'
        };
    }

    const iso = new Date().toISOString();
    await withWriteLock(() => dbRun(
        `INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time, status, personel) VALUES (?, ?, ?, ?, ?, 'GİRİŞ', ?, 'AÇIK', ?)`,
        ['LOG-' + Date.now(), iso.split('T')[0], student.child_id, student.student_name, student.parent_name, iso, 'Sınıf Okuyucu']));

    return {
        success: true, mode: 'OYUN', action: 'GIRIS', child_id: student.child_id,
        student_name: student.student_name,
        message: student.student_name + ' oyun alanına girdi. Çıkış kasadan yapılır.'
    };
}

// Ders seçildiğinde: program eşleşmesi varsa yoklama, yoksa "eşleşme yok".
async function classroomClassTap(tap) {
    const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [tap.child_id]);
    if (!student) return { success: false, code: 'OGRENCI_YOK', message: 'Öğrenci bulunamadı.' };

    const now = new Date();
    const session = await findCurrentClassSession(student.child_id, now);
    if (!session) {
        return {
            success: false, code: 'ESLESME_YOK', mode: 'DERS', student_name: student.student_name,
            message: 'Eşleşme yok: ' + student.student_name + ' için şu anda planlanmış bir ders görünmüyor.'
        };
    }

    const action = await withTransaction(async () => {
        const today = localDateStr(now);
        const existing = await dbGet(`SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ? AND tarih = ?`,
            [student.child_id, session.session_id, today]);
        if (existing) {
            if (existing.durum === 'GELDİ' && !existing.cikis_zamani) {
                await dbRun(`UPDATE class_attendance SET cikis_zamani = ? WHERE attendance_id = ?`, [now.toISOString(), existing.attendance_id]);
                return 'DERS_CIKIS';
            }
            return 'DERS_ZATEN';
        }
        await dbRun(`INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum, giris_zamani, personel, created_at) VALUES (?, ?, ?, ?, ?, 'GELDİ', ?, 'Sınıf Okuyucu', ?)`,
            ['YOK-' + Date.now(), student.child_id, session.session_id, session.class_id, today, now.toISOString(), now.toISOString()]);
        return 'DERS_GIRIS';
    });

    const mesaj = action === 'DERS_GIRIS' ? student.student_name + ' derse girdi.'
        : action === 'DERS_CIKIS' ? student.student_name + ' dersten çıktı.'
            : student.student_name + ' için yoklama zaten alınmış.';
    return {
        success: true, mode: 'DERS', action, child_id: student.child_id, student_name: student.student_name,
        class_name: session.class_name, start_time: session.start_time, end_time: session.end_time, message: mesaj
    };
}

// Okutma: yoklama YAZMAZ, tablete seçim ekranı için bekleyen kayıt döner.
classroomApp.post('/classroom/rfid/scan', async (req, res) => {
    try {
        if (!classroomAuthorized(req)) {
            return res.status(401).json({ success: false, code: 'YETKISIZ', message: 'Okuyucu anahtarı geçersiz.' });
        }
        const rfid = (req.body && req.body.rfid_id) || '';
        if (!normCard(rfid)) return res.json({ success: false, code: 'KART_YOK', message: 'Kart numarası okunamadı.' });

        const student = await findStudentByCard(rfid);
        if (!student) return res.json({ success: false, code: 'TANINMAYAN_KART', message: 'Bu kart tanınmadı.' });

        // Okuyucular aynı kartı arka arkaya gönderebiliyor. Kısa süre içinde tekrar
        // okutulursa yeni seçim ekranı açılmaz, mevcut bekleyen kayıt döner.
        const nowMs = Date.now();
        const dedupMs = Math.max(0, Number(appSettings.rfid_dedup_seconds || 0)) * 1000;
        for (const t of pendingTaps.values()) {
            if (t.child_id === student.child_id && nowMs - t.created < dedupMs) {
                return res.json(pendingPayload(t, student, true));
            }
        }

        const session = await findCurrentClassSession(student.child_id, new Date());
        const activeLog = await dbGet(`SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [student.child_id]);
        const tap = {
            tap_id: 'TAP-' + nowMs + '-' + Math.floor(Math.random() * 1000),
            child_id: student.child_id,
            student_name: student.student_name,
            created: nowMs,
            expires: nowMs + Math.max(5, Number(appSettings.tap_prompt_seconds || 45)) * 1000,
            session_id: session ? session.session_id : null,
            class_name: session ? session.class_name : null,
            start_time: session ? session.start_time : null,
            end_time: session ? session.end_time : null,
            inside: !!activeLog
        };
        pendingTaps.set(tap.tap_id, tap);
        res.json(pendingPayload(tap, student, false));
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// Tablet, sunucuya düşen okutmaları buradan öğrenir (okuyucu tablete bağlı değilse).
classroomApp.get('/classroom/api/pending', (req, res) => {
    tapCleanup();
    const taps = [];
    for (const t of pendingTaps.values()) {
        if (t.expires > Date.now()) {
            taps.push({
                tap_id: t.tap_id, child_id: t.child_id, student_name: t.student_name, created: t.created,
                has_class: !!t.session_id, class_name: t.class_name, start_time: t.start_time,
                end_time: t.end_time, inside: !!t.inside,
                expires_in: Math.round((t.expires - Date.now()) / 1000)
            });
        }
    }
    // En YENİ okutma ilk sırada: kapıda duran çocuk en son okutandır.
    taps.sort((a, b) => b.created - a.created);
    res.json({ success: true, taps });
});

// Öğrencinin seçimi. Kayıt tek kullanımlıktır.
classroomApp.post('/classroom/tap/:tap_id/choose', async (req, res) => {
    try {
        if (!classroomAuthorized(req)) {
            return res.status(401).json({ success: false, code: 'YETKISIZ', message: 'Okuyucu anahtarı geçersiz.' });
        }
        const choice = String((req.body && req.body.choice) || '').toUpperCase();
        const tap = pendingTaps.get(req.params.tap_id);
        if (!tap || tap.expires < Date.now()) {
            pendingTaps.delete(req.params.tap_id);
            return res.json({ success: false, code: 'SURE_DOLDU', message: 'Seçim süresi doldu, kartı tekrar okutun.' });
        }
        if (choice !== 'DERS' && choice !== 'OYUN') {
            return res.json({ success: false, code: 'GECERSIZ_SECIM', message: 'Geçersiz seçim.' });
        }
        pendingTaps.delete(tap.tap_id);
        res.json(choice === 'DERS' ? await classroomClassTap(tap) : await classroomPlayAreaEntry(tap));
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// ---- Sınıf ekranının salt okunur uçları ----
classroomApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'classroom.html')));
classroomApp.get('/classroom', (req, res) => res.sendFile(path.join(__dirname, 'public', 'classroom.html')));

// Sınıf tabletinde öğrenci arama. Kasada gereken veli telefonu gibi alanlar burada
// DÖNMEZ: tablette yalnızca ad ve puan görünür.
classroomApp.get('/classroom/api/students/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ success: true, students: [] });
        const needle = sheetsLib.fold(q);
        const rows = await dbAll(`SELECT child_id, student_name, wallet_balance FROM students WHERE status = 'Aktif' ORDER BY student_name LIMIT 500`);
        const students = rows
            .filter(s => sheetsLib.fold(s.student_name).indexOf(needle) !== -1)
            .slice(0, 20)
            .map(s => ({ child_id: s.child_id, student_name: s.student_name, wallet_balance: Number(s.wallet_balance || 0) }));
        res.json({ success: true, students });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.get('/classroom/api/leaderboard/weekly', async (req, res) => {
    try {
        res.json({ success: true, ...(await weeklyLeaderboardData()) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.get('/classroom/api/today', async (req, res) => {
    try {
        res.json({ success: true, ...(await todaySessionsData()) });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.get('/classroom/api/passport/:child_id', async (req, res) => {
    try {
        const child_id = req.params.child_id;
        const student = await dbGet(`SELECT child_id, student_name, parent_name, parent_phone, wallet_balance FROM students WHERE child_id = ?`, [child_id]);
        if (!student) return res.json({ success: false, message: 'Öğrenci bulunamadı.' });
        const tasks = await dbAll(`
            SELECT t.task_id, t.name, t.description, t.points, t.status,
                   s.puan AS kazanilan_puan, s.tamamlanma_tarihi, s.personel AS yapan
            FROM tasks t
            LEFT JOIN student_tasks s ON s.task_id = t.task_id AND s.child_id = ?
            WHERE t.status = 'Aktif' ORDER BY t.name`, [child_id]);
        const toplam = await dbGet(`SELECT COALESCE(SUM(puan), 0) AS toplam FROM student_tasks WHERE child_id = ?`, [child_id]);
        res.json({
            success: true,
            student: { ...student, wallet_balance: Number(student.wallet_balance || 0) },
            tasks: tasks.map(t => ({ ...t, tamamlandi: !!t.tamamlanma_tarihi })),
            toplam_puan: Number(toplam.toplam || 0)
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.post('/classroom/api/passport/complete', async (req, res) => {
    const { child_id, task_id, personel, note } = req.body || {};
    if (!child_id || !task_id) return res.json({ success: false, message: 'Öğrenci ve görev seçilmeli.' });
    try {
        const out = await withTransaction(async () => {
            const student = await dbGet(`SELECT * FROM students WHERE child_id = ?`, [child_id]);
            if (!student) throw new Error('Öğrenci bulunamadı.');
            const task = await dbGet(`SELECT * FROM tasks WHERE task_id = ?`, [task_id]);
            if (!task) throw new Error('Görev bulunamadı.');
            const already = await dbGet(`SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?`, [child_id, task_id]);
            if (already) throw new Error('Bu görev bu öğrenci için zaten işaretlenmiş.');
            const puan = Number(task.points || 0);
            await dbRun(`INSERT INTO student_tasks (child_id, task_id, puan, tamamlanma_tarihi, personel, note) VALUES (?, ?, ?, ?, ?, ?)`,
                [child_id, task_id, puan, new Date().toISOString(), personel || 'Sınıf', note || '']);
            const bal = await grantPoints(child_id, puan, 'Görev tamamlandı: ' + task.name, { task_id, personel });
            return { puan, bakiye: bal ? bal.yeni : Number(student.wallet_balance || 0), task_name: task.name };
        });
        res.json({ success: true, puan: out.puan, yeni_bakiye: out.bakiye, message: out.task_name + ' tamamlandı: +' + out.puan + ' puan (bakiye ' + out.bakiye + ').' });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.post('/classroom/api/passport/uncomplete', async (req, res) => {
    const { child_id, task_id, personel } = req.body || {};
    if (!child_id || !task_id) return res.json({ success: false, message: 'Öğrenci ve görev seçilmeli.' });
    try {
        const out = await withTransaction(async () => {
            const row = await dbGet(`SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?`, [child_id, task_id]);
            if (!row) throw new Error('Bu görev bu öğrenci için işaretlenmemiş.');
            const task = await dbGet(`SELECT name FROM tasks WHERE task_id = ?`, [task_id]);
            await dbRun(`DELETE FROM student_tasks WHERE id = ?`, [row.id]);
            const bal = await grantPoints(child_id, -Number(row.puan || 0), 'Görev geri alındı: ' + ((task && task.name) || task_id), { task_id, personel });
            return { bakiye: bal ? bal.yeni : 0 };
        });
        res.json({ success: true, yeni_bakiye: out.bakiye, message: 'Görev geri alındı.' });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

classroomApp.get('/classroom/api/profil/:child_id', async (req, res) => {
    try {
        const student = await dbGet(`SELECT child_id, student_name, wallet_balance, rfid_id FROM students WHERE child_id = ?`, [req.params.child_id]);
        if (!student) return res.json({ success: false, message: 'Öğrenci bulunamadı.' });
        const inside = await dbGet(`SELECT log_id, entry_time FROM logs WHERE child_id = ? AND status = 'AÇIK'`, [req.params.child_id]);
        const bugun = await dbAll(`SELECT t.name, t.points FROM tasks t WHERE t.status = 'Aktif' ORDER BY t.name`);
        const yapilan = await dbAll(`SELECT task_id FROM student_tasks WHERE child_id = ?`, [req.params.child_id]);
        const yapilanSet = {};
        yapilan.forEach(y => { yapilanSet[y.task_id] = true; });
        res.json({
            success: true,
            student: { ...student, wallet_balance: Number(student.wallet_balance || 0) },
            iceride: !!inside,
            gorevler: bugun.map(t => ({ ...t })),
            yapilan: Object.keys(yapilanSet)
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

// =====================================================================================
//  GOOGLE E-TABLO EŞİTLEMESİ
//  Ders tanımları, haftalık seanslar ve öğrenci listesi e-tablodan okunur.
//  Kural: e-tablo yalnızca KENDİ oluşturduğu satırlara dokunur (kaynak='SHEET').
//  Kasiyerin elle açtığı kayıtlar (kaynak='MANUEL') eşitlemeden etkilenmez.
// =====================================================================================

function sheetsTabNames() {
    const t = (v, d) => String(v == null || v === '' ? d : v).trim() || d;
    return {
        dersler: t(appSettings.sheets_tab_dersler, 'Dersler'),
        program: t(appSettings.sheets_tab_program, 'Program'),
        kayitlar: t(appSettings.sheets_tab_kayitlar, 'Kayitlar')
    };
}

function nowIso() { return new Date().toISOString(); }

// E-tablodaki öğrenci satırını uygulamadaki öğrenciye bağlar.
// Kart numarası birincil anahtardır; yoksa ada göre (tek eşleşme şartıyla) aranır.
async function resolveSheetStudent(reg) {
    const all = await dbAll(`SELECT child_id, student_name, rfid_id, status FROM students`);
    if (reg.rfid) {
        const wanted = normCard(reg.rfid);
        const byCard = all.find(s => normCard(s.rfid_id) === wanted);
        if (byCard) return { child: byCard };
        if (reg.student_name) {
            const byName = all.filter(s => sheetsLib.fold(s.student_name) === sheetsLib.fold(reg.student_name));
            if (byName.length === 1) return { child: byName[0], uyari: 'Kart no eşleşmedi, ada göre bağlandı: ' + reg.student_name };
            if (byName.length > 1) return { error: 'OGRENCI_BELIRSIZ', mesaj: '"' + reg.rfid + '" kartı tanımsız; "' + reg.student_name + '" adına birden fazla kayıt var.' };
        }
        return { error: 'KART_TANIMSIZ', mesaj: '"' + reg.rfid + '" kartı hiçbir öğrenciye tanımlı değil (' + (reg.student_name || 'ad yok') + ').' };
    }
    const byName = all.filter(s => sheetsLib.fold(s.student_name) === sheetsLib.fold(reg.student_name));
    if (byName.length === 0) return { error: 'OGRENCI_YOK', mesaj: '"' + reg.student_name + '" adında öğrenci bulunamadı.' };
    if (byName.length > 1) return { error: 'OGRENCI_BELIRSIZ', mesaj: '"' + reg.student_name + '" adına birden fazla kayıt var; Kart No yazın.' };
    if (!byName[0].rfid_id) return { child: byName[0], uyari: '"' + reg.student_name + '" için Kart No yok; sınıf okuyucusu bu çocuğu tanıyamaz.' };
    return { child: byName[0] };
}

/**
 * Doğrulanmış planı veritabanına uygular. dryRun=true ise hiçbir şey yazılmaz;
 * ne değişeceğinin sayıları döner (admin panelindeki ÖNİZLEME bunu kullanır).
 */
async function applySheetsPlan(plan, { dryRun = false } = {}) {
    const seen = { classes: new Set(), sessions: new Set(), regs: new Set() };
    const ch = {
        ders_eklenen: 0, ders_guncellenen: 0, ders_pasif: 0,
        seans_eklenen: 0, seans_guncellenen: 0, seans_pasif: 0,
        kayit_eklenen: 0, kayit_guncellenen: 0, kayit_pasif: 0, atlanan: 0
    };
    const uyarilar = [];
    const ts = nowIso();

    const work = async () => {
        // ---- Dersler
        for (const c of plan.classes) {
            const key = 'C:' + c.key;
            seen.classes.add(key);
            const ex = await dbGet(`SELECT * FROM classes WHERE sheet_key = ?`, [key]);
            if (!ex) {
                ch.ders_eklenen++;
                await dbRun(
                    `INSERT INTO classes (class_id, name, description, monthly_fee, term_fee, status, kaynak, sheet_key, son_gorulme, created_at) VALUES (?, ?, ?, ?, ?, ?, 'SHEET', ?, ?, ?)`,
                    ['CLS-SHT-' + Date.now() + '-' + Math.floor(Math.random() * 1000), c.name, c.description, c.monthly_fee, c.term_fee, c.status, key, ts, ts]);
            } else {
                const degisti = ex.name !== c.name || Number(ex.monthly_fee) !== Number(c.monthly_fee) ||
                    Number(ex.term_fee) !== Number(c.term_fee) || ex.status !== c.status ||
                    String(ex.description || '') !== String(c.description || '') || ex.kaynak !== 'SHEET';
                if (degisti) ch.ders_guncellenen++;
                await dbRun(
                    `UPDATE classes SET name=?, description=?, monthly_fee=?, term_fee=?, status=?, kaynak='SHEET', son_gorulme=? WHERE class_id=?`,
                    [c.name, c.description, c.monthly_fee, c.term_fee, c.status, ts, ex.class_id]);
            }
        }
        // e-tablodan çıkarılan dersler silinmez, pasife alınır
        const clsRows = await dbAll(`SELECT class_id, sheet_key, status, name FROM classes WHERE kaynak = 'SHEET'`);
        for (const r of clsRows) {
            if (!seen.classes.has(r.sheet_key)) {
                if (r.status !== 'Pasif') { ch.ders_pasif++; await dbRun(`UPDATE classes SET status='Pasif', son_gorulme=? WHERE class_id=?`, [ts, r.class_id]); }
                seen.classes.add(r.sheet_key);
            }
        }

        // ---- Seanslar
        for (const s of plan.sessions) {
            const key = 'S:' + s.key;
            seen.sessions.add(key);
            const cls = await dbGet(`SELECT class_id FROM classes WHERE sheet_key = ?`, ['C:' + s.class_key]);
            if (!cls) { ch.atlanan++; continue; }
            const ex = await dbGet(`SELECT * FROM sessions WHERE sheet_key = ?`, [key]);
            if (!ex) {
                ch.seans_eklenen++;
                await dbRun(
                    `INSERT INTO sessions (session_id, class_id, day_of_week, start_time, end_time, capacity, status, kaynak, sheet_key, son_gorulme, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'SHEET', ?, ?, ?)`,
                    ['SES-SHT-' + Date.now() + '-' + Math.floor(Math.random() * 1000), cls.class_id, s.day, sheetsLib.minutesToClock(s.start), sheetsLib.minutesToClock(s.end), s.capacity, s.status, key, ts, ts]);
            } else {
                const degisti = ex.class_id !== cls.class_id || Number(ex.day_of_week) !== s.day ||
                    ex.start_time !== sheetsLib.minutesToClock(s.start) || ex.end_time !== sheetsLib.minutesToClock(s.end) ||
                    Number(ex.capacity) !== s.capacity || ex.status !== s.status;
                if (degisti) ch.seans_guncellenen++;
                await dbRun(
                    `UPDATE sessions SET class_id=?, day_of_week=?, start_time=?, end_time=?, capacity=?, status=?, kaynak='SHEET', son_gorulme=? WHERE session_id=?`,
                    [cls.class_id, s.day, sheetsLib.minutesToClock(s.start), sheetsLib.minutesToClock(s.end), s.capacity, s.status, ts, ex.session_id]);
            }
        }
        const sesRows = await dbAll(`SELECT session_id, sheet_key, status FROM sessions WHERE kaynak = 'SHEET'`);
        for (const r of sesRows) {
            if (!seen.sessions.has(r.sheet_key)) {
                if (r.status !== 'Pasif') { ch.seans_pasif++; await dbRun(`UPDATE sessions SET status='Pasif', son_gorulme=? WHERE session_id=?`, [ts, r.session_id]); }
                seen.sessions.add(r.sheet_key);
            }
        }

        // ---- Kayıtlar
        for (const reg of plan.registrations) {
            const key = 'R:' + reg.key;
            seen.regs.add(key);
            const resolved = await resolveSheetStudent(reg);
            if (resolved.error) {
                ch.atlanan++;
                uyarilar.push({ kod: resolved.error, mesaj: resolved.mesaj, satir: reg.__satir });
                continue;
            }
            if (resolved.uyari) uyarilar.push({ kod: 'UYARI', mesaj: resolved.uyari, satir: reg.__satir });
            const ses = await dbGet(`SELECT s.*, c.name AS class_name, c.monthly_fee AS class_monthly_fee, c.term_fee AS class_term_fee FROM sessions s JOIN classes c ON c.class_id = s.class_id WHERE s.sheet_key = ?`, ['S:' + reg.session_key]);
            if (!ses) { ch.atlanan++; continue; }

            const ex = await dbGet(`SELECT * FROM class_registrations WHERE sheet_key = ?`, [key]);
            if (!ex) {
                ch.kayit_eklenen++;
                await dbRun(
                    `INSERT INTO class_registrations (reg_id, child_id, session_id, payment_type, fee, start_date, end_date, status, not_alani, sheet_not, personel, kaynak, sheet_key, odeme_durumu, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'E-Tablo', 'SHEET', ?, 'BEKLIYOR', ?)`,
                    ['KAY-SHT-' + Date.now() + '-' + Math.floor(Math.random() * 1000), resolved.child.child_id, ses.session_id,
                        reg.payment_type || 'AYLIK', reg.payment_type === 'DÖNEMLİK' ? Number(ses.class_term_fee || 0) : Number(ses.class_monthly_fee || 0),
                        reg.start_date || localDateStr(), reg.end_date || null, reg.status, reg.note || '', reg.note || '', key, ts]);
            } else {
                const degisti = String(ex.child_id) !== String(resolved.child.child_id) || String(ex.session_id) !== String(ses.session_id) ||
                    ex.status !== reg.status || String(ex.start_date || '') !== String(reg.start_date || localDateStr()) ||
                    String(ex.end_date || '') !== String(reg.end_date || '') || (reg.payment_type && ex.payment_type !== reg.payment_type) ||
                    String(ex.sheet_not || '') !== String(reg.note || '');
                if (degisti) ch.kayit_guncellenen++;
                await dbRun(
                    `UPDATE class_registrations SET child_id=?, session_id=?, payment_type=?, start_date=?, end_date=?, status=?, kaynak='SHEET', son_gorulme=?, sheet_not=? WHERE reg_id=?`,
                    [resolved.child.child_id, ses.session_id, reg.payment_type || ex.payment_type,
                        reg.start_date || ex.start_date, reg.end_date || null, reg.status, ts, reg.note || '', ex.reg_id]);
            }
        }
        const regRows = await dbAll(`SELECT reg_id, sheet_key, status FROM class_registrations WHERE kaynak = 'SHEET'`);
        for (const r of regRows) {
            if (!seen.regs.has(r.sheet_key)) {
                if (r.status !== 'Pasif') { ch.kayit_pasif++; await dbRun(`UPDATE class_registrations SET status='Pasif', son_gorulme=? WHERE reg_id=?`, [ts, r.reg_id]); }
                seen.regs.add(r.sheet_key);
            }
        }
    };

    // Önizleme (dryRun) gerçek işi yapıp SONUNDA GERİ ALIR. Böylece bir dersin ardından
    // gelen seans/kayıt satırları da doğru çözümlenir (yazmadan çözümlenemezlerdi) ve
    // hiçbir değişiklik kalıcı olmaz.
    if (dryRun) {
        await withWriteLock(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                await work();
            } finally {
                await dbRun('ROLLBACK');
            }
        });
    } else {
        await withTransaction(work);
    }

    return { dryRun: !!dryRun, ...ch, uyarilar };
}

let sheetsSyncRunning = false;

async function runSheetsSync({ dryRun = false } = {}) {
    const url = String(appSettings.sheets_url || '').trim();
    if (!url) return { success: false, code: 'AYAR_YOK', message: 'E-tablo bağlantısı tanımlı değil (Admin Paneli > E-Tablo).' };
    if (sheetsSyncRunning) return { success: false, code: 'CALISIYOR', message: 'Eşitleme zaten çalışıyor.' };

    sheetsSyncRunning = true;
    const t0 = Date.now();
    let logId = null;
    try {
        const tabs = sheetsTabNames();
        const fetched = await sheetsLib.fetchTabs({
            url, apiKey: String(appSettings.sheets_api_key || '').trim(), tabs,
            log: (m) => console.log('[E-TABLO] ' + m)
        });
        const plan = sheetsLib.buildPlan(fetched.tabs, tabs);
        const applied = await applySheetsPlan(plan, { dryRun });

        if (!dryRun) {
            logId = 'SYN-' + Date.now();
            await withWriteLock(() => dbRun(
                `INSERT INTO sheets_sync_log (sync_id, tarih, kaynak, durum, ders, seans, kayit, eklenen, guncellenen, pasif, atlanan, hata, uyari, sure_ms, mesaj) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [logId, nowIso(), fetched.source, plan.errors.length ? 'UYARI' : 'TAMAM',
                    plan.ozet.ders, plan.ozet.seans, plan.ozet.kayit,
                    applied.ders_eklenen + applied.seans_eklenen + applied.kayit_eklenen,
                    applied.ders_guncellenen + applied.seans_guncellenen + applied.kayit_guncellenen,
                    applied.ders_pasif + applied.seans_pasif + applied.kayit_pasif,
                    applied.atlanan, plan.errors.length, applied.uyarilar.length, Date.now() - t0,
                    'E-tablo okundu (' + fetched.source + ')']));
            for (const e of plan.errors) {
                await withWriteLock(() => dbRun(
                    `INSERT INTO sheets_sync_errors (sync_id, sekme, satir, sutun, kod, mesaj) VALUES (?, ?, ?, ?, ?, ?)`,
                    [logId, e.sekme, e.satir, e.sutun || '', e.kod, e.mesaj]));
            }
            for (const w of applied.uyarilar) {
                await withWriteLock(() => dbRun(
                    `INSERT INTO sheets_sync_errors (sync_id, sekme, satir, sutun, kod, mesaj) VALUES (?, ?, ?, '', ?, ?)`,
                    [logId, 'Kayitlar', w.satir || '', w.kod, w.mesaj]));
            }
            appSettings.sheets_last_sync = nowIso();
            appSettings.sheets_last_status = 'TAMAM (' + plan.ozet.ders + ' ders, ' + plan.ozet.seans + ' seans, ' + plan.ozet.kayit + ' kayıt, ' + plan.errors.length + ' hata)';
            await withWriteLock(async () => {
                await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sheets_last_sync', ?)`, [appSettings.sheets_last_sync]);
                await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sheets_last_status', ?)`, [appSettings.sheets_last_status]);
            });
        }

        return {
            success: true, dryRun: !!dryRun, kaynak: fetched.source, sync_id: logId,
            ozet: plan.ozet, degisiklik: applied, hatalar: plan.errors, uyarilar: applied.uyarilar,
            sure_ms: Date.now() - t0
        };
    } catch (err) {
        if (!dryRun) {
            try {
                await withWriteLock(() => dbRun(
                    `INSERT INTO sheets_sync_log (sync_id, tarih, kaynak, durum, ders, seans, kayit, eklenen, guncellenen, pasif, atlanan, hata, uyari, sure_ms, mesaj) VALUES (?, ?, '', 'HATA', 0,0,0,0,0,0,0,1,0,?,?)`,
                    ['SYN-ERR-' + Date.now(), nowIso(), Date.now() - t0, String(err.message || err).slice(0, 400)]));
                appSettings.sheets_last_status = 'HATA: ' + String(err.message || err).slice(0, 200);
                await withWriteLock(() => dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sheets_last_status', ?)`, [appSettings.sheets_last_status]));
            } catch (e2) { console.error('[E-TABLO] hata kaydı yazılamadı:', e2.message); }
        }
        return { success: false, code: 'OKUNAMADI', message: String(err.message || err), sure_ms: Date.now() - t0 };
    } finally {
        sheetsSyncRunning = false;
    }
}

let sheetsTimer = null;
function scheduleSheetsSync() {
    if (sheetsTimer) clearInterval(sheetsTimer);
    const mins = Math.max(1, Number(appSettings.sheets_sync_minutes || 5));
    sheetsTimer = setInterval(async () => {
        if (Number(appSettings.sheets_enabled) !== 1) return;
        const out = await runSheetsSync();
        if (!out.success) console.error('[E-TABLO] eşitleme başarısız:', out.message);
        else if (out.hatalar && out.hatalar.length) console.log('[E-TABLO] eşitleme ' + out.hatalar.length + ' satır hatasıyla tamamlandı.');
    }, mins * 60000);
    if (sheetsTimer.unref) sheetsTimer.unref();
    return sheetsTimer;
}

app.get('/api/sheets/status', async (req, res) => {
    try {
        const son = await dbAll(`SELECT * FROM sheets_sync_log ORDER BY tarih DESC LIMIT 5`);
        res.json({
            success: true,
            enabled: Number(appSettings.sheets_enabled) === 1,
            url: appSettings.sheets_url || '',
            has_api_key: !!String(appSettings.sheets_api_key || '').trim(),
            sync_minutes: Number(appSettings.sheets_sync_minutes || 5),
            classroom_port: Number(appSettings.classroom_port || 3001),
            tabs: sheetsTabNames(),
            last_sync: appSettings.sheets_last_sync || '',
            last_status: appSettings.sheets_last_status || '',
            son_esitlemeler: son
        });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.get('/api/sheets/errors', async (req, res) => {
    try {
        const son = await dbGet(`SELECT sync_id FROM sheets_sync_log ORDER BY tarih DESC LIMIT 1`);
        if (!son) return res.json({ success: true, errors: [] });
        const rows = await dbAll(`SELECT * FROM sheets_sync_errors WHERE sync_id = ? ORDER BY sekme, satir LIMIT 500`, [son.sync_id]);
        res.json({ success: true, sync_id: son.sync_id, errors: rows });
    } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/sheets/preview', async (req, res) => {
    try { res.json(await runSheetsSync({ dryRun: true })); }
    catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/api/sheets/sync', async (req, res) => {
    try { res.json(await runSheetsSync({ dryRun: false })); }
    catch (err) { res.json({ success: false, message: err.message }); }
});

if (require.main === module) {
    scheduleDailyReport();
    scheduleClassJobs();
    scheduleSheetsSync();

    // Kasiyer arayüzü
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Üreten Çocuk KASA arayüzü: http://localhost:${PORT}`);
    });

    // Sınıf arayüzü (ayrı port, ayrı uç kümesi). Kasiyer uçları burada yoktur.
    const classroomPort = process.env.CLASSROOM_PORT
        ? Number(process.env.CLASSROOM_PORT)
        : Number(appSettings.classroom_port || 3001);
    if (classroomPort && classroomPort !== PORT) {
        classroomApp.listen(classroomPort, '0.0.0.0', () => {
            console.log(`Üreten Çocuk SINIF arayüzü: http://localhost:${classroomPort}  (yalnızca liderlik, pasaport, RFID)`);
            if (!String(appSettings.classroom_reader_token || '').trim()) {
                console.warn('[UYARI] classroom_reader_token tanımlı değil: sınıf portuna ağdan erişen herkes okutma gönderebilir.');
            }
        });
    }
}

module.exports = {
    app,
    db,
    DATABASE_PATH,
    PORT,
    PRINTER_NAME,
    PRINT_COPIES,
    SLIP_TMP_DIR,
    appSettings,
    calculateFee,
    calculateAge,
    updateExpiredRights,
    generateExcelBuffer,
    sendServerPrint,
    // yazma katmanı (testler için)
    withWriteLock,
    withTransaction,
    drainWrites,
    dbRun,
    dbGet,
    dbAll,
    // ders / pasaport yardımcıları (testler için)
    localDateStr,
    dayOfWeek,
    minutesOf,
    registrationCoversDate,
    findCurrentClassSession,
    grantPoints,
    createCompensationRight,
    grantAbsenceCompensation,
    absenceMessage,
    processClassAbsences,
    DAY_NAMES,
    weeklyLeaderboardData,
    todaySessionsData,
    reportTotals,
    logDurum,
    IPTAL_TIPI,
    // sınıf arayüzü
    classroomApp,
    pendingTaps,
    findStudentByCard,
    classroomClassTap,
    classroomPlayAreaEntry,
    tapCleanup,
    // e-tablo eşitlemesi
    sheetsLib,
    sheetsTabNames,
    resolveSheetStudent,
    applySheetsPlan,
    runSheetsSync,
    scheduleSheetsSync
};