// theme.js: tombol ganti tema terang atau gelap. Pilihan disimpan di localStorage.
// Tema yang sudah tersimpan dipasang lebih dulu di <head> (base.html) agar halaman tidak berkedip.
(function () {
  var KEY = "titiket-theme";
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  var themeColor = document.querySelector('meta[name="theme-color"]');
  var colorScheme = document.querySelector('meta[name="color-scheme"]');

  function readStoredTheme() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    return null;
  }

  // Tema efektif: selalu hormati pilihan tersimpan di localStorage di semua halaman, lalu fallback ke default dark.
  function effectiveTheme() {
    var stored = readStoredTheme();
    if (stored) return stored;
    var explicit = root.getAttribute("data-theme");
    if (explicit === "light" || explicit === "dark") return explicit;
    var step = document.body && document.body.getAttribute("data-step");
    var knownStep = (step === "landing" || step === "detail" || step === "promo" || step === "cart" || step === "checkout" || step === "profile");
    return knownStep ? "dark" : "dark";
  }

  function render() {
    var current = effectiveTheme();
    if (root.getAttribute("data-theme") !== current) {
      root.setAttribute("data-theme", current);
    }
    root.classList.toggle("dark", current === "dark");
    if (btn) {
      btn.setAttribute("data-current", current);
      btn.setAttribute("aria-label", current === "dark" ? "Beralih ke tema terang" : "Beralih ke tema gelap");
    }
    if (themeColor) themeColor.setAttribute("content", current === "light" ? "#FFFFFF" : "#0B0F17");
    if (colorScheme) colorScheme.setAttribute("content", current);
    try {
      window.dispatchEvent(new CustomEvent("titiket:themechange", { detail: { theme: current } }));
    } catch (e) {}
  }

  function syncFromStorage() {
    var current = readStoredTheme() || "dark";
    root.setAttribute("data-theme", current);
    render();
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
      var targetTheme = readStoredTheme() || "dark";
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
    syncFromStorage();
  });

  window.addEventListener("storage", function (event) {
    if (event.key === KEY) syncFromStorage();
  });

  window.TitiketTransition = {
    fadeOutAndGo: fadeOutAndGo
  };

  revealFadingPage();
})();
