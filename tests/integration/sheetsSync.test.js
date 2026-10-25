'use strict';
/**
 * E-tablo eşitlemesi: plan uygulama, idempotentlik, yumuşak silme, kaynak ayrımı ve
 * ödeme durumunun korunması. AĞ KULLANILMAZ: ağdan gelen sekme satırları taklit edilir,
 * böylece eşitlemenin veritabanına etkisi gerçek kod yolu üzerinden test edilir.
 */
const path = require('path');
const { makeTempDbPath, waitForSchema, openDb, get, all, run, closeDb } = require('../helpers/db');

jest.mock('pdf-to-printer', () => ({ print: jest.fn().mockResolvedValue(undefined) }));

const DB_PATH = makeTempDbPath();
process.env.DB_PATH = DB_PATH;
process.env.SLIP_TMP_DIR = path.dirname(DB_PATH);

const request = require('supertest');
const { app, db, drainWrites, sheetsLib, applySheetsPlan, resolveSheetStudent, runSheetsSync, appSettings } = require('../../server.js');

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

const HDR_D = ['Ders Adı', 'Aylık Ücret', 'Dönemlik Ücret', 'Durum', 'Açıklama'];
const HDR_P = ['Ders Adı', 'Gün', 'Başlangıç', 'Bitiş', 'Kontenjan', 'Durum'];
const HDR_K = ['Ad Soyad', 'Kart No', 'Ders Adı', 'Gün', 'Başlangıç', 'Başlangıç Tarihi', 'Bitiş Tarihi', 'Ödeme Tipi', 'Durum', 'Not'];

async function makeStudent(name, rfid = null) {
    const res = await request(app).post('/api/students/create').send({
        student_name: name, parent_name: 'Veli', parent_phone: '5550000', birth_date: '2016-01-01', rfid_id: rfid,
    });
    expect(res.body.success).toBe(true);
    return res.body.child_id;
}

/** Şablon yapısında sekme satırları üretir. */
function tabsWith({ classes = [], sessions = [], regs = [] } = {}) {
    return {
        Dersler: [HDR_D].concat(classes),
        Program: [HDR_P].concat(sessions),
        Kayitlar: [HDR_K].concat(regs),
    };
}

const planOf = (opts) => sheetsLib.buildPlan(tabsWith(opts), sheetsLib.TABS);

