'use strict';
/**
 * lib/sheets.js — e-tablo ayrıştırma ve doğrulama birim testleri.
 * Veritabanı ve ağ kullanılmaz; şablon dosyasındaki yapı taklit edilir.
 */
const S = require('../../lib/sheets');

const HDR_D = ['Ders Adı', 'Aylık Ücret', 'Dönemlik Ücret', 'Durum', 'Açıklama'];
const HDR_P = ['Ders Adı', 'Gün', 'Başlangıç', 'Bitiş', 'Kontenjan', 'Durum'];
const HDR_K = ['Ad Soyad', 'Kart No', 'Ders Adı', 'Gün', 'Başlangıç', 'Başlangıç Tarihi', 'Bitiş Tarihi', 'Ödeme Tipi', 'Durum', 'Not'];

const FIX = () => ({
    Dersler: [
        HDR_D,
        ['Lego WeDo', 1200, 3600, 'Aktif', 'Robotik atölyesi'],
        ['3D Kalem', '1.000', '3.000', 'Aktif', ''],
        ['Kağıt Devreler', 900, 2700, 'Aktif', ''],
    ],
    Program: [
        HDR_P,
        ['Lego WeDo', 'Salı', '17:00', '18:00', 10, 'Aktif'],
        ['Lego WeDo', 'Cumartesi', '11:00', '12:00', 10, 'Aktif'],
        ['3D Kalem', 'Çarşamba', '16:30', '17:30', 8, 'Aktif'],
        ['Kağıt Devreler', 'Cumartesi', '13:00', '14:00', 8, 'Aktif'],
    ],
    Kayitlar: [
        HDR_K,
        ['Kuzey Denizkuşu', '0005265792', 'Lego WeDo', 'Cumartesi', '11:00', '2026-10-24', '', 'DÖNEMLİK', 'Aktif', ''],
        ['Defne BAYSIN', '0005222064', 'Lego WeDo', 'Salı', '17:00', '2026-10-24', '', 'AYLIK', 'Aktif', ''],
        ['MİRA ALTUNTAŞ', '0005265688', '3D Kalem', 'Çarşamba', '16:30', '2026-10-24', '2027-01-15', 'AYLIK', 'Aktif', ''],
        ['Alparslan AYDIN', '', 'Kağıt Devreler', 'Cumartesi', '13:00', '2026-10-24', '', 'AYLIK', 'Aktif', 'kart yok'],
    ],
});

