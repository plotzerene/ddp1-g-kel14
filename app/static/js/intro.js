// intro.js: animasi dolly zoom dari panggung 00_Parallax_Intro menuju Auth Gate.
(function () {
  var stage = document.getElementById("intro-stage");
  var start = document.getElementById("intro-start");
  var ctaWrap = document.getElementById("intro-cta");
  var gate = document.getElementById("intro-gate");
  if (!stage || !start || !gate) return;

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var triggered = false;

  function enterGate() {
    if (triggered || !gate.hidden) return;
    triggered = true;
    start.disabled = true;
    start.setAttribute("aria-expanded", "true");
    if (ctaWrap) ctaWrap.classList.add("is-done");
    stage.classList.add("is-dolly");
    window.setTimeout(function () {
      gate.hidden = false;
      var first = gate.querySelector("button, a");
      if (first) first.focus();
    }, reduce ? 0 : 750);
  }

  start.addEventListener("click", enterGate);

  gate.addEventListener("click", function (event) {
    var homeLink = event.target.closest("[data-home-transition], .intro__option-guest");
    if (!homeLink || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var href = homeLink.getAttribute("href");
    if (href && window.TitiketTransition && typeof window.TitiketTransition.fadeOutAndGo === "function") {
      event.preventDefault();
      window.TitiketTransition.fadeOutAndGo(href);
    }
  });

  var brandLinks = document.querySelectorAll(".intro__brand-bar [data-home-transition], .intro__gate-brand a");
  Array.prototype.forEach.call(brandLinks, function (link) {
    link.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var href = link.getAttribute("href");
      if (href && window.TitiketTransition && typeof window.TitiketTransition.fadeOutAndGo === "function") {
        event.preventDefault();
        window.TitiketTransition.fadeOutAndGo(href);
      }
    });
  });

  window.addEventListener("wheel", function (event) {
    if (event.deltaY > 24) enterGate();
  }, { passive: true });

  window.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown" || event.key === "PageDown") enterGate();
  });
})();
