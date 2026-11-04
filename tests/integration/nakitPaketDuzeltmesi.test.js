'use strict';
/**
 * Açılışta çalışan tek seferlik veri düzeltmesi (lib/nakit-paket-duzeltmesi.js).
 *
 * Kural: paket bakiyesi görünmediği dönemde kasadan nakit alınmış ziyaretler
 * "paketten karşılandı" hâline getirilir ve bakiyeden düşülür. Bir kez uygulanır;
 * ikinci çalıştırma hiçbir şey yazmamalıdır. Bakiye yetmezse satır atlanır,
 * bakiye asla eksiye düşmez, satırın kendi çıkış zamanı (payment_date) korunur.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, run, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const { db, dbRun, dbGet, dbAll, withTransaction, nakitPaketDuzeltmesi, DATABASE_PATH } = require('../../server.js');

let dbi;
const calistir = () => nakitPaketDuzeltmesi.uygula({ dbGet, dbAll, dbRun, withTransaction, dbPath: DATABASE_PATH });

beforeAll(async () => {
    await waitForSchema(DB_PATH);
    dbi = openDb(DB_PATH);
});
afterAll(async () => { await closeDb(dbi); await closeDb(db); });

async function ogrenciVePaket(child_id, kalanAna, kalanBonus) {
    await run(dbi, `INSERT INTO students (child_id, student_name, parent_name, parent_phone, created_at, status)
                    VALUES (?, ?, 'Veli', '5550000', ?, 'Aktif')`,
        [child_id, 'Test ' + child_id, new Date().toISOString()]);
    await run(dbi, `INSERT INTO rights (hak_id, child_id, hak_tipi, miktar_dk, kalan_dk, kalan_ana_para,
                        kalan_bonus, kaynak, tanim_tarihi, durum)
                    VALUES (?, ?, 'PAKET', 2000, ?, ?, ?, 'Test', ?, 'Aktif')`,
        ['HAK-' + child_id, child_id, kalanAna + kalanBonus, kalanAna, kalanBonus, new Date().toISOString()]);
}

/** Kuralın tarihine denk gelen nakit ziyaret kaydı. */
async function nakitZiyaret(log_id, child_id, gun, sure, tutar, odeme_tarihi) {
    await run(dbi, `INSERT INTO logs (log_id, tarih, child_id, student_name, entry_time, duration_min, fee,
                        payment_type, paketten_dusen, status, payment_date, source_summary)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'NAKİT', 0, 'KAPALI', ?, 'NAKİT Tahsilatı')`,
        [log_id, gun, child_id, 'Test ' + child_id, gun + 'T10:26:00.000Z', sure, tutar, odeme_tarihi]);
}

describe('tek seferlik nakit → paket düzeltmesi', () => {
    test('kurala uyan ziyareti paketten karşılanmış yapar ve bakiyeden düşer', async () => {
        await ogrenciVePaket('UC-000010', 1000, 1000);                       // bakiye 2000
        await nakitZiyaret('LOG-MIG-1', 'UC-000010', '2026-10-27', 95, 750, '2026-10-27T12:00:39.833Z');

        const sonuc = await calistir();
        expect(sonuc.degisiklik).toBe(1);

        const lg = await get(dbi, `SELECT * FROM logs WHERE log_id = 'LOG-MIG-1'`);
        expect(lg.payment_type).toBe('PAKET');                               // artık paketten
        expect(lg.fee).toBe(0);                                              // nakit tahsilat yok
        expect(lg.paketten_dusen).toBe(750);                                 // bakiyeden düşen tutar
        expect(lg.source_summary).toBe('750 TL Paket');                      // uygulamanın kendi biçimi
        expect(lg.payment_date).toBe('2026-10-27T12:00:39.833Z');            // gerçek çıkış anı KORUNUR

        const hak = await get(dbi, `SELECT * FROM rights WHERE hak_id = 'HAK-UC-000010'`);
        expect(hak.kalan_ana_para).toBe(250);                                // önce ana para harcandı
        expect(hak.kalan_bonus).toBe(1000);
        expect(hak.kalan_dk).toBe(1250);
        expect(hak.kalan_dk).toBe(hak.kalan_ana_para + hak.kalan_bonus);
        expect(hak.durum).toBe('Aktif');

        const hareket = await get(dbi, `SELECT * FROM right_movements WHERE log_id = 'LOG-MIG-1'`);
        expect(hareket.islem).toBe('Kullanım (Çıkış)');
        expect(hareket.degisim_dk).toBe(-750);
        expect(hareket.yeni_kalan_dk).toBe(1250);

        const isaret = await get(dbi, `SELECT value FROM settings WHERE key = 'nakit_paket_duzeltmesi_v1'`);
        expect(isaret).toBeTruthy();
        expect(JSON.parse(isaret.value).ziyaret).toBe(1);
    });

    test('ikinci çalıştırma hiçbir şey yazmaz (aynı kayıt iki kez düşülemez)', async () => {
        const bakiyeOnce = (await get(dbi, `SELECT kalan_dk FROM rights WHERE hak_id = 'HAK-UC-000010'`)).kalan_dk;
        const hareketOnce = (await get(dbi, `SELECT COUNT(*) n FROM right_movements`)).n;

        const ikinci = await calistir();

        expect(ikinci.degisiklik).toBe(0);
        expect((await get(dbi, `SELECT kalan_dk FROM rights WHERE hak_id = 'HAK-UC-000010'`)).kalan_dk).toBe(bakiyeOnce);
        expect((await get(dbi, `SELECT COUNT(*) n FROM right_movements`)).n).toBe(hareketOnce);
    });

    test('süre ±3 dk toleransı: makbuzdaki 94 dk, kuraldaki 95 dk ile eşleşir', async () => {
        await nakitZiyaret('LOG-MIG-2', 'UC-000010', '2026-10-27', 94, 750, null);

        await calistir();

        const lg = await get(dbi, `SELECT * FROM logs WHERE log_id = 'LOG-MIG-2'`);
        expect(lg.payment_type).toBe('PAKET');
        expect(lg.paketten_dusen).toBe(750);
        // 1250 - 750 = 500
        expect((await get(dbi, `SELECT kalan_dk FROM rights WHERE hak_id = 'HAK-UC-000010'`)).kalan_dk).toBe(500);
    });

    test('bakiye yetmezse satır atlanır, bakiye eksiye düşmez', async () => {
        await ogrenciVePaket('UC-000004', 100, 0);                           // bakiye 100, gereken 450
        await nakitZiyaret('LOG-MIG-3', 'UC-000004', '2026-10-29', 32, 450, null);

        await calistir();

        const lg = await get(dbi, `SELECT * FROM logs WHERE log_id = 'LOG-MIG-3'`);
        expect(lg.payment_type).toBe('NAKİT');                               // dokunulmadı
        expect(lg.paketten_dusen).toBe(0);

        const hak = await get(dbi, `SELECT * FROM rights WHERE hak_id = 'HAK-UC-000004'`);
        expect(hak.kalan_dk).toBe(100);                                      // bakiye değişmedi
        expect(hak.kalan_dk).toBeGreaterThanOrEqual(0);
    });
});
