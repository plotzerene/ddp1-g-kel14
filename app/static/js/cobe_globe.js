/**
 * cobe_globe.js — Modul WebGL 3D Globe interaktif berbasis Cobe v2.0.1.
 *
 * Dipakai pada Hero Landing Page (520x520 px display / 1040x1040 px Retina)
 * dan Detail Konser Coldplay (mini globe rute tur dunia).
 */
import createGlobe from "./vendor/cobe.esm.js";

const TOUR_STOPS = [
  {
    id: "tokyo",
    state: "done",
    city: "Tokyo",
    label: "Tokyo (Completed)",
    status: "Selesai",
    location: [35.6762, 139.6503],
    size: 0.03,
    color: [0.55, 0.58, 0.65],
  },
  {
    id: "kaohsiung",
    state: "done",
    city: "Kaohsiung",
    label: "Kaohsiung (Completed)",
    status: "Selesai",
    location: [22.6273, 120.3014],
    size: 0.03,
    color: [0.55, 0.58, 0.65],
  },
  {
    id: "jakarta",
    state: "active",
    city: "Jakarta (SUGBK)",
    label: "Jakarta (SUGBK) - NEXT SHOW: 19 NOV 2026",
    status: "NEXT SHOW: 19 NOV 2026",
    location: [-6.2186, 106.8026],
    size: 0.08,
    color: [0.1, 0.9, 0.8],
    active: true,
  },
  {
    id: "singapore",
    state: "upcoming",
    city: "Singapore",
    label: "Singapore (Upcoming)",
    status: "Upcoming",
    location: [1.3521, 103.8198],
    size: 0.04,
    color: [0.9, 0.9, 0.9],
  },
];

const REGION_COORDS = {
  JABODETABEK: [-6.2186, 106.8026],
  BANDUNG: [-6.9175, 107.6191],
  SURABAYA: [-7.2575, 112.7521],
  YOGYAKARTA: [-7.7956, 110.3695],
  BALI: [-8.65, 115.2167],
  MEDAN: [3.5952, 98.6722],
};

function locationToAngles(lat, lon) {
  return [
    Math.PI - ((lon * Math.PI) / 180 - Math.PI / 2),
    (lat * Math.PI) / 180,
  ];
}

/**
 * Proyeksi lat/lon -> koordinat kanvas, identik dengan shader Cobe v2 (fungsi _() dan ie()
 * di vendor/cobe.esm.js): sudut phi/theta Cobe memutar bola, jadi rumus sin(lng + phi) polos
 * meleset (tidak memperhitungkan kemiringan theta). Mengembalikan x,y 0..1 (kiri-atas = 0,0)
 * dan z = kedalaman -1..1 (>0 menghadap kamera). `r` = jarak dari pusat bola (default: permukaan + elevasi marker);
 * busur rute memakai r lebih besar. sx/sy/sz = koordinat layar mentah (bola berjari-jari SPHERE_R).
 */
const SPHERE_R = 0.8;
const MARKER_ELEVATION = 0.02;
export function projectLatLon(lat, lon, phi, theta, r = SPHERE_R + MARKER_ELEVATION) {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180 - Math.PI;
  const p0 = -Math.cos(la) * Math.cos(lo) * r;
  const p1 = Math.sin(la) * r;
  const p2 = Math.cos(la) * Math.sin(lo) * r;
  const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
  const sx = cp * p0 + sp * p2;
  const sy = sp * st * p0 + ct * p1 - cp * st * p2;
  const sz = -sp * ct * p0 + st * p1 + cp * ct * p2;
  return { x: (sx + 1) / 2, y: (1 - sy) / 2, z: sz / r, sx, sy, sz };
}

function normalizeAngleDelta(delta) {
  const tau = Math.PI * 2;
  return ((((delta + Math.PI) % tau) + tau) % tau) - Math.PI;
}

