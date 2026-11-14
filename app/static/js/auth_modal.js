// auth_modal.js: kerangka modal Masuk, Buat Akun, dan SSO UI. Form asli diisi modul auth.
(function () {
  var modal = document.getElementById("auth-modal");
  if (!modal) return;

  var titleEl = document.getElementById("auth-modal-title");
  var closeBtn = modal.querySelector(".auth-modal__close");
  var titles = { login: "Masuk", register: "Buat Akun", sso: "Masuk dengan SSO UI" };
  var lastFocus = null;

  function open(mode) {
    lastFocus = document.activeElement;
    titleEl.textContent = titles[mode] || titles.login;
    modal.setAttribute("data-mode", mode);
    modal.hidden = false;
    closeBtn.focus();
  }

  function close() {
    modal.hidden = true;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  document.addEventListener("click", function (event) {
    var opener = event.target.closest("[data-auth-open]");
    if (opener) {
      event.preventDefault();
      open(opener.getAttribute("data-auth-open"));
      return;
    }
    if (event.target.closest("[data-auth-close]")) close();
  });

  document.addEventListener("keydown", function (event) {
    if (modal.hidden) return;
    if (event.key === "Escape") {
      close();
      return;
    }
    // Fokus tetap di dalam modal selama terbuka.
    if (event.key === "Tab") {
      var items = modal.querySelectorAll("button");
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
})();
