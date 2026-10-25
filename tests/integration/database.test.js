'use strict';
/**
 * Integration tests for the SQLite layer: boot migrations, schema shape, and every
 * table-touching endpoint asserted against the rows actually written to the database file
 * (read back on an independent connection, not through the API).
 */
const path = require('path');
const {
    makeTempDbPath, waitForSchema, openDb, get, all, closeDb, EXPECTED_TABLES, EXPECTED_INDEXES,
} = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db , drainWrites} = require('../../server.js');

let dbi;

beforeAll(async () => {
    await waitForSchema(DB_PATH);
    dbi = openDb(DB_PATH);
});

afterAll(async () => {
    await drainWrites();
    await closeDb(dbi);
    await closeDb(db);
});

async function createStudent(overrides = {}) {
    const res = await request(app).post('/api/students/create').send({
        student_name: 'Test Çocuk',
        parent_name: 'Test Veli',
        parent_phone: '5551234567',
        birth_date: '2016-05-10',
        cari_turu: 'Dramatik Oyun Alanı',
        ...overrides,
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

const countFor = async (table, childId) =>
    (await get(dbi, `SELECT COUNT(*) AS c FROM ${table} WHERE child_id = ?`, [childId])).c;

describe('schema & boot migrations', () => {
    test('creates every application table', async () => {
        const names = (await all(dbi, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
        for (const t of EXPECTED_TABLES) expect(names).toContain(t);
    });

    test('applies the later columns to existing tables', async () => {
        const cols = async (t) => (await all(dbi, `PRAGMA table_info(${t})`)).map((c) => c.name);
        expect(await cols('students')).toEqual(expect.arrayContaining(['child_id', 'cari_turu', 'status', 'rfid_id']));
        expect(await cols('logs')).toEqual(expect.arrayContaining(['personel', 'is_paused', 'paused_at', 'total_pause_duration']));
        expect(await cols('rights')).toEqual(expect.arrayContaining(['personel', 'kalan_ana_para', 'kalan_bonus']));
        expect(await cols('right_movements')).toEqual(expect.arrayContaining(['personel']));
    });

    test('creates the indexes the hot lookups depend on', async () => {
        const names = (await all(dbi, "SELECT name FROM sqlite_master WHERE type='index'")).map((i) => i.name);
        for (const idx of EXPECTED_INDEXES) expect(names).toContain(idx);
    });

    test('the RFID card lookup uses its index instead of scanning the table', async () => {
        const plan = await all(dbi, 'EXPLAIN QUERY PLAN SELECT * FROM students WHERE rfid_id = ?', ['CARD-X']);
        expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING (COVERING )?INDEX idx_students_rfid/);
    });

    test('does not advertise CORS to other origins', async () => {
        const res = await request(app).get('/api/settings').set('Origin', 'http://evil.example');
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    test('the open-session lookup uses its index instead of scanning the table', async () => {
        const plan = await all(dbi,
            "EXPLAIN QUERY PLAN SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", ['UC-000001']);
        expect(plan.map((p) => p.detail).join(' ')).toMatch(/USING (COVERING )?INDEX idx_logs_child_status/);
    });

    test('seeds pricing settings on a fresh database', async () => {
        const rows = await all(dbi, 'SELECT key, value FROM settings');
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        expect(Number(map.base_rate)).toBe(300);
        expect(Number(map.hourly_rate)).toBe(500);
        expect(Number(map.extra_rate)).toBe(150);
        expect(Number(map.telafi_expiry_days)).toBe(30);
    });
});

describe('settings', () => {
    test('GET /api/settings reflects the in-memory settings', async () => {
        const res = await request(app).get('/api/settings');
        expect(res.body.success).toBe(true);
        expect(res.body.settings.base_rate).toBe(300);
        expect(res.body.settings.exit_tolerance_minutes).toBe(5);
    });

    test('POST /api/settings/update persists to SQLite and to memory', async () => {
        const res = await request(app).post('/api/settings/update').send({
            base_rate: 111, hourly_rate: 222, extra_rate: 33,
            telafi_expiry_days: 10, package_expiry_days: 20, exit_tolerance_minutes: 7,
            telegram_token: '', telegram_chat_id: '',
        });
        expect(res.body.success).toBe(true);

        const row = await get(dbi, "SELECT value FROM settings WHERE key = 'base_rate'");
        expect(Number(row.value)).toBe(111);
        const tol = await get(dbi, "SELECT value FROM settings WHERE key = 'exit_tolerance_minutes'");
        expect(Number(tol.value)).toBe(7);

        const after = await request(app).get('/api/settings');
        expect(after.body.settings.base_rate).toBe(111);
        expect(after.body.settings.exit_tolerance_minutes).toBe(7);
    });
});

describe('students table', () => {
    test('create assigns a zero-padded child_id and persists the row', async () => {
        const a = await createStudent({ student_name: 'Zeynep' });
        const b = await createStudent({ student_name: 'Mert' });

        expect(a).toMatch(/^UC-\d{6}$/);
        expect(Number(b.slice(3))).toBe(Number(a.slice(3)) + 1);

        const row = await get(dbi, 'SELECT * FROM students WHERE child_id = ?', [a]);
        expect(row.student_name).toBe('Zeynep');
        expect(row.cari_turu).toBe('Dramatik Oyun Alanı');
        expect(row.status).toBe('Aktif');
        expect(row.created_at).toBeTruthy();
        expect(row.birth_date).toBe('2016-05-10');
    });

    test('falls back to the default cari_turu when omitted', async () => {
        const id = await createStudent({ cari_turu: undefined });
        const row = await get(dbi, 'SELECT cari_turu FROM students WHERE child_id = ?', [id]);
        expect(row.cari_turu).toBe('Dramatik Oyun Alanı');
    });

    test('GET /api/students returns rows enriched with age and a formatted date', async () => {
        const res = await request(app).get('/api/students');
        expect(res.body.success).toBe(true);
        expect(res.body.students.length).toBeGreaterThan(0);
        const s = res.body.students[0];
        expect(s).toHaveProperty('age');
        expect(s).toHaveProperty('created_at_fmt');
        expect(typeof s.age).toBe('number');
    });

    test('search matches by name and parent phone, case-insensitively', async () => {
        const id = await createStudent({ student_name: 'Aranan Çocuk', parent_phone: '5998877665' });

        const byName = await request(app).get('/api/students/search').query({ q: 'aranan' });
        expect(byName.body.students.map((s) => s.child_id)).toContain(id);

        const byPhone = await request(app).get('/api/students/search').query({ q: '5998877665' });
        expect(byPhone.body.students.map((s) => s.child_id)).toContain(id);
    });

    test('search matches a card id regardless of case', async () => {
        // The route lower-cases the whole query before using it, so the `rfid_id = ?`
        // comparison only matches cards that happen to be stored in lower case.
        const id = await createStudent({ student_name: 'Kart Arama Çocuk', rfid_id: 'CARD-FIND' });
        const res = await request(app).get('/api/students/search').query({ q: 'CARD-FIND' });
        expect(res.body.students.map((s) => s.child_id)).toContain(id);
    });

    test('GET /api/students/get/:id reports an empty rights summary when outside', async () => {
        const id = await createStudent({ student_name: 'Profil Çocuk' });
        const res = await request(app).get(`/api/students/get/${id}`);
        expect(res.body.success).toBe(true);
        expect(res.body.student.inside).toBe(false);
        expect(res.body.student.entry_time).toBeNull();
        expect(res.body.student.rights_summary).toEqual({ telafi_minutes: 0, package_minutes: 0, telafi_dersi_count: 0 });
        expect(typeof res.body.student.age).toBe('number');
    });

    test('GET /api/students/get/:id reports inside=true during a session', async () => {
        const id = await createStudent({ student_name: 'İçeride Çocuk' });
        await request(app).post('/api/entry/start').send({ child_id: id, personel: 'Test' });
        const res = await request(app).get(`/api/students/get/${id}`);
        expect(res.body.student.inside).toBe(true);
        expect(res.body.student.entry_time).toMatch(/^\d{2}:\d{2}$/);
    });

    test('unknown child_id is reported as not found', async () => {
        const res = await request(app).get('/api/students/get/UC-999999');
        expect(res.body).toEqual({ success: false, message: 'Öğrenci bulunamadı.' });
    });

    test('edit updates the row and provisions a telafi right', async () => {
        const id = await createStudent({ student_name: 'Eski Ad' });
        const res = await request(app).post('/api/students/edit').send({
            child_id: id, student_name: 'Yeni Ad', parent_name: 'Yeni Veli', parent_phone: '5000000000',
            birth_date: '2018-02-02', rfid_id: 'CARD-EDIT', note: 'not', cari_turu: 'Oyun Alanı',
            telafi_minutes: 90, package_minutes: 0, telafi_dersi_count: 0,
        });
        expect(res.body.success).toBe(true);

        const row = await get(dbi, 'SELECT * FROM students WHERE child_id = ?', [id]);
        expect(row.student_name).toBe('Yeni Ad');
        expect(row.rfid_id).toBe('CARD-EDIT');
        expect(row.cari_turu).toBe('Oyun Alanı');

        const rights = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(rights).toHaveLength(1);
        expect(rights[0].kalan_dk).toBe(90);
        expect(rights[0].durum).toBe('Aktif');
        expect(rights[0].son_kullanma).toBeTruthy();
    });

    test('editing telafi minutes again reuses the existing right instead of duplicating it', async () => {
        const id = await createStudent({ student_name: 'Tekrar Çocuk' });
        const payload = (minutes) => ({
            child_id: id, student_name: 'Tekrar Çocuk', parent_name: 'V', parent_phone: '5',
            birth_date: '2018-02-02', rfid_id: null, note: '', cari_turu: 'Oyun',
            telafi_minutes: minutes, package_minutes: 0, telafi_dersi_count: 0,
        });
        await request(app).post('/api/students/edit').send(payload(60));
        await request(app).post('/api/students/edit').send(payload(45));

        const rights = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(rights).toHaveLength(1);
        expect(rights[0].kalan_dk).toBe(45);
        expect(rights[0].miktar_dk).toBe(45);
    });

    test('editing can provision a package and makeup-lesson count', async () => {
        const id = await createStudent({ student_name: 'Paketli Çocuk' });
        await request(app).post('/api/students/edit').send({
            child_id: id, student_name: 'Paketli Çocuk', parent_name: 'V', parent_phone: '5',
            birth_date: '2018-02-02', rfid_id: null, note: '', cari_turu: 'Oyun',
            telafi_minutes: 0, package_minutes: 250, telafi_dersi_count: 2,
        });

        const pkg = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(pkg.kalan_dk).toBe(250);
        expect(pkg.kalan_ana_para).toBe(250);

        const ders = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ'", [id]);
        expect(ders).toHaveLength(2);
        ders.forEach((d) => expect(d.miktar_dk).toBe(1));
    });

    test('delete removes the student and cascades to logs, rights and movements', async () => {
        const id = await createStudent({ student_name: 'Silinecek Çocuk', rfid_id: 'CARD-DEL' });
        await request(app).post('/api/rights/add-telafi').send({ child_id: id, minutes: 30, personel: 'Test' });
        await request(app).post('/api/entry/start').send({ child_id: id, personel: 'Test' });

        expect(await countFor('logs', id)).toBeGreaterThan(0);
        expect(await countFor('rights', id)).toBeGreaterThan(0);
        expect(await countFor('right_movements', id)).toBeGreaterThan(0);

        const del = await request(app).post('/api/students/delete').send({ child_id: id });
        expect(del.body.success).toBe(true);

        expect(await countFor('students', id)).toBe(0);
        expect(await countFor('logs', id)).toBe(0);
        expect(await countFor('rights', id)).toBe(0);
        expect(await countFor('right_movements', id)).toBe(0);
    });

    test('delete without a child_id is rejected', async () => {
        const res = await request(app).post('/api/students/delete').send({});
        expect(res.body).toEqual({ success: false, message: 'Geçersiz öğrenci ID.' });
    });
});

describe('staff table', () => {
    test('add / verify / delete round-trips through SQLite', async () => {
        const add = await request(app).post('/api/staff/add').send({ pin: '1234', name: 'Ayşe' });
        expect(add.body.success).toBe(true);

        const row = await get(dbi, 'SELECT * FROM staff WHERE pin = ?', ['1234']);
        expect(row.name).toBe('Ayşe');

        const ok = await request(app).post('/api/staff/verify').send({ pin: '1234' });
        expect(ok.body).toEqual({ success: true, name: 'Ayşe' });

        const bad = await request(app).post('/api/staff/verify').send({ pin: '0000' });
        expect(bad.body.success).toBe(false);

        await request(app).post('/api/staff/delete').send({ pin: '1234' });
        expect(await get(dbi, 'SELECT * FROM staff WHERE pin = ?', ['1234'])).toBeUndefined();
    });

    test('rejects a PIN that is not exactly 4 digits', async () => {
        const short = await request(app).post('/api/staff/add').send({ pin: '12', name: 'Kısa' });
        expect(short.body.success).toBe(false);
        const long = await request(app).post('/api/staff/add').send({ pin: '12345', name: 'Uzun' });
        expect(long.body.success).toBe(false);
        const noName = await request(app).post('/api/staff/add').send({ pin: '4321', name: '' });
        expect(noName.body.success).toBe(false);
    });

    test('re-adding the same PIN upserts instead of duplicating', async () => {
        await request(app).post('/api/staff/add').send({ pin: '7777', name: 'İlk' });
        await request(app).post('/api/staff/add').send({ pin: '7777', name: 'Son' });
        const rows = await all(dbi, 'SELECT * FROM staff WHERE pin = ?', ['7777']);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Son');
    });
});

describe('bonus packages table', () => {
    test('add / list / delete', async () => {
        const add = await request(app).post('/api/bonus-packages/add').send({ sales: 1000, bonus: 100 });
        expect(add.body.success).toBe(true);

        const row = await get(dbi, 'SELECT * FROM bonus_packages WHERE sales_amount = 1000');
        expect(row.bonus_amount).toBe(100);

        const list = await request(app).get('/api/bonus-packages');
        expect(list.body.success).toBe(true);
        expect(list.body.packages.length).toBeGreaterThan(0);

        const del = await request(app).post('/api/bonus-packages/delete').send({ id: row.id });
        expect(del.body.success).toBe(true);
        expect(await get(dbi, 'SELECT * FROM bonus_packages WHERE id = ?', [row.id])).toBeUndefined();
    });
});

describe('rights & movement ledger', () => {
    test('add-telafi writes the right and a Tanımlama movement', async () => {
        const id = await createStudent({ student_name: 'Ledger Çocuk' });
        const res = await request(app).post('/api/rights/add-telafi')
            .send({ child_id: id, minutes: 120, source: 'Test Kaynağı', note: 'not', personel: 'Test' });
        expect(res.body.success).toBe(true);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(right.kalan_dk).toBe(120);
        expect(right.miktar_dk).toBe(120);
        expect(right.kaynak).toBe('Test Kaynağı');
        expect(right.son_kullanma).toBeTruthy();

        const mov = await get(dbi, 'SELECT * FROM right_movements WHERE hak_id = ?', [right.hak_id]);
        expect(mov.islem).toBe('Tanımlama');
        expect(mov.hak_tipi).toBe('TELAFİ');
        expect(mov.degisim_dk).toBe(120);
        expect(mov.onceki_kalan_dk).toBe(0);
        expect(mov.yeni_kalan_dk).toBe(120);
    });

    test('add-package splits principal and bonus balance', async () => {
        const id = await createStudent({ student_name: 'Paket Satış' });
        const res = await request(app).post('/api/rights/add-package')
            .send({ child_id: id, price: 300, bonus: 50, payment_type: 'NAKİT', personel: 'Test' });
        expect(res.body.success).toBe(true);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(right.kalan_dk).toBe(350);
        expect(right.kalan_ana_para).toBe(300);
        expect(right.kalan_bonus).toBe(50);
        expect(right.satis_tutari).toBe(300);
        expect(right.odeme_tipi).toBe('NAKİT');
    });

    test('add-package with a zero total is rejected', async () => {
        const id = await createStudent({ student_name: 'Sıfır Paket' });
        const res = await request(app).post('/api/rights/add-package').send({ child_id: id, price: 0, bonus: 0 });
        expect(res.body.success).toBe(false);
        expect(await countFor('rights', id)).toBe(0);
    });

    test('rights/get returns balances and a formatted movement history', async () => {
        const id = await createStudent({ student_name: 'Hareket Çocuk' });
        await request(app).post('/api/rights/add-telafi').send({ child_id: id, minutes: 60 });
        await request(app).post('/api/rights/add-package').send({ child_id: id, price: 100, bonus: 0 });

        const res = await request(app).get(`/api/rights/get/${id}`);
        expect(res.body.success).toBe(true);
        expect(res.body.telafi_minutes).toBe(60);
        expect(res.body.package_minutes).toBe(100);
        expect(res.body.telafi_dersi_count).toBe(0);
        expect(res.body.movements.length).toBeGreaterThanOrEqual(2);
        expect(res.body.movements[0]).toHaveProperty('created_at_fmt');
    });
});