describe('plan uygulama (e-tablo -> veritabanı)', () => {
    test('ders, seans ve kayıt SHEET kaynağıyla oluşturulur', async () => {
        const child = await makeStudent('Sınıf Öğrencisi', 'CARD-SHT-1');
        const plan = planOf({
            classes: [['Lego WeDo', 1200, 3600, 'Aktif', 'Robotik']],
            sessions: [['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif']],
            regs: [['Sınıf Öğrencisi', 'CARD-SHT-1', 'Lego WeDo', 'Cumartesi', '11:00', '2026-10-24', '', 'DÖNEMLİK', 'Aktif', 'ilk kayıt']],
        });
        expect(plan.errors).toEqual([]);

        const out = await applySheetsPlan(plan);
        expect(out.ders_eklenen).toBe(1);
        expect(out.seans_eklenen).toBe(1);
        expect(out.kayit_eklenen).toBe(1);

        const cls = await get(dbi, "SELECT * FROM classes WHERE name = 'Lego WeDo'");
        expect(cls.kaynak).toBe('SHEET');
        expect(cls.sheet_key).toBe('C:legowedo');
        expect(Number(cls.monthly_fee)).toBe(1200);
        expect(cls.son_gorulme).toBeTruthy();

        const ses = await get(dbi, 'SELECT * FROM sessions WHERE class_id = ?', [cls.class_id]);
        expect(ses.day_of_week).toBe(6);
        expect(ses.start_time).toBe('11:00');
        expect(ses.end_time).toBe('12:00');
        expect(ses.kaynak).toBe('SHEET');

        const reg = await get(dbi, 'SELECT * FROM class_registrations WHERE child_id = ?', [child]);
        expect(reg.session_id).toBe(ses.session_id);
        expect(reg.kaynak).toBe('SHEET');
        expect(reg.payment_type).toBe('DÖNEMLİK');
        expect(Number(reg.fee)).toBe(3600);            // dönemlik ücret Dersler sekmesinden gelir
        expect(reg.odeme_durumu).toBe('BEKLIYOR');     // tahsilat kasiyerin işi
        expect(reg.start_date).toBe('2026-10-24');
        expect(reg.sheet_not).toBe('ilk kayıt');
    });

    test('aynı e-tablo ikinci kez uygulanınca hiçbir şey değişmez (idempotent)', async () => {
        const plan = planOf({
            classes: [['Lego WeDo', 1200, 3600, 'Aktif', 'Robotik']],
            sessions: [['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif']],
            regs: [['Sınıf Öğrencisi', 'CARD-SHT-1', 'Lego WeDo', 'Cumartesi', '11:00', '2026-10-24', '', 'DÖNEMLİK', 'Aktif', 'ilk kayıt']],
        });
        const before = await all(dbi, 'SELECT class_id FROM classes WHERE kaynak = ?', ['SHEET']);
        const out = await applySheetsPlan(plan);
        expect(out.ders_eklenen).toBe(0);
        expect(out.ders_guncellenen).toBe(0);
        expect(out.seans_eklenen).toBe(0);
        expect(out.seans_guncellenen).toBe(0);
        expect(out.kayit_eklenen).toBe(0);
        expect(out.kayit_guncellenen).toBe(0);
        const after = await all(dbi, 'SELECT class_id FROM classes WHERE kaynak = ?', ['SHEET']);
        expect(after.map((r) => r.class_id)).toEqual(before.map((r) => r.class_id));
    });

    test('okuma biçimi değişince güncelleme sayılır ve yoklama geçmişi korunur', async () => {
        // bir yoklama kaydı oluştur (geçmiş korunmalı)
        const cls = await get(dbi, "SELECT * FROM classes WHERE name = 'Lego WeDo'");
        const ses = await get(dbi, 'SELECT * FROM sessions WHERE class_id = ?', [cls.class_id]);
        const child = await get(dbi, 'SELECT * FROM students WHERE student_name = ?', ['Sınıf Öğrencisi']);
        await run(dbi, `INSERT INTO class_attendance (attendance_id, child_id, session_id, class_id, tarih, durum) VALUES ('YOK-T1', ?, ?, ?, '2026-10-18', 'GELDİ')`,
            [child.child_id, ses.session_id, cls.class_id]);

        const plan = planOf({
            classes: [['Lego WeDo', 1500, 4200, 'Aktif', 'Robotik']],   // zamlı
            sessions: [['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif']],
            regs: [['Sınıf Öğrencisi', 'CARD-SHT-1', 'Lego WeDo', 'Cumartesi', '11:00', '2026-10-24', '', 'DÖNEMLİK', 'Aktif', 'ilk kayıt']],
        });
        const out = await applySheetsPlan(plan);
        expect(out.ders_guncellenen).toBe(1);
        const after = await get(dbi, 'SELECT * FROM classes WHERE class_id = ?', [cls.class_id]);
        expect(Number(after.monthly_fee)).toBe(1500);
        expect(await all(dbi, "SELECT * FROM class_attendance WHERE attendance_id = 'YOK-T1'")).toHaveLength(1);
    });

    test('ödeme durumu eşitleme ile ASLA sıfırlanmaz', async () => {
        const reg = await get(dbi, 'SELECT * FROM class_registrations WHERE kaynak = ?', ['SHEET']);
        // kasiyer tahsilatı aldı
        await run(dbi, `UPDATE class_registrations SET odeme_durumu = 'ODENDI' WHERE reg_id = ?`, [reg.reg_id]);

        // e-tabloda değişiklik var (not alanı) -> güncelleme çalışır ama ödeme durumu korunmalı
        const plan = planOf({
            classes: [['Lego WeDo', 1500, 4200, 'Aktif', 'Robotik']],
            sessions: [['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif']],
            regs: [['Sınıf Öğrencisi', 'CARD-SHT-1', 'Lego WeDo', 'Cumartesi', '11:00', '2026-10-24', '', 'DÖNEMLİK', 'Aktif', 'not değişti']],
        });
        const out = await applySheetsPlan(plan);
        expect(out.kayit_guncellenen).toBe(1);
        const after = await get(dbi, 'SELECT * FROM class_registrations WHERE reg_id = ?', [reg.reg_id]);
        expect(after.odeme_durumu).toBe('ODENDI');
        expect(after.sheet_not).toBe('not değişti');
    });

    test('e-tablodan çıkarılan satır SİLİNMEZ, pasife alınır', async () => {
        const plan = planOf({
            classes: [['Lego WeDo', 1500, 4200, 'Aktif', 'Robotik']],
            sessions: [['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif']],
            regs: [],                                          // öğrenci e-tablodan çıkarıldı
        });
        const out = await applySheetsPlan(plan);
        expect(out.kayit_pasif).toBe(1);
        const reg = await get(dbi, 'SELECT * FROM class_registrations WHERE kaynak = ?', ['SHEET']);
        expect(reg.status).toBe('Pasif');                      // silinmedi
        expect(reg.odeme_durumu).toBe('ODENDI');               // ödeme kaydı da duruyor
        expect(await all(dbi, 'SELECT * FROM class_attendance WHERE child_id = ?', [reg.child_id])).toHaveLength(1);

        // ders ve seans e-tablodan çıkarılırsa onlar da pasif olur
        const out2 = await applySheetsPlan(planOf({
            classes: [['Lego WeDo', 1500, 4200, 'Aktif', 'Robotik']],
            sessions: [],
            regs: [],
        }));
        expect(out2.seans_pasif).toBe(1);
        const ses = await get(dbi, 'SELECT * FROM sessions WHERE kaynak = ?', ['SHEET']);
        expect(ses.status).toBe('Pasif');
    });

    test('KASİYERİN elle açtığı kayıtlara eşitleme DOKUNMAZ', async () => {
        const res = await request(app).post('/api/classes/add').send({ name: 'Elle Açılan Ders', monthly_fee: 800, term_fee: 2400 });
        expect(res.body.success).toBe(true);
        const manualId = res.body.class_id;
        const before = await get(dbi, 'SELECT * FROM classes WHERE class_id = ?', [manualId]);
        expect(before.kaynak).toBe('MANUEL');

        // e-tabloda bu ders yok: pasife alınmamalı
        await applySheetsPlan(planOf({ classes: [['Lego WeDo', 1500, 4200, 'Aktif', 'Robotik']], sessions: [], regs: [] }));

        const after = await get(dbi, 'SELECT * FROM classes WHERE class_id = ?', [manualId]);
        expect(after.status).toBe('Aktif');
        expect(after.name).toBe('Elle Açılan Ders');
    });

    test('kuru çalıştırma (önizleme) hiçbir şey yazmaz', async () => {
        const before = await all(dbi, 'SELECT class_id FROM classes');
        const out = await applySheetsPlan(planOf({
            classes: [['Yeni Önizleme Dersi', 100, 200, 'Aktif', '']],
            sessions: [['Yeni Önizleme Dersi', 'Pazartesi', '09:00', '10:00', 5, 'Aktif']],
            regs: [],
        }), { dryRun: true });
        expect(out.ders_eklenen).toBe(1);
        expect(out.seans_eklenen).toBe(1);
        const after = await all(dbi, 'SELECT class_id FROM classes');
        expect(after.length).toBe(before.length);
        expect(await all(dbi, "SELECT * FROM classes WHERE name = 'Yeni Önizleme Dersi'")).toHaveLength(0);
    });
});

