// movie_trailer.js: modal trailer YouTube di halaman detail film.
// Dialog native menangani Escape dan jebakan fokus. Iframe dikosongkan saat modal ditutup
// supaya video berhenti diputar.
(function () {
  var dialog = document.getElementById("trailer-modal");
  var openBtn = document.getElementById("trailer-open");
  if (!dialog || !openBtn) return;

  // Prioritas 1: video lokal (HTML5). Prioritas 2: iframe YouTube dari embed_id.
  var video = document.getElementById("trailer-video");
  var frame = document.getElementById("trailer-frame");
  var embedUrl = dialog.getAttribute("data-embed") || "";

  openBtn.addEventListener("click", function () {
    if (video) {
      // Autoplay dilakukan saat modal dibuka, karena browser hanya mengizinkan play setelah klik.
      var played = video.play();
      if (played && typeof played.catch === "function") played.catch(function () {});
    } else if (embedUrl && frame) {
      frame.setAttribute("src", embedUrl + "?autoplay=1&rel=0");
    }
    dialog.showModal();
    var closeBtn = dialog.querySelector(".trailer-modal__close");
    if (closeBtn) closeBtn.focus();
  });

  // Escape, tombol tutup, dan klik di luar panel semuanya memicu close.
  dialog.addEventListener("close", function () {
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    if (frame) frame.removeAttribute("src");
  });

  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });
})();
