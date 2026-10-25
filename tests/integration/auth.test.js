'use strict';
/**
 * Oturum (giriş) katmanı.
 *
 * Bu dosyanın en önemli testi MİGRASYON testidir: eski kurulumda PIN'ler düz metindi ve
 * giriş, staff tablosunun DIŞINDAN (tarayıcıda) yapılıyordu. Burada eski biçimli bir
 * veritabanı kurulup uygulama ona karşı açılıyor; personel ESKİ PIN'i ile giriş yapabiliyor mu
 * ve PIN artık düz metin olarak durmuyor mu — ikisi de doğrulanır.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb } = require('../helpers/db');
const auth = require('../../lib/auth');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
let app, classroomApp, db, dbi, agent;

/** Giriş yanıtındaki Set-Cookie başlığından oturum jetonunu çıkarır. */
function cerezJetonu(yanit) {
    const cerez = String(((yanit.headers || {})['set-cookie'] || [])[0] || '');
    const parca = cerez.split(auth.COOKIE_ADI + '=')[1] || '';
    return decodeURIComponent(parca.split(';')[0]);
}

beforeAll(async () => {
    // 1) Eski biçimli veritabanı: staff tablosu düz metin PIN ile, uygulama YÜKLENMEDEN önce.
    const tohum = openDb(DB_PATH);
    await run(tohum, 'CREATE TABLE staff (pin TEXT PRIMARY KEY, name TEXT)');
    await run(tohum, "INSERT INTO staff (pin, name) VALUES ('9999', 'PATRON')");
    await run(tohum, "INSERT INTO staff (pin, name) VALUES ('1111', 'Genel')");
    await run(tohum, 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    await closeDb(tohum);

    // 2) Uygulama bu veritabanına karşı yüklenir; açılışta migrasyon çalışır.
    ({ app, classroomApp, db } = require('../../server.js'));
    await waitForSchema(DB_PATH);
    dbi = openDb(DB_PATH);

    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ pin: '9999' });
});

afterAll(async () => {
    await closeDb(dbi);
    await closeDb(db);
});

beforeEach(() => auth.denemeleriSifirla());

describe('eski kurulumdan geçiş', () => {
    test('düz metin PIN özete taşınır, personel eski PIN ile giriş yapar', async () => {
        const satirlar = await all(dbi, 'SELECT * FROM staff');
        expect(satirlar).toHaveLength(2);

        const patron = satirlar.find((s) => s.name === 'PATRON');
        expect(patron.pin_hash).toBeTruthy();
        expect(patron.pin_salt).toBeTruthy();
        // Düz metin PIN hiçbir kolonda kalmamalı.
        expect(JSON.stringify(satirlar)).not.toContain('9999');
        expect(JSON.stringify(satirlar)).not.toContain('1111');

        const kolonlar = (await all(dbi, 'PRAGMA table_info(staff)')).map((c) => c.name);
        expect(kolonlar).not.toContain('pin');
        expect(kolonlar).toContain('pin_hash');
    });

    test('eski PIN ile giriş yapılabilir (personel bir şey yapmak zorunda kalmaz)', async () => {
        const r = await request(app).post('/api/auth/login').send({ pin: '1111' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ success: true, name: 'Genel' });
    });

    test('migrasyon idempotent: ikinci kez çalıştırıldığında satırlar değişmez', async () => {
        // Migrasyon "pin_hash varsa hiçbir şey yapma" kuralıyla korunuyor. Gerçekten
        // korunup korunmadığını görmek için fonksiyon doğrudan ikinci kez çağrılır:
        // aksi halde DROP/RENAME akışı personel kayıtlarını çoğaltabilirdi.
        const { personelSifreMigrasyonu } = require('../../server.js');
        const once = await all(dbi, 'SELECT id, name, pin_salt FROM staff ORDER BY id');

        await personelSifreMigrasyonu();
        await personelSifreMigrasyonu();

        const sonra = await all(dbi, 'SELECT id, name, pin_salt FROM staff ORDER BY id');
        expect(sonra).toEqual(once);
        expect(sonra).toHaveLength(2);
        // Tuzlar birbirinden farklı olmalı: aynı PIN iki kişide olsa bile özet aynı olmaz.
        expect(sonra[0].pin_salt).not.toBe(sonra[1].pin_salt);
    });
});

describe('giriş kapısı', () => {
    test('oturumsuz API isteği 401 döner', async () => {
        const r = await request(app).get('/api/students');
        expect(r.status).toBe(401);
        expect(r.body.kod).toBe('OTURUM_YOK');
    });

    test('oturumsuz sayfa isteği giriş ekranına yönlendirilir', async () => {
        const r = await request(app).get('/home.html');
        expect(r.status).toBe(302);
        expect(r.headers.location).toBe('/login.html');
    });

    test('giriş ekranı ve oturum betiği oturumsuz erişilebilir', async () => {
        expect((await request(app).get('/login.html')).status).toBe(200);
        expect((await request(app).get('/oturum.js')).status).toBe(200);
    });

    test('oturumlu istek veriye erişebilir', async () => {
        const r = await agent.get('/api/students');
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
    });

    test('oturumdaki personel adı /api/auth/me ile öğrenilir', async () => {
        const r = await agent.get('/api/auth/me');
        expect(r.body).toMatchObject({ success: true, name: 'PATRON' });
        expect(r.body.tekrar_pin).toBe(0);
    });

    test('sınıf portu da oturum ister', async () => {
        // Dikkat: bir supertest aracısı tek bir uygulamaya bağlıdır; sınıf portu için
        // ayrı bir aracı gerekir, yoksa istek kasiyer uygulamasına gider.
        const acik = await request(classroomApp).get('/classroom/api/leaderboard/weekly');
        expect(acik.status).toBe(401);

        const sinif = request.agent(classroomApp);
        await sinif.post('/api/auth/login').send({ pin: '9999' });
        const kapali = await sinif.get('/classroom/api/leaderboard/weekly');
        expect(kapali.status).toBe(200);
    });
});