describe('değer çözümleyiciler', () => {
    test('parseClock — tüm gerçek dünya biçimleri', () => {
        expect(S.parseClock('13:00')).toBe(780);
        expect(S.parseClock('13:00:00')).toBe(780);
        expect(S.parseClock('9:05')).toBe(545);
        expect(S.parseClock('09:15')).toBe(555);
        expect(S.parseClock('13.00')).toBe(780);        // Türkçe yazım
        expect(S.parseClock('0,541666')).toBe(780);     // CSV'de metinleşmiş Excel serisi
        expect(S.parseClock(0.5416666)).toBe(780);      // sayı serisi
        expect(S.parseClock(13)).toBe(780);             // sadece saat
        expect(S.parseClock('1:00 PM')).toBe(780);      // yerel ayar
        expect(S.parseClock('17:30')).toBe(1050);
        expect(S.parseClock('00:00')).toBe(0);
        expect(S.parseClock('25:00')).toBeNull();
        expect(S.parseClock('abc')).toBeNull();
        expect(S.parseClock('')).toBeNull();
        expect(S.parseClock(null)).toBeNull();
    });

    test('parseClock — Date nesnesi (tarih/saat biçimli hücre)', () => {
        expect(S.parseClock(new Date(Date.UTC(1899, 11, 30, 13, 0, 0)))).toBe(780);
    });

    test('parseDay — ad, kısaltma ve rakam', () => {
        expect(S.parseDay('Pazartesi')).toBe(1);
        expect(S.parseDay('Salı')).toBe(2);
        expect(S.parseDay('ÇARŞAMBA')).toBe(3);
        expect(S.parseDay('çar')).toBe(3);
        expect(S.parseDay('Perşembe')).toBe(4);
        expect(S.parseDay('Cuma')).toBe(5);
        expect(S.parseDay('cumartesi')).toBe(6);
        expect(S.parseDay('cmt')).toBe(6);
        expect(S.parseDay('Pazar')).toBe(7);
        expect(S.parseDay('6')).toBe(6);
        expect(S.parseDay('xyz')).toBeNull();
        expect(S.parseDay('')).toBeNull();
    });

    test('parseDate — ISO, Türkçe yazım, Date ve Excel serisi', () => {
        expect(S.parseDate('2026-10-24')).toBe('2026-10-24');
        expect(S.parseDate('24.10.2026')).toBe('2026-10-24');
        expect(S.parseDate('24/10/2026')).toBe('2026-10-24');
        expect(S.parseDate(new Date(2026, 9, 24))).toBe('2026-10-24');
        expect(S.parseDate('2026-10-24T00:00:00.000Z')).toBe('2026-10-24');
        expect(S.parseDate(45000)).toBe('2023-03-15');
        expect(S.parseDate('bozuk')).toBeNull();
        expect(S.parseDate('')).toBeNull();
    });

    test('parseMoney — Türkçe ve İngilizce sayı yazımı', () => {
        expect(S.parseMoney(1200)).toBe(1200);
        expect(S.parseMoney('1200')).toBe(1200);
        expect(S.parseMoney('1.200')).toBe(1200);
        expect(S.parseMoney('1.200,50')).toBe(1200.5);
        expect(S.parseMoney('1200,50')).toBe(1200.5);
        expect(S.parseMoney('1,200.50')).toBe(1200.5);
        expect(S.parseMoney('1200 TL')).toBe(1200);
        expect(S.parseMoney('')).toBeNull();
        expect(S.parseMoney('abc')).toBeNull();
    });

    test('extractSpreadsheetId — bağlantı ve çıplak kimlik', () => {
        const id = '1t_-5S0ZTzAwsQcR4bSPx2iPf6AaHPzOQGNoZriAW2HE';
        expect(S.extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`)).toBe(id);
        expect(S.extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}`)).toBe(id);
        expect(S.extractSpreadsheetId(id)).toBe(id);
        expect(S.extractSpreadsheetId('https://example.com/foo')).toBeNull();
        expect(S.extractSpreadsheetId('')).toBeNull();
    });

    test('parseCsv — tırnak, virgül ve satır sonu', () => {
        const rows = S.parseCsv('a,b,c\n1,"x,y",3\n\n');
        expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x,y', '3']]);
        expect(S.parseCsv('a;"b"\n')).toEqual([['a;b']]);   // noktalı virgül ayraç değildir, tırnak temizlenir
        expect(S.parseCsv('')).toEqual([]);
    });
});

