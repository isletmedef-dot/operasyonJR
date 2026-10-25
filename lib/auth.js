'use strict';
/**
 * Personel girişi ve oturum yönetimi.
 *
 * Kararlar ve gerekçeleri:
 *
 * 1) PIN düz metin saklanmaz. Her personel için rastgele tuz + scrypt özeti tutulur.
 *    Amaç, veritabanı sızarsa personelin başka yerlerde kullandığı PIN'in ele geçmemesi.
 *
 * 2) Oturum kaydı SUNUCUDA tutulur; çerez yalnızca opak, rastgele bir jeton taşır.
 *    Böylece oturum sunucudan tek taraflı iptal edilebilir (çerezi silsen bile
 *    sunucudaki kayıt ayrıca silinebilir).
 *
 * 3) 4 haneli PIN'in tek başına koruması YOKTUR (10.000 olasılık, internete açık bir
 *    adreste dakikalar içinde denenir). Asıl koruma deneme sınırı + oturumdur; bu
 *    yüzden aynı kaynaktan art arda hatalı denemeler kilitlenir.
 *
 * 4) scrypt asenkron kullanılır: giriş sırasında olay döngüsü bloke edilmez.
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const COOKIE_ADI = 'oc_oturum';
const OTURUM_SAAT = 12;
const MAX_DENEME = 5;
const KILIT_DAKIKA = 15;
const KEYLEN = 64;

function yeniTuz() {
    return crypto.randomBytes(16).toString('hex');
}

function yeniJeton() {
    return crypto.randomBytes(32).toString('hex');
}

async function pinOzetle(pin, tuz) {
    const buf = await scrypt(String(pin), String(tuz), KEYLEN);
    return buf.toString('hex');
}

// Zamanlama sızıntısı olmadan iki özeti karşılaştırır.
function sabitZamanEsit(a, b) {
    const ba = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verilen PIN'i personel satırları arasında arar. Eşleşen satırı döner, yoksa null.
 * Uzunluğu tutmayan satırlar hiç özetlenmez (boşuna scrypt maliyeti çıkarılmaz).
 */
async function pinDogrula(pin, satirlar) {
    const verilen = String(pin == null ? '' : pin);
    if (!verilen) return null;
    for (const s of satirlar || []) {
        if (Number(s.pin_uzunluk || 4) !== verilen.length) continue;
        const ozet = await pinOzetle(verilen, s.pin_salt);
        if (sabitZamanEsit(ozet, s.pin_hash)) return s;
    }
    return null;
}

// --- Deneme sınırı -----------------------------------------------------------
// Bellekte tutulur: süreç yeniden başlarsa sayaç sıfırlanır. Bu bilinçli bir tercih;
// personel kilidi kalıcı olsaydı yanlış girişlerden sonra uygulama kullanılamaz hale gelirdi.
const denemeler = new Map();

function kilitDurumu(anahtar) {
    const k = denemeler.get(anahtar);
    if (!k) return { kilitli: false, kalan: MAX_DENEME };
    if (k.kilitSonu && k.kilitSonu > Date.now()) {
        return { kilitli: true, dakika: Math.max(1, Math.ceil((k.kilitSonu - Date.now()) / 60000)) };
    }
    if (k.kilitSonu && k.kilitSonu <= Date.now()) {
        denemeler.delete(anahtar);
        return { kilitli: false, kalan: MAX_DENEME };
    }
    return { kilitli: false, kalan: Math.max(0, MAX_DENEME - k.sayi) };
}

function denemeKaydet(anahtar, basarili) {
    if (basarili) { denemeler.delete(anahtar); return; }
    const k = denemeler.get(anahtar) || { sayi: 0, kilitSonu: 0 };
    k.sayi += 1;
    if (k.sayi >= MAX_DENEME) k.kilitSonu = Date.now() + KILIT_DAKIKA * 60000;
    denemeler.set(anahtar, k);
}

function denemeleriSifirla() {
    denemeler.clear();
}

// --- Çerez yardımcıları ------------------------------------------------------
function cookieOku(req, ad) {
    const ham = String((req && req.headers && req.headers.cookie) || '');
    for (const parca of ham.split(';')) {
        const i = parca.indexOf('=');
        if (i < 0) continue;
        if (parca.slice(0, i).trim() === ad) {
            const deger = parca.slice(i + 1).trim();
            try { return decodeURIComponent(deger); } catch (e) { return deger; }
        }
    }
    return null;
}

// guvenli=true iken Secure eklenir. Yerel ağda (http) Secure çerez hiç gönderilmez,
// bu yüzden alan adı üzerinden HTTPS geldiğinde eklenir.
function cookieYaz(res, jeton, saniye, guvenli) {
    const parcalar = [COOKIE_ADI + '=' + jeton, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + saniye];
    if (guvenli) parcalar.push('Secure');
    res.append('Set-Cookie', parcalar.join('; '));
}

function cookieSil(res) {
    res.append('Set-Cookie', COOKIE_ADI + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

module.exports = {
    COOKIE_ADI, OTURUM_SAAT, MAX_DENEME, KILIT_DAKIKA,
    yeniTuz, yeniJeton, pinOzetle, sabitZamanEsit, pinDogrula,
    kilitDurumu, denemeKaydet, denemeleriSifirla,
    cookieOku, cookieYaz, cookieSil,
};
