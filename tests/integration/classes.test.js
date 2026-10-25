'use strict';
/**
 * Scheduled classes: class/session/registration CRUD, smart RFID routing, attendance and the
 * absence-compensation job.
 *
 * Session times are computed relative to "now" so the tests exercise the real clock logic
 * instead of a mocked one.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const {
    app, db, drainWrites, dayOfWeek, localDateStr, minutesOf, absenceMessage,
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

const dow = () => dayOfWeek(new Date());
const today = () => localDateStr(new Date());
const hhmm = (minsFromNow) => {
    const d = new Date(Date.now() + minsFromNow * 60000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

async function makeClass(body = {}) {
    const res = await request(app).post('/api/classes/add').send({
        name: 'Lego WeDo', monthly_fee: 1200, term_fee: 3600, ...body,
    });
    expect(res.body.success).toBe(true);
    return res.body.class_id;
}

async function makeSession(classId, startMin, endMin, extra = {}) {
    const res = await request(app).post('/api/sessions/add').send({
        class_id: classId, day_of_week: dow(), start_time: hhmm(startMin), end_time: hhmm(endMin), ...extra,
    });
    expect(res.body.success).toBe(true);
    return res.body.session_id;
}

async function makeStudent(name, rfid = null) {
    const res = await request(app).post('/api/students/create').send({
        student_name: name, parent_name: 'Veli', parent_phone: '5550000', birth_date: '2016-01-01', rfid_id: rfid,
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

const register = (child_id, session_id, extra = {}) =>
    request(app).post('/api/classes/register').send({ child_id, session_id, payment_type: 'AYLIK', ...extra });

const scan = (rfid_id) => request(app).post('/api/rfid/scan').send({ rfid_id });
const processAbsences = () => request(app).post('/api/classes/process-absences').send({});

describe('classes and sessions', () => {
    test('create, list and update a class', async () => {
        const id = await makeClass({ name: '3D Pen', monthly_fee: 900, term_fee: 2700, description: 'Kalem' });
        const list = await request(app).get('/api/classes');
        const cls = list.body.classes.find((c) => c.class_id === id);
        expect(cls.name).toBe('3D Pen');
        expect(cls.monthly_fee).toBe(900);
        expect(cls.sessions).toEqual([]);

        const upd = await request(app).post('/api/classes/update').send({
            class_id: id, name: '3D Pen İleri', monthly_fee: 1000, term_fee: 3000, status: 'Aktif',
        });
        expect(upd.body.success).toBe(true);
        const row = await get(dbi, 'SELECT * FROM classes WHERE class_id = ?', [id]);
        expect(row.name).toBe('3D Pen İleri');
    });

    test('a class needs a name', async () => {
        const res = await request(app).post('/api/classes/add').send({ name: '   ' });
        expect(res.body.success).toBe(false);
    });

    test('session must end after it starts', async () => {
        const classId = await makeClass();
        const res = await request(app).post('/api/sessions/add').send({
            class_id: classId, day_of_week: dow(), start_time: '18:00', end_time: '17:00',
        });
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('Bitiş saati');
    });

    test('sessions are listed with their active registration count', async () => {
        const classId = await makeClass({ name: 'Paper Circuits' });
        const sessionId = await makeSession(classId, -30, 30);
        const child = await makeStudent('Sayım Çocuk');
        await register(child, sessionId);

        const list = await request(app).get('/api/classes');
        const cls = list.body.classes.find((c) => c.class_id === classId);
        expect(cls.sessions[0].kayitli).toBe(1);
    });

    test('a session with active registrations cannot be deleted', async () => {
        const classId = await makeClass({ name: 'Silinemez' });
        const sessionId = await makeSession(classId, -30, 30);
        const child = await makeStudent('Silinemez Çocuk');
        await register(child, sessionId);

        const res = await request(app).post('/api/sessions/delete').send({ session_id: sessionId });
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('aktif kayıtlı');
    });
});

describe('registration (payment + session assignment together)', () => {
    test('registration stores the payment type and uses the class fee when none is given', async () => {
        const classId = await makeClass({ name: 'Ücret Testi', monthly_fee: 1250, term_fee: 3750 });
        const sessionId = await makeSession(classId, -30, 30);
        const child = await makeStudent('Ücret Çocuk');

        const res = await register(child, sessionId, { payment_type: 'DÖNEMLİK' });
        expect(res.body.success).toBe(true);

        const row = await get(dbi, 'SELECT * FROM class_registrations WHERE reg_id = ?', [res.body.reg_id]);
        expect(row.payment_type).toBe('DÖNEMLİK');
        expect(row.fee).toBe(3750);            // picked from the class term fee
        expect(row.status).toBe('Aktif');
        expect(row.child_id).toBe(child);
        expect(row.session_id).toBe(sessionId);

        // and the monthly fee is chosen for a monthly registration
        const child2 = await makeStudent('Aylık Çocuk');
        const res2 = await register(child2, sessionId, { payment_type: 'AYLIK' });
        const row2 = await get(dbi, 'SELECT * FROM class_registrations WHERE reg_id = ?', [res2.body.reg_id]);
        expect(row2.fee).toBe(1250);
    });

    test('the same child cannot be registered twice to one session', async () => {
        const classId = await makeClass({ name: 'Çift Kayıt' });
        const sessionId = await makeSession(classId, -30, 30);
        const child = await makeStudent('Çift Çocuk');
        await register(child, sessionId);

        const again = await register(child, sessionId);
        expect(again.body.success).toBe(false);
        expect(again.body.message).toContain('zaten kayıtlı');

        const rows = await all(dbi, 'SELECT * FROM class_registrations WHERE child_id = ?', [child]);
        expect(rows).toHaveLength(1);
    });

    test('capacity is enforced atomically', async () => {
        const classId = await makeClass({ name: 'Kontenjan' });
        const sessionId = await makeSession(classId, -30, 30, { capacity: 1 });
        const first = await makeStudent('Kontenjan 1');
        const second = await makeStudent('Kontenjan 2');

        expect((await register(first, sessionId)).body.success).toBe(true);
        const full = await register(second, sessionId);
        expect(full.body.success).toBe(false);
        expect(full.body.message).toContain('kontenjan');

        const rows = await all(dbi, "SELECT * FROM class_registrations WHERE session_id = ? AND status = 'Aktif'", [sessionId]);
        expect(rows).toHaveLength(1);
    });

    test('registration without a student or session is rejected', async () => {
        expect((await request(app).post('/api/classes/register').send({})).body.success).toBe(false);
    });

    test('registrations can be listed and cancelled', async () => {
        const classId = await makeClass({ name: 'İptal Testi' });
        const sessionId = await makeSession(classId, -30, 30);
        const child = await makeStudent('İptal Çocuk');
        const reg = await register(child, sessionId);

        const list = await request(app).get('/api/classes/registrations').query({ child_id: child });
        expect(list.body.success).toBe(true);
        expect(list.body.registrations).toHaveLength(1);
        expect(list.body.registrations[0].gun_adi).toBeTruthy();

        const cancel = await request(app).post('/api/classes/registration-cancel').send({ reg_id: reg.body.reg_id });
        expect(cancel.body.success).toBe(true);
        const row = await get(dbi, 'SELECT status FROM class_registrations WHERE reg_id = ?', [reg.body.reg_id]);
        expect(row.status).toBe('İptal');

        // a cancelled registration no longer blocks session deletion
        const del = await request(app).post('/api/sessions/delete').send({ session_id: sessionId });
        expect(del.body.success).toBe(true);
    });
});

describe('smart RFID routing', () => {
    test('a card scanned during a registered session is logged as class attendance', async () => {
        const classId = await makeClass({ name: 'RFID Ders' });
        const sessionId = await makeSession(classId, -10, 40);
        const child = await makeStudent('Dersli Kart', 'CARD-CLASS-1');
        await register(child, sessionId);

        const res = await scan('CARD-CLASS-1');
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBe('DERS');
        expect(res.body.action).toBe('DERS_GIRIS');
        expect(res.body.session_id).toBe(sessionId);
        expect(res.body.class_name).toBe('RFID Ders');

        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ?', [child, sessionId]);
        expect(att.durum).toBe('GELDİ');
        expect(att.tarih).toBe(today());
        expect(att.giris_zamani).toBeTruthy();
    });

    test('a class scan does not open a play-area session or consume a right', async () => {
        const classId = await makeClass({ name: 'Oyun Alanı Karışmasın' });
        const sessionId = await makeSession(classId, -10, 40);
        const child = await makeStudent('Karışmasın Çocuk', 'CARD-CLASS-2');
        await register(child, sessionId);

        await scan('CARD-CLASS-2');

        const logs = await all(dbi, 'SELECT * FROM logs WHERE child_id = ?', [child]);
        expect(logs).toHaveLength(0);
        const rights = await all(dbi, 'SELECT * FROM rights WHERE child_id = ?', [child]);
        expect(rights).toHaveLength(0);

        const inside = await request(app).get('/api/inside');
        expect(inside.body.children.map((c) => c.child_id)).not.toContain(child);
    });

    test('the second tap checks the child out of the class', async () => {
        const classId = await makeClass({ name: 'İki Kere' });
        const sessionId = await makeSession(classId, -10, 40);
        const child = await makeStudent('İki Kere Çocuk', 'CARD-CLASS-3');
        await register(child, sessionId);

        expect((await scan('CARD-CLASS-3')).body.action).toBe('DERS_GIRIS');
        expect((await scan('CARD-CLASS-3')).body.action).toBe('DERS_CIKIS');
        expect((await scan('CARD-CLASS-3')).body.action).toBe('DERS_ZATEN');

        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(att.cikis_zamani).toBeTruthy();
    });

    test('outside the session window the card falls back to the play area flow', async () => {
        const classId = await makeClass({ name: 'Saat Dışı' });
        await makeSession(classId, 120, 180);           // two hours from now
        const child = await makeStudent('Saat Dışı Çocuk', 'CARD-OUTSIDE');
        const list = await request(app).get('/api/classes');
        const session = list.body.classes.find((c) => c.class_id === classId).sessions[0];
        await register(child, session.session_id);

        const res = await scan('CARD-OUTSIDE');
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBeUndefined();
        expect(res.body.action).toBe('ENTRY');
        expect(res.body).toEqual({ success: true, action: 'ENTRY', child_id: child });
    });

    test('a session on another day does not match today', async () => {
        const classId = await makeClass({ name: 'Başka Gün' });
        const otherDay = dow() === 7 ? 1 : dow() + 1;
        const add = await request(app).post('/api/sessions/add').send({
            class_id: classId, day_of_week: otherDay, start_time: hhmm(-30), end_time: hhmm(30),
        });
        const child = await makeStudent('Başka Gün Çocuk', 'CARD-OTHERDAY');
        await register(child, add.body.session_id);

        const res = await scan('CARD-OTHERDAY');
        expect(res.body.action).toBe('ENTRY');
    });

    test('a child with no class registration behaves exactly as before', async () => {
        const child = await makeStudent('Derssiz Çocuk', 'CARD-NOCLASS');
        const res = await scan('CARD-NOCLASS');
        expect(res.body).toEqual({ success: true, action: 'ENTRY', child_id: child });
    });

    test('early arrival within the tolerance window still counts as class', async () => {
        const classId = await makeClass({ name: 'Erken Gelen' });
        const sessionId = await makeSession(classId, 10, 60);   // starts in 10 min, tolerance is 15
        const child = await makeStudent('Erken Çocuk', 'CARD-EARLY');
        await register(child, sessionId);

        const res = await scan('CARD-EARLY');
        expect(res.body.mode).toBe('DERS');
        expect(res.body.action).toBe('DERS_GIRIS');
    });
});

describe('absence compensation', () => {
    test('a registered child who never scanned gets a play-area right and a notification', async () => {
        const classId = await makeClass({ name: 'Gelmeyen Ders' });
        const sessionId = await makeSession(classId, -120, -60);   // already finished
        const child = await makeStudent('Gelmeyen Çocuk', 'CARD-ABSENT');
        await register(child, sessionId);

        const res = await processAbsences();
        expect(res.body.success).toBe(true);
        expect(res.body.telafi_verilen).toBe(1);
        expect(res.body.bildirim).toBe(1);
        expect(res.body.detay[0].child_id).toBe(child);

        const right = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [child]);
        expect(right).toBeTruthy();
        expect(right.kalan_dk).toBe(60);                     // oyun_alani_seans_dk default
        expect(right.kaynak).toBe('Derse Katılmama Telafisi');
        expect(right.durum).toBe('Aktif');
        expect(right.son_kullanma).toBeTruthy();

        const movement = await get(dbi, 'SELECT * FROM right_movements WHERE hak_id = ?', [right.hak_id]);
        expect(movement.islem).toBe('Tanımlama');
        expect(movement.degisim_dk).toBe(60);

        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ? AND session_id = ?', [child, sessionId]);
        expect(att.durum).toBe('GELMEDİ');
        expect(att.telafi_hak_id).toBe(right.hak_id);
    });

    test('running it again grants nothing (idempotent)', async () => {
        const classId = await makeClass({ name: 'Tekrar Ders' });
        const sessionId = await makeSession(classId, -120, -60);
        const child = await makeStudent('Tekrar Çocuk', 'CARD-ABSENT-2');
        await register(child, sessionId);

        expect((await processAbsences()).body.telafi_verilen).toBe(1);
        expect((await processAbsences()).body.telafi_verilen).toBe(0);

        const rights = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [child]);
        expect(rights).toHaveLength(1);
        const atts = await all(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(atts).toHaveLength(1);
    });

    test('a child who attended is not compensated', async () => {
        const classId = await makeClass({ name: 'Gelen Ders' });
        const sessionId = await makeSession(classId, -120, -60);
        const child = await makeStudent('Gelen Çocuk', 'CARD-ATTEND');
        await register(child, sessionId);

        // mark the attendance by hand (the child arrived, the scan window has passed)
        const mark = await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELDİ', personel: 'Test' });
        expect(mark.body.success).toBe(true);

        expect((await processAbsences()).body.telafi_verilen).toBe(0);
        const rights = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [child]);
        expect(rights).toHaveLength(0);
    });

    test('sessions that have not finished yet are left alone', async () => {
        const classId = await makeClass({ name: 'Devam Eden' });
        const sessionId = await makeSession(classId, -10, 90);
        const child = await makeStudent('Devam Çocuk', 'CARD-ONGOING');
        await register(child, sessionId);

        const res = await processAbsences();
        expect(res.body.telafi_verilen).toBe(0);
        const atts = await all(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(atts).toHaveLength(0);
    });

    test('a registration that is not active yet is not compensated', async () => {
        const classId = await makeClass({ name: 'Gelecek Kayıt' });
        const sessionId = await makeSession(classId, -120, -60);
        const child = await makeStudent('Gelecek Çocuk', 'CARD-FUTURE');
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        await register(child, sessionId, { start_date: tomorrow });

        expect((await processAbsences()).body.telafi_verilen).toBe(0);
    });

    test('manual absence marking also compensates, and switching to GELDİ revokes it', async () => {
        const classId = await makeClass({ name: 'Elle Yoklama' });
        const sessionId = await makeSession(classId, -30, 0);
        const child = await makeStudent('Elle Çocuk', 'CARD-MANUAL');
        await register(child, sessionId);

        const absent = await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELMEDİ', personel: 'Öğretmen' });
        expect(absent.body.success).toBe(true);
        expect(absent.body.telafi).toBeTruthy();

        const right = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', [absent.body.telafi]);
        expect(right.durum).toBe('Aktif');

        const corrected = await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELDİ', personel: 'Öğretmen' });
        expect(corrected.body.success).toBe(true);

        const after = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', [absent.body.telafi]);
        expect(after.durum).toBe('İptal');            // the unused compensation is withdrawn
        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(att.durum).toBe('GELDİ');
    });

    test('a missed day can be backfilled by date (machine was off at session end)', async () => {
        const classId = await makeClass({ name: 'Geçmiş Gün' });
        const child = await makeStudent('Geçmiş Çocuk', 'CARD-PASTDAY');

        const past = new Date(Date.now() - 3 * 86400000);
        const pastDate = localDateStr(past);
        const add = await request(app).post('/api/sessions/add').send({
            class_id: classId, day_of_week: dayOfWeek(past), start_time: '10:00', end_time: '11:00',
        });
        await register(child, add.body.session_id, { start_date: pastDate });

        // today's sweep must not touch a session from another day
        expect((await processAbsences()).body.telafi_verilen).toBe(0);
        expect(await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child])).toBeUndefined();

        const res = await request(app).post('/api/classes/process-absences').send({ tarih: pastDate });
        expect(res.body.success).toBe(true);
        expect(res.body.telafi_verilen).toBe(1);

        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(att.tarih).toBe(pastDate);
        expect(att.durum).toBe('GELMEDİ');
        const rights = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [child]);
        expect(rights).toHaveLength(1);
    });

    test('correcting an attended record to GELMEDİ also compensates, symmetrically', async () => {
        const classId = await makeClass({ name: 'Düzeltme Dersi' });
        const sessionId = await makeSession(classId, -20, 40);
        const child = await makeStudent('Düzeltme Çocuk', 'CARD-FIX');
        await register(child, sessionId);
        await scan('CARD-FIX');                       // attended via the card tap

        // the teacher says the child actually did not attend
        const corrected = await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELMEDİ', personel: 'Öğretmen' });
        expect(corrected.body.success).toBe(true);
        expect(corrected.body.telafi).toBeTruthy();

        const right = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', [corrected.body.telafi]);
        expect(right.durum).toBe('Aktif');
        expect(right.kalan_dk).toBe(60);
        expect(right.kaynak).toBe('Derse Katılmama Telafisi');

        // marking absent again must reuse that right, not mint a second one
        const again = await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELMEDİ', personel: 'Öğretmen' });
        expect(again.body.telafi).toBe(corrected.body.telafi);
        expect(await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [child])).toHaveLength(1);

        // correcting back to GELDİ withdraws the unused compensation
        await request(app).post('/api/classes/attendance')
            .send({ child_id: child, session_id: sessionId, durum: 'GELDİ', personel: 'Öğretmen' });
        const after = await get(dbi, 'SELECT * FROM rights WHERE hak_id = ?', [corrected.body.telafi]);
        expect(after.durum).toBe('İptal');
        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(att.durum).toBe('GELDİ');
        expect(att.telafi_hak_id).toBeNull();
    });

    test("today's view shows each child's attendance state", async () => {
        const classId = await makeClass({ name: 'Bugün Görünümü' });
        const sessionId = await makeSession(classId, -20, 40);
        const child = await makeStudent('Görünüm Çocuk', 'CARD-TODAY');
        await register(child, sessionId);
        await scan('CARD-TODAY');

        const res = await request(app).get('/api/classes/today');
        expect(res.body.success).toBe(true);
        const session = res.body.sessions.find((s) => s.session_id === sessionId);
        expect(session).toBeTruthy();
        const row = session.ogrenciler.find((o) => o.child_id === child);
        expect(row.yoklama).toBe('GELDİ');
    });
});

describe('absence notification text', () => {
    test('contains the exact sentence the parents are told', () => {
        const message = absenceMessage(
            { student_name: 'Ali' },
            { class_name: 'Lego WeDo', start_time: '17:00', end_time: '18:00' },
            '2026-10-24');
        expect(message).toContain('Derse katılamadığınız için hesabınıza 1 seanslık oyun alanı hakkı tanımlanmıştır.');
        expect(message).toContain('Ali');
        expect(message).toContain('Lego WeDo');
    });
});
