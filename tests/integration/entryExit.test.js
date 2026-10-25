'use strict';
/**
 * Integration tests for the session lifecycle: check-in, pausing, billing, the four
 * checkout modes, receipt printing, end-of-day reporting and the Excel export.
 *
 * Fees are asserted against the real pricing helper (fee === calculateFee(duration_min))
 * so the tests stay deterministic even when a minute ticks over during a run.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
const SLIP_DIR = path.dirname(DB_PATH);
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = SLIP_DIR;

const request = require('supertest');
const ptp = require('pdf-to-printer');
const { app, db, calculateFee , drainWrites} = require('../../server.js');

let dbi;

let agent;

beforeAll(async () => {
    await waitForSchema(DB_PATH);
    agent = await authedAgent(app);
    dbi = openDb(DB_PATH);
});

afterAll(async () => {
    await drainWrites();
    await closeDb(dbi);
    await closeDb(db);
});

beforeEach(() => ptp.print.mockClear());

async function createStudent(overrides = {}) {
    const res = await agent.post('/api/students/create').send({
        student_name: 'Oturum Çocuk',
        parent_name: 'Oturum Veli',
        parent_phone: '5551112233',
        birth_date: '2016-05-10',
        cari_turu: 'Dramatik Oyun Alanı',
        ...overrides,
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

/** Check a child in, then backdate entry_time so the session has a known length. */
async function openSession(childId, minutesAgo) {
    const started = await agent.post('/api/entry/start').send({ child_id: childId, personel: 'Test' });
    expect(started.body.success).toBe(true);
    const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [childId]);
    await run(dbi, 'UPDATE logs SET entry_time = ? WHERE log_id = ?',
        [new Date(Date.now() - minutesAgo * 60000).toISOString(), log.log_id]);
    return log.log_id;
}

const currentLog = (childId) =>
    get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [childId]);

/** Read the slip that was just handed to the (mocked) thermal printer. */
function lastSlip() {
    const calls = ptp.print.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [filePath, options] = calls[calls.length - 1];
    return { html: fs.readFileSync(filePath, 'utf8'), options, filePath };
}

const binaryParser = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(Buffer.from(c)));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('check-in', () => {
    test('creates an open session and prints an entry receipt', async () => {
        const id = await createStudent({ student_name: 'Giren Çocuk', parent_phone: '5559998877' });
        const res = await agent.post('/api/entry/start').send({ child_id: id, personel: 'Ayşe' });
        expect(res.body.success).toBe(true);

        const log = await currentLog(id);
        expect(log).toBeTruthy();
        expect(log.status).toBe('AÇIK');
        expect(log.action).toBe('GİRİŞ');
        expect(log.personel).toBe('Ayşe');
        expect(log.entry_time).toBeTruthy();
        expect(log.duration_min).toBe(0);
        expect(log.tarih).toBe(new Date().toISOString().split('T')[0]);

        const slip = lastSlip();
        expect(slip.options).toEqual({ printer: 'KASA', copies: 2 });
        expect(slip.html).toContain('Giriş İşlemi');
        expect(slip.html).toContain('ÜRETEN ÇOCUK');
        expect(slip.html).toContain('Giren Çocuk');
        expect(slip.html).toContain(id);
        expect(slip.html).toContain('5559998877');
        expect(slip.html).toContain('Ayşe');
    });

    test('refuses a second check-in for a child already inside', async () => {
        const id = await createStudent({ student_name: 'Çift Giriş' });
        await agent.post('/api/entry/start').send({ child_id: id });
        const again = await agent.post('/api/entry/start').send({ child_id: id });
        expect(again.body).toEqual({ success: false, message: 'Çocuk zaten içeride.' });
    });

    test('registration with start_entry opens a session and prints', async () => {
        const res = await agent.post('/api/students/create').send({
            student_name: 'Yeni Giren', parent_name: 'Veli', parent_phone: '5550000001',
            birth_date: '2017-03-03', start_entry: true, personel: 'Kayıt',
        });
        expect(res.body.success).toBe(true);
        const log = await currentLog(res.body.child_id);
        expect(log).toBeTruthy();
        expect(lastSlip().html).toContain('Giriş İşlemi');
    });
});

