'use strict';
/**
 * Passport gamification: tasks, points ledger (wallet), weekly leaderboard, and the points
 * shown on the checkout receipt.
 */
const fs = require('fs');
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const ptp = require('pdf-to-printer');
const {
    app, db, drainWrites, withTransaction, grantPoints,
} = require('../../server.js');

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

beforeEach(() => ptp.print.mockClear());

async function makeStudent(name) {
    const res = await request(app).post('/api/students/create').send({
        student_name: name, parent_name: 'Veli', parent_phone: '5551112233', birth_date: '2016-05-10',
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

const taskIds = async () => (await request(app).get('/api/tasks')).body.tasks.map((t) => t.task_id);

const complete = (child_id, task_id, personel = 'Öğretmen') =>
    request(app).post('/api/tasks/complete').send({ child_id, task_id, personel });

const uncomplete = (child_id, task_id) =>
    request(app).post('/api/tasks/uncomplete').send({ child_id, task_id });

const balanceOf = async (child_id) =>
    Number((await get(dbi, 'SELECT wallet_balance FROM students WHERE child_id = ?', [child_id])).wallet_balance || 0);

/** Check a child in and backdate the entry so the bill is a known tier. */
async function openSession(childId, minutesAgo) {
    const started = await request(app).post('/api/entry/start').send({ child_id: childId, personel: 'Test' });
    expect(started.body.success).toBe(true);
    const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [childId]);
    await run(dbi, 'UPDATE logs SET entry_time = ? WHERE log_id = ?',
        [new Date(Date.now() - minutesAgo * 60000).toISOString(), log.log_id]);
}

const checkout = (child_id, body = {}) =>
    request(app).post('/api/exit/finalize').send({ child_id, payment_type: 'NAKİT', personel: 'Kasa', ...body });

function lastSlip() {
    const calls = ptp.print.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return fs.readFileSync(calls[calls.length - 1][0], 'utf8');
}

describe('tasks', () => {
    test('the three starter tasks are seeded', async () => {
        const res = await request(app).get('/api/tasks');
        expect(res.body.success).toBe(true);
        const names = res.body.tasks.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining(['Lego WeDo', '3D Pen', 'Paper Circuits']));
        expect(res.body.tasks[0].points).toBeGreaterThan(0);
    });

    test('a task can be added and updated', async () => {
        const add = await request(app).post('/api/tasks/add').send({ name: 'Robotik', points: 25 });
        expect(add.body.success).toBe(true);
        const row = await get(dbi, 'SELECT * FROM tasks WHERE task_id = ?', [add.body.task_id]);
        expect(row.name).toBe('Robotik');
        expect(row.points).toBe(25);

        const upd = await request(app).post('/api/tasks/update').send({
            task_id: add.body.task_id, name: 'Robotik İleri', points: 30, status: 'Aktif',
        });
        expect(upd.body.success).toBe(true);
        expect((await get(dbi, 'SELECT points FROM tasks WHERE task_id = ?', [add.body.task_id])).points).toBe(30);
    });

    test('a task without a name is rejected', async () => {
        expect((await request(app).post('/api/tasks/add').send({ name: '' })).body.success).toBe(false);
    });
});

describe('passport and wallet', () => {
    test('checking off a task writes the row, the points and a ledger entry', async () => {
        const child = await makeStudent('Pasaport Çocuk');
        const [t1] = await taskIds();

        const res = await complete(child, t1);
        expect(res.body.success).toBe(true);
        expect(res.body.puan).toBe(10);
        expect(res.body.yeni_bakiye).toBe(10);

        const st = await get(dbi, 'SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?', [child, t1]);
        expect(st.puan).toBe(10);
        expect(st.tamamlanma_tarihi).toBeTruthy();
        expect(st.personel).toBe('Öğretmen');

        expect(await balanceOf(child)).toBe(10);

        const mov = await get(dbi, 'SELECT * FROM wallet_movements WHERE child_id = ?', [child]);
        expect(mov.tip).toBe('KAZANIM');
        expect(mov.puan).toBe(10);
        expect(mov.onceki_bakiye).toBe(0);
        expect(mov.yeni_bakiye).toBe(10);
        expect(mov.task_id).toBe(t1);
    });

    test('the same task cannot be checked off twice', async () => {
        const child = await makeStudent('Tekrar Puan');
        const [t1] = await taskIds();
        await complete(child, t1);

        const again = await complete(child, t1);
        expect(again.body.success).toBe(false);
        expect(again.body.message).toContain('zaten işaretlenmiş');
        expect(await balanceOf(child)).toBe(10);
        const rows = await all(dbi, 'SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?', [child, t1]);
        expect(rows).toHaveLength(1);
    });

    test('a passport lists every active task with its completion state', async () => {
        const child = await makeStudent('Liste Çocuk');
        const ids = await taskIds();
        await complete(child, ids[0]);

        const res = await request(app).get('/api/passport/' + child);
        expect(res.body.success).toBe(true);
        expect(res.body.student.student_name).toBe('Liste Çocuk');
        expect(res.body.student.wallet_balance).toBe(10);
        expect(res.body.toplam_puan).toBe(10);
        expect(res.body.tasks.length).toBeGreaterThanOrEqual(3);
        expect(res.body.tasks.filter((t) => t.tamamlandi)).toHaveLength(1);
        expect(res.body.movements.length).toBe(1);
    });

    test('an unknown child has no passport', async () => {
        expect((await request(app).get('/api/passport/UC-999999')).body.success).toBe(false);
    });

    test('the wallet exposes the balance and its TL value', async () => {
        const child = await makeStudent('Cüzdan Çocuk');
        await withTransaction(() => grantPoints(child, 35, 'test'));
        const res = await request(app).get('/api/wallet/' + child);
        expect(res.body.success).toBe(true);
        expect(res.body.wallet_balance).toBe(35);
        expect(res.body.point_tl_rate).toBe(1);
        expect(res.body.tl_karsiligi).toBe(35);
    });

    test('revoking a task takes the points back', async () => {
        const child = await makeStudent('Geri Alan');
        const [t1] = await taskIds();
        await complete(child, t1);

        const res = await uncomplete(child, t1);
        expect(res.body.success).toBe(true);
        expect(res.body.yeni_bakiye).toBe(0);
        expect(await balanceOf(child)).toBe(0);
        expect(await get(dbi, 'SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?', [child, t1])).toBeUndefined();
        const movs = await all(dbi, 'SELECT * FROM wallet_movements WHERE child_id = ?', [child]);
        expect(movs.map((m) => m.tip)).toEqual(expect.arrayContaining(['KAZANIM', 'HARCAMA']));
    });

    test('revoking is refused when the points were already spent', async () => {
        const child = await makeStudent('Harcayan');
        const [t1] = await taskIds();
        await complete(child, t1);                     // 10 points
        await openSession(child, 20);
        await checkout(child, { kullanilan_puan: 10 }); // spends all 10 → fee 300 - 10
        expect(await balanceOf(child)).toBe(0);

        const res = await uncomplete(child, t1);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('yetersiz');

        // the task must still be marked complete: the transaction rolled back
        const st = await get(dbi, 'SELECT * FROM student_tasks WHERE child_id = ? AND task_id = ?', [child, t1]);
        expect(st).toBeTruthy();
        expect(await balanceOf(child)).toBe(0);
    });

    test('revoking a task that was never completed is refused', async () => {
        const child = await makeStudent('İşaretsiz');
        const [t1] = await taskIds();
        const res = await uncomplete(child, t1);
        expect(res.body.success).toBe(false);
    });
});

describe('week leaderboard', () => {
    test('ranks this week\'s stamps and ignores older ones', async () => {
        const a = await makeStudent('Birinci');
        const b = await makeStudent('İkinci');
        const c = await makeStudent('Geçen Hafta');
        const ids = await taskIds();
        await complete(a, ids[0]);                       // 10
        await complete(a, ids[1]);                       // 20 total
        await complete(b, ids[0]);                       // 10
        // a stamp from three weeks ago must not count towards this week
        await run(dbi,
            `INSERT INTO student_tasks (child_id, task_id, puan, tamamlanma_tarihi, personel)
             VALUES (?, 'TSK-100', 999, ?, 'Test')`,
            [c, new Date(Date.now() - 21 * 86400000).toISOString()]);

        const res = await request(app).get('/api/leaderboard/weekly');
        expect(res.body.success).toBe(true);
        expect(res.body.hafta_baslangici).toBeTruthy();

        const rows = res.body.leaderboard;
        expect(rows.map((r) => r.child_id)).not.toContain(c);   // last week's stamp is excluded
        const rowA = rows.find((r) => r.child_id === a);
        const rowB = rows.find((r) => r.child_id === b);
        expect(rowA.toplam_puan).toBe(20);
        expect(rowB.toplam_puan).toBe(10);
        expect(rowA.sira).toBeLessThan(rowB.sira);              // more points ranks higher
        expect(rows.map((r) => r.sira)).toEqual(rows.map((_, i) => i + 1));
    });

    test('a revoked stamp disappears from the leaderboard', async () => {
        const child = await makeStudent('İptal Edilen');
        const ids = await taskIds();
        await complete(child, ids[0]);

        let res = await request(app).get('/api/leaderboard/weekly');
        expect(res.body.leaderboard.find((r) => r.child_id === child).toplam_puan).toBe(10);

        await uncomplete(child, ids[0]);

        res = await request(app).get('/api/leaderboard/weekly');
        expect(res.body.leaderboard.find((r) => r.child_id === child)).toBeUndefined();
    });

    test('spending points at checkout does not affect the weekly ranking', async () => {
        const child = await makeStudent('Harcayan Kaşif');
        const ids = await taskIds();
        await complete(child, ids[0]);                   // 10 earned
        await openSession(child, 20);
        await checkout(child, { kullanilan_puan: 10 });   // all spent
        expect(await balanceOf(child)).toBe(0);

        const res = await request(app).get('/api/leaderboard/weekly');
        expect(res.body.leaderboard.find((r) => r.child_id === child).toplam_puan).toBe(10);
    });

    test('the week starts on Monday', async () => {
        const res = await request(app).get('/api/leaderboard/weekly');
        const start = new Date(res.body.hafta_baslangici);
        expect(start.getDay()).toBe(1);              // Monday
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
    });
});

describe('points on the checkout receipt', () => {
    test('redeeming points discounts the bill and records it on the log', async () => {
        const child = await makeStudent('İndirim Çocuk');
        await withTransaction(() => grantPoints(child, 200, 'test'));
        await openSession(child, 20);                    // bill lands in the base tier
        const preview = await request(app).get('/api/exit/preview/' + child);
        const fee = preview.body.fee;
        expect(fee).toBeGreaterThan(20);

        const res = await checkout(child, { kullanilan_puan: 20 });
        expect(res.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        expect(log.kullanilan_puan).toBe(20);
        expect(log.puan_indirimi).toBe(20);
        expect(log.fee).toBe(fee - 20);
        expect(log.source_summary).toContain('puan');
        expect(await balanceOf(child)).toBe(180);

        const html = lastSlip();
        expect(html).toContain('Kullanılan Puan:</b> 20');
        expect(html).toContain('Kazanılan Puan:</b> 0');
        expect(html).toContain('Mevcut Cüzdan Bakiyesi:</b> 180 puan');
    });

    test('awarding points at checkout raises the balance and shows on the receipt', async () => {
        const child = await makeStudent('Kazanan Çocuk');
        await openSession(child, 20);
        const res = await checkout(child, { kazanilan_puan: 15 });
        expect(res.body.success).toBe(true);

        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        expect(log.kazanilan_puan).toBe(15);
        expect(await balanceOf(child)).toBe(15);

        const html = lastSlip();
        expect(html).toContain('Kazanılan Puan:</b> 15');
        expect(html).toContain('Mevcut Cüzdan Bakiyesi:</b> 15 puan');
    });

    test('redemption is capped by the balance', async () => {
        const child = await makeStudent('Az Puanlı');
        await withTransaction(() => grantPoints(child, 5, 'test'));
        await openSession(child, 20);
        const preview = await request(app).get('/api/exit/preview/' + child);

        await checkout(child, { kullanilan_puan: 500 });
        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        expect(log.kullanilan_puan).toBe(5);                     // only what they had
        expect(log.fee).toBe(preview.body.fee - 5);
        expect(await balanceOf(child)).toBe(0);
    });

    test('redemption is capped by the bill, and unspent points survive', async () => {
        const child = await makeStudent('Puanı Kalan');
        await withTransaction(() => grantPoints(child, 500, 'test'));
        await openSession(child, 20);
        const preview = await request(app).get('/api/exit/preview/' + child);
        const fee = preview.body.fee;

        await checkout(child, { kullanilan_puan: 500 });
        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        expect(log.kullanilan_puan).toBe(Math.floor(fee));        // never more than the bill
        expect(log.fee).toBe(fee - Math.floor(fee));
        expect(await balanceOf(child)).toBe(500 - Math.floor(fee));
    });

    test('no points are burned on a free checkout', async () => {
        const child = await makeStudent('Bedava Çocuk');
        await withTransaction(() => grantPoints(child, 40, 'test'));
        await openSession(child, 1);                             // inside the tolerance window → fee 0

        const preview = await request(app).get('/api/exit/preview/' + child);
        expect(preview.body.fee).toBe(0);

        await checkout(child, { kullanilan_puan: 40 });
        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        expect(log.kullanilan_puan).toBe(0);
        expect(log.fee).toBe(0);
        expect(await balanceOf(child)).toBe(40);                 // points kept
    });

    test('the status slip shows the wallet balance too', async () => {
        const child = await makeStudent('Fiş Çocuk');
        await withTransaction(() => grantPoints(child, 7, 'test'));
        const res = await request(app).post('/api/print/status').send({
            student_name: 'Fiş Çocuk', child_id: child, parent_phone: '5551112233',
            entry_time_fmt: '14:05', sure_dk: 42, estimated_fee: 500,
        });
        expect(res.body.success).toBe(true);
        expect(lastSlip()).toContain('Mevcut Cüzdan Bakiyesi:</b> 7 puan');
    });

    test('a checkout with no points leaves the ledger untouched', async () => {
        const child = await makeStudent('Puansız Çocuk');
        await openSession(child, 20);
        await checkout(child);
        expect(await all(dbi, 'SELECT * FROM wallet_movements WHERE child_id = ?', [child])).toHaveLength(0);
        expect(await balanceOf(child)).toBe(0);
    });
});
