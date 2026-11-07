/**
 * TÜM ÖĞRENCİLERİN HAREKET DÖKÜMÜ — 80 mm termal yazıcı için.
 *
 * Yönetici panelindeki (home.html) düğmeden çalışır. Bütün öğrencilerin dökümünü TEK bir
 * yazdırma işi olarak hazırlar: her öğrenci ayrı sayfa, aralarında kesme. Böylece 11 öğrenci
 * için 11 kez yazdırma penceresi açılmaz.
 *
 * Biçim, kasadaki "HAREKET DÖKÜMÜ — TERMAL YAZDIR" ile BİREBİR aynıdır (aynı satır düzeni,
 * aynı 36 karakter sınırı); fişler kâğıt üzerinde birbirinden ayırt edilemez. Bu dosya
 * bilerek kendi kendine yeterlidir: index.html'in betiğine hiçbir şey eklemez, oradaki
 * çalışan kasa akışını değiştirmez.
 */
(function () {
    'use strict';

    const CI = '================================';

    function stEsc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, (s) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[s]
        ));
    }
    function stDate(t) {
        if (!t) return '-';
        const d = new Date(t);
        return isNaN(d) ? '-' : d.toLocaleDateString('tr-TR');
    }
    function stMoney(v) {
        return Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' TL';
    }
    function stInt(v) {
        return Number(v || 0).toLocaleString('tr-TR');
    }
    // Uzun süreler saat olarak yazılır (eski kayıtlarda gün mertebesinde süreler olabiliyor).
    function stSure(v) {
        const m = Number(v || 0);
        if (m >= 120) {
            const sa = Math.floor(m / 60), dk = m % 60;
            return sa + ' sa' + (dk ? ' ' + dk + ' dk' : '');
        }
        return m + ' dk';
    }

    /** Tek öğrencinin 80 mm dökümü. index.html'deki statementTermalHtml ile aynı biçim. */
    function dokumTermalHtml(d) {
        const satir = [];
        satir.push('ÜRETEN ÇOCUK');
        satir.push('Hareket Dökümü');
        satir.push(CI);
        satir.push(stEsc(d.ogrenci.student_name));
        satir.push(stEsc(d.ogrenci.child_id) + ' ' + stEsc(d.ogrenci.parent_name || '-'));
        if (d.ogrenci.parent_phone) satir.push('Tel: ' + stEsc(d.ogrenci.parent_phone));
        satir.push('Döküm: ' + new Date().toLocaleString('tr-TR'));
        satir.push(CI);

        // "Kalan" yürüyen bakiyedir: ilk bakiyeden her ziyaretin tutarı sırayla düşülür ve
        // son satır özetin KALAN değerine oturur; müşteri/okuyucu zinciri kendisi doğrular.
        let yuruyen = Number(d.kalan.paket_ilk || 0);
        const ilkVar = yuruyen > 0;
        (d.hareketler || []).forEach((h) => {
            const no = h.sira + ') ';
            const kisa = stDate(h.tarih);
            if (h.iptal) satir.push(no + kisa + ' ' + stSure(h.sure_dk) + ' IPTAL');
            else if (/İyi niyet/i.test(String(h.ozet || ''))) satir.push(no + kisa + ' ' + stSure(h.sure_dk) + ' iyi niyet');
            else if (h.paket_dk > 0) satir.push(no + kisa + ' ' + stSure(h.sure_dk) + ' Paket ' + stInt(h.paket_dk) + 'TL');
            else if (h.nakit_tl > 0) satir.push(no + kisa + ' ' + stSure(h.sure_dk) + ' ' + stInt(h.nakit_tl) + 'TL');
            else satir.push(no + kisa + ' ' + stSure(h.sure_dk));
            if (ilkVar) {
                yuruyen -= Number(h.paket_dk || 0);
                satir.push('   Kalan: ' + stInt(yuruyen) + ' TL');
            } else if (h.kalan_dk !== null && h.kalan_dk !== undefined) {
                satir.push('   Kalan: ' + stInt(h.kalan_dk) + (h.kalan_tipi === 'PAKET' ? ' TL' : ' dk'));
            }
        });
        if (!(d.hareketler || []).length) satir.push('Hareket kaydı yok.');

        satir.push(CI);
        if (d.kalan.paket_ilk > 0) satir.push('İlk bakiye : ' + stMoney(d.kalan.paket_ilk));
        if (d.ozet.paket_dk > 0) satir.push('Kullanılan : ' + stMoney(d.ozet.paket_dk));
        if (d.ozet.nakit_tl > 0) satir.push('Nakit/kart : ' + stMoney(d.ozet.nakit_tl));
        satir.push('KALAN      : ' + stMoney(d.kalan.paket_dk));
        if (d.kalan.telafi_dk > 0) satir.push('Telafi     : ' + stInt(d.kalan.telafi_dk) + ' dk');
        if (d.kalan.puan > 0) satir.push('Puan       : ' + stInt(d.kalan.puan));
        satir.push(CI);
        satir.push('Ziyaret: ' + stInt(d.ozet.ziyaret));
        return '<pre class="tm-metin">' + satir.join('\n') + '</pre>';
    }

    // --- yazdırma altyapısı -------------------------------------------------------------

    function stilKur() {
        if (document.getElementById('tumDokumStil')) return;
        const st = document.createElement('style');
        st.id = 'tumDokumStil';
        st.textContent = `
#tumDokumAlani { display: none; }
#tumDokumAlani pre.tm-metin {
    font-family: Consolas, 'Courier New', monospace;
    font-size: 11px; line-height: 1.35; margin: 0; white-space: pre;
}
@media print {
    /* Yalnızca döküm alanı kâğıda çıkar; panelin geri kalanı gizlenir. */
    body.tumdokum > *:not(#tumDokumAlani) { display: none !important; }
    body.tumdokum #tumDokumAlani { display: block !important; }
    #tumDokumAlani pre.tm-metin { page-break-after: always; break-after: page; }
    #tumDokumAlani pre.tm-metin:last-child { page-break-after: auto; break-after: auto; }
}`;
        document.head.appendChild(st);
    }

    function termalSayfaKur(acik) {
        const mevcut = document.getElementById('termalSayfa');
        if (!acik) { if (mevcut) mevcut.remove(); return; }
        if (mevcut) return;
        const st = document.createElement('style');
        st.id = 'termalSayfa';
        st.textContent = '@page { size: 80mm auto; margin: 3mm; }';
        document.head.appendChild(st);
    }

    function alan() {
        let el = document.getElementById('tumDokumAlani');
        if (!el) {
            el = document.createElement('div');
            el.id = 'tumDokumAlani';
            document.body.appendChild(el);      // body'nin doğrudan çocuğu olmalı (yazdırmada gizleme buna dayanıyor)
        }
        return el;
    }

    function temizle() {
        document.body.classList.remove('tumdokum');
        termalSayfaKur(false);
        const el = document.getElementById('tumDokumAlani');
        if (el) el.innerHTML = '';
        const durum = document.getElementById('tumDokumDurum');
        if (durum && durum.dataset.kilit === '1') { durum.textContent = ''; durum.dataset.kilit = '0'; }
    }

    function trKars(a, b) {
        return String(a || '').localeCompare(String(b || ''), 'tr');
    }

    // --- düğme eylemi -------------------------------------------------------------------

    async function tumDokumleriYazdir() {
        const btn = document.getElementById('tumDokumBtn');
        const durum = document.getElementById('tumDokumDurum');
        const yaz = (t) => { if (durum) durum.textContent = t; };

        if (btn && btn.disabled) return;
        if (btn) btn.disabled = true;
        yaz('Öğrenci listesi alınıyor…');

        try {
            const listeCevap = await fetch('/api/students');
            const listeJson = await listeCevap.json();
            const liste = (listeJson.students || []).slice().sort((a, b) => trKars(a.student_name, b.student_name));
            if (!liste.length) { yaz('Öğrenci bulunamadı.'); return; }

            const parcalar = [];
            const atlanan = [];
            for (let i = 0; i < liste.length; i++) {
                const s = liste[i];
                yaz('Dökümler hazırlanıyor… ' + (i + 1) + ' / ' + liste.length + ' — ' + (s.student_name || s.child_id));
                try {
                    const r = await fetch('/api/students/statement/' + encodeURIComponent(s.child_id));
                    const d = await r.json();
                    if (d && d.ogrenci && d.kalan && d.ozet) parcalar.push(d);
                    else atlanan.push(s.student_name || s.child_id);
                } catch (e) {
                    atlanan.push(s.student_name || s.child_id);
                }
            }

            if (!parcalar.length) { yaz('Döküm hazırlanamadı.'); return; }

            stilKur();
            alan().innerHTML = parcalar.map(dokumTermalHtml).join('');
            termalSayfaKur(true);
            document.body.classList.add('tumdokum');

            const uyari = atlanan.length ? ' (' + atlanan.length + ' öğrenci atlandı: ' + atlanan.join(', ') + ')' : '';
            yaz(parcalar.length + ' döküm hazır' + uyari +
                '. Yazdırma penceresinde yazıcı olarak termal ruloyu seçin.');

            // afterprint desteklenmeyen tarayıcılar için emniyet zamanlayıcısı
            const bitir = () => { window.removeEventListener('afterprint', bitir); temizle(); };
            window.addEventListener('afterprint', bitir, { once: true });
            setTimeout(bitir, 180000);

            window.print();
        } catch (e) {
            yaz('Hata: ' + (e && e.message ? e.message : e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    window.tumDokumleriYazdir = tumDokumleriYazdir;
})();