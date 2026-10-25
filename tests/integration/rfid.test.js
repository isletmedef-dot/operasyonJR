'use strict';
/**
 * Integration tests for the RFID door flow.
 *
 * POST /api/rfid/scan is the endpoint the card reader calls: it resolves a card to a child
 * and decides whether the next action is ENTRY or EXIT based on whether that child has an
 * open ('AÇIK') session in the logs table.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, closeDb, authedAgent } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db , drainWrites} = require('../../server.js');

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

async function createStudent(overrides = {}) {
    const res = await agent.post('/api/students/create').send({
        student_name: 'Rfid Çocuk',
        parent_name: 'Rfid Veli',
        parent_phone: '5550001122',
        birth_date: '2017-01-15',
        cari_turu: 'Dramatik Oyun Alanı',
        ...overrides,
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

const scan = (rfid_id) => agent.post('/api/rfid/scan').send({ rfid_id });

describe('RFID card flow', () => {
    test('an unregistered card is rejected', async () => {
        const res = await scan('UNKNOWN-CARD');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: false, message: 'Bu karta tanımlı öğrenci bulunamadı.' });
    });

    test('a blank card id is rejected', async () => {
        const res = await scan('');
        expect(res.body.success).toBe(false);
    });

    test('the first tap of a registered card reports ENTRY', async () => {
        const childId = await createStudent({ student_name: 'Giriş Çocuk', rfid_id: 'CARD-ENTRY-1' });
        const res = await scan('CARD-ENTRY-1');
        expect(res.body).toEqual({ success: true, action: 'ENTRY', child_id: childId });
    });

    test('the tap toggles ENTRY -> EXIT -> ENTRY around a session', async () => {
        const childId = await createStudent({ student_name: 'Toggle Çocuk', rfid_id: 'CARD-TOGGLE' });

        // outside -> ENTRY
        let res = await scan('CARD-TOGGLE');
        expect(res.body.action).toBe('ENTRY');

        // door handler opens the session
        const started = await agent.post('/api/entry/start').send({ child_id: childId, personel: 'Rfid Kapı' });
        expect(started.body.success).toBe(true);

        const openLog = await get(dbi, "SELECT * FROM logs WHERE child_id = ? AND status = 'AÇIK'", [childId]);
        expect(openLog).toBeTruthy();
        expect(openLog.personel).toBe('Rfid Kapı');
        expect(openLog.action).toBe('GİRİŞ');

        // inside -> EXIT
        res = await scan('CARD-TOGGLE');
        expect(res.body).toEqual({ success: true, action: 'EXIT', child_id: childId });

        // check out, then the next tap is an ENTRY again
        const fin = await agent.post('/api/exit/finalize')
            .send({ child_id: childId, payment_type: 'NAKİT', personel: 'Rfid Kapı' });
        expect(fin.body.success).toBe(true);

        res = await scan('CARD-TOGGLE');
        expect(res.body).toEqual({ success: true, action: 'ENTRY', child_id: childId });
    });

    test('a deleted child\'s card no longer resolves', async () => {
        const childId = await createStudent({ student_name: 'Silinen Kart', rfid_id: 'CARD-ORPHAN' });
        expect((await scan('CARD-ORPHAN')).body.child_id).toBe(childId);

        await agent.post('/api/students/delete').send({ child_id: childId });

        const res = await scan('CARD-ORPHAN');
        expect(res.body.success).toBe(false);
    });

    test('a card is only matched against the child that owns it', async () => {
        const a = await createStudent({ student_name: 'A Çocuk', rfid_id: 'CARD-A' });
        const b = await createStudent({ student_name: 'B Çocuk', rfid_id: 'CARD-B' });
        expect((await scan('CARD-A')).body.child_id).toBe(a);
        expect((await scan('CARD-B')).body.child_id).toBe(b);

        const stored = await all(dbi, 'SELECT child_id, rfid_id FROM students WHERE rfid_id IS NOT NULL');
        expect(stored.find((r) => r.rfid_id === 'CARD-A').child_id).toBe(a);
        expect(stored.find((r) => r.rfid_id === 'CARD-B').child_id).toBe(b);
    });

    test('children without a card are never matched', async () => {
        await createStudent({ student_name: 'Kartsız Çocuk' });
        const withoutCards = await all(dbi, 'SELECT COUNT(*) AS c FROM students WHERE rfid_id IS NULL');
        expect(withoutCards[0].c).toBeGreaterThan(0);

        const res = await scan('NO-SUCH-CARD');
        expect(res.body.success).toBe(false);
    });
});
