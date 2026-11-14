// movie_trailer.js: modal trailer hybrid (MP4 lokal atau embed YouTube) di halaman detail film.
// Dialog native dan handler tombol tutup memutus pemutaran media saat modal ditutup.
(function () {
  var dialog = document.getElementById("trailer-modal");
  var openBtn = document.getElementById("trailer-open");
  if (!dialog || !openBtn) return;

  // Prioritas 1: video lokal (HTML5). Prioritas 2: iframe YouTube dari embed_id.
  var video = document.getElementById("trailer-video");
  var frame = document.getElementById("trailer-frame");
  var closeBtns = dialog.querySelectorAll(".trailer-modal__close, #trailer-close");
  var embedUrl = dialog.getAttribute("data-embed") || "";

  function stopMedia() {
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch (err) {
        // Abaikan jika metadata video belum dimuat.
      }
    }
    if (frame) frame.removeAttribute("src");
  }

  function closeModal() {
    stopMedia();
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
    if (openBtn && typeof openBtn.focus === "function") openBtn.focus();
  }

  openBtn.addEventListener("click", function () {
    if (video) {
      // Autoplay dilakukan saat modal dibuka, karena browser hanya mengizinkan play setelah klik.
      var played = video.play();
      if (played && typeof played.catch === "function") played.catch(function () {});
    } else if (embedUrl && frame) {
      var sep = embedUrl.indexOf("?") === -1 ? "?" : "&";
      frame.setAttribute("src", embedUrl + sep + "autoplay=1&rel=0");
    }
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "open");
    }
    if (closeBtns[0]) closeBtns[0].focus();
  });

  closeBtns.forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeModal();
    });
  });

  // Escape, tombol tutup, dan klik di luar panel semuanya memicu close.
  dialog.addEventListener("close", stopMedia);

  dialog.addEventListener("cancel", function (event) {
    event.preventDefault();
    closeModal();
  });

  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) closeModal();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && (dialog.open || dialog.hasAttribute("open"))) {
      event.preventDefault();
      closeModal();
    }
  });
})();