describe('GET /api/inside', () => {
    test('lists children currently inside with live duration and fee', async () => {
        const id = await createStudent({ student_name: 'İçerdeki Çocuk' });
        await openSession(id, 20);

        const res = await agent.get('/api/inside');
        expect(res.body.success).toBe(true);
        const row = res.body.children.find((c) => c.child_id === id);
        expect(row).toBeTruthy();
        expect(row.sure_dk).toBeGreaterThanOrEqual(20);
        expect(row.estimated_fee).toBe(calculateFee(row.sure_dk));
        expect(row.is_paused).toBe(false);
        expect(row.warning).toBe(false);
        expect(row.entry_timestamp).toBeGreaterThan(0);
    });

    test('flags warning and alarm thresholds', async () => {
        const id = await createStudent({ student_name: 'Uzun Kalan' });
        await openSession(id, 130);

        const res = await agent.get('/api/inside');
        const row = res.body.children.find((c) => c.child_id === id);
        expect(row.warning).toBe(true);
        expect(row.alarm).toBe(true);
    });

    test('maps each child to their own balances and phone (batched query)', async () => {
        const a = await createStudent({ student_name: 'İçerde A' });
        const b = await createStudent({ student_name: 'İçerde B' });
        const outside = await createStudent({ student_name: 'Dışarda C' });

        await agent.post('/api/rights/add-telafi').send({ child_id: a, minutes: 60 });
        await agent.post('/api/rights/add-package').send({ child_id: b, price: 250, bonus: 50 });
        // a child who is NOT inside: their rights must not leak into anyone else's row
        await agent.post('/api/rights/add-telafi').send({ child_id: outside, minutes: 999 });

        await openSession(a, 20);
        await openSession(b, 30);

        const res = await agent.get('/api/inside');
        const ids = res.body.children.map((c) => c.child_id);
        expect(ids).toContain(a);
        expect(ids).toContain(b);
        expect(ids).not.toContain(outside);

        const rowA = res.body.children.find((c) => c.child_id === a);
        expect(rowA.telafi_minutes).toBe(60);
        expect(rowA.package_minutes).toBe(0);
        expect(rowA.parent_phone).toBe('5551112233');
        expect(rowA.sure_dk).toBeGreaterThanOrEqual(20);
        expect(rowA.estimated_fee).toBe(calculateFee(rowA.sure_dk));

        const rowB = res.body.children.find((c) => c.child_id === b);
        expect(rowB.package_minutes).toBe(300);
        expect(rowB.telafi_minutes).toBe(0);
    });
});

describe('pause / resume', () => {
    test('excludes paused time from the billed duration', async () => {
        const id = await createStudent({ student_name: 'Duraklatan' });
        await openSession(id, 20);

        const paused = await agent.post('/api/entry/pause-toggle').send({ child_id: id });
        expect(paused.body).toEqual({ success: true, message: 'Duraklatıldı.' });

        // pretend the child has been paused for 10 minutes
        await run(dbi, 'UPDATE logs SET paused_at = ? WHERE child_id = ? AND status = ?',
            [new Date(Date.now() - 10 * 60000).toISOString(), id, 'AÇIK']);

        const during = await agent.get(`/api/exit/preview/${id}`);
        expect(during.body.sure_dk).toBeGreaterThanOrEqual(10);
        expect(during.body.sure_dk).toBeLessThanOrEqual(12);

        const resumed = await agent.post('/api/entry/pause-toggle').send({ child_id: id });
        expect(resumed.body).toEqual({ success: true, message: 'Devam ediliyor.' });

        const log = await currentLog(id);
        expect(log.is_paused).toBe(0);
        expect(log.paused_at).toBeNull();
        expect(log.total_pause_duration).toBeGreaterThanOrEqual(9);

        const after = await agent.get(`/api/exit/preview/${id}`);
        expect(after.body.sure_dk).toBeLessThanOrEqual(12);
    });

    test('pause-toggle without an open session is rejected', async () => {
        const id = await createStudent({ student_name: 'Oturumsuz' });
        const res = await agent.post('/api/entry/pause-toggle').send({ child_id: id });
        expect(res.body).toEqual({ success: false, message: 'Kayıt bulunamadı.' });
    });
});

