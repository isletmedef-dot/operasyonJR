'use strict';
/**
 * Döküm fişlerindeki "x" işaretli satırların düzeltmesi (lib/dokum-duzeltmesi.js).
 *
 * Doğrulananlar: yanlış ilk bakiyenin düzeltilip bakiyenin artması (kalan = ana + bonus
 * korunarak), "sil" işaretli kaydın silinmesi ama BAKİYEDEN DÜŞMÜŞ bir kaydın silinmemesi,
 * yanlış tutarın düzeltilmesi, nakdin pakete çevrilmesi, tekrar çalıştırmanın no-op olması
 * ve dökümün "İlk bakiye" değerinin (paket_ilk = SUM(miktar_dk)) artık doğru olması.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db, dbRun, dbGet, dbAll, withTransaction, dokumDuzeltmesi, DATABASE_PATH } = require('../../server.js');

let dbi, agent;
const calistir = () => dokumDuzeltmesi.uygula({ dbGet, dbAll, dbRun, withTransaction, dbPath: DATABASE_PATH });
const bakiye = async (ch) => (await get(dbi, `SELECT COALESCE(SUM(kalan_dk),0) t FROM rights WHERE child_id = ? AND hak_tipi='PAKET'`, [ch])).t;

beforeAll(async () => {
    await waitForSchema(DB_PATH);
    agent = await authedAgent(app);
    dbi = openDb(DB_PATH);
});
afterAll(async () => { await closeDb(dbi); await closeDb(db); });

async function ogrenci(child_id) {
    await run(dbi, `INSERT OR IGNORE INTO students (child_id, student_name, parent_name, parent_phone, created_at, status)
                    VALUES (?, ?, 'Veli', '5550000', ?, 'Aktif')`, [child_id, 'Test ' + child_id, new Date().toISOString()]);
}
async function paket(child_id, miktar, ana, bonus) {
    await run(dbi, `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para,
                        kalan_bonus, kaynak, tanim_tarihi, durum)
                    VALUES (?, ?, 'PAKET', ?, ?, ?, ?, 'Test', ?, 'Aktif')`,
        ['HAK-' + child_id, child_id, miktar, miktar, ana, bonus, new Date().toISOString()]);
}
async function ziyaret(log_id, child_id, gun, dk, { odeme = 'PAKET', fee = 0, dusen = 0, ozet = null } = {}) {
    await run(dbi, `INSERT INTO logs (log_id, tarih, child_id, student_name, entry_time, duration_min, fee,
                        payment_type, paketten_dusen, status, payment_date, source_summary)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'KAPALI', ?, ?)`,
        [log_id, gun, child_id, 'Test ' + child_id, gun + 'T10:00:00.000Z', dk, fee, odeme, dusen,
            gun + 'T11:00:00.000Z', ozet || (dusen > 0 ? dusen + ' TL Paket' : 'NAKİT Tahsilatı')]);
}

describe('döküm fişi düzeltmeleri (x işaretli)', () => {
    test('ilk bakiye düzeltilir, bakiye artar ve dökümdeki İlk bakiye doğru çıkar', async () => {
        // Göksu: paket 18.800 -> 20.000 olmalı, ayrıca 05.11 nakit kaydı pakete çevrilecek
        await ogrenci('UC-000004');
        await paket('UC-000004', 18800, 8800, 10000);
        await ziyaret('LOG-D-1', 'UC-000004', '2026-11-05', 51, { odeme: 'NAKİT', fee: 600 });

        const onceki = await get(dbi, `SELECT miktar_dk, kalan_dk FROM rights WHERE hak_id='HAK-UC-000004'`);
        expect(onceki.miktar_dk).toBe(18800);
        expect(await bakiye('UC-000004')).toBe(18800);

        const sonuc = await calistir();
        expect(sonuc.degisiklik).toBeGreaterThan(0);

        const sonraki = await get(dbi, `SELECT * FROM rights WHERE hak_id='HAK-UC-000004'`);
        expect(sonraki.miktar_dk).toBe(20000);                            // ilk bakiye düzeltildi
        expect(sonraki.kalan_dk).toBe(19400);                             // 20.000 - 600 (pakete çevrilen ziyaret)
        expect(sonraki.kalan_dk).toBe(sonraki.kalan_ana_para + sonraki.kalan_bonus);

        // dökümün "İlk bakiye" satırı
        const st = await agent.get('/api/students/statement/UC-000004');
        expect(st.body.success).toBe(true);
        expect(Number(st.body.kalan && st.body.kalan.paket_ilk)).toBe(20000);

        const hareket = await get(dbi, `SELECT * FROM right_movements WHERE child_id='UC-000004' AND islem='Bakiye Düzeltmesi'`);
        expect(hareket).toBeTruthy();
        expect(hareket.degisim_dk).toBe(1200);
    });

    test('"sil" işaretli kayıt silinir, bakiyeden düşmüş kayıt silinmez', async () => {
        await ogrenci('UC-000010');
        await ziyaret('LOG-D-2', 'UC-000010', '2026-11-06', 1, { odeme: 'VAZGEÇTİ', fee: 0, ozet: 'İptal edildi' });

        await ogrenci('UC-000016');
        await ziyaret('LOG-D-3', 'UC-000016', '2026-10-18', 1, { odeme: 'PAKET', fee: 0, dusen: 100 });   // bakiyeden düşmüş

        await calistir();

        expect(await get(dbi, `SELECT * FROM logs WHERE log_id='LOG-D-2'`)).toBeUndefined();              // silindi
        const korunan = await get(dbi, `SELECT * FROM logs WHERE log_id='LOG-D-3'`);
        expect(korunan).toBeTruthy();                                                                    // KORUNDU
        expect(korunan.paketten_dusen).toBe(100);
    });

    test('yanlış tutar düzeltilir ve aradaki fark bakiyeden düşülür', async () => {
        await ogrenci('UC-000018');
        await paket('UC-000018', 10000, 9941, 0);                   // 59 TL zaten düşülmüş (gerçek durum)
        await ziyaret('LOG-D-4', 'UC-000018', '2026-11-01', 59, { odeme: 'PAKET', fee: 0, dusen: 59 });

        await calistir();

        const lg = await get(dbi, `SELECT * FROM logs WHERE log_id='LOG-D-4'`);
        expect(lg.paketten_dusen).toBe(600);
        expect(lg.source_summary).toBe('600 TL Paket');
        expect(await bakiye('UC-000018')).toBe(9400);                // 9.941 - 541
    });

    test('nakit kayıt pakete çevrilir: fee 0, paketten_dusen tutar, bakiye düşer', async () => {
        await ogrenci('UC-000008');
        await paket('UC-000008', 10000, 10000, 0);
        await ziyaret('LOG-D-5', 'UC-000008', '2026-10-28', 85, { odeme: 'NAKİT', fee: 750 });

        await calistir();

        const lg = await get(dbi, `SELECT * FROM logs WHERE log_id='LOG-D-5'`);
        expect(lg.payment_type).toBe('PAKET');
        expect(lg.fee).toBe(0);
        expect(lg.paketten_dusen).toBe(750);
        expect(lg.payment_date).toBe('2026-10-28T11:00:00.000Z');            // gerçek çıkış anı korunur
        expect(await bakiye('UC-000008')).toBe(9250);
    });

    test('ikinci çalıştırma hiçbir şey yazmaz', async () => {
        const once = {
            b4: await bakiye('UC-000004'), b8: await bakiye('UC-000008'), b18: await bakiye('UC-000018'),
            hareket: (await get(dbi, `SELECT COUNT(*) n FROM right_movements`)).n,
            log: (await get(dbi, `SELECT COUNT(*) n FROM logs`)).n,
        };
        const ikinci = await calistir();
        expect(ikinci.degisiklik).toBe(0);
        expect(await bakiye('UC-000004')).toBe(once.b4);
        expect(await bakiye('UC-000008')).toBe(once.b8);
        expect(await bakiye('UC-000018')).toBe(once.b18);
        expect((await get(dbi, `SELECT COUNT(*) n FROM right_movements`)).n).toBe(once.hareket);
        expect((await get(dbi, `SELECT COUNT(*) n FROM logs`)).n).toBe(once.log);
    });
});