describe('öğrenci eşleştirme', () => {
    test('kart numarasıyla, ada göre ve belirsizlik durumları', async () => {
        await makeStudent('Eşleşme Bir', 'CARD-M1');

        const byCard = await resolveSheetStudent({ rfid: 'CARD-M1', student_name: 'Yanlış Ad' });
        expect(byCard.child.student_name).toBe('Eşleşme Bir');

        const byName = await resolveSheetStudent({ rfid: '', student_name: 'eşleşme bir' });
        expect(byName.child.student_name).toBe('Eşleşme Bir');

        const unknownCard = await resolveSheetStudent({ rfid: 'CARD-YOK', student_name: 'Kimse' });
        expect(unknownCard.error).toBe('KART_TANIMSIZ');

        const unknownName = await resolveSheetStudent({ rfid: '', student_name: 'Kayıtsız Kişi' });
        expect(unknownName.error).toBe('OGRENCI_YOK');

        // aynı isimden iki kayıt -> belirsiz, kart no istenir
        await makeStudent('İkiz Kardeş', 'CARD-M2');
        await makeStudent('İkiz Kardeş', 'CARD-M3');
        const ambiguous = await resolveSheetStudent({ rfid: '', student_name: 'İkiz Kardeş' });
        expect(ambiguous.error).toBe('OGRENCI_BELIRSIZ');

        // kartı olmayan öğrenci uyarıyla bağlanır
        const noCard = await makeStudent('Kartsız Çocuk', null);
        const warn = await resolveSheetStudent({ rfid: '', student_name: 'Kartsız Çocuk' });
        expect(warn.child.child_id).toBe(noCard);
        expect(warn.uyari).toContain('Kart No yok');
    });

    test('kart no eşleşmezse ada göre bağlanır ve uyarı verir', async () => {
        await makeStudent('Kart Değişti', 'CARD-NEW');
        const out = await resolveSheetStudent({ rfid: 'CARD-OLD', student_name: 'Kart Değişti' });
        expect(out.child.student_name).toBe('Kart Değişti');
        expect(out.uyari).toContain('ada göre');
    });
});