describe('PIN denemeleri ve kilit', () => {
    test('hatalı PIN reddedilir, doğru PIN kabul edilir', async () => {
        const kotu = await request(app).post('/api/auth/login').send({ pin: '0000' });
        expect(kotu.status).toBe(401);
        expect(kotu.body.success).toBe(false);

        const iyi = await request(app).post('/api/auth/login').send({ pin: '9999' });
        expect(iyi.status).toBe(200);
    });

    test('art arda hatalı denemeler kilitlenir (4 haneli PIN tek başına korumasız)', async () => {
        for (let i = 0; i < auth.MAX_DENEME; i++) {
            await request(app).post('/api/auth/login').send({ pin: '0000' });
        }
        // Kilitliyken DOĞRU PIN bile kabul edilmez: deneme sınırı asıl korumadır.
        const kilitli = await request(app).post('/api/auth/login').send({ pin: '9999' });
        expect(kilitli.status).toBe(401);
        expect(kilitli.body.message).toContain('Çok fazla hatalı deneme');

        auth.denemeleriSifirla();
        const tekrar = await request(app).post('/api/auth/login').send({ pin: '9999' });
        expect(tekrar.status).toBe(200);
    });

    test('başarılı giriş deneme sayacını sıfırlar', async () => {
        await request(app).post('/api/auth/login').send({ pin: '0000' });
        await request(app).post('/api/auth/login').send({ pin: '0000' });
        await request(app).post('/api/auth/login').send({ pin: '9999' });    // başarılı
        for (let i = 0; i < auth.MAX_DENEME - 1; i++) {
            await request(app).post('/api/auth/login').send({ pin: '0000' });
        }
        const hala = await request(app).post('/api/auth/login').send({ pin: '9999' });
        expect(hala.status).toBe(200);          // sayaç sıfırlandığı için kilit yok
    });
});

describe('çıkış ve oturum iptali', () => {
    test('çıkış sonrası eski çerez işe yaramaz', async () => {
        const gecici = request.agent(app);
        const giris = await gecici.post('/api/auth/login').send({ pin: '9999' });
        const jeton = cerezJetonu(giris);
        expect((await gecici.get('/api/students')).status).toBe(200);
        expect(await get(dbi, 'SELECT token FROM oturumlar WHERE token = ?', [jeton])).toBeTruthy();

        await gecici.post('/api/auth/logout');
        expect((await gecici.get('/api/students')).status).toBe(401);
        // Oturum kaydı sunucudan da silinmiş olmalı (yalnızca çerez değil).
        expect(await get(dbi, 'SELECT token FROM oturumlar WHERE token = ?', [jeton])).toBeUndefined();
    });

    test('süresi geçmiş oturum reddedilir ve sunucudan silinir', async () => {
        const gecici = request.agent(app);
        const giris = await gecici.post('/api/auth/login').send({ pin: '9999' });
        const jeton = cerezJetonu(giris);

        // Yalnızca bu oturumun süresi geçmişe çekilir; diğer oturumlar etkilenmesin.
        await run(dbi, 'UPDATE oturumlar SET bitis = ? WHERE token = ?',
            [new Date(Date.now() - 60000).toISOString(), jeton]);

        expect((await gecici.get('/api/students')).status).toBe(401);
        expect(await get(dbi, 'SELECT token FROM oturumlar WHERE token = ?', [jeton])).toBeUndefined();
    });
});

describe('ilk kurulum ucu', () => {
    test('personel varken kurulum yapılamaz (ele geçirme engeli)', async () => {
        const r = await request(app).post('/api/auth/setup').send({ name: 'Saldırgan', pin: '0001' });
        expect(r.status).toBe(400);
        expect(r.body.success).toBe(false);
        const saldirgan = await get(dbi, "SELECT id FROM staff WHERE name = 'Saldırgan'");
        expect(saldirgan).toBeUndefined();
    });

    test('personel yokken kurulum yapılabilir', async () => {
        // Tabloyu boşaltıp temiz kurulum senaryosunu taklit ediyoruz.
        await run(dbi, 'DELETE FROM staff');
        const r = await request(app).post('/api/auth/setup').send({ name: 'Yeni Patron', pin: '2222' });
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);

        const giris = await request(app).post('/api/auth/login').send({ pin: '2222' });
        expect(giris.status).toBe(200);
        expect(giris.body.name).toBe('Yeni Patron');
    });
});
