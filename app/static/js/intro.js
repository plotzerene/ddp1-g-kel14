// intro.js: parallax mouse empat lapis, lalu dolly zoom menuju Auth Gate.
(function () {
  var stage = document.getElementById("intro-stage");
  var start = document.getElementById("intro-start");
  var ctaWrap = document.getElementById("intro-cta");
  var gate = document.getElementById("intro-gate");
  if (!stage || !start || !gate) return;

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var layers = Array.prototype.slice.call(stage.querySelectorAll("[data-depth]"));
  var target = { x: 0, y: 0 };
  var pos = { x: 0, y: 0 };
  var frame = null;

  function paint() {
    pos.x += (target.x - pos.x) * 0.12;
    pos.y += (target.y - pos.y) * 0.12;
    layers.forEach(function (layer) {
      var depth = Number(layer.getAttribute("data-depth")) || 0;
      layer.style.transform = "translate3d(" + (pos.x * depth).toFixed(2) + "px, " +
        (pos.y * depth).toFixed(2) + "px, 0)";
    });
    var settled = Math.abs(target.x - pos.x) < 0.001 && Math.abs(target.y - pos.y) < 0.001;
    frame = settled ? null : window.requestAnimationFrame(paint);
  }

  function queue() {
    if (frame === null) frame = window.requestAnimationFrame(paint);
  }

  if (!reduce) {
    stage.addEventListener("pointermove", function (event) {
      var rect = stage.getBoundingClientRect();
      target.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      target.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      queue();
    });
    stage.addEventListener("pointerleave", function () {
      target.x = 0;
      target.y = 0;
      queue();
    });
  }

  start.addEventListener("click", function () {
    start.disabled = true;
    start.setAttribute("aria-expanded", "true");
    if (ctaWrap) ctaWrap.classList.add("is-done");
    stage.classList.add("is-dolly");
    window.setTimeout(function () {
      gate.hidden = false;
      var first = gate.querySelector("button, a");
      if (first) first.focus();
    }, reduce ? 0 : 900);
  });
})();