describe('buildPlan — sağlıklı şablon', () => {
    test('tüm satırlar kabul edilir, hata yok', () => {
        const plan = S.buildPlan(FIX());
        expect(plan.errors).toEqual([]);
        expect(plan.classes).toHaveLength(3);
        expect(plan.sessions).toHaveLength(4);
        expect(plan.registrations).toHaveLength(4);

        const lego = plan.classes.find((c) => c.name === 'Lego WeDo');
        expect(lego.monthly_fee).toBe(1200);
        expect(lego.term_fee).toBe(3600);
        expect(lego.status).toBe('Aktif');
        // "1.000" Türkçe binlik ayracıyla doğru okunmalı
        expect(plan.classes.find((c) => c.name === '3D Kalem').monthly_fee).toBe(1000);

        const sess = plan.sessions.find((s) => s.day === 6 && s.start === 660);
        expect(sess.class_name).toBe('Lego WeDo');
        expect(sess.end).toBe(720);
        expect(sess.capacity).toBe(10);

        const reg = plan.registrations.find((r) => r.rfid === '0005265792');
        expect(reg.class_name).toBe('Lego WeDo');
        expect(reg.session_key).toBe(sess.key);
        expect(reg.payment_type).toBe('DÖNEMLİK');
        expect(reg.start_date).toBe('2026-10-24');
        expect(reg.end_date).toBeNull();

        expect(plan.ozet).toEqual({ ders: 3, seans: 4, kayit: 4, hata: 0, pasif_ders: 0, pasif_seans: 0, pasif_kayit: 0 });
    });

    test('boş satırlar ve sütun sırası önemsenmez', () => {
        const fix = FIX();
        // sütunları ters çevir + araya boş satır + fazladan sütun ekle
        fix.Program = [
            ['Durum', 'Kontenjan', 'Bitiş', 'Başlangıç', 'Gün', 'Ders Adı', 'Kim Yazdı'],
            ['Aktif', 10, '18:00', '17:00', 'Salı', 'Lego WeDo', 'Ayşe'],
            ['', '', '', '', '', '', ''],
            ['Aktif', 10, '12:00', '11:00', 'Cumartesi', 'Lego WeDo', 'Ayşe'],
        ];
        const plan = S.buildPlan(fix);
        // Program sekmesi tek başına yetersiz: Kağıt Devreler ile kayıtlar eşleşmez, onları saymayalım
        const lego = plan.sessions.filter((s) => s.class_name === 'Lego WeDo');
        expect(lego).toHaveLength(2);
        expect(lego.find((s) => s.day === 2).start).toBe(1020);
        expect(plan.errors.filter((e) => e.sekme === 'Program')).toEqual([]);
    });

    test('ASCII yazılmış başlıklar da tanınır', () => {
        const fix = FIX();
        fix.Dersler[0] = ['Ders Adi', 'Aylik Ucret', 'Donemlik Ucret', 'Durum', 'Aciklama'];
        const plan = S.buildPlan(fix);
        expect(plan.classes).toHaveLength(3);
        expect(plan.errors.filter((e) => e.sekme === 'Dersler')).toEqual([]);
    });

    test('Excel saat serisi ve Date hücresi kabul edilir', () => {
        const fix = FIX();
        fix.Program = [
            HDR_P,
            ['Lego WeDo', 'Salı', 0.7083333, 0.75, 10, 'Aktif'],                      // 17:00 - 18:00
            ['Lego WeDo', 'Cumartesi', new Date(Date.UTC(1899, 11, 30, 11, 0)), new Date(Date.UTC(1899, 11, 30, 12, 0)), 10, 'Aktif'],
            ['3D Kalem', 'Çarşamba', '16:30', '17:30', 8, 'Aktif'],
            ['Kağıt Devreler', 'Cumartesi', '13:00', '14:00', 8, 'Aktif'],
        ];
        const plan = S.buildPlan(fix);
        expect(plan.errors).toEqual([]);
        expect(plan.sessions.find((s) => s.day === 2).start).toBe(1020);
        expect(plan.sessions.find((s) => s.day === 6 && s.class_name === 'Lego WeDo').start).toBe(660);
        expect(plan.registrations).toHaveLength(4);
    });

    test('sekme adları ayarlanabilir', () => {
        const fix = { 'Kurslar': [HDR_D, ['Lego WeDo', 1200, 3600, 'Aktif', '']], 'Seanslar': [HDR_P, ['Lego WeDo', 'Salı', '17:00', '18:00', 10, 'Aktif']], 'Ogrenci Kayitlari': [HDR_K, ['Ali', '111', 'Lego WeDo', 'Salı', '17:00', '', '', 'AYLIK', 'Aktif', '']] };
        const plan = S.buildPlan(fix, { dersler: 'Kurslar', program: 'Seanslar', kayitlar: 'Ogrenci Kayitlari' });
        expect(plan.errors).toEqual([]);
        expect(plan.registrations).toHaveLength(1);
    });
});