describe('checkout — cash modes', () => {
    test('preview reports the fee for the elapsed time', async () => {
        const id = await createStudent({ student_name: 'Önizleme' });
        await openSession(id, 20);
        const res = await agent.get(`/api/exit/preview/${id}`);
        expect(res.body.success).toBe(true);
        expect(res.body.fee).toBe(calculateFee(res.body.sure_dk));
        expect(res.body.student_name).toBe('Önizleme');
    });

    test('finalize with NAKİT closes the session and charges the computed fee', async () => {
        const id = await createStudent({ student_name: 'Nakit Çocuk' });
        await openSession(id, 20);

        const res = await agent.post('/api/exit/finalize')
            .send({ child_id: id, payment_type: 'NAKİT', personel: 'Kasa' });
        expect(res.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(log.duration_min).toBeGreaterThanOrEqual(20);
        expect(log.fee).toBe(calculateFee(log.duration_min));
        expect(log.fee).toBe(300); // 20-21 min sits safely in the base-rate tier
        expect(log.payment_type).toBe('NAKİT');
        expect(log.personel).toBe('Kasa');
        expect(log.payment_date).toBeTruthy();
        expect(log.source_summary).toBe('NAKİT Tahsilatı');

        const slip = lastSlip();
        expect(slip.html).toContain('Çıkış İşlemi');
        expect(slip.html).toContain('Nakit Çocuk');
        expect(slip.html).toContain('NAKİT');
    });

    test('finalize with KREDİ KARTI records a card payment', async () => {
        const id = await createStudent({ student_name: 'Kart Çocuk' });
        await openSession(id, 45);
        await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'KREDİ KARTI' });

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(log.payment_type).toBe('KREDİ KARTI');
        expect(log.fee).toBe(calculateFee(log.duration_min));
        expect(log.fee).toBe(500); // 45-46 min -> hourly tier
    });

    test('finalize with ÜCRETSİZ stores a zero fee', async () => {
        const id = await createStudent({ student_name: 'Ücretsiz Çocuk' });
        await openSession(id, 45);
        await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'ÜCRETSİZ' });

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(log.fee).toBe(0);
        expect(log.source_summary).toBe('ÜCRETSİZ');
    });

    test('a session inside the tolerance window is free', async () => {
        const id = await createStudent({ student_name: 'Tolerans Çocuk' });
        await openSession(id, 3);
        await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'NAKİT' });

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(log.duration_min).toBeLessThanOrEqual(5);
        expect(log.fee).toBe(0);
    });

    test('finalize without an open session is rejected', async () => {
        const id = await createStudent({ student_name: 'Kapalı Çocuk' });
        const res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'NAKİT' });
        expect(res.body).toEqual({ success: false, message: 'Aktif giriş bulunamadı.' });
    });

    test('preview without an open session is rejected', async () => {
        const id = await createStudent({ student_name: 'Önizlemesiz' });
        const res = await agent.get(`/api/exit/preview/${id}`);
        expect(res.body).toEqual({ success: false, message: 'Çocuk içeride görünmüyor.' });
    });
});

