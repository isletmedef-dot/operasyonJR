'use strict';
/**
 * Unit tests for the pure pricing / age helpers that drive billing.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const { db, calculateFee, calculateAge, appSettings , drainWrites} = require('../../server.js');

// let the boot migrations finish before we close the handle in afterAll
beforeAll(async () => { await waitForSchema(DB_PATH); });
afterAll(async () => {
    await drainWrites();
    await closeDb(db);
});

describe('calculateFee() — time-based pricing', () => {
    const snapshot = { ...appSettings };

    beforeEach(() => Object.assign(appSettings, {
        base_rate: 300, hourly_rate: 500, extra_rate: 150, exit_tolerance_minutes: 5,
    }));

    afterAll(() => Object.assign(appSettings, snapshot));

    test('is free inside the exit-tolerance window', () => {
        expect(calculateFee(0)).toBe(0);
        expect(calculateFee(1)).toBe(0);
        expect(calculateFee(5)).toBe(0);
    });

    test('charges the base rate for the first tier after tolerance', () => {
        expect(calculateFee(6)).toBe(300);    // effective 1 min
        expect(calculateFee(20)).toBe(300);   // effective 15 min
        expect(calculateFee(35)).toBe(300);   // effective 30 min
    });

    test('charges the hourly rate up to 60 effective minutes', () => {
        expect(calculateFee(36)).toBe(500);   // effective 31 min
        expect(calculateFee(65)).toBe(500);   // effective 60 min
    });

    test('adds the extra rate per started 30-minute block past 60', () => {
        expect(calculateFee(66)).toBe(650);   // effective 61 -> 1 block
        expect(calculateFee(95)).toBe(650);   // effective 90 -> 1 block
        expect(calculateFee(96)).toBe(800);   // effective 91 -> 2 blocks
    });

    test('treats negative, null and undefined input as zero', () => {
        expect(calculateFee(-10)).toBe(0);
        expect(calculateFee(null)).toBe(0);
        expect(calculateFee(undefined)).toBe(0);
    });

    test('coerces numeric strings', () => {
        expect(calculateFee('20')).toBe(300);
    });

    test('reads live settings — widening tolerance widens the free window', () => {
        appSettings.exit_tolerance_minutes = 15;
        expect(calculateFee(15)).toBe(0);
        expect(calculateFee(16)).toBe(300);
    });

    test('reads live settings — rate changes are picked up immediately', () => {
        appSettings.base_rate = 1000;
        expect(calculateFee(20)).toBe(1000);
    });
});

describe('calculateAge()', () => {
    const localDate = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };

    test('a birthday exactly 10 years ago yields 10', () => {
        const d = new Date();
        d.setFullYear(d.getFullYear() - 10);
        expect(calculateAge(localDate(d))).toBe(10);
    });

    test('a birthday still ahead this year yields one year less', () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setFullYear(d.getFullYear() - 10);
        expect(calculateAge(localDate(d))).toBe(9);
    });

    test('returns "-" for missing or unparsable dates', () => {
        expect(calculateAge(null)).toBe('-');
        expect(calculateAge(undefined)).toBe('-');
        expect(calculateAge('')).toBe('-');
        expect(calculateAge('not-a-date')).toBe('-');
    });

    test('never returns a negative age', () => {
        const future = new Date();
        future.setDate(future.getDate() + 1);
        expect(calculateAge(localDate(future))).toBe(0);
    });
});
