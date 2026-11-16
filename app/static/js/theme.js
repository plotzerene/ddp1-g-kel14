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

  function revealFadingPage() {
    if (!root.classList.contains("is-page-fading-in")) return;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      root.classList.remove("is-page-fading-in");
    }
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(finish);
      });
    } else {
      finish();
    }
    window.setTimeout(finish, 650);
  }

  function fadeOutAndGo(targetUrl) {
    var dest = targetUrl || "/home";
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      sessionStorage.setItem("titiket-fade-in", "1");
    } catch (e) {
      // Abaikan jika sessionStorage tidak tersedia.
    }
    if (reduce) {
      window.location.href = dest;
      return;
    }
    var curtain = document.getElementById("page-fade-curtain");
    if (curtain) {
      var targetTheme = "light";
      try {
        if (localStorage.getItem(KEY) === "dark") targetTheme = "dark";
      } catch (e) {}
      curtain.setAttribute("data-target-theme", targetTheme);
    }
    root.classList.add("is-leaving-to-home");
    window.setTimeout(function () {
      window.location.href = dest;
    }, 380);
  }

  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      root.classList.remove("is-leaving-to-home", "is-page-fading-in");
    }
  });

  window.TitiketTransition = {
    fadeOutAndGo: fadeOutAndGo
  };

  revealFadingPage();
})();