describe('eşitleme ucu', () => {
    test('bağlantı tanımlı değilse anlaşılır hata döner', async () => {
        appSettings.sheets_url = '';
        const out = await runSheetsSync({});
        expect(out.success).toBe(false);
        expect(out.code).toBe('AYAR_YOK');
        expect(out.message).toContain('E-tablo');
    });

    test('geçersiz bağlantı biçimi reddedilir', async () => {
        appSettings.sheets_url = 'https://example.com/bu-bir-tablo-degil';
        const out = await runSheetsSync({});
        expect(out.success).toBe(false);
        expect(out.message).toContain('okunamadı');
        appSettings.sheets_url = '';
    });

    test('durum ucu eşitleme ayarlarını ve son kayıtları döner', async () => {
        const res = await request(app).get('/api/sheets/status');
        expect(res.body.success).toBe(true);
        expect(res.body.tabs).toEqual({ dersler: 'Dersler', program: 'Program', kayitlar: 'Kayitlar' });
        expect(res.body.sync_minutes).toBeGreaterThan(0);
        expect(Array.isArray(res.body.son_esitlemeler)).toBe(true);
    });
});

describe('ağ katmanı (gerçek istek yapmadan)', () => {
    test('kimlik çıkarma ve sağlayıcı sırası', async () => {
        const id = '1t_-5S0ZTzAwsQcR4bSPx2iPf6AaHPzOQGNoZriAW2HE';
        const calls = [];
        const fakeFetch = async (url) => {
            calls.push(url);
            if (url.indexOf('export?format=xlsx') !== -1) {
                return { ok: false, status: 404 };
            }
            if (url.indexOf('gviz/tq') !== -1) {
                return { ok: true, text: async () => 'Ders Adı,Aylık Ücret\nLego WeDo,1200\n' };
            }
            return { ok: false, status: 500 };
        };
        const out = await sheetsLib.fetchTabs({
            url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit?usp=sharing',
            fetchImpl: fakeFetch,
        });
        expect(out.source).toBe('csv');
        expect(out.tabs.Dersler[0][0]).toBe('Ders Adı');
        expect(out.tabs.Dersler[1][0]).toBe('Lego WeDo');
        expect(calls[0]).toContain('export?format=xlsx');
        expect(calls.some((u) => u.indexOf('/gviz/tq') !== -1)).toBe(true);
    });

    test('kapalı bir e-tabloda anlaşılır hata', async () => {
        const fakeFetch = async () => ({ ok: false, status: 403 });
        await expect(sheetsLib.fetchTabs({
            url: 'https://docs.google.com/spreadsheets/d/1t_-5S0ZTzAwsQcR4bSPx2iPf6AaHPzOQGNoZriAW2HE/edit',
            fetchImpl: fakeFetch,
        })).rejects.toThrow(/paylaşılmış olmalı/);
    });
});
