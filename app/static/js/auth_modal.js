// auth_modal.js: modal autentikasi member, auth guard checkout, serta Modal A & B global.
(function () {
  var PENDING_KEY = "titiket-pending-checkout";
  var BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  var modal = document.getElementById("auth-modal");
  var titleEl = document.getElementById("auth-modal-title");
  var eyebrowEl = document.getElementById("auth-modal-eyebrow");
  var feedbackEl = document.getElementById("auth-feedback");
  var guardNoticeEl = document.getElementById("auth-guard-notice");
  var forgotTargetEl = document.getElementById("auth-forgot-target");
  var closeBtn = modal ? modal.querySelector(".auth-modal__close") : null;
  var views = modal ? Array.prototype.slice.call(modal.querySelectorAll("[data-auth-view]")) : [];

  var titles = {
    login: "Masuk",
    register: "Daftar",
    forgot: "Lupa Kata Sandi",
    "forgot-sent": "Instruksi Reset Terkirim"
  };
  var eyebrows = {
    login: "",
    register: "",
    forgot: "",
    "forgot-sent": ""
  };
  var lastFocus = null;
  var toastTimer = null;
  var gateLocked = false;

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* abaikan bila penyimpanan diblokir */ }
  }

  function readPending() {
    try {
      var raw = sessionStorage.getItem(PENDING_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writePending(payload) {
    try {
      if (!payload) sessionStorage.removeItem(PENDING_KEY);
      else sessionStorage.setItem(PENDING_KEY, JSON.stringify(payload));
    } catch (e) { /* abaikan bila sessionStorage tidak tersedia */ }
  }

  function safeLocalPath(candidate, fallback) {
    var val = String(candidate || "").trim();
    if (!val || val.charAt(0) !== "/" || val.indexOf("//") === 0) return fallback || "/home";
    return val;
  }

  function currentUserState() {
    var ds = document.body ? document.body.dataset : {};
    var authenticated = ds.authenticated === "1";
    return {
      authenticated: authenticated,
      name: ds.userName || "",
      email: ds.userEmail || "",
      is_ui_student: ds.userUi === "1"
    };
  }

  function setDatasetUser(user) {
    if (!document.body) return;
    if (user) {
      document.body.dataset.authenticated = "1";
      document.body.dataset.userName = user.name || "";
      document.body.dataset.userEmail = user.email || "";
      document.body.dataset.userUi = user.is_ui_student ? "1" : "0";
      writeStorage("titiket-auth-user", user.name || "");
      writeStorage("titiket-sso-ui", user.is_ui_student ? "verified" : null);
    } else {
      document.body.dataset.authenticated = "0";
      document.body.dataset.userName = "";
      document.body.dataset.userEmail = "";
      document.body.dataset.userUi = "0";
      writeStorage("titiket-auth-user", null);
      writeStorage("titiket-auth-preview", null);
      writeStorage("titiket-sso-ui", null);
    }
  }

  function showFeedback(text, isError) {
    if (!feedbackEl) return;
    feedbackEl.textContent = text || "";
    feedbackEl.classList.toggle("is-error", Boolean(isError));
    feedbackEl.hidden = !text;
  }

  function showGuardNotice(text) {
    if (!guardNoticeEl) return;
    guardNoticeEl.textContent = text || "";
    guardNoticeEl.hidden = !text;
  }

  function syncViews(mode) {
    if (!modal || !titleEl) return;
    var targetMode = titles[mode] ? mode : "login";
    titleEl.textContent = titles[targetMode];
    if (eyebrowEl) eyebrowEl.textContent = eyebrows[targetMode] || "";
    modal.setAttribute("data-mode", targetMode);
    views.forEach(function (view) {
      view.hidden = view.getAttribute("data-auth-view") !== targetMode;
    });
  }

  function open(mode, guardNotice, locked) {
    if (!modal) return;
    lastFocus = document.activeElement;
    gateLocked = Boolean(locked);
    showFeedback("", false);
    showGuardNotice(guardNotice || "");
    syncViews(mode || "login");
    modal.hidden = false;
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!modal) return;
    if (gateLocked && !currentUserState().authenticated) {
      window.location.replace("/cart?auth=required&next=" + encodeURIComponent(window.location.pathname + window.location.search));
      return;
    }
    gateLocked = false;
    modal.hidden = true;
    showFeedback("", false);
    showGuardNotice("");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function syncAuthIndicators() {
    var state = currentUserState();
    var badge = document.getElementById("sso-footer-badge");
    if (badge) badge.hidden = !state.is_ui_student;

    Array.prototype.forEach.call(document.querySelectorAll("[data-auth-guest]"), function (el) {
      el.hidden = state.authenticated;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-auth-member]"), function (el) {
      el.hidden = !state.authenticated;
      var nameEl = el.querySelector("[data-auth-member-name]");
      if (nameEl) nameEl.textContent = state.name || "Member";
    });
  }

  async function postJson(url, payload) {
    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload || {})
    });
    var data = {};
    try { data = await response.json(); } catch (e) { data = {}; }
    return { ok: response.ok, status: response.status, data: data };
  }

  function showSeatCollisionToast(opts) {
    var banner = document.getElementById("top-toast-banner");
    if (!banner) return;
    var info = opts || {};
    var isStanding = Boolean(info.standing);
    var label = info.label || info.seatId || (isStanding ? "pilihan" : "tersebut");
    var msg = info.message || (isStanding
      ? "Tiket " + label + " baru saja penuh atau diambil pengguna lain. Silakan pilih kategori lain yang tersedia."
      : "Kursi " + label + " baru saja diambil pengguna lain. Silakan pilih kursi lain yang tersedia.");
    banner.innerHTML = "";
    var iconWrap = document.createElement("span");
    iconWrap.className = "top-toast__icon";
    iconWrap.innerHTML = '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#i-x"/></svg>';
    var textEl = document.createElement("span");
    textEl.textContent = msg;
    banner.appendChild(iconWrap);
    banner.appendChild(textEl);
    banner.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      banner.hidden = true;
    }, 4500);
  }

  function showExpiredReservation(opts) {
    if (document.body.classList.contains("is-wayfinding-mode")
      || new URLSearchParams(window.location.search).get("mode") === "wayfinding") {
      return;
    }
    var root = document.getElementById("reservation-expired-root");
    if (!root) return;
    var cfg = opts || {};
    var titleText = cfg.title || "Waktu Reservasi Habis";
    var bodyText = cfg.message || "Sesi pemesananmu berakhir dan tiket dilepas. Pilih ulang untuk melanjutkan.";
    var cancelText = cfg.cancelLabel || "Batalkan Sesi";
    var ctaText = cfg.cta || "Pilih Ulang";

    root.innerHTML = "";
    var backdrop = document.createElement("div");
    backdrop.className = "resv-expired-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "resv-expired-title");

    var card = document.createElement("div");
    card.className = "resv-expired-card";

    var iconWrap = document.createElement("div");
    iconWrap.className = "resv-expired-card__icon";
    iconWrap.innerHTML = '<svg class="icon" width="24" height="24" aria-hidden="true"><use href="#i-hourglass-empty"/></svg>';

    var heading = document.createElement("h2");
    heading.className = "resv-expired-card__title";
    heading.id = "resv-expired-title";
    heading.textContent = titleText;

    var desc = document.createElement("p");
    desc.className = "resv-expired-card__body";
    desc.textContent = bodyText;

    var actions = document.createElement("div");
    actions.className = "resv-expired-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn resv-expired-card__cancel";
    cancelBtn.textContent = cancelText;
    cancelBtn.addEventListener("click", async function () {
      root.innerHTML = "";
      try {
        await postJson("/checkout/cancel", { action: "cancel_order", reason: "Waktu reservasi habis" });
      } catch (e) {}
      window.location.href = "/";
    });

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn resv-expired-card__cta";
    btn.textContent = ctaText;
    btn.addEventListener("click", function () {
      root.innerHTML = "";
      if (typeof cfg.onRestart === "function") {
        cfg.onRestart();
      } else {
        window.location.href = cfg.redirectUrl || "/";
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(btn);

    card.appendChild(iconWrap);
    card.appendChild(heading);
    card.appendChild(desc);
    card.appendChild(actions);
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    btn.focus();
  }

  async function finalizeAuthenticated(user, fallbackNext) {
    setDatasetUser(user);
    syncAuthIndicators();

    var pending = readPending();
    if (pending && pending.pendingCartPayload) {
      var addRes = await postJson("/visualizer/api/cart", pending.pendingCartPayload);
      if (addRes.status === 409) {
        writePending(null);
        close();
        showSeatCollisionToast({
          seatId: addRes.data.conflict_seat_id,
          label: addRes.data.conflict_label,
          standing: addRes.data.conflict_standing,
          message: addRes.data.error
        });
        document.dispatchEvent(new CustomEvent("titiket:cart-collision", { detail: addRes.data }));
        return;
      }
    }

    var target = pending && pending.nextUrl ? pending.nextUrl : fallbackNext;
    writePending(null);
    if (target) {
      window.location.href = safeLocalPath(target, "/checkout/");
      return;
    }
    if (document.getElementById("intro-gate") || window.location.pathname === "/" || window.location.pathname === "/intro") {
      window.setTimeout(function () {
        if (window.TitiketTransition && typeof window.TitiketTransition.fadeOutAndGo === "function") {
          window.TitiketTransition.fadeOutAndGo("/home");
        } else {
          window.location.href = "/home";
        }
      }, 420);
      return;
    }
    window.setTimeout(close, 500);
  }

  function requireAuth(options) {
    var state = currentUserState();
    var opts = options || {};
    if (state.authenticated) return true;
    var nextUrl = safeLocalPath(opts.nextUrl || "/checkout/", "/checkout/");
    writePending({
      nextUrl: nextUrl,
      pendingCartPayload: opts.pendingCartPayload || null
    });
    open(
      opts.mode || "login",
      opts.notice || "Silakan masuk atau daftar akun terlebih dahulu untuk melanjutkan pemesanan.",
      Boolean(opts.locked)
    );
    return false;
  }

  document.addEventListener("click", async function (event) {
    var logoutBtn = event.target.closest("[data-auth-logout]");
    if (logoutBtn) {
      event.preventDefault();
      await postJson("/auth/logout", {});
      setDatasetUser(null);
      writePending(null);
      syncAuthIndicators();
      if (window.location.pathname.indexOf("/checkout") === 0) {
        window.location.href = "/cart";
      } else if (window.location.pathname.indexOf("/profile") === 0 || window.location.pathname.indexOf("/pesanan") === 0) {
        window.location.reload();
      }
      return;
    }

    var guardLink = event.target.closest("[data-requires-auth]");
    if (guardLink && !currentUserState().authenticated) {
      event.preventDefault();
      requireAuth({ nextUrl: guardLink.getAttribute("href") || "/checkout/" });
      return;
    }

    var opener = event.target.closest("[data-auth-open]");
    if (opener && modal) {
      event.preventDefault();
      var nextMode = opener.getAttribute("data-auth-open");
      if (modal.hidden) open(nextMode);
      else {
        showFeedback("", false);
        syncViews(nextMode);
      }
      return;
    }

    var togglePass = event.target.closest("[data-toggle-password]");
    if (togglePass) {
      var input = document.getElementById(togglePass.getAttribute("data-toggle-password"));
      if (input) {
        var reveal = input.type === "password";
        input.type = reveal ? "text" : "password";
        togglePass.setAttribute("aria-pressed", String(reveal));
        var useEl = togglePass.querySelector("use");
        if (useEl) useEl.setAttribute("href", reveal ? "#i-eye-off" : "#i-eye");
      }
      return;
    }

    var oauthBtn = event.target.closest("[data-oauth-provider]");
    if (oauthBtn) {
      event.preventDefault();
      var provider = oauthBtn.getAttribute("data-oauth-provider") || "Google";
      var pending = readPending();
      var res = await postJson("/auth/oauth", {
        provider: provider,
        next: (pending && pending.nextUrl) || (oauthBtn.closest("#intro-gate") ? "/home" : "")
      });
      if (!res.ok) {
        showFeedback((res.data && res.data.error) || "Gagal masuk dengan " + provider + ".", true);
        return;
      }
      if (oauthBtn.closest("#intro-gate")) {
        setDatasetUser(res.data.user);
        syncAuthIndicators();
        var gateFeedback = document.getElementById("intro-gate-feedback");
        if (gateFeedback) {
          gateFeedback.textContent = "Masuk dengan " + provider + " berhasil. Mengalihkan...";
          gateFeedback.hidden = false;
        }
        window.setTimeout(function () {
          if (window.TitiketTransition && typeof window.TitiketTransition.fadeOutAndGo === "function") {
            window.TitiketTransition.fadeOutAndGo("/home");
          } else {
            window.location.href = "/home";
          }
        }, 420);
        return;
      }
      showFeedback("Berhasil masuk dengan " + provider + ".");
      await finalizeAuthenticated(res.data.user, "");
      return;
    }

    var profileBtn = event.target.closest("[data-profile-toggle]");
    var popoverMenu = document.getElementById("profile-popover-menu");
    if (profileBtn && popoverMenu) {
      event.preventDefault();
      var nextOpen = popoverMenu.hidden;
      popoverMenu.hidden = !nextOpen;
      profileBtn.setAttribute("aria-expanded", String(nextOpen));
      return;
    }
    if (popoverMenu && !popoverMenu.hidden && !event.target.closest(".auth-profile-wrap")) {
      popoverMenu.hidden = true;
      var trig = document.getElementById("profile-popover-trigger");
      if (trig) trig.setAttribute("aria-expanded", "false");
    }

    var openLocBtn = event.target.closest("[data-open-location-sheet]");
    var locModal = document.getElementById("location-sheet-modal");
    if (openLocBtn && locModal) {
      event.preventDefault();
      locModal.hidden = false;
      return;
    }
    if (event.target.closest("[data-location-close]") && locModal) {
      locModal.hidden = true;
      return;
    }
    var locChoiceBtn = event.target.closest("[data-location-choice]");
    if (locChoiceBtn && locModal) {
      Array.prototype.forEach.call(locModal.querySelectorAll("[data-location-choice]"), function (b) {
        b.classList.toggle("is-selected", b === locChoiceBtn);
      });
      return;
    }
    if (event.target.closest("#location-confirm-btn") && locModal) {
      var chosen = locModal.querySelector("[data-location-choice].is-selected");
      var cityVal = chosen ? chosen.getAttribute("data-location-choice") : "JABODETABEK";
      setCity(cityVal);
      locModal.hidden = true;
      return;
    }

    if (event.target.closest("[data-auth-close]")) close();
  });

  if (modal) {
    modal.addEventListener("submit", async function (event) {
      var form = event.target.closest("[data-auth-form]");
      if (!form) return;
      event.preventDefault();
      var kind = form.getAttribute("data-auth-form");
      var emailInput = form.querySelector('input[type="email"]');
      var rawEmail = emailInput ? emailInput.value.trim() : "";
      if (emailInput && !rawEmail) {
        showFeedback("Mohon isi email terlebih dahulu.", true);
        emailInput.focus();
        return;
      }
      if (emailInput && !BASIC_EMAIL_RE.test(rawEmail)) {
        showFeedback("Format email belum valid.", true);
        emailInput.focus();
        return;
      }

      var passInput = form.querySelector('input[type="password"], input[name="password"]');
      var rawPass = passInput ? passInput.value.trim() : "";
      if ((kind === "login" || kind === "register") && passInput && !rawPass) {
        showFeedback("Kata sandi wajib diisi.", true);
        passInput.focus();
        return;
      }
      if ((kind === "register" || kind === "reset") && rawPass.length < 8) {
        showFeedback("Kata sandi minimal 8 karakter.", true);
        if (passInput) passInput.focus();
        return;
      }
      if (kind === "register") {
        var termsInput = form.querySelector('input[name="agree_terms"]');
        if (termsInput && !termsInput.checked) {
          showFeedback("Setujui Syarat & Ketentuan terlebih dahulu.", true);
          termsInput.focus();
          return;
        }
      }

      if (kind === "forgot") {
        var forgotRes = await postJson("/auth/forgot-password", { email: rawEmail });
        if (!forgotRes.ok) {
          showFeedback((forgotRes.data && forgotRes.data.error) || "Gagal mengirim tautan reset.", true);
          return;
        }
        if (forgotTargetEl && emailInput) forgotTargetEl.textContent = rawEmail;
        syncViews("forgot-sent");
        showFeedback("");
        return;
      }

      if (kind === "reset") {
        var resetRes = await postJson("/auth/reset-password", { new_password: rawPass });
        if (!resetRes.ok) {
          showFeedback((resetRes.data && resetRes.data.error) || "Gagal memperbarui kata sandi.", true);
          return;
        }
        showFeedback("Kata sandi berhasil diperbarui. Silakan masuk.");
        syncViews("login");
        return;
      }

      var pending = readPending();
      if (kind === "register") {
        var nameInput = form.querySelector('input[name="full_name"]');
        var regRes = await postJson("/auth/register", {
          full_name: nameInput ? nameInput.value.trim() : "",
          email: rawEmail,
          password: rawPass,
          agree_terms: true,
          next: (pending && pending.nextUrl) || ""
        });
        if (!regRes.ok) {
          showFeedback((regRes.data && regRes.data.error) || "Pendaftaran gagal.", true);
          return;
        }
        showFeedback("Akun berhasil didaftarkan.");
        await finalizeAuthenticated(regRes.data.user, "");
        return;
      }

      var loginRes = await postJson("/auth/login", {
        email: rawEmail,
        password: rawPass,
        next: (pending && pending.nextUrl) || ""
      });
      if (!loginRes.ok) {
        showFeedback((loginRes.data && loginRes.data.error) || "Email atau kata sandi belum valid.", true);
        return;
      }
      showFeedback("Berhasil masuk.");
      await finalizeAuthenticated(loginRes.data.user, "");
    });
  }

  document.addEventListener("keydown", function (event) {
    if (!modal || modal.hidden) return;
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key === "Tab") {
      var viewItems = modal.querySelectorAll("button:not([hidden]), input:not([hidden]), a:not([hidden])");
      var visible = Array.prototype.filter.call(viewItems, function (el) {
        return el.offsetParent !== null;
      });
      if (!visible.length) return;
      var first = visible[0];
      var last = visible[visible.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  var citySelector = document.getElementById("city-selector");
  var heroCitySelector = document.getElementById("hero-city-selector");

  function setCity(val) {
    if (!val) return;
    writeStorage("titiket-city", val);
    [citySelector, heroCitySelector].forEach(function (sel) {
      if (sel && Array.prototype.some.call(sel.options, function (opt) { return opt.value === val; })) {
        sel.value = val;
      }
    });
    try {
      window.dispatchEvent(new CustomEvent("titiket:citychange", { detail: { city: val } }));
    } catch (e) {}
  }

  var savedCity = readStorage("titiket-city");
  if (savedCity) setCity(savedCity);

  [citySelector, heroCitySelector].forEach(function (sel) {
    if (sel) {
      sel.addEventListener("change", function () {
        setCity(sel.value);
      });
    }
  });

  var navSearchForm = document.querySelector(".nav-search");
  if (navSearchForm && document.getElementById("now-playing-grid")) {
    navSearchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var catalogSec = document.getElementById("lagi-tayang");
      if (catalogSec) catalogSec.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  window.TitiketAuth = {
    isAuthenticated: function () { return currentUserState().authenticated; },
    user: function () { return currentUserState(); },
    sync: syncAuthIndicators,
    openLogin: function (mode, notice) { open(mode || "login", notice || ""); },
    requireAuth: requireAuth
  };

  window.TitiketModals = {
    showSeatCollisionToast: showSeatCollisionToast,
    showExpiredReservation: showExpiredReservation
  };

  syncAuthIndicators();

  var params = new URLSearchParams(window.location.search);
  var bodyGate = document.body && document.body.dataset && document.body.dataset.authGate === "required";
  if ((params.get("auth") === "required" || bodyGate) && !currentUserState().authenticated) {
    requireAuth({
      nextUrl: params.get("next") || (bodyGate ? (window.location.pathname + window.location.search) : "/checkout/"),
      notice: "Silakan masuk atau daftar akun terlebih dahulu untuk melanjutkan pemesanan.",
      locked: bodyGate
    });
  }
})();
