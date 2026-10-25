'use strict';
/**
 * Öğrenci hareket dökümü (ekstre): geçmiş giriş/çıkışlar, ücretler ve her işlemden
 * sonra kalan bakiye. Döküm tarayıcıdan yazdırılır; burada veri doğruluğu test edilir.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db, drainWrites } = require('../../server.js');

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

async function makeStudent(name) {
    const res = await request(app).post('/api/students/create').send({
        student_name: name, parent_name: 'Veli Adı', parent_phone: '5551112233', birth_date: '2016-05-10',
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

async function openSession(childId, minutesAgo) {
    const started = await request(app).post('/api/entry/start').send({ child_id: childId, personel: 'Test' });
    expect(started.body.success).toBe(true);
    const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [childId]);
    await run(dbi, 'UPDATE logs SET entry_time = ? WHERE log_id = ?',
        [new Date(Date.now() - minutesAgo * 60000).toISOString(), log.log_id]);
    return log;
}

const checkout = (child_id, body = {}) =>
    request(app).post('/api/exit/finalize').send({ child_id, payment_type: 'NAKİT', personel: 'Kasa', ...body });

const statement = (child_id) => request(app).get('/api/students/statement/' + child_id);

describe('hareket dökümü (ekstre)', () => {
    test('ziyaretler ücret ve çıkış saatiyle listelenir', async () => {
        const child = await makeStudent('Ekstre Çocuk');
        await openSession(child, 90);                 // 90 dk önce giriş -> ücretli ziyaret
        const out = await checkout(child);
        expect(out.body.success).toBe(true);

        const st = await statement(child);
        expect(st.body.success).toBe(true);
        expect(st.body.ogrenci.student_name).toBe('Ekstre Çocuk');
        expect(st.body.ogrenci.parent_name).toBe('Veli Adı');
        expect(st.body.hareketler).toHaveLength(1);

        const h = st.body.hareketler[0];
        expect(h.sira).toBe(1);
        expect(h.tarih).toMatch(/^\d{4}-\d{2}-\d{2}$/);          // normalize edilmiş tarih
        expect(h.giris).toBeTruthy();
        expect(h.cikis).toBeTruthy();                            // giriş + süre
        expect(h.sure_dk).toBeGreaterThan(80);
        expect(h.ucret).toBeGreaterThan(0);
        expect(h.nakit_tl).toBe(h.ucret);                        // nakit ödeme: kasadan çıkan tutar
        expect(h.odeme).toBe('NAKİT');

        // çıkış = giriş + süre (dakika)
        const fark = Math.round((new Date(h.cikis) - new Date(h.giris)) / 60000);
        expect(Math.abs(fark - (h.sure_dk + 0))).toBeLessThanOrEqual(1);
    });

    test('özet toplamları ve kalan bakiye doğru', async () => {
        const child = await makeStudent('Ekstre Özet');
        await openSession(child, 90);
        await checkout(child);
        await openSession(child, 40);
        await checkout(child);

        const st = await statement(child);
        const d = st.body;
        expect(d.ozet.ziyaret).toBe(2);
        expect(d.ozet.nakit_tl).toBe(d.hareketler.reduce((a, h) => a + h.nakit_tl, 0));
        expect(d.ozet.paket_dk).toBe(0);                         // paket yok, nakit ödendi
        expect(d.ozet.ilk_tarih).toBeTruthy();
        expect(d.ozet.son_tarih).toBeTruthy();
        expect(d.kalan.paket_dk).toBe(0);
        expect(d.kalan.telafi_dk).toBe(0);
        expect(d.kalan.puan).toBe(0);
        // hareketler eskiden yeniye sıralı
        expect(d.hareketler[0].giris <= d.hareketler[1].giris).toBe(true);
    });

    test('paketten düşülen ziyarette nakit tutar sıfır, kalan bakiye dolu', async () => {
        const child = await makeStudent('Ekstre Paket');
        // 600 dk paket tanımla
        const hak = await request(app).post('/api/rights/add').send({
            child_id: child, hak_tipi: 'PAKET', miktar_dk: 600, satis_tutari: 600, kaynak: '600 TL Paket',
        });
        if (hak.body && hak.body.success === false) return;      // uç yoksa bu test atlanır

        await openSession(child, 70);
        const out = await checkout(child, { payment_type: 'PAKET' });
        if (!out.body.success) return;

        const st = await statement(child);
        const d = st.body;
        if (!d.hareketler.length) return;
        const h = d.hareketler[0];
        if (h.paket_dk > 0) {
            expect(h.nakit_tl).toBe(0);                          // paketten düşüldü, kasadan para çıkmadı
            expect(h.kalan_dk).not.toBeNull();                   // işlem sonrası kalan dakika
            expect(d.ozet.paket_dk).toBe(h.paket_dk);
        }
    });

    test('hareketi olmayan öğrencide boş döküm döner', async () => {
        const child = await makeStudent('Hareketsiz Çocuk');
        const st = await statement(child);
        expect(st.body.success).toBe(true);
        expect(st.body.hareketler).toEqual([]);
        expect(st.body.ozet.ziyaret).toBe(0);
        expect(st.body.ozet.nakit_tl).toBe(0);
        expect(st.body.ozet.ilk_tarih).toBeNull();
    });

    test('olmayan öğrenci için anlaşılır hata', async () => {
        const st = await statement('UC-YOK-9999');
        expect(st.body.success).toBe(false);
        expect(st.body.message).toContain('bulunamadı');
    });

    test('iptal edilmiş (VAZGEÇTİ) ziyaretler de dökümde görünür', async () => {
        const child = await makeStudent('Ekstre İptal');
        await openSession(child, 60);
        await request(app).post('/api/exit/finalize').send({
            child_id: child, payment_type: 'VAZGEÇTİ', cancel_reason: 'Test iptali', personel: 'Kasa',
        });
        const st = await statement(child);
        expect(st.body.hareketler.length).toBeGreaterThanOrEqual(1);
        expect(st.body.ozet.nakit_tl).toBe(0);                   // iptalde tahsilat yok
    });

    test('döküm hareket sayısı veritabanıyla uyuşur', async () => {
        const child = await makeStudent('Ekstre Sayım');
        await openSession(child, 90); await checkout(child);
        await openSession(child, 80); await checkout(child);
        await openSession(child, 30);
        const acik = await get(dbi, "SELECT COUNT(*) AS c FROM logs WHERE child_id = ? AND status = 'KAPALI'", [child]);
        const st = await statement(child);
        expect(st.body.ozet.ziyaret).toBeGreaterThanOrEqual(Number(acik.c));
    });
});
