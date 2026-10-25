'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

/** Unique throwaway database path for one test file (Jest gives each file its own module registry). */
function makeTempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-test-'));
    return path.join(dir, 'database.db');
}

function openDb(dbPath) {
    const db = new sqlite3.Database(dbPath);
    // The app holds real write locks during a transaction; an independent harness connection
    // must wait for them instead of failing instantly with SQLITE_BUSY.
    db.configure('busyTimeout', 5000);
    // An EventEmitter 'error' with no listener is thrown as an uncaught exception, which Jest
    // then reports as "Test suite failed to run" against an arbitrary file.
    db.on('error', (e) => console.error('[HARNESS DB ERROR]', (e && e.message) || e));
    return db;
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); });
    });
}

function closeDb(db) {
    return new Promise((resolve) => {
        if (!db) return resolve();
        // Give any pending statement a moment to finish: closing a handle with work in flight
        // surfaces as a late SQLITE_BUSY error event.
        setTimeout(() => {
            try {
                db.close(() => resolve());
            } catch (e) {
                resolve();
            }
        }, 10);
    });
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const EXPECTED_TABLES = ['students', 'logs', 'rights', 'right_movements', 'settings', 'staff', 'bonus_packages',
    'classes', 'sessions', 'class_registrations', 'class_attendance', 'tasks', 'student_tasks', 'wallet_movements',
    'sheets_sync_log', 'sheets_sync_errors', 'oturumlar'];

/**
 * Every column the current application code reads or writes. Boot migrations must deliver all of
 * these on a fresh database as well as on one created by an older version of the app.
 */
const EXPECTED_COLUMNS = {
    students: ['child_id', 'cari_turu', 'student_name', 'birth_date', 'parent_name', 'parent_phone', 'note', 'created_at', 'status', 'rfid_id', 'wallet_balance'],
    logs: ['log_id', 'tarih', 'child_id', 'student_name', 'parent_name', 'action', 'entry_time', 'duration_min', 'paketten_dusen', 'personel', 'status', 'payment_status', 'fee', 'payment_type', 'payment_date', 'source_summary', 'hak_id', 'is_paused', 'paused_at', 'total_pause_duration', 'kullanilan_puan', 'puan_indirimi', 'kazanilan_puan'],
    rights: ['hak_id', 'child_id', 'hak_tipi', 'miktar_dk', 'kalan_dk', 'kaynak', 'tanim_tarihi', 'son_kullanma', 'durum', 'satis_tutari', 'odeme_tipi', 'not_alani', 'personel', 'kalan_ana_para', 'kalan_bonus'],
    right_movements: ['hareket_id', 'tarih', 'child_id', 'hak_id', 'islem', 'hak_tipi', 'degisim_dk', 'onceki_kalan_dk', 'yeni_kalan_dk', 'kaynak', 'aciklama', 'log_id', 'personel'],
    settings: ['key', 'value'],
    staff: ['id', 'name', 'pin_hash', 'pin_salt', 'pin_uzunluk', 'olusturma'],
    bonus_packages: ['id', 'sales_amount', 'bonus_amount'],
    classes: ['class_id', 'name', 'description', 'monthly_fee', 'term_fee', 'status', 'kaynak', 'sheet_key', 'son_gorulme', 'created_at'],
    sessions: ['session_id', 'class_id', 'day_of_week', 'start_time', 'end_time', 'capacity', 'status', 'kaynak', 'sheet_key', 'son_gorulme', 'created_at'],
    class_registrations: ['reg_id', 'child_id', 'session_id', 'payment_type', 'fee', 'start_date', 'end_date', 'status', 'not_alani', 'personel', 'kaynak', 'sheet_key', 'son_gorulme', 'odeme_durumu', 'sheet_not', 'created_at'],
    class_attendance: ['attendance_id', 'child_id', 'session_id', 'class_id', 'tarih', 'durum', 'giris_zamani', 'cikis_zamani', 'telafi_hak_id', 'personel', 'created_at'],
    tasks: ['task_id', 'name', 'description', 'points', 'status', 'created_at'],
    student_tasks: ['id', 'child_id', 'task_id', 'puan', 'tamamlanma_tarihi', 'personel', 'note'],
    wallet_movements: ['hareket_id', 'child_id', 'tarih', 'tip', 'puan', 'onceki_bakiye', 'yeni_bakiye', 'aciklama', 'task_id', 'log_id', 'personel'],
    sheets_sync_log: ['sync_id', 'tarih', 'kaynak', 'durum', 'ders', 'seans', 'kayit', 'eklenen', 'guncellenen', 'pasif', 'atlanan', 'hata', 'uyari', 'sure_ms', 'mesaj'],
    sheets_sync_errors: ['id', 'sync_id', 'sekme', 'satir', 'sutun', 'kod', 'mesaj'],
};

const EXPECTED_INDEXES = [
    'idx_logs_child_status', 'idx_logs_status', 'idx_logs_tarih_status', 'idx_rights_child',
    'idx_right_movements_child', 'idx_right_movements_log', 'idx_right_movements_hak', 'idx_students_rfid',
    'idx_rights_expiry',
    'idx_sessions_class', 'idx_regs_child', 'idx_regs_session', 'uq_attendance',
    'idx_attendance_tarih', 'idx_student_tasks_child', 'idx_wallet_child',
    'uq_classes_sheet', 'uq_sessions_sheet', 'uq_regs_sheet', 'idx_sync_log_tarih',
];

/**
 * The app writes its settings defaults inside an async callback during boot. A test that runs
 * before those land sees a half-seeded settings table (that is a real bug that showed up once).
 */
const EXPECTED_SETTINGS = [
    'base_rate', 'hourly_rate', 'extra_rate', 'telafi_expiry_days',
    'point_tl_rate', 'oyun_alani_seans_dk', 'class_early_minutes', 'class_late_minutes',
    'classroom_port', 'rfid_dedup_seconds', 'tap_prompt_seconds',
    'sheets_enabled', 'sheets_sync_minutes', 'sheets_tab_dersler', 'sheets_tab_program', 'sheets_tab_kayitlar',
    'tekrar_pin_sor',
];

/**
 * Poll until the boot migrations have finished: every table exists, settings are seeded, and
 * every column the app expects is present. Waiting for columns - not just tables - is what makes
 * the schema assertions deterministic, because ADD COLUMN work runs inside async callbacks.
 */
async function waitForSchema(dbPath, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    const db = openDb(dbPath);
    try {
        while (Date.now() < deadline) {
            try {
                const names = (await all(db, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
                if (EXPECTED_TABLES.every((t) => names.includes(t))) {
                    const settingKeys = (await all(db, 'SELECT key FROM settings')).map((r) => r.key);
                    if (EXPECTED_SETTINGS.every((k) => settingKeys.includes(k))) {
                        let ready = true;
                        for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
                            const present = (await all(db, `PRAGMA table_info(${table})`)).map((c) => c.name);
                            if (!cols.every((c) => present.includes(c))) { ready = false; break; }
                        }
                        // The app creates its indexes only after every column exists; a test that
                        // queries while those CREATE INDEX statements are still running can hit
                        // SQLITE_BUSY, so readiness includes them.
                        if (ready) {
                            const indexes = (await all(db, "SELECT name FROM sqlite_master WHERE type='index'")).map((i) => i.name);
                            if (!EXPECTED_INDEXES.every((i) => indexes.includes(i))) ready = false;
                        }
                        if (ready) return true;
                    }
                }
            } catch (e) {
                // Still migrating, or a statement collided with the boot DDL: just poll again.
                // Letting this escape would fail the whole suite in beforeAll.
            }
            await sleep(50);
        }
    } finally {
        await closeDb(db);
    }
    throw new Error('Timed out waiting for boot migrations at ' + dbPath);
}

/** Read the slip file that sendServerPrint() handed to the (mocked) printer. */
function readSlipFile(call) {
    const [filePath] = call;
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Oturum açmış bir supertest aracısı döner.
 *
 * Uygulamanın tüm uçları artık oturum ister; testler bu denetimi KAPATMAZ, gerçek giriş
 * yolunu kullanır. Personel tablosu boşken /api/auth/setup ilk yöneticiyi tanımlar.
 */
async function authedAgent(app, pin = '1234') {
    const request = require('supertest');
    const agent = request.agent(app);
    const kurulum = await agent.post('/api/auth/setup').send({ name: 'Test Personel', pin });
    if (!kurulum.body || !kurulum.body.success) {
        await agent.post('/api/auth/login').send({ pin });
    }
    return agent;
}

module.exports = {
    makeTempDbPath, openDb, all, get, run, closeDb, sleep, waitForSchema, readSlipFile, authedAgent,
    EXPECTED_TABLES, EXPECTED_COLUMNS, EXPECTED_INDEXES, EXPECTED_SETTINGS,
};
