'use strict';
/**
 * Sınıf arayüzü: port/uç izolasyonu, bağlamsal RFID akışı (Ders / Oyun Alanı seçimi),
 * okuyucu anahtarı, tekrar filtresi ve pasaport onayı.
 *
 * Önemli kural: sınıf portundan kasiyer uçlarına erişilemez (404) ve sınıf tabletinden
 * oyun alanı ÇIKIŞI yapılamaz.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const {
    app, classroomApp, db, drainWrites, dayOfWeek, appSettings, pendingTaps,
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

afterEach(() => { pendingTaps.clear(); appSettings.classroom_reader_token = ''; });

const dow = () => dayOfWeek(new Date());
const hhmm = (minsFromNow) => {
    const d = new Date(Date.now() + minsFromNow * 60000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

async function makeClass(body = {}) {
    const res = await request(app).post('/api/classes/add').send({ name: 'Sınıf Dersi', monthly_fee: 1200, term_fee: 3600, ...body });
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
const register = (child_id, session_id) => request(app).post('/api/classes/register').send({ child_id, session_id, payment_type: 'AYLIK' });
const scan = (rfid_id, token) => {
    const r = request(classroomApp).post('/classroom/rfid/scan');
    if (token) r.set('X-Reader-Token', token);
    return r.send({ rfid_id });
};
const choose = (tapId, choice, token) => {
    const r = request(classroomApp).post('/classroom/tap/' + tapId + '/choose');
    if (token) r.set('X-Reader-Token', token);
    return r.send({ choice });
};

describe('port izolasyonu — iki arayüz birbirinin ucunu görmez', () => {
    test('sınıf portunda kasiyer uçları YOKTUR', async () => {
        const cashierPaths = [
            '/api/students', '/api/settings', '/api/inside', '/api/classes', '/api/classes/today',
            '/api/classes/add', '/api/classes/attendance', '/api/exit/finalize', '/api/reports/summary',
            '/api/students/create', '/api/entry/start',
        ];
        for (const p of cashierPaths) {
            const res = await request(classroomApp).get(p);
            expect(res.status).toBe(404);
        }
        // POST ile de erişilemez: öğretmen elle yoklama alamaz, ders açamaz
        const att = await request(classroomApp).post('/api/classes/attendance').send({ child_id: 'X', session_id: 'Y', durum: 'GELDİ' });
        expect(att.status).toBe(404);
        const add = await request(classroomApp).post('/api/classes/add').send({ name: 'Kaçak Ders' });
        expect(add.status).toBe(404);
        const rows = await all(dbi, "SELECT * FROM classes WHERE name = 'Kaçak Ders'");
        expect(rows).toHaveLength(0);
    });

    test('kasiyer portunda sınıf uçları YOKTUR', async () => {
        expect((await request(app).post('/classroom/rfid/scan').send({ rfid_id: 'x' })).status).toBe(404);
        expect((await request(app).get('/classroom/api/pending')).status).toBe(404);
        expect((await request(app).post('/classroom/api/passport/complete').send({})).status).toBe(404);
    });

    test('sınıf ekranı tablet sayfasını sunar, kasiyer sayfalarını sunmaz', async () => {
        const home = await request(classroomApp).get('/');
        expect(home.status).toBe(200);
        expect(home.text).toContain('Sınıf Ekranı');
        expect((await request(classroomApp).get('/home.html')).status).toBe(404);
        expect((await request(classroomApp).get('/inside.html')).status).toBe(404);
    });

    test('sınıf arama ucu yalnızca ad ve puan döner (veli telefonu yok)', async () => {
        await makeStudent('Zeynep Deneme', 'CARD-SRCH');
        const res = await request(classroomApp).get('/classroom/api/students/search?q=zeynep');
        expect(res.body.success).toBe(true);
        expect(res.body.students.length).toBeGreaterThan(0);
        expect(Object.keys(res.body.students[0]).sort()).toEqual(['child_id', 'student_name', 'wallet_balance']);
        // Türkçe harf duyarsız arama: "MİRA" -> "mira"
        await makeStudent('MİRA Test', 'CARD-SRCH2');
        const tr = await request(classroomApp).get('/classroom/api/students/search?q=' + encodeURIComponent('mira'));
        expect(tr.body.students.some((s) => s.student_name === 'MİRA Test')).toBe(true);
    });
});

describe('okutma akışı — öğrenci seçim yapar', () => {
    test('okutma yoklama YAZMAZ, seçim bekler', async () => {
        const classId = await makeClass({ name: 'Seçim Dersi' });
        const sessionId = await makeSession(classId, -10, 50);
        const child = await makeStudent('Seçim Çocuk', 'CARD-CHOOSE');
        await register(child, sessionId);

        const res = await scan('CARD-CHOOSE');
        expect(res.body.success).toBe(true);
        expect(res.body.code).toBe('SECIM_BEKLIYOR');
        expect(res.body.has_class).toBe(true);
        expect(res.body.class_name).toBe('Seçim Dersi');
        expect(res.body.tap_id).toBeTruthy();

        // Henüz yoklama yok: okutmak tek başına bir şey yazmaz
        expect(await all(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child])).toHaveLength(0);
        expect(await all(dbi, 'SELECT * FROM logs WHERE child_id = ?', [child])).toHaveLength(0);
    });

    test('DERS seçilirse yoklama; ikinci okutma çıkış yazar', async () => {
        const classId = await makeClass({ name: 'Giriş Çıkış' });
        const sessionId = await makeSession(classId, -10, 50);
        const child = await makeStudent('Ders Çocuk', 'CARD-DERS');
        await register(child, sessionId);

        const t1 = await scan('CARD-DERS');
        const c1 = await choose(t1.body.tap_id, 'DERS');
        expect(c1.body.success).toBe(true);
        expect(c1.body.action).toBe('DERS_GIRIS');
        expect(c1.body.class_name).toBe('Giriş Çıkış');

        const att = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(att.durum).toBe('GELDİ');
        expect(att.giris_zamani).toBeTruthy();
        expect(att.cikis_zamani).toBeNull();
        // Sınıf yoklaması oyun alanı hakkı düşmez ve logs satırı yazmaz
        expect(await all(dbi, 'SELECT * FROM logs WHERE child_id = ?', [child])).toHaveLength(0);

        const t2 = await scan('CARD-DERS');
        const c2 = await choose(t2.body.tap_id, 'DERS');
        expect(c2.body.action).toBe('DERS_CIKIS');
        const after = await get(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [child]);
        expect(after.cikis_zamani).toBeTruthy();

        const t3 = await scan('CARD-DERS');
        const c3 = await choose(t3.body.tap_id, 'DERS');
        expect(c3.body.action).toBe('DERS_ZATEN');
    });

    test('programda dersi olmayan çocuğa DERS seçilirse "eşleşme yok"', async () => {
        await makeStudent('Derssiz Çocuk', 'CARD-NOCLASS');
        const t = await scan('CARD-NOCLASS');
        expect(t.body.has_class).toBe(false);
        const c = await choose(t.body.tap_id, 'DERS');
        expect(c.body.success).toBe(false);
        expect(c.body.code).toBe('ESLESME_YOK');
        expect(c.body.message).toContain('Eşleşme yok');
    });

    test('OYUN seçilirse oyun alanı GİRİŞİ yazılır', async () => {
        const child = await makeStudent('Oyun Çocuk', 'CARD-OYUN');
        const t = await scan('CARD-OYUN');
        const c = await choose(t.body.tap_id, 'OYUN');
        expect(c.body.success).toBe(true);
        expect(c.body.action).toBe('GIRIS');
        const log = await get(dbi, 'SELECT * FROM logs WHERE child_id = ?', [child]);
        expect(log.status).toBe('AÇIK');
        expect(log.action).toBe('GİRİŞ');
        expect(log.personel).toBe('Sınıf Okuyucu');
    });

    test('oyun alanı ÇIKIŞI sınıf tabletinden YAPILAMAZ', async () => {
        const child = await makeStudent('Çıkış Çocuk', 'CARD-EXIT');
        const t1 = await scan('CARD-EXIT');
        await choose(t1.body.tap_id, 'OYUN');

        // ikinci kez OYUN seçilirse çıkış değil, "zaten içeride" cevabı gelir
        const t2 = await scan('CARD-EXIT');
        const c2 = await choose(t2.body.tap_id, 'OYUN');
        expect(c2.body.success).toBe(false);
        expect(c2.body.code).toBe('ZATEN_ICERIDE');
        expect(c2.body.message).toContain('kasadan');

        const log = await get(dbi, 'SELECT * FROM logs WHERE child_id = ?', [child]);
        expect(log.status).toBe('AÇIK');       // hâlâ içeride
        expect(log.fee).toBeFalsy();           // ücret/çıkış işlemi yok
        expect(await all(dbi, 'SELECT * FROM logs WHERE child_id = ? AND status = ?', [child, 'KAPALI'])).toHaveLength(0);
    });

    test('tanınmayan kart ve boş kart', async () => {
        const unk = await scan('CARD-YOK-BU');
        expect(unk.body.success).toBe(false);
        expect(unk.body.code).toBe('TANINMAYAN_KART');
        const empty = await scan('   ');
        expect(empty.body.code).toBe('KART_YOK');
    });

    test('kart numarası büyük/küçük harf ve boşluk farkıyla da bulunur', async () => {
        await makeStudent('Kart Çocuk', 'abc12345');
        const res = await scan(' ABC12345 ');
        expect(res.body.success).toBe(true);
        expect(res.body.student_name).toBe('Kart Çocuk');
    });

    test('tekrarlayan okutma yeni seçim ekranı açmaz', async () => {
        await makeStudent('Tekrar Çocuk', 'CARD-DUP');
        const a = await scan('CARD-DUP');
        const b = await scan('CARD-DUP');
        expect(b.body.tap_id).toBe(a.body.tap_id);
        expect(b.body.repeated).toBe(true);
        expect(pendingTaps.size).toBe(1);
    });

    test('geçersiz seçim ve süresi dolmuş okutma', async () => {
        await makeStudent('Seçim2 Çocuk', 'CARD-BAD');
        const t = await scan('CARD-BAD');
        const bad = await choose(t.body.tap_id, 'KAHVE');
        expect(bad.body.code).toBe('GECERSIZ_SECIM');
        // geçersiz seçim bekleyen kaydı tüketmez
        expect(pendingTaps.size).toBe(1);

        // süresi geçmiş kayıt
        const tap = pendingTaps.get(t.body.tap_id);
        tap.expires = Date.now() - 1000;
        const late = await choose(t.body.tap_id, 'DERS');
        expect(late.body.code).toBe('SURE_DOLDU');
        expect(pendingTaps.size).toBe(0);
    });

    test('okuyucu anahtarı tanımlıysa yetkisiz okutma reddedilir', async () => {
        await makeStudent('Anahtar Çocuk', 'CARD-TOKEN');
        appSettings.classroom_reader_token = 'gizli-123';

        expect((await scan('CARD-TOKEN')).status).toBe(401);
        expect((await scan('CARD-TOKEN', 'yanlis')).status).toBe(401);

        const ok = await scan('CARD-TOKEN', 'gizli-123');
        expect(ok.status).toBe(200);
        expect(ok.body.success).toBe(true);

        const c = await choose(ok.body.tap_id, 'DERS');
        expect(c.status).toBe(401);                       // seçim de yetki ister
        const c2 = await choose(ok.body.tap_id, 'DERS', 'gizli-123');
        expect(c2.status).toBe(200);
    });

    test('tablet bekleyen okutmaları görebilir', async () => {
        await makeStudent('Bekleyen Çocuk', 'CARD-PEND');
        const t = await scan('CARD-PEND');
        const list = await request(classroomApp).get('/classroom/api/pending');
        expect(list.body.success).toBe(true);
        expect(list.body.taps.map((x) => x.tap_id)).toContain(t.body.tap_id);
        expect(list.body.taps[0].student_name).toBe('Bekleyen Çocuk');
    });

    test('birden fazla bekleyen okutma varsa EN YENİSİ önce gelir', async () => {
        await makeStudent('Önce Okutan', 'CARD-P1');
        await makeStudent('Sonra Okutan', 'CARD-P2');
        await scan('CARD-P1');
        await new Promise((r) => setTimeout(r, 15));       // okutmalar arasında zaman farkı
        const sonraki = await scan('CARD-P2');

        const list = await request(classroomApp).get('/classroom/api/pending');
        expect(list.body.taps).toHaveLength(2);
        expect(list.body.taps[0].tap_id).toBe(sonraki.body.tap_id);
        expect(list.body.taps[0].student_name).toBe('Sonra Okutan');
    });

    test('pasaport onayı ve geri alma puanı yürütür', async () => {
        const child = await makeStudent('Pasaport Çocuk', 'CARD-PAS');
        const tasks = await request(app).get('/api/tasks');
        const taskId = tasks.body.tasks[0].task_id;

        const c = await request(classroomApp).post('/classroom/api/passport/complete').send({ child_id: child, task_id: taskId });
        expect(c.body.success).toBe(true);
        expect(c.body.puan).toBe(10);
        expect(c.body.yeni_bakiye).toBe(10);

        const p = await request(classroomApp).get('/classroom/api/passport/' + child);
        expect(p.body.success).toBe(true);
        expect(p.body.student.wallet_balance).toBe(10);
        expect(p.body.tasks.find((t) => t.task_id === taskId).tamamlandi).toBe(true);

        const u = await request(classroomApp).post('/classroom/api/passport/uncomplete').send({ child_id: child, task_id: taskId });
        expect(u.body.success).toBe(true);
        expect(u.body.yeni_bakiye).toBe(0);
    });

    test('sınıf portunda liderlik ve bugün uçları çalışır', async () => {
        const lead = await request(classroomApp).get('/classroom/api/leaderboard/weekly');
        expect(lead.body.success).toBe(true);
        expect(Array.isArray(lead.body.leaderboard)).toBe(true);
        const today = await request(classroomApp).get('/classroom/api/today');
        expect(today.body.success).toBe(true);
        expect(Array.isArray(today.body.sessions)).toBe(true);
    });
});
