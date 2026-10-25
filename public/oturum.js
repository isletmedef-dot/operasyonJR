/*
 * Oturum kapısı (istemci tarafı).
 *
 * İki iş yapar:
 *   1) Sunucu 401 dönerse (oturum yok/süresi doldu) kullanıcıyı giriş ekranına döndürür.
 *      Böylece her sayfaya ayrı ayrı hata kontrolü eklemek gerekmez.
 *   2) Sayfaların kendi promptPIN() akışını oturumdaki personel adıyla kısa devre yapar;
 *      giriş yapan personele her işlemde tekrar PIN sorulmaz. "tekrar_pin_sor" ayarı 1 ise
 *      eski davranış (her işlemde PIN) korunur.
 *
 * Sayfaların SONUNDA yüklenir: böylece sayfanın kendi promptPIN tanımı varsa üzerine yazabilir.
 */
(function () {
    const GIRIS = '/login.html';
    const girisSayfasi = /\/login\.html$/.test(location.pathname);

    window.OTURUM = { personel: null, hazir: false, tekrarPin: 0 };

    const gercekFetch = window.fetch.bind(window);

    window.fetch = function (...args) {
        return gercekFetch(...args).then((yanit) => {
            const hedef = String((args[0] && args[0].url) || args[0] || '');
            if (yanit.status === 401 && !girisSayfasi && !/\/api\/auth\//.test(hedef)) {
                location.href = GIRIS;
            }
            return yanit;
        });
    };

    gercekFetch('/api/auth/me')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            if (d && d.success) {
                window.OTURUM.personel = d.name;
                window.OTURUM.tekrarPin = Number(d.tekrar_pin || 0);
                window.OTURUM.hazir = true;
                // Çıkış düğmesi olmayan sayfalar için: sağ üstte kim giriş yaptığını göster.
                oturumSeridiniCiz(d.name);
            } else if (!girisSayfasi) {
                location.href = GIRIS;
            }
        })
        .catch(() => {});

    function oturumSeridiniCiz(ad) {
        if (girisSayfasi || document.getElementById('oturumSeridi')) return;
        const s = document.createElement('div');
        s.id = 'oturumSeridi';
        s.style.cssText = 'position:fixed;top:8px;right:10px;z-index:9998;font:12px Arial,sans-serif;' +
            'background:rgba(17,24,39,.86);color:#e5e7eb;padding:6px 10px;border-radius:10px;display:flex;gap:8px;align-items:center';
        const ad2 = document.createElement('span');
        ad2.textContent = '👤 ' + ad;
        const cikis = document.createElement('button');
        cikis.textContent = 'Çıkış';
        cikis.style.cssText = 'background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:3px 8px;cursor:pointer;font-size:11px';
        cikis.onclick = async () => {
            try { await gercekFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
            location.href = GIRIS;
        };
        s.appendChild(ad2);
        s.appendChild(cikis);
        document.body.appendChild(s);
    }

    // promptPIN'i oturum adıyla kısa devre yap.
    function pinAkisiniBagla() {
        if (typeof window.promptPIN !== 'function' || window.promptPIN.__oturumlu) return;
        const eski = window.promptPIN;
        const yeni = function (callback) {
            if (window.OTURUM.personel && !window.OTURUM.tekrarPin) {
                return callback(window.OTURUM.personel);
            }
            return eski(callback);
        };
        yeni.__oturumlu = true;
        window.promptPIN = yeni;
    }

    window.addEventListener('oturum-hazir', pinAkisiniBagla);
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(pinAkisiniBagla, 0);       // sayfa betiği geç tanımladıysa
        const bekle = setInterval(() => {
            if (window.OTURUM.hazir) { pinAkisiniBagla(); clearInterval(bekle); }
        }, 200);
        setTimeout(() => clearInterval(bekle), 5000);
    });
})();
