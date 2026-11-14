// theme.js: tombol ganti tema terang atau gelap. Pilihan disimpan di localStorage.
// Tema yang sudah tersimpan dipasang lebih dulu di <head> (base.html) agar halaman tidak berkedip.
(function () {
  var KEY = "titiket-theme";
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  var themeColor = document.querySelector('meta[name="theme-color"]');
  var colorScheme = document.querySelector('meta[name="color-scheme"]');

  // Tema efektif: pilihan eksplisit, atau bawaan halaman (beranda, promo, keranjang, checkout, dan profil terang; visualizer gelap).
  function effectiveTheme() {
    var explicit = root.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    var step = document.body && document.body.getAttribute("data-step");
    return (step === "landing" || step === "promo" || step === "cart" || step === "checkout" || step === "profile")
      ? "light"
      : "dark";
  }

  function render() {
    var current = effectiveTheme();
    if (btn) {
      btn.setAttribute("data-current", current);
      btn.setAttribute("aria-label", current === "dark" ? "Beralih ke tema terang" : "Beralih ke tema gelap");
    }
    if (themeColor) themeColor.setAttribute("content", current === "light" ? "#FFFFFF" : "#0B0F17");
    if (colorScheme) colorScheme.setAttribute("content", current);
  }

  if (btn) {
    btn.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      // Transisi warna singkat (lihat liquid_glass.css) lalu dilepas lagi agar tidak membebani interaksi lain.
      root.classList.add("is-theme-switching");
      window.clearTimeout(btn._switchTimer);
      btn._switchTimer = window.setTimeout(function () {
        root.classList.remove("is-theme-switching");
      }, 340);
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {
        // Penyimpanan diblokir: tema tetap berlaku untuk sesi ini.
      }
      render();
    });
  }

  render();
})();
