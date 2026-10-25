'use strict';
/**
 * Unit tests for the thermal-receipt pipeline: sendServerPrint() renders a slip into an
 * 80mm HTML document, hands it to the KASA printer (2 copies), and cleans up the temp file.
 * The physical printer is mocked — no paper, no hardware required.
 */
const fs = require('fs');
const path = require('path');
const { makeTempDbPath, waitForSchema, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
const SLIP_DIR = path.dirname(DB_PATH);
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = SLIP_DIR;

const ptp = require('pdf-to-printer');
const { db, sendServerPrint, PRINTER_NAME, PRINT_COPIES, SLIP_TMP_DIR , drainWrites} = require('../../server.js');

// let the boot migrations finish before we close the handle in afterAll
beforeAll(async () => { await waitForSchema(DB_PATH); });
beforeEach(() => ptp.print.mockClear());
afterAll(async () => {
    await drainWrites();
    await closeDb(db);
});

describe('sendServerPrint() — 80mm thermal receipt', () => {
    test('exports the production printer settings', () => {
        expect(PRINTER_NAME).toBe('KASA');
        expect(PRINT_COPIES).toBe(2);
        expect(SLIP_TMP_DIR).toBe(SLIP_DIR);
    });

    test('wraps the slip in an 80mm print document and sends it to the KASA printer', async () => {
        await sendServerPrint('<h3>ÜRETEN ÇOCUK</h3><p>test satırı</p>');

        expect(ptp.print).toHaveBeenCalledTimes(1);
        const [filePath, options] = ptp.print.mock.calls[0];

        expect(options).toEqual({ printer: 'KASA', copies: 2 });
        expect(path.dirname(filePath)).toBe(SLIP_DIR);
        expect(path.basename(filePath)).toMatch(/^temp_slip_\d+\.html$/);

        const html = fs.readFileSync(filePath, 'utf8');
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('<meta charset="utf-8">');
        expect(html).toContain('size: 80mm auto');
        expect(html).toContain('width: 80mm !important');
        expect(html).toContain('@media print');
        expect(html).toContain('test satırı');
        expect(html).toMatch(/<body>\s*<h3>ÜRETEN ÇOCUK<\/h3>/);
    });

    test('deletes the temporary slip file after the printer has consumed it', async () => {
        jest.useFakeTimers();
        try {
            await sendServerPrint('<p>temizlik testi</p>');
            const [filePath] = ptp.print.mock.calls[0];
            expect(fs.existsSync(filePath)).toBe(true);

            jest.advanceTimersByTime(3000);
            expect(fs.existsSync(filePath)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('swallows printer failures instead of crashing the request handler', async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        ptp.print.mockRejectedValueOnce(new Error("printer 'KASA' not found"));
        await expect(sendServerPrint('<p>hata</p>')).resolves.toBeUndefined();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('produces a distinct file per slip', async () => {
        await sendServerPrint('<p>bir</p>');
        const first = ptp.print.mock.calls[0][0];
        await new Promise((r) => setTimeout(r, 2));
        await sendServerPrint('<p>iki</p>');
        const second = ptp.print.mock.calls[1][0];
        expect(second).not.toBe(first);
    });
});
