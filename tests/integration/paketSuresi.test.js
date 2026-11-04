'use strict';
/**
 * Ön ödemeli paket bakiyesi süre sonu.
 *
 * BELİRTİ: öğrenci profilinde "Mevcut Paket: 0 TL" görünürken çıkış popup'ında gerçek bakiye
 * yazıyordu. Neden: profil ucu süre taramasını çalıştırıyor (updateExpiredRights), popup
 * çalıştırmıyor; tarama ise PAKET haklarını da 'Süresi Doldu' yapıyordu. Bakiye silinmiyordu
 * ama profilden kayboluyor ve çıkışta kullanılamıyordu — yani aile ön ödemeli parasını
 * harcayamıyordu.
 *
 * Bu testler hem iki ucun AYNI değeri vermesini hem de paketin süre taramasından
 * etkilenmemesini doğrular. Oyun alanı telafisinin süresi dolmaya devam eder.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db, updateExpiredRights } = require('../../server.js');
let dbi;
let agent;

beforeAll(async () => {
    await waitForSchema(DB_PATH);
    agent = await authedAgent(app);
    dbi = openDb(DB_PATH);
});
afterAll(async () => {
    await closeDb(dbi);
    await closeDb(db);
});

async function ogrenciOlustur(ad) {
    const r = await agent.post('/api/students/create').send({
        student_name: ad, parent_name: 'Veli', parent_phone: '5550000', birth_date: '2016-01-01',
    });
    return r.body.child_id;
}

/** Paket tanımlar (panel ucu) ve süre sonunu geçmişe çeker. */
async function paketTanimla(childId, tutar, { durum = 'Aktif', gecmisSonKullanma = true } = {}) {
    await agent.post('/api/students/edit').send({
        child_id: childId, student_name: 'X', parent_name: 'Veli', parent_phone: '5550000',
        birth_date: '2016-01-01', rfid_id: null, note: '', cari_turu: 'Oyun',
        telafi_minutes: 0, package_minutes: tutar, telafi_dersi_count: 0, duzeltme_notu: 'test',
    });
    const hak = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [childId]);
    const dun = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    await run(dbi, 'UPDATE rights SET durum = ?, son_kullanma = ? WHERE hak_id = ?',
        [durum, gecmisSonKullanma ? dun : null, hak.hak_id]);
    return hak;
}

describe('paket bakiyesi süre sonu', () => {
    test('profil ve çıkış popup’ı AYNI paket bakiyesini gösterir', async () => {
        const id = await ogrenciOlustur('Süre Testi');
        await paketTanimla(id, 5000);

        const profil = await agent.get('/api/students/get/' + id);
        const profilPaket = profil.body.student.rights_summary.package_minutes;

        // Çıkış önizlemesi çocuğun içeride olmasını ister.
        await agent.post('/api/entry/start').send({ child_id: id, personel: 'Test' });
        const onizleme = await agent.get('/api/exit/preview/' + id);

        expect(profilPaket).toBe(5000);
        expect(onizleme.body.package_minutes).toBe(5000);
        expect(onizleme.body.package_minutes).toBe(profilPaket);
    });

    test('süresi geçmiş işaretlenmiş paket de profilde ve çıkışta görünür', async () => {
        const id = await ogrenciOlustur('Eski Süre');
        await paketTanimla(id, 7500, { durum: 'Süresi Doldu' });

        const profil = await agent.get('/api/students/get/' + id);
        expect(profil.body.student.rights_summary.package_minutes).toBe(7500);

        await agent.post('/api/entry/start').send({ child_id: id, personel: 'Test' });
        const onizleme = await agent.get('/api/exit/preview/' + id);
        expect(onizleme.body.package_minutes).toBe(7500);
    });

    test('süre taraması PAKET haklarını süresi dolmuş saymaz, telafiyi sayar', async () => {
        const id = await ogrenciOlustur('Tarama Testi');
        await paketTanimla(id, 4000);                                  // paket: süresi geçmiş tarihli

        // Telafi: süresi geçmiş (oyun alanı telafisi gerçekten süresi dolar)
        const dun = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        await run(dbi, `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kaynak, tanim_tarihi, son_kullanma, durum)
                        VALUES (?, ?, 'TELAFİ', 120, 120, 'Test', ?, ?, 'Aktif')`,
            ['HAK-TARAMA-' + Date.now(), id, new Date(Date.now() - 40 * 86400000).toISOString(), dun]);

        await updateExpiredRights();                                    // taramayı bekle

        const paket = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'PAKET'", [id]);
        expect(paket.durum).toBe('Aktif');                              // paket parası durur
        expect(paket.kalan_dk).toBe(4000);
        expect(paket.durum).not.toBe('Süresi Doldu');

        const telafi = await get(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ'", [id]);
        expect(telafi.durum).not.toBe('Aktif');                         // telafi süresi doldu
        // 120 dk telafi = 2 ders olarak dönüşmüş olmalı
        const dersler = await all(dbi, "SELECT * FROM rights WHERE child_id = ? AND hak_tipi = 'TELAFİ DERSİ'", [id]);
        expect(dersler).toHaveLength(2);
    });
});