describe('checkout — telafi (HAK)', () => {
    test('refuses checkout on HAK when there is no makeup balance', async () => {
        const id = await createStudent({ student_name: 'Bakiyesiz' });
        await openSession(id, 20);
        const res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'HAK' });
        expect(res.body).toEqual({ success: false, message: 'Yeterli telafi bakiyesi (dakika) yok.' });
        expect(await currentLog(id)).toBeTruthy(); // session stays open
    });

    test('deducts makeup minutes and writes a usage movement', async () => {
        const id = await createStudent({ student_name: 'Telafi Çocuk' });
        await agent.post('/api/rights/add-telafi').send({ child_id: id, minutes: 120, personel: 'Test' });
        await openSession(id, 20);

        const res = await agent.post('/api/exit/finalize')
            .send({ child_id: id, payment_type: 'HAK', personel: 'Kasa' });
        expect(res.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        const used = log.paketten_dusen;
        expect(used).toBeGreaterThanOrEqual(20);
        expect(log.fee).toBe(0);
        expect(log.payment_type).toBe('HAK');
        expect(log.source_summary).toBe(`${used} Dk Telafi`);
        expect(log.hak_id === undefined || log.hak_id === null).toBe(true);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(right.kalan_dk).toBe(120 - used);
        expect(right.durum).toBe('Aktif');

        const mov = await get(dbi, "SELECT * FROM right_movements WHERE log_id = ? AND islem = 'Kullanım (Çıkış)'", [log.log_id]);
        expect(mov).toBeTruthy();
        expect(mov.hak_tipi).toBe('TELAFİ');
        expect(mov.degisim_dk).toBe(-used);
        expect(mov.yeni_kalan_dk).toBe(120 - used);

        expect(lastSlip().html).toContain('HAK (Telafi)');
    });

    test('marks the right as exhausted when the balance is fully consumed', async () => {
        const id = await createStudent({ student_name: 'Tükenen' });
        await openSession(id, 45);

        // give the child exactly as many makeup minutes as the session will burn
        const preview = await agent.get(`/api/exit/preview/${id}`);
        const sureDk = preview.body.sure_dk;
        await agent.post('/api/rights/add-telafi').send({ child_id: id, minutes: sureDk });

        const res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'HAK' });
        expect(res.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(log.paketten_dusen).toBe(sureDk);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(right.kalan_dk).toBe(0);
        expect(right.durum).toBe('Tükendi');
    });
});

describe('checkout — package (PAKET)', () => {
    test('refuses checkout on PAKET when the balance is too small', async () => {
        const id = await createStudent({ student_name: 'Az Bakiye' });
        await agent.post('/api/rights/add-package').send({ child_id: id, price: 100, bonus: 0 });

        // the balance must really exist, otherwise this test passes for the wrong reason
        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(right).toBeTruthy();
        expect(right.kalan_dk).toBe(100);

        await openSession(id, 20);
        const res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET' });
        expect(res.body).toEqual({ success: false, message: 'Yeterli paket bakiyesi (TL) yok.' });
    });

    test('spends the principal before the bonus and exhausts the package', async () => {
        const id = await createStudent({ student_name: 'Paket Çocuk' });
        await agent.post('/api/rights/add-package')
            .send({ child_id: id, price: 500, bonus: 100, payment_type: 'NAKİT', personel: 'Kasa' });

        // first checkout: ~300 TL tier
        await openSession(id, 20);
        let res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET' });
        expect(res.body.success).toBe(true);

        let log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        let right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        const used1 = log.paketten_dusen;
        expect(used1).toBe(300);
        expect(log.fee).toBe(0);
        expect(log.source_summary).toBe(`${used1} TL Paket`);
        expect(right.kalan_ana_para).toBe(500 - used1);
        expect(right.kalan_bonus).toBe(100);
        expect(right.kalan_dk).toBe(600 - used1);
        expect(right.durum).toBe('Aktif');
        expect(lastSlip().html).toContain('(Paketten Karşılandı)');

        // second checkout: drains the remaining principal, then the bonus
        await openSession(id, 20);
        res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET' });
        expect(res.body.success).toBe(true);

        right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(right.kalan_ana_para).toBe(0);
        expect(right.kalan_bonus).toBe(0);
        expect(right.kalan_dk).toBe(0);
        expect(right.durum).toBe('Tükendi');

        const movements = await all(dbi,
            "SELECT * FROM right_movements WHERE hak_id = ? AND islem = 'Kullanım (Çıkış)'", [right.hak_id]);
        expect(movements).toHaveLength(2);
        movements.forEach((m) => expect(m.degisim_dk).toBeLessThan(0));

        // third checkout: nothing left
        await openSession(id, 20);
        res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET' });
        expect(res.body.success).toBe(false);
    });

    test('two simultaneous checkouts cannot double-spend the same balance', async () => {
        const id = await createStudent({ student_name: 'Yarış Çocuk' });
        await agent.post('/api/rights/add-package').send({ child_id: id, price: 1000, bonus: 0 });
        await openSession(id, 20);

        const [first, second] = await Promise.all([
            agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET', personel: 'Kasa 1' }),
            agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET', personel: 'Kasa 2' }),
        ]);

        // exactly one checkout may win; the other must find no open session
        const winners = [first, second].filter((r) => r.body.success);
        expect(winners).toHaveLength(1);

        const closed = await all(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [id]);
        expect(closed).toHaveLength(1);
        const used = closed[0].paketten_dusen;
        expect(used).toBeGreaterThan(0);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(right.kalan_dk).toBe(1000 - used); // charged once, never twice
        expect(right.kalan_ana_para).toBe(1000 - used);
        expect(right.kalan_dk).toBeGreaterThanOrEqual(0);

        const movements = await all(dbi,
            "SELECT * FROM right_movements WHERE log_id = ? AND islem = 'Kullanım (Çıkış)'", [closed[0].log_id]);
        expect(movements).toHaveLength(1);
    });
});

