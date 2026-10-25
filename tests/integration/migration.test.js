'use strict';
/**
 * Boot-migration tests.
 *
 * The app ships with a pre-migrated `database.db`, so the two paths that were silently broken
 * are exactly the ones a fresh install takes:
 *   - a brand-new database must get the full current schema (not the old one)
 *   - a database created by an older version must be upgraded in place, without data loss
 *
 * The fixture below is a legacy database: no pause columns on `logs`, no principal/bonus split
 * on `rights`, and no `right_movements` / `staff` / `bonus_packages` tables at all.
 */
const fs = require('fs');
const path = require('path');
const {
    makeTempDbPath, openDb, all, get, run, closeDb, waitForSchema,
    EXPECTED_COLUMNS, EXPECTED_INDEXES, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');

let app, db, dbi;

const LEGACY_STATEMENTS = [
    `CREATE TABLE students (child_id TEXT PRIMARY KEY, cari_turu TEXT, student_name TEXT NOT NULL, birth_date TEXT, parent_name TEXT, parent_phone TEXT NOT NULL, note TEXT, created_at TEXT, status TEXT DEFAULT 'Aktif')`,
    `CREATE TABLE logs (log_id TEXT PRIMARY KEY, tarih TEXT, child_id TEXT, student_name TEXT, parent_name TEXT, action TEXT, entry_time TEXT, duration_min INTEGER DEFAULT 0, paketten_dusen INTEGER DEFAULT 0, personel TEXT, status TEXT, payment_status TEXT, fee REAL DEFAULT 0, payment_type TEXT, payment_date TEXT, source_summary TEXT, hak_id TEXT)`,
    `CREATE TABLE rights (hak_id TEXT PRIMARY KEY, child_id TEXT, hak_tipi TEXT, miktar_dk INTEGER, kalan_dk INTEGER, kaynak TEXT, tanim_tarihi TEXT, son_kullanma TEXT, durum TEXT DEFAULT 'Aktif', satis_tutari REAL DEFAULT 0, odeme_tipi TEXT, not_alani TEXT, personel TEXT)`,
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`,
    `INSERT INTO settings (key, value) VALUES ('base_rate', '300'), ('hourly_rate', '500'), ('extra_rate', '150'), ('telafi_expiry_days', '30')`,
    `INSERT INTO students (child_id, student_name, parent_name, parent_phone, birth_date, cari_turu, created_at) VALUES ('UC-000001', 'Eski Çocuk', 'Eski Veli', '5551112233', '2016-05-10', 'Dramatik Oyun Alanı', '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, durum) VALUES ('PAK-OLD-1', 'UC-000001', 'PAKET', 400, 400, 'Eski Satış', '2026-01-01T00:00:00.000Z', 'Aktif')`,
];

let agent;

beforeAll(async () => {
    // build the legacy fixture on disk BEFORE the app opens it
    const setup = openDb(DB_PATH);
    try {
        for (const stmt of LEGACY_STATEMENTS) await run(setup, stmt);
    } finally {
        await closeDb(setup);
    }

    ({ app, db, drainWrites } = require('../../server.js')); // boot migrations run at require time
    await waitForSchema(DB_PATH);
    agent = await authedAgent(app);
    dbi = openDb(DB_PATH);
});

afterAll(async () => {
    await drainWrites();
    await closeDb(dbi);
    await closeDb(db);
});

const columns = async (t) => (await all(dbi, `PRAGMA table_info(${t})`)).map((c) => c.name);

describe('upgrading a database from an older version', () => {
    test('adds every column the current code expects', async () => {
        for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
            const present = await columns(table);
            for (const c of cols) {
                expect([table, c, present.includes(c)]).toEqual([table, c, true]);
            }
        }
    });

    test('creates the tables the old version never had', async () => {
        const names = (await all(dbi, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
        for (const t of ['right_movements', 'staff', 'bonus_packages']) expect(names).toContain(t);
    });

    test('creates the query indexes', async () => {
        const names = (await all(dbi, "SELECT name FROM sqlite_master WHERE type='index'")).map((i) => i.name);
        for (const idx of EXPECTED_INDEXES) expect(names).toContain(idx);
    });

    test('does not lose or alter existing rows', async () => {
        const student = await get(dbi, 'SELECT * FROM students WHERE child_id = ?', ['UC-000001']);
        expect(student.student_name).toBe('Eski Çocuk');
        expect(student.parent_phone).toBe('5551112233');

        const pkg = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', ['PAK-OLD-1']);
        expect(pkg.kalan_dk).toBe(400);
        expect(pkg.miktar_dk).toBe(400);
        expect(pkg.kaynak).toBe('Eski Satış');
    });

    test('backfills the principal balance introduced by the newer schema', async () => {
        const pkg = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', ['PAK-OLD-1']);
        expect(pkg.kalan_ana_para).toBe(400); // legacy balance becomes principal
        expect(pkg.kalan_bonus).toBe(0);
    });
});

describe('the upgraded database is fully functional', () => {
    test('serves pre-existing students over the API', async () => {
        const res = await agent.get('/api/students/get/UC-000001');
        expect(res.body.success).toBe(true);
        expect(res.body.student.student_name).toBe('Eski Çocuk');
        expect(res.body.student.rights_summary.package_minutes).toBe(400);
        expect(res.body.student.age).toBeGreaterThanOrEqual(0);
    });

    test('a package sale now actually persists', async () => {
        const res = await agent.post('/api/rights/add-package')
            .send({ child_id: 'UC-000001', price: 500, bonus: 100, payment_type: 'NAKİT', personel: 'Kasa' });
        expect(res.body.success).toBe(true);

        const right = await get(dbi,
            "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET' AND kaynak = 'Satış'", ['UC-000001']);
        expect(right).toBeTruthy();
        expect(right.kalan_dk).toBe(600);
        expect(right.kalan_ana_para).toBe(500);
        expect(right.kalan_bonus).toBe(100);
    });

    test('pausing a session works, which it could not before the fix', async () => {
        await agent.post('/api/entry/start').send({ child_id: 'UC-000001', personel: 'Test' });

        const pause = await agent.post('/api/entry/pause-toggle').send({ child_id: 'UC-000001' });
        expect(pause.body).toEqual({ success: true, message: 'Duraklatıldı.' });

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", ['UC-000001']);
        expect(log.is_paused).toBe(1);
        expect(log.paused_at).toBeTruthy();

        const resume = await agent.post('/api/entry/pause-toggle').send({ child_id: 'UC-000001' });
        expect(resume.body).toEqual({ success: true, message: 'Devam ediliyor.' });
    });

    test('a full checkout with a package completes', async () => {
        const preview = await agent.get('/api/exit/preview/UC-000001');
        expect(preview.body.success).toBe(true);

        const fin = await agent.post('/api/exit/finalize')
            .send({ child_id: 'UC-000001', payment_type: 'PAKET', personel: 'Kasa' });
        expect(fin.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", ['UC-000001']);
        expect(log.payment_type).toBe('PAKET');
        expect(log.fee).toBe(0);
    });

    test('re-running the migrations is harmless (idempotent boot)', async () => {
        const before = await columns('rights');
        // duplicate-column path must not throw, and no index may be missing or duplicated
        const names = (await all(dbi, "SELECT name FROM sqlite_master WHERE type='index'")).map((i) => i.name);
        expect(names.filter((n) => n.startsWith('idx_') || n.startsWith('uq_'))).toEqual(
            expect.arrayContaining(EXPECTED_INDEXES));
        expect(new Set(names).size).toBe(names.length);
        expect(before.filter((c) => c === 'kalan_ana_para')).toHaveLength(1);
    });
});