describe('buildPlan — hata yakalama', () => {
    test('başlık satırı yoksa uyarır', () => {
        const plan = S.buildPlan({ Dersler: [['a', 'b']], Program: [HDR_P], Kayitlar: [HDR_K] });
        expect(plan.errors.some((e) => e.kod === 'BASLIK_YOK')).toBe(true);
    });

    test('tanımsız ders, geçersiz gün ve saat yakalanır', () => {
        const fix = FIX();
        fix.Program = [
            HDR_P,
            ['Olmayan Ders', 'Salı', '17:00', '18:00', 10, 'Aktif'],
            ['Lego WeDo', 'Sallı', '17:00', '18:00', 10, 'Aktif'],
            ['Lego WeDo', 'Çarşamba', 'abur cubur', '18:00', 10, 'Aktif'],
            ['Lego WeDo', 'Perşembe', '18:00', '17:00', 10, 'Aktif'],
        ];
        const plan = S.buildPlan(fix);
        const kodlar = plan.errors.map((e) => e.kod);
        expect(kodlar).toContain('BILINMEYEN_DERS');
        expect(kodlar).toContain('GECERSIZ_GUN');
        expect(kodlar).toContain('GECERSIZ_SAAT');
        expect(kodlar).toContain('BITIS_SAAT');
        // hatalı satırlar plana girmez
        expect(plan.sessions).toHaveLength(0);
        // satır numaraları kullanıcıya 1 tabanlı bildirilir
        expect(plan.errors.find((e) => e.kod === 'BILINMEYEN_DERS').satir).toBe(2);
    });

    test('mükerrer ders, mükerrer seans ve boş ders adı', () => {
        const fix = FIX();
        fix.Dersler = [HDR_D, ['Lego WeDo', 1200, 3600, 'Aktif', ''], ['lego we do', 1300, 3900, 'Aktif', ''], ['', 100, 200, 'Aktif', '']];
        fix.Program = [HDR_P, ['Lego WeDo', 'Salı', '17:00', '18:00', 10, 'Aktif'], ['Lego WeDo', 'salı', '17:00', '18:30', 10, 'Aktif']];
        fix.Kayitlar = [HDR_K];
        const plan = S.buildPlan(fix);
        const kodlar = plan.errors.map((e) => e.kod);
        expect(kodlar).toContain('MUKERRER_DERS');     // büyük/küçük harf farkı mükerrer sayılır
        expect(kodlar).toContain('BOS_DERS_ADI');
        expect(kodlar).toContain('MUKERRER_SEANS');
        expect(plan.classes).toHaveLength(1);
        expect(plan.sessions).toHaveLength(1);
    });

    test('programda olmayan seansa kayıt ve mükerrer kayıt', () => {
        const fix = FIX();
        fix.Kayitlar = [
            HDR_K,
            ['Kuzey', '0001', 'Lego WeDo', 'Cuma', '09:00', '', '', 'AYLIK', 'Aktif', ''],
            ['Kuzey', '0005265792', 'Lego WeDo', 'Cumartesi', '11:00', '', '', 'AYLIK', 'Aktif', ''],
            ['Kuzey Denizkuşu', '0005265792', 'Lego WeDo', 'Cumartesi', '11:00', '', '', 'AYLIK', 'Aktif', ''],
        ];
        const plan = S.buildPlan(fix);
        const kodlar = plan.errors.map((e) => e.kod);
        expect(kodlar).toContain('BILINMEYEN_SEANS');
        expect(kodlar).toContain('MUKERRER_KAYIT');    // aynı kart + aynı seans
        expect(plan.registrations).toHaveLength(1);
    });

    test('kontenjan aşımı ve geçersiz ödeme tipi', () => {
        const fix = FIX();
        fix.Program = [HDR_P, ['Lego WeDo', 'Salı', '17:00', '18:00', 1, 'Aktif']];
        fix.Kayitlar = [
            HDR_K,
            ['A', '111', 'Lego WeDo', 'Salı', '17:00', '', '', 'AYLIK', 'Aktif', ''],
            ['B', '222', 'Lego WeDo', 'Salı', '17:00', '', '', 'ABONELIK', 'Aktif', ''],
        ];
        const plan = S.buildPlan(fix);
        const kodlar = plan.errors.map((e) => e.kod);
        expect(kodlar).toContain('KONTENJAN_ASIMI');
        expect(kodlar).toContain('GECERSIZ_ODEME');
        expect(plan.registrations).toHaveLength(2);      // yine de plana girer, ödeme tipi null olur
        expect(plan.registrations[1].payment_type).toBeNull();
    });

    test('kart no olmayan satır kabul edilir (ad ile eşleşecek)', () => {
        const fix = FIX();
        fix.Kayitlar = [HDR_K, ['Alparslan AYDIN', '', 'Lego WeDo', 'Cumartesi', '11:00', '', '', '', '', '']];
        const plan = S.buildPlan(fix);
        expect(plan.errors).toEqual([]);
        expect(plan.registrations[0].student_key).toBe('a:alparslanaydin');
        expect(plan.registrations[0].payment_type).toBeNull();
    });
});