describe('receipt printing — status slip', () => {
    test('prints an on-demand status slip', async () => {
        const res = await agent.post('/api/print/status').send({
            student_name: 'Fiş Çocuk', child_id: 'UC-000123', parent_phone: '5551112233',
            entry_time_fmt: '14:05', sure_dk: 42, estimated_fee: 500,
        });
        expect(res.body.success).toBe(true);

        const slip = lastSlip();
        expect(slip.options).toEqual({ printer: 'KASA', copies: 2 });
        expect(slip.html).toContain('Anlık Durum Fişi');
        expect(slip.html).toContain('Fiş Çocuk');
        expect(slip.html).toContain('UC-000123');
        expect(slip.html).toContain('42 dakika');
        expect(slip.html).toContain('500 TL');
    });
});

describe('expiry engine', () => {
    test('converts expired makeup minutes into makeup lessons', async () => {
        const id = await createStudent({ student_name: 'Süresi Dolan' });
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        await run(dbi,
            `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, durum, personel)
             VALUES (?, ?, 'TELAFİ', 60, 60, 'test', ?, ?, 'Aktif', 'Test')`,
            ['HAK-EXPIRED-1', id, new Date().toISOString(), yesterday]);

        // any endpoint that runs the expiry sweeper first
        const res = await agent.get(`/api/students/get/${id}`);
        expect(res.body.success).toBe(true);

        const expired = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', ['HAK-EXPIRED-1']);
        expect(expired.durum).toBe('Süresi Doldu (Dönüştü)');
        expect(expired.kalan_dk).toBe(0);

        const lessons = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ'", [id]);
        expect(lessons).toHaveLength(1);
        expect(lessons[0].miktar_dk).toBe(1);
        expect(lessons[0].kalan_dk).toBe(1);
        expect(lessons[0].kaynak).toBe('Süresi Dolan Oyun Alanı Telafisi Dönüşümü');
    });

    test('still expires packages, not only makeup minutes', async () => {
        const id = await createStudent({ student_name: 'Paket SKT' });
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        await run(dbi,
            `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para, kalan_bonus, kaynak, tanim_tarihi, son_kullanma, durum, personel)
             VALUES (?, ?, 'PAKET', 500, 500, 500, 0, 'test', ?, ?, 'Aktif', 'Test')`,
            ['PAK-EXPIRED-1', id, new Date().toISOString(), yesterday]);

        await agent.get(`/api/students/get/${id}`);

        const row = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', ['PAK-EXPIRED-1']);
        expect(row.durum).toBe('Süresi Doldu');
        expect(row.kalan_dk).toBe(500); // only the status changes for packages

        // and an expired package can no longer pay for a checkout
        await openSession(id, 20);
        const res = await agent.post('/api/exit/finalize').send({ child_id: id, payment_type: 'PAKET' });
        expect(res.body.success).toBe(false);
    });

    test('finishes a conversion that a crash left half-done', async () => {
        const id = await createStudent({ student_name: 'Yarıda Kalan' });
        // a row parked in the intermediate 'İşleniyor' state, as if the process died mid-conversion
        await run(dbi,
            `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, durum, personel)
             VALUES (?, ?, 'TELAFİ', 120, 120, 'test', ?, 'İşleniyor', 'Test')`,
            ['HAK-STUCK-1', id, new Date().toISOString()]);

        await agent.get(`/api/students/get/${id}`);

        const stuck = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', ['HAK-STUCK-1']);
        expect(stuck.durum).toBe('Süresi Doldu (Dönüştü)');
        expect(stuck.kalan_dk).toBe(0);

        const lessons = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ'", [id]);
        expect(lessons).toHaveLength(2); // 120 minutes -> 2 lessons
    });

    test('does nothing when there is no expired work to do', async () => {
        const id = await createStudent({ student_name: 'Temiz Çocuk' });
        await agent.post('/api/rights/add-telafi').send({ child_id: id, minutes: 45 });

        const before = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        await agent.get('/api/students/get/' + id);
        const after = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);

        expect(after.durum).toBe('Aktif');
        expect(after.kalan_dk).toBe(before.kalan_dk);
        expect(after.miktar_dk).toBe(before.miktar_dk);
    });
});

