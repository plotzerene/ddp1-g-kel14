/*
 * parallax.js: parallax mouse 3 lapis (background, frame, foreground) hasil
 * ekstraksi "Martian Parallax Experience" (Craft Anything/app/parallax-math.js).
 *
 * Markup:
 *   <div data-parallax-stage data-max-offset="48">
 *     <img data-parallax-layer data-depth="0.35" data-scale="1.08" ...>
 *     <img data-parallax-layer data-depth="0.70" data-scale="1.05" ...>
 *     <img data-parallax-layer data-depth="1.25" data-scale="1.12" ...>
 *   </div>
 *
 * Rumus (sama persis dengan pratinjau):
 *   nx = ((x - left) / width - 0.5) * 2
 *   ny = ((y - top) / height - 0.5) * 2
 *   curX += (nx - curX) * 0.08
 *   curY += (ny - curY) * 0.08
 *   tx = -curX * maxOffset * depthFactor
 *   ty = -curY * maxOffset * depthFactor
 *
 * Posisi halus juga diekspor sebagai variabel CSS --parallax-x / --parallax-y
 * pada stage, supaya kilau kaca (Liquid Glass) bisa ikut bergeser.
 * Menghormati prefers-reduced-motion: lapisan diam di tengah.
 */
(function () {
  "use strict";

  var DAMPING = 0.08;
  var DEFAULT_MAX_OFFSET = 48;
  var SETTLE_EPSILON = 0.0005;
  var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };

  function clamp(value) {
    return Math.max(-1, Math.min(1, value));
  }

  function initStage(stage) {
    if (stage.__parallax) return stage.__parallax;

    var layers = Array.prototype.map.call(stage.querySelectorAll("[data-parallax-layer]"), function (el) {
      return {
        el: el,
        depth: parseFloat(el.getAttribute("data-depth")) || 0,
        scale: parseFloat(el.getAttribute("data-scale")) || 1,
      };
    });
    var maxOffset = parseFloat(stage.getAttribute("data-max-offset")) || DEFAULT_MAX_OFFSET;
    var targetX = 0;
    var targetY = 0;
    var curX = 0;
    var curY = 0;
    var frame = 0;

    function paint() {
      for (var i = 0; i < layers.length; i += 1) {
        var layer = layers[i];
        var tx = -curX * maxOffset * layer.depth;
        var ty = -curY * maxOffset * layer.depth;
        layer.el.style.transform =
          "translate3d(" + tx.toFixed(2) + "px, " + ty.toFixed(2) + "px, 0) scale(" + layer.scale + ")";
      }
      stage.style.setProperty("--parallax-x", curX.toFixed(4));
      stage.style.setProperty("--parallax-y", curY.toFixed(4));
    }

    function tick() {
      curX += (targetX - curX) * DAMPING;
      curY += (targetY - curY) * DAMPING;
      var settled = Math.abs(targetX - curX) < SETTLE_EPSILON && Math.abs(targetY - curY) < SETTLE_EPSILON;
      if (settled) {
        curX = targetX;
        curY = targetY;
      }
      paint();
      // Loop berhenti saat sudah diam, jadi tidak ada rAF yang berjalan sia-sia.
      frame = settled ? 0 : window.requestAnimationFrame(tick);
    }

    function wake() {
      if (!frame) frame = window.requestAnimationFrame(tick);
    }

    function onPointerMove(event) {
      // Sentuhan dipakai untuk menggulir halaman; parallax hanya untuk mouse & pena.
      if (event.pointerType === "touch" || reduceMotion.matches) return;
      var rect = stage.getBoundingClientRect();
      var width = rect.width || 1;
      var height = rect.height || 1;
      targetX = clamp(((event.clientX - rect.left) / width - 0.5) * 2);
      targetY = clamp(((event.clientY - rect.top) / height - 0.5) * 2);
      wake();
    }

    function recenter() {
      targetX = 0;
      targetY = 0;
      wake();
    }

    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerleave", recenter);
    if (reduceMotion.addEventListener) {
      reduceMotion.addEventListener("change", function () {
        if (reduceMotion.matches) recenter();
      });
    }

    paint();
    stage.classList.add("is-parallax-ready");
    stage.__parallax = { recenter: recenter };
    return stage.__parallax;
  }

  function initAll(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-parallax-stage]"), initStage);
  }

  window.TitiketParallax = { init: initAll, initStage: initStage };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { initAll(); });
  } else {
    initAll();
  }
})();