function interpolateLatLon(from, to, t) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const lat1 = from[0] * toRad;
  const lon1 = from[1] * toRad;
  const lat2 = to[0] * toRad;
  const lon2 = to[1] * toRad;

  const p1 = [Math.cos(lat1) * Math.cos(lon1), Math.sin(lat1), Math.cos(lat1) * Math.sin(lon1)];
  const p2 = [Math.cos(lat2) * Math.cos(lon2), Math.sin(lat2), Math.cos(lat2) * Math.sin(lon2)];
  const dot = Math.min(1, Math.max(-1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]));
  const omega = Math.acos(dot);

  let p;
  if (omega < 0.001) {
    p = p1;
  } else {
    const sinOmega = Math.sin(omega);
    const w1 = Math.sin((1 - t) * omega) / sinOmega;
    const w2 = Math.sin(t * omega) / sinOmega;
    p = [w1 * p1[0] + w2 * p2[0], w1 * p1[1] + w2 * p2[1], w1 * p1[2] + w2 * p2[2]];
  }
  const lat = Math.asin(Math.min(1, Math.max(-1, p[1]))) * toDeg;
  const lon = Math.atan2(p[2], p[0]) * toDeg;
  return [lat, lon];
}

/** Jarak sudut dua titik di bola (radian). */
function angularDistance(a, b) {
  const rad = Math.PI / 180;
  const d = Math.sin(a[0] * rad) * Math.sin(b[0] * rad)
    + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((a[1] - b[1]) * rad);
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/**
 * Leg rute antar kota. Status leg mengikuti status KOTA TUJUAN (bukan fokus kamera):
 *   tujuan selesai  → "past"     garis redup statis
 *   tujuan berjalan → "active"   satu-satunya leg yang menyala + panah mengalir
 *   tujuan belum    → "upcoming" garis putus-putus sangat tipis
 * Busur = parabola 3D: titik berjalan sepanjang lingkaran besar, jari-jari naik 4t(1-t) sehingga puncaknya
 * di tengah perjalanan (tinggi ∝ jarak sudut, dibatasi 10%–34% jari-jari bola).
 */
const LEG_STATE = { done: "past", active: "active", upcoming: "upcoming" };
const LEG_STEPS = 56;
const TOUR_LEGS = TOUR_STOPS.slice(0, -1).map((from, i) => {
  const to = TOUR_STOPS[i + 1];
  return {
    id: `${from.id}-${to.id}`,
    from: from.location,
    to: to.location,
    state: LEG_STATE[to.state],
    peak: SPHERE_R * Math.min(0.34, Math.max(0.1, 0.5 * angularDistance(from.location, to.location))),
  };
});

/** Titik busur pada parameter u (0 = kota asal, 1 = tujuan): [lat, lon, jari-jari]. */
function legPoint(leg, u) {
  const [lat, lon] = interpolateLatLon(leg.from, leg.to, u);
  return [lat, lon, SPHERE_R + MARKER_ELEVATION + leg.peak * 4 * u * (1 - u)];
}
function isDarkMode() {
  const root = document.documentElement;
  return root.classList.contains("dark") || root.getAttribute("data-theme") === "dark";
}

function getThemeConfig(darkMode) {
  if (darkMode) {
    return {
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 6,
      mapBaseBrightness: 0.08,
      baseColor: [0.15, 0.2, 0.3],
      markerColor: [0.1, 0.9, 0.8],
      glowColor: [0.1, 0.15, 0.25],
    };
  }
  return {
    dark: 0,
    diffuse: 1.25,
    mapSamples: 16000,
    mapBrightness: 5.5,
    mapBaseBrightness: 0.12,
    baseColor: [0.88, 0.95, 0.98],
    markerColor: [0.0, 0.45, 0.52],
    glowColor: [0.76, 0.92, 0.96],
  };
}

function buildDynamicMarkers(nowMs, darkMode) {
  const t = nowMs * 0.001;
  const pulseSize = 0.08 + 0.016 * Math.sin(t * 4.2);
  const pulseColor = [
    0.1 + 0.08 * (0.5 + 0.5 * Math.sin(t * 4.2)),
    0.9,
    0.8 + 0.12 * (0.5 + 0.5 * Math.sin(t * 4.2)),
  ];

  const baseMarkers = TOUR_STOPS.map((stop) => {
    let color = stop.color;
    if (stop.active) {
      color = pulseColor;
    } else if (!darkMode && stop.id === "singapore") {
      color = [0.05, 0.45, 0.55];
    }
    return {
      location: stop.location,
      size: stop.active ? pulseSize : stop.size,
      color,
      id: stop.id,
    };
  });

  return baseMarkers;
}

function mountGlobe(container) {
  const canvas = container.querySelector("canvas[data-cobe-canvas]");
  if (!canvas || container.dataset.cobeMounted === "1") return null;
  container.dataset.cobeMounted = "1";

  const sizePx = Number(container.dataset.globeSize || canvas.dataset.displaySize || 520);
  const dpr = 2;
  const renderPx = sizePx * dpr;
  canvas.width = renderPx;
  canvas.height = renderPx;

  let activeIndex = 2; // Default focus: Jakarta (SUGBK)
  const [initPhi, initTheta] = locationToAngles(
    TOUR_STOPS[activeIndex].location[0],
    TOUR_STOPS[activeIndex].location[1],
  );
  let phi = initPhi;
  let theta = initTheta;
  let targetPhi = null;
  let targetTheta = null;
  let pauseAutoUntil = 0;

  let pointerDownX = null;
  let pointerDownY = null;
  let dragPhiOffset = 0;
  let darkMode = isDarkMode();
  let themeOpts = getThemeConfig(darkMode);

  const counterEl = container.querySelector("[data-globe-counter]");
  const stopButtons = Array.from(container.querySelectorAll("[data-globe-stop]"));
  const prevBtn = container.querySelector("[data-globe-prev]");
  const nextBtn = container.querySelector("[data-globe-next]");

  function syncStopUI() {
    if (counterEl) {
      counterEl.textContent = `Tur ${activeIndex + 1} dari ${TOUR_STOPS.length}`;
    }
    stopButtons.forEach((btn) => {
      const idx = Number(btn.dataset.globeStop);
      const isActive = idx === activeIndex;
      btn.classList.toggle("is-focused", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
    container.dispatchEvent(new CustomEvent("tour-stop-change", { bubbles: true, detail: { index: activeIndex } }));
  }

  function focusLatLon(lat, lon) {
    const [p, t] = locationToAngles(lat, lon);
    targetPhi = p;
    targetTheta = t;
    pauseAutoUntil = performance.now() + 3400;
  }

  function focusStop(index) {
    activeIndex = ((index % TOUR_STOPS.length) + TOUR_STOPS.length) % TOUR_STOPS.length;
    const stop = TOUR_STOPS[activeIndex];
    focusLatLon(stop.location[0], stop.location[1]);
    syncStopUI();
  }

  if (prevBtn) {
    prevBtn.addEventListener("click", () => focusStop(activeIndex - 1));
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => focusStop(activeIndex + 1));
  }
  // Beranda: setiap 5,5 detik kamera terbang ke kota tur berikutnya (berhenti saat tab tersembunyi / reduced-motion).
  if (container.dataset.cobeGlobe === "hero" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    window.setInterval(() => {
      if (document.hidden || pointerDownX !== null || performance.now() < pauseAutoUntil) return;
      focusStop(activeIndex + 1);
    }, 5500);
  }
  stopButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.globeStop);
      if (!Number.isNaN(idx)) focusStop(idx);
    });
  });

  // Region dropdown synchronization
  function handleRegionChange(event) {
    const city = String(event.target?.value || event.detail?.city || "").toUpperCase();
    const coords = REGION_COORDS[city];
    if (coords) {
      focusLatLon(coords[0], coords[1]);
    }
  }

  ["city-selector", "hero-city-selector"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.addEventListener("change", handleRegionChange);
  });
  window.addEventListener("titiket:citychange", handleRegionChange);

  // Pointer drag rotation
  canvas.addEventListener("pointerdown", (e) => {
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
    targetPhi = null;
    targetTheta = null;
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("pointerup", () => {
    if (pointerDownX !== null) {
      pointerDownX = null;
      pointerDownY = null;
      phi += dragPhiOffset;
      dragPhiOffset = 0;
      pauseAutoUntil = performance.now() + 1200;
      canvas.style.cursor = "grab";
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (pointerDownX === null) return;
    const dx = e.clientX - pointerDownX;
    const dy = e.clientY - pointerDownY;
    dragPhiOffset = dx * 0.008;
    theta = Math.max(-0.85, Math.min(0.85, theta + dy * 0.002));
    pointerDownY = e.clientY;
  });
  canvas.style.cursor = "grab";

  // Pin DOM (landing): dipindah tiap frame ke titik proyeksi, memudar saat menghadap belakang bola.
  const pins = Array.from(container.querySelectorAll("[data-globe-pin]"))
    .map((el) => ({ el, stop: TOUR_STOPS.find((st) => st.id === el.dataset.globePin) }))
    .filter((p) => p.stop);
  const wrapEl = canvas.closest(".cobe-canvas-wrap") || container;
  let box = { left: 0, top: 0, w: sizePx, h: sizePx };
  // Kanvas 2D di atas bola: busur parabola 3D + panah mengalir (Cobe hanya bisa menempelkan titik di permukaan).
  const arcCanvas = document.createElement("canvas");
  arcCanvas.className = "globe-arcs";
  arcCanvas.setAttribute("aria-hidden", "true");
  arcCanvas.style.cssText = "position:absolute;z-index:2;pointer-events:none;max-width:none;max-height:none;";
  wrapEl.appendChild(arcCanvas);
  const arcCtx = arcCanvas.getContext("2d");
  if (getComputedStyle(wrapEl).position === "static") wrapEl.style.position = "relative";   // halaman konser tidak memuat landing.css
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ARC_PAD = 0.18;
  function measure() {
    const c = canvas.getBoundingClientRect();
    const w = wrapEl.getBoundingClientRect();
    box = { left: c.left - w.left, top: c.top - w.top, w: c.width, h: c.height };
    // Kanvas busur sengaja lebih besar dari bola: busur yang terangkat di dekat tepi piringan melewati batas kanvas WebGL.
    const padX = box.w * ARC_PAD;
    const padY = box.h * ARC_PAD;
    Object.assign(arcCanvas.style, {
      left: `${box.left - padX}px`, top: `${box.top - padY}px`,
      width: `${box.w + 2 * padX}px`, height: `${box.h + 2 * padY}px`,
    });
    arcCanvas.width = Math.max(1, Math.round((box.w + 2 * padX) * dpr));
    arcCanvas.height = Math.max(1, Math.round((box.h + 2 * padY) * dpr));
  }
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  if (resizeObserver) resizeObserver.observe(wrapEl);
  measure();

  /**
   * Titik busur → piksel kanvas. Terlihat bila menghadap kamera ATAU berada di luar piringan bola (lengkung di tepi).
   * Proyeksi Cobe ortografis: busur yang menghadap kamera tampak lurus walau terangkat. Karena itu titik digeser di layar
   * tegak lurus garis kota-ke-kota (`n`, sisi yang menjauhi pusat bola) sebanding tingginya: 0 di kedua ujung, jadi tetap
   * menyatu dengan pin kota, dan puncak lengkung tepat di tengah perjalanan.
   */
  const BOW_ON_SCREEN = 0.6;
  function bowNormal(leg, p, t) {
    const a = projectLatLon(leg.from[0], leg.from[1], p, t);
    const b = projectLatLon(leg.to[0], leg.to[1], p, t);
    const dx = (b.x - a.x) * box.w;
    const dy = (b.y - a.y) * box.h;
    const len = Math.hypot(dx, dy) || 1;
    let nx = dy / len;
    let ny = -dx / len;
    // Sisi luar piringan; pusat acuan sedikit di bawah tengah supaya busur di tengah globe selalu melengkung ke atas (tanpa berkedip).
    const mx = ((a.x + b.x) / 2 - 0.5) * box.w;
    const my = ((a.y + b.y) / 2 - 0.62) * box.h;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  }

  function project(leg, u, p, t, n) {
    const [lat, lon, r] = legPoint(leg, u);
    const q = projectLatLon(lat, lon, p, t, r);
    const bow = (r - (SPHERE_R + MARKER_ELEVATION)) * BOW_ON_SCREEN * (box.w / 2);
    return {
      x: q.x * box.w + n[0] * bow,
      y: q.y * box.h + n[1] * bow,
      vis: q.sz > 0 || Math.hypot(q.sx, q.sy) > SPHERE_R,
    };
  }

  function strokeLeg(leg, p, t, n, width, rgba) {
    arcCtx.lineWidth = width;
    arcCtx.strokeStyle = rgba;
    let open = false;
    arcCtx.beginPath();
    for (let i = 0; i <= LEG_STEPS; i += 1) {
      const q = project(leg, i / LEG_STEPS, p, t, n);
      if (!q.vis) { open = false; continue; }
      if (open) arcCtx.lineTo(q.x, q.y);
      else arcCtx.moveTo(q.x, q.y);
      open = true;
    }
    arcCtx.stroke();
  }

  function drawArcs(p, t, now) {
    arcCtx.setTransform(1, 0, 0, 1, 0, 0);
    arcCtx.clearRect(0, 0, arcCanvas.width, arcCanvas.height);
    arcCtx.setTransform(dpr, 0, 0, dpr, box.w * ARC_PAD * dpr, box.h * ARC_PAD * dpr);   // koordinat tetap relatif ke kanvas bola
    arcCtx.lineCap = "round";
    arcCtx.lineJoin = "round";
    const tone = darkMode
      ? { active: "45,212,191", past: "148,163,184", upcoming: "203,213,225" }
      : { active: "13,148,136", past: "71,85,105", upcoming: "71,85,105" };
    for (const leg of TOUR_LEGS) {
      const n = bowNormal(leg, p, t);
      if (leg.state === "past") {
        strokeLeg(leg, p, t, n, 1.25, `rgba(${tone.past},0.25)`);            // redup, statis, solid
      } else if (leg.state === "upcoming") {
        arcCtx.setLineDash([2, 6]);
        strokeLeg(leg, p, t, n, 1, `rgba(${tone.upcoming},0.22)`);           // putus-putus sangat tipis
        arcCtx.setLineDash([]);
      }
    }
    for (const leg of TOUR_LEGS) {
      if (leg.state !== "active") continue;
      const n = bowNormal(leg, p, t);
      strokeLeg(leg, p, t, n, 6, `rgba(${tone.active},0.16)`);               // halo
      strokeLeg(leg, p, t, n, 2.2, `rgba(${tone.active},0.95)`);
      // Panah (chevron ganda) mengalir dari kota asal ke tujuan, searah garis singgung busur di layar.
      for (let k = 0; k < 4; k += 1) {
        const u = reduceMotion ? (k + 0.5) / 4 : (now * 0.00024 + k / 4) % 1;
        const a = project(leg, Math.max(0, u - 0.012), p, t, n);
        const b = project(leg, Math.min(1, u + 0.012), p, t, n);
        if (!a.vis || !b.vis) continue;
        const m = project(leg, u, p, t, n);
        arcCtx.save();
        arcCtx.translate(m.x, m.y);
        arcCtx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
        arcCtx.strokeStyle = `rgba(${tone.active},${(Math.sin(Math.PI * u) ** 0.6).toFixed(3)})`;
        arcCtx.lineWidth = 2.4;
        for (const off of [3, -4]) {
          arcCtx.beginPath();
          arcCtx.moveTo(off - 5, -4.5);
          arcCtx.lineTo(off, 0);
          arcCtx.lineTo(off - 5, 4.5);
          arcCtx.stroke();
        }
        arcCtx.restore();
      }
    }
  }

  function updatePins(p, t) {
    for (const { el, stop } of pins) {
      const q = projectLatLon(stop.location[0], stop.location[1], p, t);
      const alpha = q.z > 0 ? Math.min(1, q.z * 1.5) : 0;
      el.style.opacity = alpha.toFixed(3);
      const live = alpha > 0.4;
      el.style.pointerEvents = live ? "auto" : "none";
      el.tabIndex = live ? 0 : -1;
      if (alpha === 0) continue;
      el.style.setProperty("--px", `${(box.left + q.x * box.w).toFixed(1)}px`);
      el.style.setProperty("--py", `${(box.top + q.y * box.h).toFixed(1)}px`);
      const side = q.x > 0.58 ? "left" : "right";
      if (el.dataset.side !== side) el.dataset.side = side;
    }
  }

  const onRender = (state) => {
    const now = performance.now();
    if (targetPhi !== null && targetTheta !== null) {
      const dPhi = normalizeAngleDelta(targetPhi - phi);
      const dTheta = targetTheta - theta;
      phi += dPhi * 0.085;
      theta += dTheta * 0.085;
      if (Math.abs(dPhi) < 0.004 && Math.abs(dTheta) < 0.004) {
        phi = targetPhi;
        theta = targetTheta;
        targetPhi = null;
        targetTheta = null;
      }
    } else if (pointerDownX === null && now > pauseAutoUntil) {
      phi += 0.004;
    }

    state.phi = phi + dragPhiOffset;
    state.theta = theta;
    state.markers = buildDynamicMarkers(now, darkMode);
    if (pins.length) updatePins(state.phi, state.theta);
    drawArcs(state.phi, state.theta, now);
  };

  let globe;
  try {
    globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: sizePx,
      height: sizePx,
      phi,
      theta,
      scale: 1,
      markerElevation: 0.02,
      opacity: 0.96,
      ...themeOpts,
      markers: buildDynamicMarkers(performance.now(), darkMode),
      onRender,
    });
  } catch (err) {
    container.classList.add("is-globe-fallback");
    return null;
  }

  function refreshTheme() {
    const nextDark = isDarkMode();
    if (nextDark === darkMode) return;
    darkMode = nextDark;
    themeOpts = getThemeConfig(darkMode);
    globe.update(themeOpts);
  }

  const themeObserver = new MutationObserver(refreshTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  window.addEventListener("titiket:themechange", refreshTheme);

  let rafId = 0;
  let destroyed = false;
  function tick() {
    if (destroyed) return;
    const frameState = {};
    onRender(frameState);
    globe.update(frameState);
    rafId = window.requestAnimationFrame(tick);
  }
  syncStopUI();
  rafId = window.requestAnimationFrame(tick);

  return {
    focusStop,
    focusLatLon,
    destroy: () => {
      destroyed = true;
      window.cancelAnimationFrame(rafId);
      themeObserver.disconnect();
      if (resizeObserver) resizeObserver.disconnect();
      window.removeEventListener("titiket:themechange", refreshTheme);
      window.removeEventListener("titiket:citychange", handleRegionChange);
      if (globe && typeof globe.destroy === "function") globe.destroy();
    },
  };
}

export function initAllGlobes() {
  const containers = Array.from(document.querySelectorAll("[data-cobe-globe]"));
  return containers.map(mountGlobe).filter(Boolean);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAllGlobes);
} else {
  initAllGlobes();
}