describe('end-of-day reporting', () => {
    test('GET /api/reports/summary aggregates today from the logs table', async () => {
        const today = new Date().toISOString().split('T')[0];
        const closedToday = await all(dbi, "SELECT * FROM logs WHERE tarih = ? AND status = 'KAPALI'", [today]);
        const cash = closedToday.filter((l) => l.payment_type === 'NAKİT').reduce((s, l) => s + l.fee, 0);
        const card = closedToday.filter((l) => l.payment_type === 'KREDİ KARTI').reduce((s, l) => s + l.fee, 0);
        const insideRows = await get(dbi, "SELECT COUNT(*) AS c FROM logs WHERE status = 'AÇIK'");

        const res = await agent.get('/api/reports/summary');
        expect(res.body.success).toBe(true);
        expect(res.body.inside_count).toBe(insideRows.c);
        expect(res.body.today.entries).toBe(closedToday.length);
        expect(res.body.today.cash).toBe(cash);
        expect(res.body.today.card).toBe(card);
        expect(res.body.today_logs.length).toBe(closedToday.length);
        expect(res.body.today_logs[0]).toHaveProperty('entry_time');
        expect(res.body.today_logs[0]).toHaveProperty('exit_time');
    });

    test('GET /api/export/excel returns a 4-sheet workbook of the whole database', async () => {
        const res = await agent.get('/api/export/excel').buffer(true).parse(binaryParser);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
        expect(res.body.subarray(0, 2).toString('utf8')).toBe('PK');

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        expect(wb.worksheets.map((w) => w.name)).toEqual([
            'Kayıtlı Öğrenciler', 'Giriş Çıkış Logları', 'Hak ve Paketler', 'Hak Hareketleri',
        ]);
        expect(wb.getWorksheet('Kayıtlı Öğrenciler').rowCount).toBeGreaterThan(1);
        expect(wb.getWorksheet('Hak Hareketleri').rowCount).toBeGreaterThan(1);
    });
});
