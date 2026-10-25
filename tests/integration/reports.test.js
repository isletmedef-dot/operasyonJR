'use strict';
/**
 * İptal edilen (VAZGEÇTİ) ziyaretler: gelire ve "ücretsiz" sayısına girmez, raporlarda
 * işaretlenir. Eski kayıtlarda iptal satırlarının fee alanı DOLU kaldığı için ayrım
 * payment_type üzerinden yapılmalıdır — bu testler tam olarak onu doğrular.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, run, closeDb, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db, drainWrites, reportTotals, logDurum } = require('../../server.js');

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

// Rapor ucu "bugün"ü tarih metniyle süzer; test aynı biçimi kullanır.
const reportDay = () => new Date().toISOString().split('T')[0];

let seq = 0;
async function insertLog({ payment_type, fee, durum_adi = '', tarih = null, child = 'UC-TEST' }) {
    seq += 1;
    const id = 'LOG-TST-' + seq + '-' + Date.now();
    const iso = new Date().toISOString();
    await run(dbi, `INSERT INTO logs (log_id, tarih, child_id, student_name, parent_name, action, entry_time,
                 duration_min, fee, payment_type, payment_date, status, source_summary, personel)
                 VALUES (?, ?, ?, 'Test Çocuk', 'Test Veli', 'GİRİŞ', ?, 60, ?, ?, ?, 'KAPALI', ?, 'Test')`,
        [id, tarih || reportDay(), child, iso, Number(fee || 0), payment_type, iso, durum_adi]);
    return id;
}

describe('reportTotals — gelir hesabı', () => {
    test('iptal edilenler gelire ve ücretsiz sayısına girmez', () => {
        const t = reportTotals([
            { payment_type: 'NAKİT', fee: 450 },
            { payment_type: 'KREDİ KARTI', fee: 300 },
            { payment_type: 'VAZGEÇTİ', fee: 0 },          // yeni kayıt: fee sıfır
            { payment_type: 'VAZGEÇTİ', fee: 500 },        // ESKİ kayıt: fee dolu!
            { payment_type: 'ÜCRETSİZ', fee: 0 },
            { payment_type: 'PAKET', fee: 0 },
            { payment_type: 'HAK', fee: 0 },
        ]);
        expect(t.cash).toBe(450);
        expect(t.card).toBe(300);
        expect(t.revenue).toBe(750);
        expect(t.free).toBe(3);                            // ÜCRETSİZ + PAKET + HAK
        expect(t.iptal).toBe(2);                           // iptaller ayrı sayılır
        expect(t.iptal_tl).toBe(500);                       // tahsil edilmeyen tutar (eski kayıt)
    });

    test('iptal, tahsilat tiplerinden ve ücretsizden ayrıdır', () => {
        const t = reportTotals([{ payment_type: 'VAZGEÇTİ', fee: 999 }]);
        expect(t.cash).toBe(0);
        expect(t.card).toBe(0);
        expect(t.free).toBe(0);
        expect(t.revenue).toBe(0);
        expect(t.iptal).toBe(1);
    });

    test('logDurum satır etiketi', () => {
        expect(logDurum({ payment_type: 'VAZGEÇTİ' })).toBe('İPTAL');
        expect(logDurum({ payment_type: 'NAKİT' })).toBe('TAHSİLAT');
        expect(logDurum({ payment_type: 'KREDİ KARTI' })).toBe('TAHSİLAT');
        expect(logDurum({ payment_type: 'ÜCRETSİZ' })).toBe('ÜCRETSİZ');
        expect(logDurum({ payment_type: 'PAKET' })).toBe('PAKET');
        expect(logDurum({ payment_type: 'HAK' })).toBe('HAK/TELAFİ');
        expect(logDurum({})).toBe('TAHSİLAT');
    });
});

describe('çıkış iptali artık tahsilat yazmıyor', () => {
    test('VAZGEÇTİ ile kapatılan ziyaret gelire yazılmaz, tutarı kayıtta kalır', async () => {
        const stu = await agent.post('/api/students/create').send({
            student_name: 'İptal Test', parent_name: 'Veli', parent_phone: '5550000', birth_date: '2016-01-01',
        });
        const child = stu.body.child_id;
        const started = await agent.post('/api/entry/start').send({ child_id: child, personel: 'Test' });
        expect(started.body.success).toBe(true);

        // Tutarın oluşması için girişi geriye al
        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [child]);
        await run(dbi, 'UPDATE logs SET entry_time = ? WHERE log_id = ?',
            [new Date(Date.now() - 120 * 60000).toISOString(), log.log_id]);

        const cashBefore = (await agent.get('/api/reports/summary')).body.today.cash;
        const out = await agent.post('/api/exit/finalize').send({
            child_id: child, payment_type: 'VAZGEÇTİ', cancel_reason: 'Test iptali', personel: 'Kasa',
        });
        expect(out.body.success).toBe(true);
        const cashAfter = (await agent.get('/api/reports/summary')).body.today.cash;

        const row = await get(dbi, 'SELECT * FROM logs WHERE log_id = ?', [log.log_id]);
        expect(row.status).toBe('KAPALI');
        expect(row.payment_type).toBe('VAZGEÇTİ');
        expect(row.source_summary).toContain('İptal edildi');
        expect(row.source_summary).toContain('hesaplanan');

        // Hesaplanan tutar KAYITTA kalır (rapor "İptal Edilen Tutar" olarak gösterir)...
        expect(Number(row.fee)).toBeGreaterThan(0);
        // ...ama nakit toplamına HİÇBİR ŞEY eklemez.
        expect(cashAfter - cashBefore).toBe(0);

        const res = await agent.get('/api/reports/summary');
        const satir = res.body.today_logs.find(l => l.log_id === log.log_id);
        expect(satir.durum).toBe('İPTAL');
        expect(satir.tahsilat).toBe(0);
        expect(Number(res.body.today.iptal_tl)).toBeGreaterThanOrEqual(Number(row.fee));
    });

    test('iptal edilen ziyarette puan harcanamaz', async () => {
        const stu = await agent.post('/api/students/create').send({
            student_name: 'Puan Test', parent_name: 'Veli', parent_phone: '5550001', birth_date: '2016-01-01',
        });
        const child = stu.body.child_id;
        // çocuğa puan ver
        await run(dbi, 'UPDATE students SET wallet_balance = 50 WHERE child_id = ?', [child]);

        await agent.post('/api/entry/start').send({ child_id: child, personel: 'Test' });
        const log = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [child]);
        await run(dbi, 'UPDATE logs SET entry_time = ? WHERE log_id = ?',
            [new Date(Date.now() - 120 * 60000).toISOString(), log.log_id]);

        // İptal isteğiyle birlikte puan harcama gönderilse bile harcanmamalı.
        const out = await agent.post('/api/exit/finalize').send({
            child_id: child, payment_type: 'VAZGEÇTİ', kullanilan_puan: 30, personel: 'Kasa',
        });
        expect(out.body.success).toBe(true);

        const after = await get(dbi, 'SELECT wallet_balance FROM students WHERE child_id = ?', [child]);
        expect(Number(after.wallet_balance)).toBe(50);                 // puan duruyor
        const row = await get(dbi, 'SELECT * FROM logs WHERE log_id = ?', [log.log_id]);
        expect(Number(row.kullanilan_puan || 0)).toBe(0);
        expect(Number(row.puan_indirimi || 0)).toBe(0);
    });
});

describe('günlük rapor ucu', () => {
    test('iptaller ayrı sayılır, gelire ve ücretsize karışmaz', async () => {
        // Aynı veritabanı paylaşıldığı için temel alıp FARKI ölçeriz.
        const before = (await agent.get('/api/reports/summary')).body.today;

        await insertLog({ payment_type: 'NAKİT', fee: 400 });
        await insertLog({ payment_type: 'KREDİ KARTI', fee: 250 });
        await insertLog({ payment_type: 'ÜCRETSİZ', fee: 0 });
        const eskiIptal = await insertLog({ payment_type: 'VAZGEÇTİ', fee: 999, durum_adi: 'VAZGEÇTİ Tahsilatı' });

        const res = await agent.get('/api/reports/summary');
        expect(res.body.success).toBe(true);
        const t = res.body.today;
        expect(t.cash - before.cash).toBe(400);
        expect(t.card - before.card).toBe(250);
        expect(t.revenue - before.revenue).toBe(650);                     // iptal gelire eklenmedi
        expect(t.free - before.free).toBe(1);                             // sadece ÜCRETSİZ
        expect(t.iptal - before.iptal).toBe(1);                           // iptal ayrı sayıldı
        expect(t.iptal_tl - before.iptal_tl).toBe(999);                   // tahsil edilmeyen tutar

        const row = res.body.today_logs.find(l => l.log_id === eskiIptal);
        expect(row.durum).toBe('İPTAL');
        expect(row.iptal).toBe(true);
        expect(row.tahsilat).toBe(0);                                     // tabloda 0 görünür
    });
});

describe('Excel dışa aktarımı', () => {
    test('iptal satırı İPTAL olarak işaretlenir ve tutarı 0 yazılır', async () => {
        const ExcelJS = require('exceljs');
        const iptalId = await insertLog({ payment_type: 'VAZGEÇTİ', fee: 1234, durum_adi: 'VAZGEÇTİ Tahsilatı' });
        await insertLog({ payment_type: 'NAKİT', fee: 700 });

        const res = await agent.get('/api/export/excel').buffer(true).parse((r, cb) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        const ws = wb.getWorksheet('Giriş Çıkış Logları');
        expect(ws).toBeTruthy();

        const headers = ws.getRow(1).values.filter(Boolean);
        const col = (name) => headers.indexOf(name) + 1;
        expect(headers).toContain('Durum');
        expect(headers).toContain('Tutar (TL)');
        expect(headers).toContain('İptal Edilen Tutar (TL)');

        let bulundu = false;
        ws.eachRow((row, i) => {
            if (i === 1) return;
            if (row.getCell(col('Log ID')).value === iptalId) {
                bulundu = true;
                expect(row.getCell(col('Durum')).value).toBe('İPTAL');
                expect(Number(row.getCell(col('Tutar (TL)')).value)).toBe(0);      // toplama karışmaz
                expect(Number(row.getCell(col('İptal Edilen Tutar (TL)')).value)).toBe(1234);
            }
        });
        expect(bulundu).toBe(true);
    });

    test('normal tahsilat satırı Durum=TAHSİLAT ve tutarı korunur', async () => {
        const ExcelJS = require('exceljs');
        const nakId = await insertLog({ payment_type: 'NAKİT', fee: 555 });
        const res = await agent.get('/api/export/excel').buffer(true).parse((r, cb) => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body);
        const ws = wb.getWorksheet('Giriş Çıkış Logları');
        const headers = ws.getRow(1).values.filter(Boolean);
        const col = (name) => headers.indexOf(name) + 1;
        let bulundu = false;
        ws.eachRow((row, i) => {
            if (i === 1) return;
            if (row.getCell(col('Log ID')).value === nakId) {
                bulundu = true;
                expect(row.getCell(col('Durum')).value).toBe('TAHSİLAT');
                expect(Number(row.getCell(col('Tutar (TL)')).value)).toBe(555);
            }
        });
        expect(bulundu).toBe(true);
    });
});
