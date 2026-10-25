'use strict';
/**
 * Unit tests for the write layer that every multi-step money operation now depends on:
 * withTransaction() must be all-or-nothing, and withWriteLock() must stop statements from
 * different requests interleaving on the single shared SQLite connection.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const {
    db, withTransaction, withWriteLock, dbRun, dbGet, drainWrites,
} = require('../../server.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => { await waitForSchema(DB_PATH); });
afterAll(async () => {
    await drainWrites();
    await closeDb(db);
});

const pkgCount = async (salesAmount) => {
    const row = await dbGet('SELECT COUNT(*) AS c FROM bonus_packages WHERE sales_amount = ?', [salesAmount]);
    return row.c;
};

describe('withTransaction()', () => {
    test('commits every write when the callback succeeds', async () => {
        await withTransaction(async () => {
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [1001, 10]);
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [1002, 20]);
        });
        expect(await pkgCount(1001)).toBe(1);
        expect(await pkgCount(1002)).toBe(1);
    });

    test('rolls everything back when the callback throws', async () => {
        await expect(withTransaction(async () => {
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [2001, 1]);
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [2002, 2]);
            throw new Error('boom');
        })).rejects.toThrow('boom');

        expect(await pkgCount(2001)).toBe(0);
        expect(await pkgCount(2002)).toBe(0);
    });

    test('rolls back when a statement itself fails', async () => {
        await expect(withTransaction(async () => {
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [3001, 1]);
            await dbRun('INSERT INTO no_such_table (x) VALUES (?)', [1]);
        })).rejects.toThrow();

        expect(await pkgCount(3001)).toBe(0);
    });

    test('releases the lock, so a later transaction still works', async () => {
        await expect(withTransaction(async () => { throw new Error('first fails'); })).rejects.toThrow();
        await withTransaction(async () => {
            await dbRun('INSERT INTO bonus_packages (sales_amount, bonus_amount) VALUES (?, ?)', [4001, 1]);
        });
        expect(await pkgCount(4001)).toBe(1);
    });

    test('propagates the result of the callback', async () => {
        const result = await withTransaction(async () => {
            const row = await dbGet('SELECT 42 AS answer');
            return row.answer;
        });
        expect(result).toBe(42);
    });
});

describe('withWriteLock()', () => {
    test('serialises concurrent writers instead of interleaving them', async () => {
        const order = [];
        await Promise.all([
            withWriteLock(async () => {
                order.push('a:start');
                await sleep(40);
                order.push('a:end');
            }),
            withWriteLock(async () => {
                order.push('b:start');
                order.push('b:end');
            }),
        ]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    test('a failing task does not block the queue', async () => {
        const order = [];
        await Promise.allSettled([
            withWriteLock(async () => { order.push('fail'); throw new Error('nope'); }),
            withWriteLock(async () => { order.push('after'); }),
        ]);
        expect(order).toEqual(['fail', 'after']);
    });

    test('a transaction is not interleaved with a plain locked write', async () => {
        const order = [];
        await Promise.all([
            withTransaction(async () => {
                order.push('tx:start');
                await sleep(40);
                order.push('tx:end');
            }),
            withWriteLock(async () => {
                order.push('plain');
            }),
        ]);
        expect(order).toEqual(['tx:start', 'tx:end', 'plain']);
    });
});
