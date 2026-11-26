/**
 * visualizer_app.js — pengatur state & UI halaman visualizer.
 *
 * Alur data (satu arah):
 *
 *   klik kursi / geser slider / ganti target / ganti lensa
 *        └─► POST /visualizer/api/pov  (Python menghitung semuanya)
 *                └─► applyPov(): kamera 3D, peta 2D, panel metrik, audio
 *
 * File ini tidak menghitung geometri: ia hanya mengirim pilihan pengguna ke
 * Python dan menampilkan angka yang dikembalikan.
 */
import { Map2DPicker, SubPositionPicker, formatRupiah, formatRupiahShort, h, icon } from './map_2d_picker.js';
import { PovScene } from './pov_3d_three.js';

const boot = JSON.parse(document.getElementById('viz-bootstrap').textContent);
const $ = (id) => document.getElementById(id);
const fixed = (value, digits = 1) => Number(value).toFixed(digits);
const venueUrl = (template, venueId) => template.replace('__VENUE__', encodeURIComponent(venueId));
// Film pilihan dari landing: trailernya yang diputar di layar 3D dan judulnya yang masuk keranjang.
const filmQuery = boot.film ? `?film=${encodeURIComponent(boot.film)}` : '';

const state = {
  venueId: boot.venueId,
  layout: null,
  selector: null,
  pov: null,
  body: boot.limits.body_default_cm,
  front: boot.limits.body_default_cm,
  targetId: null,
  lens: 'normal',
  aspect: 16 / 9,
  cart: boot.cart,
  preset: null,
  reco: null,
  heatmap: false,
  compareOn: false,
  compareMode: 'pip',
  photoIndex: 0,
  photoKey: '',
  fullscreen: false,
  clusterSize: 1,
  clusterSeats: [],
  clusterCenter: null,
  clusterAvgScore: null,
  scoreCache: new Map(),
};

function syncEventCard(layout) {
  const isConcert = layout.kind === 'concert';
  const kindEl = $('event-card-kind');
  const titleEl = $('event-card-title');
  const venueEl = $('event-card-venue');
  const dtEl = $('event-card-datetime');
  const posterEl = $('event-card-poster');
  const badgeEl = $('pov-card-badge');

  if (kindEl) kindEl.textContent = isConcert ? 'Konser Live' : 'Sedang Tayang';
  if (titleEl) titleEl.textContent = layout.event ? layout.event.title : layout.name;
  if (badgeEl) {
    badgeEl.textContent = layout.short_label;
    badgeEl.hidden = true;   // badge kategori dihapus dari header pratinjau (V2)
  }
  if (posterEl) {
    const posterSrc = (layout.media && layout.media.poster) || boot.posterFallbackUrl || '';
    posterEl.onerror = () => {
      posterEl.onerror = null;
      if (boot.posterFallbackUrl) posterEl.src = boot.posterFallbackUrl;
    };
    if (posterSrc) {
      posterEl.src = posterSrc;
      posterEl.alt = layout.event ? layout.event.title : layout.name;
      posterEl.hidden = false;
    } else {
      posterEl.hidden = true;
    }
  }
  const sched = boot.schedule || {};
  if (venueEl) {
    venueEl.textContent = isConcert
      ? 'Stadion Utama GBK \u2022 Coldplay Live'
      : `${sched.cinema || 'AGORA MALL XXI'} \u2022 ${layout.short_label}`;
  }
  if (dtEl) {
    dtEl.textContent = isConcert
      ? '19 Des 2026 \u2022 19:30 WIB'
      : `${sched.date || 'Sabtu, 14 Nov 2026'} \u2022 ${sched.time || '19:00 WIB'}`;
  }
}

function updateQuickHudMetrics(pov, target, parts) {
  const viewVal = $('metric-view-val');
  const neckVal = $('metric-neck-val');
  const distVal = $('metric-dist-val');
  if (viewVal) {
    const clearPct = Math.round(pov.clear_view_pct ?? 100);
    const viewTag = clearPct >= 90 ? 'Optimal' : clearPct >= 70 ? 'Baik' : 'Terhalang';
    viewVal.textContent = `${clearPct}% ${viewTag}`;
  }
  if (neckVal) {
    const rawDeg = pov.summary && pov.summary.neck_pitch_deg !== undefined
      ? Number(pov.summary.neck_pitch_deg)
      : 0;
    const rounded = Math.round(rawDeg);
    const sign = rounded > 0 ? '+' : '';
    const absDeg = Math.abs(rounded);
    const neckTag = absDeg <= 12 ? 'Nyaman' : absDeg <= 22 ? 'Cukup' : 'Mendongak';
    neckVal.textContent = `${sign}${rounded}\u00b0 (${neckTag})`;
  }
  if (distVal && target) {
    const distScore = parts.fov ?? parts.proximity ?? pov.score.total;
    const distTag = distScore >= 80 ? 'Ideal' : distScore >= 55 ? 'Cukup' : 'Jauh';
    distVal.textContent = `${fixed(target.distance_m, 1)} m \u2022 ${distTag}`;
  }
}

/* •••••••••••• */
/* Util: API, toast, debounce                                                 */
/* •••••••••••• */
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    const failure = new Error((data && (data.error || data.message)) || `Permintaan gagal (${response.status}).`);
    failure.data = data;
    throw failure;
  }
  return data;
}

const postJson = (url, body, signal) => api(url, { method: 'POST', body: JSON.stringify(body), signal });

function toast(message, kind = 'success') {
  const node = h('div', { class: `toast glass glass--3 toast--${kind}` },
    icon(kind === 'error' ? 'alert' : 'check'), h('span', { text: message }));
  $('toast-region').append(node);
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 260);
  }, 4200);
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function setVeil(visible, text = '', isError = false) {
  const veil = $('veil');
  if (!veil) return;
  veil.hidden = !visible;
  veil.setAttribute('aria-hidden', String(!visible));
  veil.classList.toggle('is-hidden', !visible);
  veil.classList.toggle('is-error', isError);
  const spinner = veil.querySelector('.spinner');
  if (spinner) spinner.hidden = isError;
  if (text) $('veil-text').textContent = text;
}

/* •••••••••••• */
/* Komponen                                                                   */
/* •••••••••••• */
const map = new Map2DPicker({
  host: $('map2d'),
  legend: $('map-legend'),
  tooltip: $('map-tooltip'),
  onSelect: (selector) => selectPosition(selector),
  onBlock: (blockId) => openBlock(blockId),
});

const picker = new SubPositionPicker({
  root: $('picker'),
  onSelect: (selector) => {
    state.selector = selector;
    requestPov('glide');
  },
});

let scene = null;
try {
  scene = new PovScene($('pov-canvas'), $('canvas-host'));
  state.aspect = scene.aspect;
} catch (error) {
  setVeil(true, 'Browser ini tidak mendukung WebGL, jadi pandangan 3D tidak bisa ditampilkan. '
    + 'Peta, data POV, dan rekomendasi tetap berfungsi.', true);
}
if (typeof window !== 'undefined') {
  window.__titiketViz = { state, scene, map, picker };
}

const isStandingPov = (pov) => Boolean(pov && pov.viewer && pov.viewer.posture === 'standing');

let seatLockRemaining = 600;
let seatLockTargetKey = '';
let seatLockIntervalId = null;
let seatLockExpiredShown = false;

function formatLockClock(sec) {
  const safe = Math.max(0, sec | 0);
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function renderSeatLockClock() {
  const clockEl = $('seat-lock-countdown');
  const pillEl = $('seat-lock-timer');
  if (!clockEl) return;
  clockEl.textContent = formatLockClock(seatLockRemaining);
  if (pillEl) {
    pillEl.classList.toggle('is-urgent', seatLockRemaining > 0 && seatLockRemaining <= 120);
    pillEl.classList.toggle('is-expired', seatLockRemaining <= 0);
  }
}

function isWayfindingModeActive() {
  return wayfindingOn
    || document.body.classList.contains('is-wayfinding-mode')
    || new URLSearchParams(window.location.search).get('mode') === 'wayfinding';
}

function clearReservationTimers() {
  if (seatLockIntervalId) {
    window.clearInterval(seatLockIntervalId);
    seatLockIntervalId = null;
  }
  if (window.reservationTimerInterval) {
    window.clearInterval(window.reservationTimerInterval);
    window.reservationTimerInterval = null;
  }
}

async function handleLockExpiredModal() {
  if (isWayfindingModeActive()) {
    clearReservationTimers();
    return;
  }
  if (seatLockExpiredShown) return;
  seatLockExpiredShown = true;
  const standing = isStandingPov(state.pov);
  try {
    state.cart = await postJson('/visualizer/api/cart/clear', {});
  } catch (e) { /* abaikan kegagalan rilis kunci cadangan */ }
  syncCart();
  if (window.TitiketModals && typeof window.TitiketModals.showExpiredReservation === 'function') {
    window.TitiketModals.showExpiredReservation({
      standing,
      onRestart: async () => {
        seatLockExpiredShown = false;
        seatLockTargetKey = '';
        seatLockRemaining = 600;
        renderSeatLockClock();
        try {
          await loadVenue(state.venueId);
        } catch (err) { reportFatal(err); }
      },
    });
  }
}

function ensureSeatLockTimer(pov) {
  if (isWayfindingModeActive()) {
    clearReservationTimers();
    return;
  }
  if (state.cart && state.cart.count > 0 && Number(state.cart.lock_seconds_left) > 0) {
    seatLockRemaining = Number(state.cart.lock_seconds_left);
    seatLockExpiredShown = false;
    renderSeatLockClock();
  } else {
    const key = pov ? `${pov.venue_id || ''}:${pov.block_id || ''}:${pov.seat_id || ''}` : '';
    if (key && key !== seatLockTargetKey) {
      seatLockTargetKey = key;
      seatLockRemaining = 600;
      seatLockExpiredShown = false;
      renderSeatLockClock();
    }
  }
  if (!seatLockIntervalId && $('seat-lock-countdown')) {
    renderSeatLockClock();
    seatLockIntervalId = window.setInterval(() => {
      if (isWayfindingModeActive()) {
        clearReservationTimers();
        return;
      }
      if (seatLockRemaining > 0) {
        seatLockRemaining -= 1;
        renderSeatLockClock();
        if (seatLockRemaining <= 0) handleLockExpiredModal();
      }
    }, 1000);
  }
}

function syncTerminology(pov) {
  const standing = isStandingPov(pov);
  const cinema = state.layout && state.layout.kind === 'cinema';
  const stepperLabel = $('stepper-viz-label');
  if (stepperLabel) stepperLabel.textContent = standing ? 'Pilih Kategori (CAT) & POV 3D' : 'Pilih Kursi & POV 3D';
  const lockLabel = $('seat-lock-label');
  if (lockLabel) lockLabel.textContent = 'Sisa waktu';
  ensureSeatLockTimer(pov);
  const mapTitleText = standing ? 'Pilih Kategori (CAT)' : (cinema ? 'Pilih Kursi Kamu' : 'Pilih Kursi');
  $('map-title').textContent = mapTitleText;
  const spotTitle = $('seat-spotlight-title');
  if (spotTitle) spotTitle.textContent = mapTitleText;
  const mapHintEl = $('map-hint');
  if (mapHintEl) {
    mapHintEl.textContent = standing
      ? 'Pilih area atau spot berdiri di bawah.'
      : (cinema ? 'Pilih kursi pada peta.' : 'Pilih blok kategori pada peta.');
  }
  const spotBtn = $('btn-map-spotlight');
  if (spotBtn) {
    const spotLbl = spotBtn.querySelector('span');
    if (spotLbl) spotLbl.textContent = standing ? 'Perbesar Peta Area' : 'Perbesar Peta Kursi';
  }
  const metricViewLbl = $('metric-view-label');
  if (metricViewLbl) metricViewLbl.textContent = cinema ? 'PANDANGAN LAYAR' : 'PANDANGAN PANGGUNG';
  const summaryLbl = $('cta-summary-label');
  if (summaryLbl && state.cart.count === 0) {
    summaryLbl.textContent = standing ? 'Tiket Terpilih' : 'Kursi Terpilih';
  }
  const fsExitLbl = $('fs-exit-label');
  if (fsExitLbl) fsExitLbl.textContent = standing ? 'Kembali ke Peta Area (Esc)' : 'Kembali ke Peta Kursi (Esc)';
  $('insight-title').textContent = standing ? 'Spot Insight' : 'Seat Insight';
}

function syncVenueTabs(blockId = null) {
  for (const tab of document.querySelectorAll('.venue-tab')) {
    let active = false;
    if (tab.dataset.concertBlock) {
      const blocks = (tab.dataset.concertBlocks || tab.dataset.concertBlock).split(',');
      active = Boolean(blockId) && blocks.includes(blockId);
    } else if (tab.dataset.venue) {
      active = tab.dataset.venue === state.venueId;
    }
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) $('viz-grid').setAttribute('aria-labelledby', tab.id);
  }
}

/* •••••••••••• */
/* Memuat venue                                                               */
/* •••••••••••• */
let setTheaterFullscreen = () => {};
let startSpatialRouteTour = () => {};
let hideSpatialRouteHud = () => {};
let wayfindingOn = false;      // ?mode=wayfinding: tur manual 3 langkah, layar penuh permanen
let wayfindingStep = 0;

async function loadVenue(venueId, pushHistory = false) {
  if (scene) setVeil(true, 'Memuat venue…');
  const layout = await api(venueUrl(boot.api.layout, venueId) + filmQuery);
  state.venueId = venueId;
  state.layout = layout;
  state.pov = null;
  state.targetId = layout.targets[0].id;
  state.lens = 'normal';
  state.heatmap = false;
  state.photoIndex = 0;
  state.photoKey = '';
  state.clusterSize = 1;
  state.clusterSeats = [];
  state.clusterCenter = null;
  state.clusterAvgScore = null;
  syncClusterPills();
  const clusterStatusEl = $('cluster-status');
  if (clusterStatusEl) clusterStatusEl.hidden = true;

  const vizApp = $('viz-app');
  if (vizApp) vizApp.dataset.kind = layout.kind;
  const displayGroup = $('deck-display-group');
  if (displayGroup) displayGroup.hidden = layout.kind !== 'cinema';
  const compareBtn = $('btn-compare');
  if (compareBtn) compareBtn.hidden = layout.kind !== 'cinema';
  if (layout.kind !== 'cinema') state.compareOn = false;

  $('viz-title').textContent = layout.name;
  const vizTagline = $('viz-tagline');
  if (vizTagline) vizTagline.textContent = layout.tagline;
  const eyebrow = $('viz-eyebrow');   // hanya ada di halaman bioskop
  if (eyebrow) eyebrow.textContent = layout.event ? layout.event.title : 'Visualizer';
  syncEventCard(layout);
  syncTerminology(null);
  document.title = `${layout.name} · titiket.com`;
  syncVenueTabs(layout.kind !== 'cinema' && layout.default_selector ? layout.default_selector.block_id : null);
  if (pushHistory) window.history.pushState({ venueId }, '', venueUrl(boot.urls.studio, venueId) + (window.location.search || filmQuery));

  picker.close();
  map.render(layout);
  map.setCart(state.cart.keys);
  renderLenses(layout);
  renderPresets(layout);
  const fourDX = $('btn-4dx');
  fourDX.hidden = !layout.features.four_dx;
  fourDX.setAttribute('aria-pressed', 'false');
  const timelapseBar = $('concert-timelapse-bar');
  if (timelapseBar) timelapseBar.hidden = layout.kind === 'cinema';

  if (scene) scene.loadVenue(layout);
  if (layout.kind !== 'cinema' && scene && typeof scene.setConcertPhase === 'function') {
    const activePhaseBtn = document.querySelector('#concert-timelapse-bar [data-concert-phase][aria-pressed="true"]');
    const initialPhase = (activePhaseBtn && activePhaseBtn.dataset.concertPhase) || 'peak_show';
    syncTimelapseWeatherBadge(initialPhase);
    scene.setConcertPhase(initialPhase);
  }
  const params = new URLSearchParams(window.location.search);
  const friendSeatParam = params.get('friend_seat');
  const deepSeat = params.get('seat');
  const hasDeepLink = Boolean(deepSeat || friendSeatParam);
  const wantSpatialRoute = params.get('route3d') === '1';
  const wantWayfinding = params.get('mode') === 'wayfinding' && layout.kind !== 'cinema' && Boolean($('wayfinding-dock'));
  const spatialGate = params.get('gate') || '';
  const friendFlow = resolveFriendSeatFlow(layout, friendSeatParam);
  const deepSelector = friendFlow ? friendFlow.selector : resolveDeepLinkSeat(layout, deepSeat);

  const friendChip = $('friend-reco-chip');
  const friendMeta = $('friend-reco-meta');
  if (friendChip) {
    if (friendFlow) {
      map.setFriendSeat(friendFlow.friendId);
      if (friendMeta) {
        friendMeta.textContent = friendFlow.recoLabel
          ? `${friendFlow.friendLabel} -> ${friendFlow.recoLabel}`
          : friendFlow.friendLabel;
      }
      friendChip.hidden = false;
    } else {
      map.setFriendSeat(null);
      friendChip.hidden = true;
    }
  }

  state.selector = deepSelector || layout.default_selector;
  // Drawer kursi GBK (Apple Sheet) baru terbuka saat pengguna memilih blok, bukan otomatis saat halaman dimuat.
  await requestPov(deepSelector ? 'glide' : 'jump');
  syncMedia();
  if (scene) setVeil(false);
  getVenueScoreMap().catch(() => {});
  if (wantWayfinding) {
    await startWayfinding();
  } else if (wantSpatialRoute && layout.kind !== 'cinema') {
    setTheaterFullscreen(true);
    startSpatialRouteTour(spatialGate);
  } else if (hasDeepLink) {
    setTheaterFullscreen(true);
  }
}

/* •••••••••••• */
/* Meminta & menerapkan POV                                                   */
/* •••••••••••• */
let povAbort = null;

async function requestPov(mode = 'glide') {
  if (!state.selector) return;
  if (povAbort) povAbort.abort();
  const controller = new AbortController();
  povAbort = controller;
  try {
    const pov = await postJson(boot.api.pov, {
      venue_id: state.venueId,
      selector: state.selector,
      body_height_cm: state.body,
      front_height_cm: state.front,
      target_id: state.targetId,
      lens: state.lens,
      aspect: state.aspect,
      film: boot.film,
    }, controller.signal);
    if (controller.signal.aborted) return;
    state.pov = pov;
    applyPov(pov, mode);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  }
}

const requestPovSoon = debounce(() => requestPov('quick'), 45);

/* Theater HUD (Frame 07A/B): chip, Seat Insight, mini-map, CTA bar dan navigasi kursi */
const SVG_NS = 'http://www.w3.org/2000/svg';
const MINIMAP = { cols: 9, rows: 5, x0: 18, y0: 36, cw: 11, ch: 10, px: 15, py: 17 };
const TIER_LABEL = { lower: 'Lower Tier', upper: 'Upper Tier', arena: 'Lower Tier' };

function svgNode(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent.appendChild(node);
  return node;
}

function placeMinimapMarker(cx, cy) {
  for (const id of ['tm-halo', 'tm-dot']) {
    const node = $(id);
    if (node) { node.setAttribute('cx', cx.toFixed(1)); node.setAttribute('cy', cy.toFixed(1)); }
  }
}

function renderTheaterMinimap(pov) {
  const svgEl = $('tm-svg');
  const layout = state.layout;
  if (!svgEl || !layout) return;
  if (svgEl.dataset.venue !== layout.venue_id) {
    svgEl.dataset.venue = layout.venue_id;
    svgEl.replaceChildren();
    if (layout.kind === 'cinema') {
      // Denah nyata: satu sel per kursi (posisi x/z dari layout), klik = pindah kamera ke kursi itu.
      svgEl.setAttribute('viewBox', '0 0 172 134');
      svgNode('rect', { x: 36, y: 14, width: 100, height: 6, rx: 3, class: 'tm-screen' }, svgEl);
      const xs = layout.seats.map((item) => item.x);
      const zs = layout.seats.map((item) => item.z);
      const [minX, minZ] = [Math.min(...xs), Math.min(...zs)];
      const spanX = Math.max(...xs) - minX || 1;
      const spanZ = Math.max(...zs) - minZ || 1;
      const cell = Math.max(2.6, Math.min(6.4, 136 / (new Set(xs).size + 1)));
      svgEl._project = (seat) => [18 + ((seat.x - minX) / spanX) * 136, 34 + ((seat.z - minZ) / spanZ) * 76];
      for (const seat of layout.seats) {
        const [cx, cy] = svgEl._project(seat);
        const node = svgNode('rect', {
          x: (cx - cell / 2).toFixed(1), y: (cy - cell / 2).toFixed(1), width: cell.toFixed(1), height: cell.toFixed(1), rx: 1.2,
          class: `tm-seat${seat.status === 'sold' ? ' is-sold' : ''}`, 'data-seat': seat.id,
          role: 'button', 'aria-label': `Pindah ke kursi ${seat.row}${seat.number}`,
        }, svgEl);
        if (seat.status !== 'sold') node.addEventListener('click', () => selectPosition({ seat_id: seat.id }));
      }
      svgNode('text', { x: 86, y: 127, 'text-anchor': 'middle', class: 'tm-caption' }, svgEl).textContent = 'posisimu';
    } else {
      // Stadion: tribun, lapangan, blok kategori, dan panggung dari data layout yang sama dengan peta 2D.
      svgEl.setAttribute('viewBox', '-124 -152 248 304');
      const ring = (points) => 'M' + points.map((p) => `${p[0]},${p[2]}`).join(' L') + ' Z';
      for (const tier of layout.bowl.tiers) {
        svgNode('path', { class: 'tm-tier', 'fill-rule': 'evenodd', d: `${ring(tier.outer)} ${ring(tier.inner)}` }, svgEl);
      }
      svgNode('path', { class: 'tm-pitch', d: ring(layout.bowl.field_edge) }, svgEl);
      for (const block of layout.blocks) {
        if (block.standing) continue;
        const polygon = svgNode('polygon', {
          class: 'tm-block', 'data-id': block.id, fill: block.color, role: 'button',
          'aria-label': `Pindah ke ${block.label}`, points: block.outline.map((p) => p.join(',')).join(' '),
        }, svgEl);
        polygon.addEventListener('click', () => openBlockFromTheater(block.id));
      }
      const deck = layout.stage.deck;
      svgNode('rect', { class: 'tm-stage', x: deck.x0, y: deck.z0, width: deck.x1 - deck.x0, height: deck.z1 - deck.z0, rx: 2 }, svgEl);
    }
    svgNode('circle', { r: layout.kind === 'cinema' ? 8 : 9, class: 'tm-halo', id: 'tm-halo' }, svgEl);
    svgNode('circle', { r: layout.kind === 'cinema' ? 4.5 : 4, class: 'tm-dot', id: 'tm-dot' }, svgEl);
  }
  if (!pov) return;
  if (layout.kind !== 'cinema') {
    const [x, , z] = pov.seat.floor;
    placeMinimapMarker(x, z);
    const active = pov.seat_frame && pov.seat_frame.block_id;
    for (const node of svgEl.querySelectorAll('.tm-block')) node.classList.toggle('is-active', node.dataset.id === active);
    return;
  }
  const seat = layout.seats.find((item) => item.id === pov.seat.seat_id);
  if (!seat || !svgEl._project) return;
  placeMinimapMarker(...svgEl._project(seat));
  for (const node of svgEl.querySelectorAll('.tm-seat')) node.classList.toggle('is-active', node.dataset.seat === seat.id);
}

/** Ganti blok dari HUD theater tanpa meninggalkan drawer pemilih terbuka di belakang layar penuh. */
function openBlockFromTheater(blockId) {
  openBlock(blockId);
  if (state.fullscreen) picker.close();
}

/** Geser ke kursi tersedia terdekat di baris yang sama (delta -1 = kiri, +1 = kanan). */
function stepSeat(delta) {
  const layout = state.layout;
  const pov = state.pov;
  if (!layout || !pov || wayfindingOn) return;       // tur wayfinding mengunci kursi
  if (layout.kind !== 'cinema') {
    // Stadion: blok berikutnya / sebelumnya di antara kategori duduk.
    const seated = layout.blocks.filter((block) => !block.standing);
    const current = seated.findIndex((block) => block.id === (pov.seat_frame && pov.seat_frame.block_id));
    const next = seated[(Math.max(current, 0) + delta + seated.length) % seated.length];
    if (next) openBlockFromTheater(next.id);
    return;
  }
  const cur = layout.seats.find((item) => item.id === pov.seat.seat_id);
  if (!cur) return;
  const candidates = layout.seats
    .filter((item) => item.row === cur.row && item.status !== 'sold' && (delta > 0 ? item.x > cur.x : item.x < cur.x))
    .sort((a, b) => (delta > 0 ? a.x - b.x : b.x - a.x));
  if (candidates[0]) selectPosition({ seat_id: candidates[0].id });
}

function syncTheaterHud(pov) {
  const chip = $('theater-chip-seat');
  if (chip) chip.textContent = pov.seat.label;
  const standing = isStandingPov(pov);
  const posture = $('height-pill-posture');
  if (posture) posture.textContent = standing ? 'Berdiri' : 'Duduk';
  if (state.layout && state.layout.kind !== 'cinema') {
    const frame = pov.seat_frame || {};
    const block = state.layout.blocks.find((item) => item.id === frame.block_id);
    const tier = block && block.tiers && block.tiers[0];
    const tierLabel = TIER_LABEL[tier] || 'Lower Tier';
    if (!standing && block) state.lastSeatedBlock = block.id;
    const modeChip = $('theater-chip-mode');
    if (modeChip) modeChip.textContent = standing ? 'Berdiri · Festival' : `Duduk · ${tierLabel}`;
    const tierEl = $('posture-tier');
    if (tierEl) tierEl.textContent = tierLabel;
    for (const button of document.querySelectorAll('#posture-toggle [data-posture]')) {
      button.setAttribute('aria-pressed', String((button.dataset.posture === 'standing') === standing));
    }
  }
  renderTheaterMinimap(pov);
}

function applyPov(pov, mode) {
  if (scene) scene.applyPov(pov, mode, { clusterCenter: state.clusterCenter });
  map.setSelection(pov);
  picker.sync(pov, state.selector);
  syncTerminology(pov);
  if (state.layout && state.layout.kind !== 'cinema') {
    const rawSeat = String(pov.seat && pov.seat.seat_id || '');
    const activeBlock = (state.selector && state.selector.block_id) || (rawSeat.includes(':') ? rawSeat.split(':')[0] : rawSeat);
    syncVenueTabs(activeBlock);
  }

  const standing = isStandingPov(pov);
  $('hud-seat').textContent = pov.seat.label;
  const spotSel = $('spotlight-selection');
  if (spotSel) {
    spotSel.textContent = `${pov.seat.label} · ${pov.seat.category} · ${formatRupiah(pov.seat.price)}`;
  }
  $('hud-sub').textContent = standing
    ? `Free Standing (Berdiri Bebas) · ${formatRupiah(pov.seat.price)}`
    : `${pov.seat.category} · ${formatRupiah(pov.seat.price)}`;
  $('hud-score-value').textContent = $('hdr-score-value').textContent = Math.round(pov.score.total);
  $('hud-score-grade').textContent = pov.score.grade;
  for (const button of document.querySelectorAll('#lens-buttons [data-lens]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lens === pov.camera.lens.mode));
  }
  updateInsight(pov);
  syncTheaterHud(pov);
  syncCart();
  renderCompare();
}

function preserveScroll(fn) {
  const sx = window.scrollX;
  const sy = window.scrollY;
  const mapScroll = $('seat-map-scroll');
  const msx = mapScroll ? mapScroll.scrollLeft : 0;
  const msy = mapScroll ? mapScroll.scrollTop : 0;
  fn();
  window.scrollTo(sx, sy);
  if (mapScroll) mapScroll.scrollTo(msx, msy);
  window.requestAnimationFrame(() => {
    window.scrollTo(sx, sy);
    if (mapScroll) mapScroll.scrollTo(msx, msy);
  });
}

/** Pilih kursi (bioskop) atau spot/kursi stadion langsung dari peta. */
function selectPosition(selector) {
  if (state.layout && state.layout.kind === 'cinema' && state.clusterSize > 1 && selector && selector.seat_id) {
    applyClusterCount(state.clusterSize, selector.seat_id).catch((err) => toast(err.message, 'error'));
    return;
  }
  if (state.clusterSeats && state.clusterSeats.length) {
    state.clusterSize = 1;
    syncClusterPills();
    state.clusterSeats = [];
    state.clusterCenter = null;
    state.clusterAvgScore = null;
    map.setCluster([], null);
    picker.setClusterSeats([]);
    const statusEl = $('cluster-status');
    if (statusEl) statusEl.hidden = true;
  }
  preserveScroll(() => {
    if (state.layout.kind !== 'cinema') {
      const blockId = selector.block_id || String(selector.seat_id).split(':')[0];
      if (!picker.block || picker.block.id !== blockId) picker.open(blockId, state.layout);
      if (selector.spot) picker.choice.spot = selector.spot;
    }
    state.selector = selector;
    requestPov('glide');
  });
}

/** Klik blok kategori → buka Sub-Position Picker dan tampilkan posisi bawaannya. */
function openBlock(blockId) {
  preserveScroll(() => {
    const selector = picker.open(blockId, state.layout);
    if (!selector) return;
    state.selector = selector;
    requestPov('glide');
  });
}

/* •••••••••••• */
/* Lensa kamera                                                               */
/* •••••••••••• */

function renderLenses(layout) {
  const host = $('lens-buttons');
  if (!host) return;
  host.replaceChildren();
  for (const lens of layout.lenses) {
    host.append(h('button', {
      class: 'segmented__btn', type: 'button', 'data-lens': lens.mode,
      'aria-pressed': String(lens.mode === state.lens),
      onclick: () => {
        state.lens = lens.mode;
        requestPov('quick');
      },
    }, lens.label));
  }
}

/* •••••••••••• */
/* Seat Insight: cincin skor, 5 bar, baterai halangan (konser), spesifikasi   */
/* •••••••••••• */
function getScoreTier(total) {
  if (total >= 85) {
    return {
      tier: 'good',
      accent: '#15803D',
      border: '#22C55E',
      glow: 'rgba(34, 197, 94, 0.15)',
    };
  }
  if (total >= 65) {
    return {
      tier: 'mid',
      accent: '#CA8A04',
      border: '#EAB308',
      glow: 'rgba(234, 179, 8, 0.15)',
    };
  }
  return {
    tier: 'low',
    accent: '#DC2626',
    border: '#EF4444',
    glow: 'rgba(239, 68, 68, 0.15)',
  };
}

function updateInsight(pov) {
  const target = pov.targets[pov.active_target];
  const sound = pov.acoustics;
  const total = pov.score.total;
  const spec = getScoreTier(total);
  const ring = $('score-ring');
  const ringWrap = $('score-ring-wrap') || (ring && ring.closest('.score-ring'));
  if (ringWrap) {
    ringWrap.dataset.scoreTier = spec.tier;
    ringWrap.style.setProperty('--score-accent', spec.accent);
    ringWrap.style.setProperty('--score-border', spec.border);
    ringWrap.style.setProperty('--score-glow', spec.glow);
  }
  ring.setAttribute('stroke-dashoffset', String(100 - total));       // pathLength lingkaran = 100
  ring.style.stroke = spec.accent;
  $('score-value').textContent = Math.round(total);
  $('score-grade').textContent = pov.score.grade;

  const parts = Object.fromEntries(pov.score.breakdown.map((item) => [item.key, item.value]));
  parts.screen = parts.fov ?? parts.visibility;                      // bioskop: layar & konser: LED & panggung
  // Bioskop: "Bebas Halangan" hampir selalu 100%, diganti Sudut Elevasi (dongakan ke tengah layar); konser tetap halangan.
  parts.obstruction = state.layout && state.layout.kind === 'cinema'
    ? Math.max(0, Math.min(100, 100 - Math.abs((pov.summary && pov.summary.neck_pitch_deg) || 0) * 2.5))
    : pov.clear_view_pct;
  updateQuickHudMetrics(pov, target, parts);
  for (const row of $('bars').children) {
    const key = row.dataset.key;
    row.querySelector('.bars__fill').style.transform = `scaleX(${parts[key] / 100})`;
    row.querySelector('.bars__num').textContent = key === 'acoustic'
      ? `${Math.round(sound.spl_db)} dB` : `${Math.round(parts[key])}%`;
  }

  // Seat Insight HUD di mode theater memakai angka yang sama dengan bar di panel.
  for (const key of ['screen', 'neck', 'off_axis', 'obstruction']) {
    const item = $(`ti-m-${key}`);
    if (!item || parts[key] === undefined) continue;
    item.querySelector('.ti-metric__fill').style.transform = `scaleX(${parts[key] / 100})`;
    item.querySelector('.ti-metric__val').textContent = `${Math.round(parts[key])}%`;
  }
  const tiRing = $('ti-ring');
  if (tiRing) {
    tiRing.setAttribute('stroke-dashoffset', String(100 - total));
    // Warna status hijau/kuning/merah sama persis dengan kartu Seat Insight (variabel CSS per tema).
    const ti = $('theater-insight');
    ti.style.setProperty('--score-accent', spec.accent);
    ti.style.setProperty('--score-border', spec.border);
    $('ti-score').textContent = Math.round(total);
    $('ti-grade').textContent = pov.score.grade;
  }

  const coverage = target.coverage;
  const rows = [
    [`Jarak ke ${target.label}`, `${fixed(target.distance_m, 1)} m`],
    ['Tinggi mata', `${fixed(pov.viewer.eye_height_m, 2)} m`],
    ['Posisi dari tengah', `${fixed(target.off_axis_deg, 1)}°`],
    ['Delay Suara', `${Math.round(sound.nearest_delay_ms)} ms`],           // min(d1, d2) / c ke speaker terdekat
    ['Kekuatan Akustik', `${fixed(sound.spl_db, 1)} dB`],
    ['Speaker terdekat', `${sound.nearest_source} · ${Math.round(sound.nearest_distance_m)} m`],
    ['Gaung ruangan', `${fixed(sound.rt60_s, 2)} s`],
    ['Lensa', pov.camera.lens.label],
  ];
  if (coverage) {
    rows.splice(1, 0, ['Ukuran layar di pandangan',
      `${fixed(coverage.horizontal_deg, 1)}° × ${fixed(coverage.vertical_deg, 1)}°`]);
  }
  if (parts.proximity !== undefined) rows.push(['Kedekatan ke panggung', `${Math.round(parts.proximity)} / 100`]);
  const roof = pov.roof_protection || null;
  const roofRow = $('roof-protection-row');
  if (roofRow) {
    if (roof && roof.label) {
      roofRow.hidden = false;
      roofRow.dataset.level = roof.level || 'covered';
      const roofBadge = $('roof-protection-badge');
      const roofNote = $('roof-protection-note');
      if (roofBadge) roofBadge.textContent = roof.label;
      if (roofNote) roofNote.textContent = roof.note || '';
      rows.push(['Perlindungan Atap', roof.label]);
    } else {
      roofRow.hidden = true;
    }
  }
  const specList = $('spec-list');
  if (specList) specList.replaceChildren(...rows.flatMap(([term, text]) => [h('dt', { text: term }), h('dd', { text })]));
}

/* •••••••••••• */
/* Keranjang                                                                  */
/* •••••••••••• */
function syncCart() {
  const pov = state.pov;
  const count = state.cart.count;
  for (const badge of document.querySelectorAll('[data-cart-count]')) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }
  const checkout = $('btn-checkout');
  const clearBtn = $('btn-clear');
  const summaryLbl = $('cta-summary-label');
  $('checkout-count').textContent = count;
  $('checkout-count').hidden = count === 0;
  if (clearBtn) clearBtn.textContent = count > 0 ? 'Bersihkan Keranjang' : 'Hapus Pilihan';
  map.setCart(state.cart.keys);

  const button = $('btn-cart');
  if (!pov) {
    button.disabled = true;
    checkout.setAttribute('aria-disabled', String(count === 0));
    if (clearBtn) clearBtn.disabled = count === 0;
    return;
  }
  const standing = isStandingPov(pov);
  const inCart = state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
  const sold = pov.seat.status === 'sold';
  const hasCart = count > 0;

  const priceFormatter = (state.layout && state.layout.kind === 'cinema') ? formatRupiahShort : formatRupiah;

  const seatEl = $('cta-seat');
  if (hasCart) {
    if (summaryLbl) {
      summaryLbl.textContent = `${count} ${standing ? 'Tiket Terpilih' : (state.layout && state.layout.kind === 'concert' ? 'Tiket Terpilih' : 'Kursi Terpilih')}`;
    }
    if (seatEl) {
      const chips = (state.cart.items || []).map((item) => h('span', { class: 'seat-chip', text: item.seat_label }));
      seatEl.replaceChildren(...chips);
    }
    $('cta-price').textContent = priceFormatter(state.cart.subtotal);
  } else {
    if (summaryLbl) summaryLbl.textContent = standing ? 'Posisi Terpilih' : 'Kursi Terpilih';
    if (seatEl) {
      seatEl.textContent = standing
        ? `${pov.seat.label} (Free Standing)`
        : pov.seat.label;
    }
    $('cta-price').textContent = priceFormatter(pov.seat.price);
  }

  button.disabled = sold;
  if (clearBtn) clearBtn.disabled = !hasCart && !inCart;
  checkout.setAttribute('aria-disabled', String(!hasCart && sold));
  if (standing) {
    $('btn-cart-label').textContent = inCart ? 'Hapus Tiket dari Keranjang' : 'Simpan Pilihan';
    $('btn-checkout-label').textContent = 'Pilih Tiket & Lanjut ke Checkout';
  } else {
    $('btn-cart-label').textContent = sold
      ? 'Kursi sudah terjual'
      : inCart ? 'Hapus dari Keranjang' : 'Tambah Kursi ke Keranjang';
    $('btn-checkout-label').textContent = 'Lanjut ke Checkout';
  }

  const tcTitle = $('tc-title');
  if (tcTitle) {
    const labels = hasCart ? (state.cart.items || []).map((item) => item.seat_label).join(', ') : pov.seat.label;
    tcTitle.textContent = `${labels} \u00b7 ${state.layout ? state.layout.short_label : ''}`;
    $('tc-sub').textContent = `Total ${priceFormatter(hasCart ? state.cart.subtotal : pov.seat.price)}`;
    const tcCart = $('tc-cart');
    tcCart.disabled = sold;
    const saveLabel = standing || (state.layout && state.layout.kind === 'concert') ? 'Simpan Pilihan' : 'Tambah ke Keranjang';
    tcCart.textContent = sold ? 'Kursi sudah terjual' : inCart ? 'Hapus dari Keranjang' : saveLabel;
  }
}

function handleCartConflict(error) {
  const data = error && error.data ? error.data : {};
  if (Array.isArray(data.keys)) state.cart = data;
  if (data.conflict_seat_id) map.flashCollision(data.conflict_seat_id);
  if (data.conflict_kind === 'collision' && window.TitiketModals) {
    window.TitiketModals.showSeatCollisionToast({
      seatId: data.conflict_seat_id,
      label: data.conflict_label,
      standing: Boolean(data.conflict_standing),
      message: error.message,
    });
    return;
  }
  toast(error.message, 'error');
}

async function clearCartChoices() {
  const pov = state.pov;
  const standing = isStandingPov(pov);
  const items = Array.isArray(state.cart.items) ? [...state.cart.items] : [];
  if (items.length === 0) {
    toast(standing ? 'Belum ada pilihan tiket di keranjang.' : 'Belum ada kursi tersimpan di keranjang.', 'error');
    return;
  }
  try {
    state.cart = await postJson('/visualizer/api/cart/clear', {});
    toast(standing ? 'Semua pilihan tiket dikosongkan.' : 'Pilihan kursi berhasil dihapus.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    syncCart();
  }
}

async function toggleCart() {
  const pov = state.pov;
  if (!pov) return;
  const standing = isStandingPov(pov);
  const button = $('btn-cart');
  const payload = {
    venue_id: state.venueId, seat_id: pov.seat.seat_id,
    body_height_cm: state.body, front_height_cm: state.front, film: boot.film,
    schedule: boot.schedule,
  };
  const inCart = state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
  button.disabled = true;
  try {
    const data = await postJson(inCart ? boot.api.cartRemove : boot.api.cart, payload);
    state.cart = data;
    if (Number(data.lock_seconds_left) > 0) {
      seatLockRemaining = Number(data.lock_seconds_left);
      seatLockExpiredShown = false;
      renderSeatLockClock();
    }
    toast(data.message || (standing ? 'Tiket dihapus dari keranjang.' : 'Kursi dihapus dari keranjang.'));
  } catch (error) {
    handleCartConflict(error);
  } finally {
    syncCart();
  }
}

/* •••••••••••• */
/* Rekomendasi kursi                                                          */
/* •••••••••••• */
function renderPresets(layout) {
  const host = $('preset-list');
  state.preset = layout.presets[0];
  host.replaceChildren();
  for (const preset of layout.presets) {
    host.append(h('button', {
      class: 'reco-bar__pill', type: 'button', role: 'radio', 'data-key': preset.key,
      'aria-checked': String(preset.key === state.preset.key), title: preset.description || null,
      onclick: () => {
        state.preset = preset;
        syncPreset();
        fetchReco();
      },
    }, icon(PRESET_ICON[preset.key] || 'target', 'icon--sm'), preset.label));
  }
  fetchReco();
}

const PRESET_ICON = {
  ideal_thx: 'target', neck_comfort: 'activity', max_immersion: 'screen', best_acoustic: 'volume', clear_stage_view: 'eye',
};

function syncPreset() {
  for (const button of $('preset-list').children) {
    button.setAttribute('aria-checked', String(button.dataset.key === state.preset.key));
  }
}

/** Hitung rekomendasi terbaik untuk kriteria aktif dan tampilkan di bar bawah (belum memilih kursi). */
let recoAbort = null;
async function fetchReco() {
  if (recoAbort) recoAbort.abort();
  const controller = new AbortController();
  recoAbort = controller;
  const seatEl = $('reco-seat'), scoreEl = $('reco-score'), button = $('reco-select');
  button.disabled = true;
  seatEl.textContent = 'Menghitung rekomendasi…';
  scoreEl.textContent = '';
  try {
    const data = await postJson(boot.api.recommend, {
      venue_id: state.venueId, preset: state.preset.key,
      body_height_cm: state.body, front_height_cm: state.front, film: boot.film,
    }, controller.signal);
    const best = data.recommendations[0];
    state.reco = best || null;
    map.setRecommendations(best ? [best] : []);
    seatEl.textContent = best ? `Rekomendasi: ${best.label}` : (data.note || 'Belum ada kursi tersedia.');
    scoreEl.textContent = best ? `Skor ${Math.round(best.score)} · ${best.grade}` : '';
    scoreEl.dataset.tier = best ? getScoreTier(best.score).tier : '';
    button.disabled = !best;
  } catch (error) {
    if (error.name !== 'AbortError') seatEl.textContent = 'Rekomendasi belum tersedia.';
  }
}
const fetchRecoSoon = debounce(fetchReco, 400);

/** "Pilih Kursi Ini": seleksi di peta + perbarui pratinjau 3D. */
function selectRecommended() {
  if (!state.reco) return;
  selectPosition({ seat_id: state.reco.seat_id });
  toast(`${state.reco.label} dipilih.`);
}

/* •••••••••••• */
/* Heatmap                                                                    */
/* •••••••••••• */
async function refreshHeatmap() {
  if (!state.heatmap) {
    map.setHeatmap(null);
    return;
  }
  try {
    const query = `?body_height_cm=${state.body}&front_height_cm=${state.front}`;
    const data = await api(venueUrl(boot.api.heatmap, state.venueId) + query);
    if (state.heatmap && data.venue_id === state.venueId) map.setHeatmap(data);
  } catch (error) {
    toast(error.message, 'error');
  }
}

const refreshHeatmapSoon = debounce(refreshHeatmap, 320);

/* •••••••••••• */
/* Bandingkan dengan foto asli                                                */
/* •••••••••••• */
function renderCompare() {
  if (!$('compare')) return;   // pembanding foto dihapus dari UI V2
  const stage = $('viewport-stage');
  const photos = (state.pov && state.pov.reference_photos) || (state.layout && state.layout.reference_photos) || [];
  const key = photos.map((photo) => photo.file).join('|');
  if (key !== state.photoKey) {
    state.photoKey = key;
    state.photoIndex = 0;
  }
  const active = state.compareOn && photos.length > 0;
  stage.dataset.compare = active ? state.compareMode : 'off';
  $('compare').hidden = !active;
  $('compare-mode').hidden = !state.compareOn;
  const compareBtn = $('btn-compare');
  if (compareBtn) compareBtn.setAttribute('aria-pressed', String(state.compareOn));
  if (!active) return;

  const photo = photos[state.photoIndex % photos.length];
  const image = $('compare-img');
  image.hidden = photo.missing;
  $('compare-missing').hidden = !photo.missing;
  if (photo.missing) {
    $('compare-missing-text').textContent =
      `Foto "${photo.file.split('/').pop()}" belum ada. Taruh di reference_assets/images/ lalu jalankan ulang server.`;
  } else if (image.getAttribute('src') !== photo.url) {
    image.src = photo.url;
    image.alt = `Foto asli: ${photo.caption}`;
  }
  $('compare-caption').textContent = `${photo.caption} (${(state.photoIndex % photos.length) + 1}/${photos.length})`;
  const single = photos.length < 2;
  $('compare-prev').disabled = single;
  $('compare-next').disabled = single;
}

function stepPhoto(delta) {
  const photos = (state.pov && state.pov.reference_photos) || [];
  if (!photos.length) return;
  state.photoIndex = (state.photoIndex + delta + photos.length) % photos.length;
  renderCompare();
}

/* •••••••••••• */
/* Video & audio                                                              */
/* •••••••••••• */
function setButtonIcon(button, name) {
  button.querySelector('use').setAttribute('href', `#i-${name}`);
}

function syncMedia() {
  if (!scene) return;
  const media = scene.media;
  const play = $('btn-play');
  setButtonIcon(play, media.playing ? 'pause' : 'play');
  play.setAttribute('aria-label', media.playing ? 'Jeda video' : 'Putar video');
  const mute = $('btn-mute');
  setButtonIcon(mute, media.muted ? 'mute' : 'volume');
  mute.setAttribute('aria-label', media.muted ? 'Nyalakan suara' : 'Matikan suara');
  mute.setAttribute('aria-pressed', String(!media.muted));
  const pct = String(Math.round(media.volume * 100));
  const slider = $('range-volume');
  if (slider.value !== pct) slider.value = pct;
  slider.style.setProperty('--fill', `${pct}%`);
}

/* •••••••••••• */
/* Pengikatan event                                                           */
/* •••••••••••• */
function reportFatal(error) {
  setVeil(true, `Gagal memuat venue: ${error.message}`, true);
}

function bindSlider(inputId, outputId, key) {
  const input = $(inputId);
  const sync = () => {
    const value = Number(input.value);
    state[key] = value;
    $(outputId).textContent = `${value} cm`;
    input.style.setProperty('--fill', `${((value - input.min) / (input.max - input.min)) * 100}%`);
  };
  input.min = boot.limits.body_min_cm;
  input.max = boot.limits.body_max_cm;
  input.value = state[key];
  sync();
  input.addEventListener('input', () => {
    sync();
    requestPovSoon();
    fetchRecoSoon();
    if (state.heatmap) refreshHeatmapSoon();
  });
}

function bindEvents() {
  bindSlider('range-body', 'out-body', 'body');
  bindSlider('range-front', 'out-front', 'front');

  // Pil iOS tinggi badan (Frame 06A/B): satu pil "Tinggi: 170 cm ▾", popover berisi preset + slider halus.
  const heightRange = $('range-body');
  const heightPop = $('height-pill-pop');
  const heightToggle = $('height-pill-toggle');
  const syncPresets = () => {
    for (const btn of document.querySelectorAll('[data-height-preset]')) {
      btn.classList.toggle('is-active', Number(btn.dataset.heightPreset) === Number(heightRange.value));
    }
  };
  const setHeight = (cm) => {
    const clamped = Math.max(Number(heightRange.min), Math.min(Number(heightRange.max), cm));
    heightRange.value = clamped;
    heightRange.dispatchEvent(new Event('input', { bubbles: true }));
  };
  heightRange.addEventListener('input', syncPresets);
  heightRange.addEventListener('input', () => {
    const compact = $('out-body-compact');
    if (compact) compact.textContent = `${heightRange.value} cm`;
  });
  syncPresets();
  for (const btn of document.querySelectorAll('[data-height-preset]')) {
    btn.addEventListener('click', () => {
      setHeight(Number(btn.dataset.heightPreset));
      if (heightPop) heightPop.hidden = true;
      if (heightToggle) heightToggle.setAttribute('aria-expanded', 'false');
    });
  }
  if (heightToggle && heightPop) {
    heightToggle.addEventListener('click', () => {
      heightPop.hidden = !heightPop.hidden;
      heightToggle.setAttribute('aria-expanded', String(!heightPop.hidden));
    });
    document.addEventListener('click', (event) => {
      if (!heightPop.hidden && !event.target.closest('.height-pill')) {
        heightPop.hidden = true;
        heightToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Tab venue (dengan navigasi panah sesuai pola WAI-ARIA tabs).
  const tabs = [...document.querySelectorAll('.venue-tab')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.concertBlock) {
        if (state.layout && state.layout.kind !== 'cinema') openBlock(tab.dataset.concertBlock);
        return;
      }
      if (tab.dataset.venue && tab.dataset.venue !== state.venueId) {
        loadVenue(tab.dataset.venue, true).catch(reportFatal);
      }
    });
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      tabs[(index + step + tabs.length) % tabs.length].focus({ preventScroll: true });
    });
  });
  window.addEventListener('popstate', () => {
    const venueId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
    if (boot.venues.some((venue) => venue.venue_id === venueId) && venueId !== state.venueId) {
      loadVenue(venueId).catch(reportFatal);
    }
  });

  $('btn-cart').addEventListener('click', toggleCart);
  const btnClear = $('btn-clear');
  if (btnClear) btnClear.addEventListener('click', clearCartChoices);

  document.addEventListener('titiket:cart-collision', (event) => {
    const detail = event.detail || {};
    if (detail.conflict_seat_id) map.flashCollision(detail.conflict_seat_id);
    if (Array.isArray(detail.keys)) {
      state.cart = detail;
      syncCart();
    }
  });

  $('btn-checkout').addEventListener('click', async (event) => {
    const pov = state.pov;
    const inCart = Boolean(pov) && state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
    const canAutoAdd = state.cart.count === 0 && pov && pov.seat.status !== 'sold' && !inCart;
    if (state.cart.count === 0 && !canAutoAdd) {
      event.preventDefault();
      toast('Pilih posisi tersedia terlebih dahulu sebelum checkout.', 'error');
      return;
    }

    const pendingPayload = canAutoAdd ? {
      venue_id: state.venueId, seat_id: pov.seat.seat_id,
      body_height_cm: state.body, front_height_cm: state.front, film: boot.film,
      schedule: boot.schedule,
    } : null;

    if (window.TitiketAuth && !window.TitiketAuth.isAuthenticated()) {
      event.preventDefault();
      window.TitiketAuth.requireAuth({
        nextUrl: boot.urls.checkout,
        pendingCartPayload: pendingPayload,
      });
      return;
    }

    if (canAutoAdd) {
      // Pilih seat atau spot aktif otomatis masuk keranjang sebelum berpindah ke halaman checkout.
      event.preventDefault();
      try {
        state.cart = await postJson(boot.api.cart, pendingPayload);
        window.location.assign(boot.urls.checkout);
      } catch (error) {
        handleCartConflict(error);
        syncCart();
      }
    }
  });

  const spotlightModal = $('seat-spotlight-modal');
  const spotlightBody = $('seat-spotlight-body');
  const spotlightAnchor = $('map-spotlight-anchor');
  const btnSpotlight = $('btn-map-spotlight');
  const btnCloseSpotlight = $('btn-close-spotlight');
  const spotlightScrim = $('seat-spotlight-scrim');
  let spotlightOpen = false;

  function openSpotlight() {
    if (!spotlightModal || !spotlightBody || !spotlightAnchor || spotlightOpen) return;
    const legend = $('map-legend');
    const mapWrap = spotlightAnchor.parentElement.querySelector('.map-wrap');
    spotlightBody.replaceChildren(...[legend, mapWrap].filter(Boolean));
    spotlightModal.hidden = false;
    spotlightOpen = true;
    document.body.style.overflow = 'hidden';
    if (btnSpotlight) btnSpotlight.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(() => spotlightModal.classList.add('is-open'));
    if (btnCloseSpotlight) btnCloseSpotlight.focus({ preventScroll: true });
  }

  function closeSpotlight() {
    if (!spotlightModal || !spotlightBody || !spotlightAnchor || !spotlightOpen) return;
    spotlightOpen = false;
    spotlightModal.classList.remove('is-open');
    if (btnSpotlight) btnSpotlight.setAttribute('aria-expanded', 'false');
    const restore = [
      spotlightBody.querySelector('#map-legend'),
      spotlightBody.querySelector('.map-wrap'),
    ].filter(Boolean);
    let cursor = spotlightAnchor;
    for (const node of restore) {
      cursor.after(node);
      cursor = node;
    }
    spotlightModal.hidden = true;
    document.body.style.overflow = '';
    if (btnSpotlight) btnSpotlight.focus({ preventScroll: true });
  }

  if (btnSpotlight) btnSpotlight.addEventListener('click', openSpotlight);
  if (btnCloseSpotlight) btnCloseSpotlight.addEventListener('click', closeSpotlight);
  if (spotlightScrim) spotlightScrim.addEventListener('click', closeSpotlight);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && spotlightOpen) {
      event.preventDefault();
      closeSpotlight();
    }
  });

  const onTheaterResize = () => {
    if (state.fullscreen && scene) scene.resize(window.innerWidth, window.innerHeight);
  };

  // Pil tinggi badan dan kontrol video dipindah (bukan diduplikasi) ke slot HUD theater, lalu dikembalikan.
  const heightPill = document.querySelector('.height-pill');
  const heightHome = heightPill && { parent: heightPill.parentElement, next: heightPill.nextSibling };
  const mediaBar = document.querySelector('.viewport-media-bar');
  const mediaHome = mediaBar && { parent: mediaBar.parentElement, next: mediaBar.nextSibling };
  const moveTo = (node, slot, home, inTheater) => {
    if (!node || !slot || !home) return;
    if (inTheater) slot.appendChild(node);
    else home.parent.insertBefore(node, home.next && home.next.parentNode === home.parent ? home.next : null);
  };

  setTheaterFullscreen = function setTheaterFullscreenImpl(on) {
    const vp = $('viewport');
    const fsHud = $('fullscreen-hud');
    const expandBtn = $('btn-fullscreen');
    if (!vp) return;
    state.fullscreen = Boolean(on);
    vp.classList.toggle('is-fullscreen-theater', state.fullscreen);
    document.documentElement.classList.toggle('is-theater-open', state.fullscreen);   // kunci scroll di <html> juga
    document.body.classList.toggle('is-theater-open', state.fullscreen);
    if (state.fullscreen && picker.isOpen) picker.close();   // drawer GBK tidak boleh tertinggal di belakang layar penuh
    if (!state.fullscreen) hideSpatialRouteHud();
    if (fsHud) fsHud.hidden = !state.fullscreen;
    if (state.layout && state.layout.kind === 'cinema') moveTo(heightPill, $('theater-dock-slot'), heightHome, state.fullscreen);
    moveTo(mediaBar, $('theater-controls-slot'), mediaHome, state.fullscreen);
    const heightPop = $('height-pill-pop');
    if (heightPop) heightPop.hidden = true;
    if (expandBtn) expandBtn.setAttribute('aria-pressed', String(state.fullscreen));
    if (state.fullscreen) {
      window.addEventListener('resize', onTheaterResize);
      window.requestAnimationFrame(() => {
        if (scene) scene.resize(window.innerWidth, window.innerHeight);
      });
      window.setTimeout(() => {
        if (state.fullscreen && scene) scene.resize(window.innerWidth, window.innerHeight);
      }, 60);
      const exitBtn = $('btn-exit-fullscreen');
      if (exitBtn) exitBtn.focus({ preventScroll: true });
    } else {
      window.removeEventListener('resize', onTheaterResize);
      window.requestAnimationFrame(() => {
        if (scene) scene.resize();
      });
      window.setTimeout(() => {
        if (!state.fullscreen && scene) scene.resize();
      }, 60);
      if (expandBtn) expandBtn.focus({ preventScroll: true });
    }
  }

  $('btn-fullscreen').addEventListener('click', () => {
    setTheaterFullscreen(!state.fullscreen);
  });
  const exitFsBtn = $('btn-exit-fullscreen');
  if (exitFsBtn) {
    exitFsBtn.addEventListener('click', () => setTheaterFullscreen(false));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !state.fullscreen && picker.isOpen) picker.close();
  });
  $('tc-back').addEventListener('click', () => setTheaterFullscreen(false));
  $('reco-select').addEventListener('click', selectRecommended);
  // Validasi checkout: tanpa kursi terpilih halaman tidak berpindah, tampilkan toast kaca.
  $('btn-checkout').addEventListener('click', (event) => {
    if (state.cart.count > 0) return;
    event.preventDefault();
    toast('Silakan pilih kursi terlebih dahulu sebelum melanjutkan.', 'error');
  });
  $('tc-cart').addEventListener('click', () => $('btn-cart').click());
  $('btn-seat-prev').addEventListener('click', () => stepSeat(-1));
  $('btn-seat-next').addEventListener('click', () => stepSeat(1));
  for (const button of document.querySelectorAll('#posture-toggle [data-posture]')) {
    button.addEventListener('click', () => {
      if (!state.layout) return;
      openBlockFromTheater(button.dataset.posture === 'standing' ? 'festival' : (state.lastSeatedBlock || 'cat1'));
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.fullscreen && !wayfindingOn) {
      event.preventDefault();
      setTheaterFullscreen(false);
    }
  });

  if (!scene) return;
  const media = scene.media;
  media.onChange = syncMedia;
  scene.onInteract = () => $('hud-hint').classList.add('is-hidden');
  scene.onAspect = debounce((aspect) => {
    if (Math.abs(aspect - state.aspect) < 0.02) return;
    state.aspect = aspect;
    if (state.pov) requestPov('quick');     // FOV horizontal bergantung rasio viewport
  }, 180);

  $('btn-play').addEventListener('click', () => media.toggle());
  $('btn-mute').addEventListener('click', () => media.setMuted(!media.muted));
  $('range-volume').addEventListener('input', (event) => {
    media.setVolume(Number(event.target.value) / 100);
    event.target.style.setProperty('--fill', `${event.target.value}%`);
  });
  $('range-volume').style.setProperty('--fill', '70%');
  $('btn-4dx').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const next = button.getAttribute('aria-pressed') !== 'true';
    const ok = await scene.setFourDX(next);
    if (!ok) return;
    button.setAttribute('aria-pressed', String(next));
    if (next && scene.reducedMotion) {
      toast('Efek gerak dimatikan karena pengaturan "kurangi gerakan" aktif di perangkatmu.', 'error');
    } else if (next) {
      toast('Efek 4DX aktif: kursi bergoyang dan angin berembus mengikuti trailer.');
    }
  });
}

/* •••••••••••• */
/* Deep Link Bagikan Posisi                                                   */
/* •••••••••••• */
function resolveDeepLinkSeat(layout, rawSeat) {
  if (!layout || !rawSeat) return null;
  const query = String(rawSeat).trim();
  if (!query) return null;
  const needle = query.toLowerCase();

  if (Array.isArray(layout.seats)) {
    const seatMatch = layout.seats.find(
      (item) => String(item.id || '').toLowerCase() === needle || String(item.label || '').toLowerCase() === needle
    );
    if (seatMatch) {
      return { seat_id: seatMatch.id };
    }
  }

  if (layout.kind !== 'cinema' && Array.isArray(layout.blocks)) {
    const short = /^([a-z0-9_]+)-(\d+)-(\d+)$/.exec(needle);     // "CAT3-14-163" -> cat3:R14:S163
    const full = !short ? /^([a-z0-9_]+):r(\d+):s(\d+)$/.exec(needle) : null;
    const rawPrefix = short ? short[1] : (full ? full[1] : (needle.includes(':') ? needle.split(':')[0] : needle));
    const blockAliases = { cat2: 'cat2a', cat2b: 'cat2b_s', cat4: 'cat4a', cat5: 'cat5b', cat7: 'cat7a', cat8: 'cat8a', vip: 'ultimate' };
    const resolvedPrefix = blockAliases[rawPrefix] || rawPrefix;
    const block = layout.blocks.find((b) => String(b.id || '').toLowerCase() === rawPrefix)
      || layout.blocks.find((b) => String(b.id || '').toLowerCase() === resolvedPrefix);
    if (block) {
      if (short) return { seat_id: `${block.id}:R${short[2]}:S${short[3]}` };
      if (full) return { seat_id: `${block.id}:R${full[2]}:S${full[3]}` };
      if (needle.includes(':')) {
        const parts = query.split(':');
        parts[0] = block.id;
        return { seat_id: parts.join(':') };
      }
      if (block.standing && Array.isArray(block.spots) && block.spots.length) {
        return { block_id: block.id, spot: block.spots[0].key || block.spots[0].id || block.spots[0] };
      }
      return { block_id: block.id };
    }
  }
  return null;
}

/* •••••••••••• */
/* Friend Seat Sharing (?friend_seat=)                                        */
/* •••••••••••• */
function findNearestSeatToFriend(layout, friendSeat) {
  if (!layout || !Array.isArray(layout.seats) || !friendSeat) return null;
  const available = layout.seats.filter((s) => s.status !== 'sold' && s.id !== friendSeat.id);
  if (!available.length) return null;

  const sameRow = available
    .filter((s) => s.row_index === friendSeat.row_index)
    .sort((a, b) => (
      Math.abs(a.number - friendSeat.number) - Math.abs(b.number - friendSeat.number)
      || Math.hypot(a.x - friendSeat.x, a.z - friendSeat.z) - Math.hypot(b.x - friendSeat.x, b.z - friendSeat.z)
    ));
  if (sameRow.length) return sameRow[0];

  const adjacentRow = available
    .filter((s) => Math.abs(s.row_index - friendSeat.row_index) === 1)
    .sort((a, b) => Math.hypot(a.x - friendSeat.x, a.z - friendSeat.z) - Math.hypot(b.x - friendSeat.x, b.z - friendSeat.z));
  if (adjacentRow.length) return adjacentRow[0];

  return [...available].sort(
    (a, b) => Math.hypot(a.x - friendSeat.x, a.z - friendSeat.z) - Math.hypot(b.x - friendSeat.x, b.z - friendSeat.z)
  )[0];
}

function resolveFriendSeatFlow(layout, rawFriendSeat) {
  if (!layout || !rawFriendSeat) return null;
  const query = String(rawFriendSeat).trim();
  if (!query) return null;
  const needle = query.toLowerCase();

  if (layout.kind === 'cinema' && Array.isArray(layout.seats)) {
    const friendSeat = layout.seats.find(
      (item) => String(item.id || '').toLowerCase() === needle || String(item.label || '').toLowerCase() === needle
    );
    if (!friendSeat) return null;
    const nearest = findNearestSeatToFriend(layout, friendSeat);
    return {
      friendId: friendSeat.id,
      friendLabel: friendSeat.label || friendSeat.id,
      selector: nearest ? { seat_id: nearest.id } : { seat_id: friendSeat.id },
      recoLabel: nearest ? (nearest.label || nearest.id) : null,
    };
  }

  if (layout.kind !== 'cinema' && Array.isArray(layout.blocks)) {
    const parts = query.split(':');
    const blockId = parts[0].toLowerCase();
    const block = layout.blocks.find((b) => String(b.id || '').toLowerCase() === blockId);
    if (!block) return null;
    if (block.standing && Array.isArray(block.spots) && block.spots.length) {
      const spotKey = block.spots[0].key || block.spots[0].id || 1;
      return {
        friendId: query,
        friendLabel: block.label,
        selector: { block_id: block.id, spot: spotKey },
        recoLabel: `${block.label} (Area Berdiri Terdekat)`,
      };
    }
    const rowPart = parts[1] || 'R1';
    const seatMatch = String(parts[2] || '').match(/(\d+)/);
    const baseNum = seatMatch ? Number(seatMatch[1]) : 10;
    const neighborId = `${block.id}:${rowPart}:S${baseNum + 1}`;
    return {
      friendId: query,
      friendLabel: query,
      selector: parts.length >= 3 ? { seat_id: neighborId } : { block_id: block.id },
      recoLabel: parts.length >= 3 ? neighborId : block.label,
    };
  }
  return null;
}

async function copyTextSafe(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Lanjutkan ke fallback textarea di bawah.
    }
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    const ok = document.execCommand('copy');
    helper.remove();
    return ok;
  } catch {
    return false;
  }
}

function initSharePosition() {
  const btnShare = $('btn-share-seat');
  if (!btnShare) return;
  btnShare.addEventListener('click', async () => {
    const activeId =
      (state.pov && state.pov.seat && state.pov.seat.seat_id)
      || (state.selector && (state.selector.seat_id || state.selector.block_id));
    if (!activeId) {
      toast('Silakan pilih posisi terlebih dahulu sebelum dibagikan.', 'error');
      return;
    }
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set('seat', activeId);
    await copyTextSafe(shareUrl.toString());
    toast('Tautan posisi kursi berhasil disalin!');
  });
}

/* •••••••••••• */
/* Smart Adjacent Cluster (Seat Finder Berdampingan)                          */
/* •••••••••••• */
function syncClusterPills() {
  for (const btn of document.querySelectorAll('#cluster-size-pills [data-cluster-size]')) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset.clusterSize) === state.clusterSize));
  }
}

async function getVenueScoreMap() {
  const key = `${state.venueId}|${state.body}|${state.front}`;
  if (state.scoreCache.has(key)) return state.scoreCache.get(key);
  const scores = new Map();
  try {
    const query = `?body_height_cm=${state.body}&front_height_cm=${state.front}`;
    const data = await api(venueUrl(boot.api.heatmap, state.venueId) + query);
    for (const cell of (data && data.cells) || []) {
      scores.set(cell.seat_id, Number(cell.score));
    }
    state.scoreCache.set(key, scores);
  } catch {
    // Fallback skor netral bila heatmap sementara gagal diambil.
  }
  return scores;
}

function seatScoreFallback(seat, layout) {
  if (!layout || !layout.rows || !layout.rows.length) return 75;
  const maxX = Math.max(4, ((layout.room && layout.room.width) || 12) / 2);
  const centerBonus = Math.max(0, 1 - Math.abs(seat.x || 0) / maxX) * 20;
  const rowFrac = (seat.row_index || 0) / Math.max(1, layout.rows.length - 1);
  const depthBonus = (1 - Math.abs(rowFrac - 0.62)) * 20;
  return 60 + centerBonus + depthBonus;
}

function stadiumSeatWorldPos(bowl, block, rowNo, seatNo, totalInRow) {
  let rem = rowNo - 1;
  let tierSpec = block.tiers && block.tiers[0];
  let depth = tierSpec ? tierSpec.depth_start + bowl.row_depth * 0.5 : 5;
  for (const t of block.tiers || []) {
    const count = Math.floor((t.depth_end - t.depth_start) / bowl.row_depth + 1e-6);
    if (rem < count) {
      tierSpec = t;
      depth = t.depth_start + (rem + 0.5) * bowl.row_depth;
      break;
    }
    rem -= count;
  }
  const [bStart, bEnd] = block.bearing;
  const frac = ((seatNo - 1) + 0.5) / Math.max(1, totalInRow);
  const deg = bEnd - frac * (bEnd - bStart);
  const rad = (deg * Math.PI) / 180;
  return {
    x: (bowl.rx_inner + depth) * Math.sin(rad),
    y: tierSpec ? tierSpec.y_start : 3.0,
    z: -(bowl.rz_inner + depth) * Math.cos(rad),
  };
}

async function findBestAdjacentCluster(count, anchorSeatId = null) {
  const layout = state.layout;
  if (!layout || count < 2 || count > 10) return null;
  const scoreMap = await getVenueScoreMap();

  if (layout.kind === 'cinema') {
    const seats = Array.isArray(layout.seats) ? layout.seats : [];
    const byRow = new Map();
    for (const s of seats) {
      if (!byRow.has(s.row_index)) byRow.set(s.row_index, []);
      byRow.get(s.row_index).push(s);
    }
    const sortedRowIndices = [...byRow.keys()].sort((a, b) => b - a);   // Pindai belakang (Row A) -> depan (Row M)
    const spec = layout.spec || {};
    const aisleAfter = new Set(spec.aisle_after || []);
    const maxGap = (spec.seat_pitch || 0.6) * 1.55;
    const isAvail = (s) => s.status === 'available' && s.id !== map.friendSeatId;

    const scan = (strictGap) => {
      let best = null;
      let iter = 0;
      const MAX_ITER = 2500;
      for (const rowIdx of sortedRowIndices) {
        if (iter >= MAX_ITER) break;
        const row = byRow.get(rowIdx).slice().sort((a, b) => a.number - b.number);
        for (let i = 0; i <= row.length - count; i += 1) {
          iter += 1;
          if (iter > MAX_ITER) break;
          const win = row.slice(i, i + count);
          if (anchorSeatId && !win.some((s) => s.id === anchorSeatId)) continue;
          if (!win.every(isAvail)) continue;
          let contiguous = true;
          for (let j = 0; j < win.length - 1; j += 1) {
            const cur = win[j];
            const nxt = win[j + 1];
            if (nxt.number !== cur.number + 1 || aisleAfter.has(cur.number)) {
              contiguous = false;
              break;
            }
            if (strictGap && Math.abs(nxt.x - cur.x) > maxGap) {
              contiguous = false;
              break;
            }
          }
          if (!contiguous) continue;
          const totalScore = win.reduce(
            (sum, s) => sum + (scoreMap.has(s.id) ? scoreMap.get(s.id) : seatScoreFallback(s, layout)),
            0
          );
          const avgScore = totalScore / count;
          const midX = win.reduce((acc, s) => acc + s.x, 0) / count;
          const midY = win.reduce((acc, s) => acc + s.y, 0) / count;
          const midZ = win.reduce((acc, s) => acc + s.z, 0) / count;
          const cand = {
            seats: win,
            ids: win.map((s) => s.id),
            anchorSeatId: win[Math.floor((count - 1) / 2)].id,
            center: { x: midX, y: midY, z: midZ },
            avgScore,
            midAbsX: Math.abs(midX),
            rowIndex: rowIdx,
            label: `Baris ${win[0].row} · Kursi ${win[0].number}–${win[count - 1].number}`,
          };
          if (
            !best
            || cand.avgScore > best.avgScore + 0.05
            || (Math.abs(cand.avgScore - best.avgScore) <= 0.05
              && (cand.midAbsX < best.midAbsX - 0.01
                || (Math.abs(cand.midAbsX - best.midAbsX) <= 0.01 && cand.rowIndex > best.rowIndex)))
          ) {
            best = cand;
          }
        }
      }
      return best;
    };
    return scan(true) || scan(false);
  }

  // Konser GBK: pilih kategori duduk aktif (atau CAT 3), cari baris terbaik lalu jendela N kursi berurutan.
  const currentBlockId = state.pov && state.pov.seat_frame && state.pov.seat_frame.block_id;
  let block = layout.blocks.find((b) => b.id === currentBlockId && !b.standing);
  if (!block) {
    block = layout.blocks.find((b) => b.id === 'cat3' && !b.standing) || layout.blocks.find((b) => !b.standing);
  }
  if (!block || !Array.isArray(block.row_seats) || !block.row_seats.length) return null;

  let chosenRow = block.bands && block.bands[block.bands.length - 1] ? block.bands[block.bands.length - 1].row : block.row_seats.length;
  let bestScore = -1;
  const bandScores = [];
  for (const b of (block.bands || []).slice().reverse()) {
    const totalInRow = block.row_seats[b.row - 1] || 1;
    const midSeat = Math.max(1, Math.ceil(totalInRow / 2));
    const repId = `${block.id}:R${b.row}:S${midSeat}`;
    const sc = scoreMap.get(repId) ?? 78;
    bandScores.push({ row: b.row, score: sc });
  }
  for (const bs of bandScores) {
    if (bs.score > bestScore) {
      bestScore = bs.score;
      chosenRow = bs.row;
    }
  }

  const rowTotal = block.row_seats[chosenRow - 1] || count;
  const n = Math.min(count, rowTotal);
  const startSeat = Math.max(1, Math.min(rowTotal - n + 1, Math.floor((rowTotal - n) / 2) + 1));
  const seatNumbers = Array.from({ length: n }, (_, idx) => startSeat + idx);
  const ids = seatNumbers.map((num) => `${block.id}:R${chosenRow}:S${num}`);
  const pts = seatNumbers.map((num) => stadiumSeatWorldPos(layout.bowl, block, chosenRow, num, rowTotal));
  const center = {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
    z: pts.reduce((a, p) => a + p.z, 0) / pts.length,
  };
  return {
    blockId: block.id,
    seats: ids.map((id, idx) => ({ id, number: seatNumbers[idx], row: chosenRow })),
    ids,
    anchorSeatId: ids[Math.floor((ids.length - 1) / 2)],
    center,
    avgScore: bestScore > 0 ? bestScore : 78,
    label: `${block.label} · Baris ${chosenRow} · Kursi ${seatNumbers[0]}–${seatNumbers[seatNumbers.length - 1]}`,
  };
}

let clusterReqSeq = 0;
let clusterBusy = false;

async function applyClusterCount(count, anchorSeatId = null) {
  if (clusterBusy) return;
  clusterBusy = true;
  const reqId = ++clusterReqSeq;
  try {
    state.clusterSize = count;
    syncClusterPills();
    const statusEl = $('cluster-status');
    const statusText = $('cluster-status-text');
    const addAllBtn = $('btn-cluster-cart');

    if (count <= 1) {
      state.clusterSeats = [];
      state.clusterCenter = null;
      state.clusterAvgScore = null;
      map.setCluster([], null);
      picker.setClusterSeats([]);
      if (statusEl) statusEl.hidden = true;
      if (anchorSeatId) {
        preserveScroll(() => {
          state.selector = { seat_id: anchorSeatId };
          requestPov('glide');
        });
      } else if (state.pov) {
        requestPov('glide');
      }
      return;
    }

    const cluster = await findBestAdjacentCluster(count, anchorSeatId);
    if (reqId !== clusterReqSeq) return;
    if (!cluster) {
      state.clusterSize = 1;
      syncClusterPills();
      state.clusterSeats = [];
      state.clusterCenter = null;
      state.clusterAvgScore = null;
      map.setCluster([], null);
      picker.setClusterSeats([]);
      if (statusEl) statusEl.hidden = true;
      toast(
        anchorSeatId
          ? `Kursi tersebut tidak dapat membentuk kluster ${count} kursi berdampingan, beralih ke 1 kursi.`
          : `Tidak ditemukan ${count} kursi berdampingan yang tersedia.`,
        'error'
      );
      if (anchorSeatId) {
        preserveScroll(() => {
          state.selector = { seat_id: anchorSeatId };
          requestPov('glide');
        });
      }
      return;
    }

    state.clusterSeats = cluster.ids;
    state.clusterCenter = cluster.center;
    state.clusterAvgScore = cluster.avgScore;
    if (state.layout && state.layout.kind !== 'cinema' && cluster.blockId) {
      if (!picker.block || picker.block.id !== cluster.blockId) picker.open(cluster.blockId, state.layout);
    }
    map.setCluster(cluster.ids, cluster.center);
    picker.setClusterSeats(cluster.ids);

    if (statusText) {
      statusText.textContent = `${cluster.label} · Skor Rata-rata ${Math.round(cluster.avgScore)}`;
    }
    if (addAllBtn) {
      addAllBtn.textContent = `Tambah ${cluster.ids.length} Kursi ke Keranjang`;
    }
    if (statusEl) statusEl.hidden = false;

    preserveScroll(() => {
      state.selector = { seat_id: cluster.anchorSeatId };
      requestPov('glide');
    });
  } finally {
    clusterBusy = false;
  }
}

async function addClusterToCart() {
  if (!state.clusterSeats || !state.clusterSeats.length) return;
  const btn = $('btn-cluster-cart');
  if (btn) btn.disabled = true;
  let addedCount = 0;
  try {
    for (const seatId of state.clusterSeats) {
      if (state.cart.keys.includes(`${state.venueId}|${seatId}`)) continue;
      const data = await postJson(boot.api.cart, {
        venue_id: state.venueId,
        seat_id: seatId,
        body_height_cm: state.body,
        front_height_cm: state.front,
        film: boot.film,
        schedule: boot.schedule,
      });
      state.cart = data;
      if (Number(data.lock_seconds_left) > 0) {
        seatLockRemaining = Number(data.lock_seconds_left);
        seatLockExpiredShown = false;
        renderSeatLockClock();
      }
      addedCount += 1;
    }
    toast(
      addedCount > 0
        ? `${addedCount} kursi berdampingan masuk keranjang.`
        : 'Seluruh kursi pada kluster ini sudah ada di keranjang.'
    );
  } catch (error) {
    handleCartConflict(error);
  } finally {
    if (btn) btn.disabled = false;
    syncCart();
  }
}

function initClusterSelector() {
  const host = $('cluster-size-pills');
  const addBtn = $('btn-cluster-cart');
  if (host) {
    host.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-cluster-size]');
      if (!btn) return;
      const next = Number(btn.dataset.clusterSize) || 1;
      applyClusterCount(next).catch((err) => toast(err.message, 'error'));
    });
  }
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      addClusterToCart().catch((err) => toast(err.message, 'error'));
    });
  }
}

/* •••••••••••• */
/* Timelapse Suasana Konser GBK                                               */
/* •••••••••••• */
const CONCERT_PHASE_WEATHER = {
  open_gate: 'Cerah',
  golden_hour: 'Gerimis Senja',
  transition_rain: 'Hujan Deras',
  peak_show: 'Malam Cerah',
};

function syncTimelapseWeatherBadge(phase) {
  const bar = $('concert-timelapse-bar');
  const textEl = $('timelapse-weather-text');
  if (bar) bar.dataset.phase = phase;
  if (textEl) textEl.textContent = CONCERT_PHASE_WEATHER[phase] || 'Malam Cerah';
}

function initConcertTimelapse() {
  const bar = $('concert-timelapse-bar');
  if (!bar) return;
  const buttons = bar.querySelectorAll('[data-concert-phase]');
  const active = bar.querySelector('[data-concert-phase][aria-pressed="true"]');
  syncTimelapseWeatherBadge((active && active.dataset.concertPhase) || 'peak_show');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const phase = btn.dataset.concertPhase || 'peak_show';
      buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === btn)));
      syncTimelapseWeatherBadge(phase);
      if (scene && typeof scene.setConcertPhase === 'function') {
        scene.setConcertPhase(phase);
      }
    });
  });
}

/* •••••••••••• */
/* TikBuddy AI Concierge                                                      */
/* •••••••••••• */
function initTikBuddy() {
  const fab = $('tikbuddy-fab');
  const drawer = $('tikbuddy-drawer');
  const closeBtn = $('tikbuddy-close');
  const messagesEl = $('tikbuddy-messages');
  const form = $('tikbuddy-form');
  const input = $('tikbuddy-input');
  const pillsHost = $('tikbuddy-pills');
  if (!fab || !drawer || !messagesEl || !form || !input) return;

  const setOpen = (open) => {
    drawer.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    fab.hidden = open && window.matchMedia('(max-width: 480px)').matches;
    if (open) window.setTimeout(() => input.focus({ preventScroll: true }), 40);
  };

  const appendMsg = (text, who = 'bot') => {
    const node = document.createElement('div');
    node.className = `ai-msg ai-msg--${who}`;
    node.textContent = text;
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const pickPresetForQuery = (promptText) => {
    const layout = state.layout;
    const presets = (layout && Array.isArray(layout.presets)) ? layout.presets : [];
    const hasKey = (key) => presets.some((p) => p.key === key);
    const q = promptText.toLowerCase();

    if (q.includes('leher') || q.includes('nyaman') || q.includes('neck') || q.includes('pegal')) {
      if (hasKey('neck_comfort')) return 'neck_comfort';
    }
    if (q.includes('suara') || q.includes('jernih') || q.includes('audio') || q.includes('sound') || q.includes('akustik')) {
      if (hasKey('best_acoustic')) return 'best_acoustic';
    }
    if (q.includes('tengah') || q.includes('gbk') || q.includes('lurus') || q.includes('view') || q.includes('center')) {
      if (hasKey('clear_stage_view')) return 'clear_stage_view';
      if (hasKey('ideal_thx')) return 'ideal_thx';
    }
    if (q.includes('dekat') || q.includes('besar') || q.includes('immersi') || q.includes('panggung')) {
      if (hasKey('max_immersion')) return 'max_immersion';
    }
    return (presets[0] && presets[0].key) || 'ideal_thx';
  };

  const findDirectSeatMatch = (promptText) => {
    const layout = state.layout;
    if (!layout) return null;
    const tokens = promptText.toUpperCase().match(/[A-Z]+\d+|[A-Z]{2,}\d*/g) || [];
    if (Array.isArray(layout.seats)) {
      for (const tok of tokens) {
        const hit = layout.seats.find(
          (s) => s.status !== 'sold' && (String(s.id).toUpperCase() === tok || String(s.label).toUpperCase() === tok)
        );
        if (hit) return { selector: { seat_id: hit.id }, label: hit.label };
      }
    }
    if (layout.kind !== 'cinema' && Array.isArray(layout.blocks)) {
      const lower = promptText.toLowerCase();
      const block = layout.blocks.find((b) => lower.includes(b.id.toLowerCase()) || lower.includes(b.label.toLowerCase()));
      if (block) {
        return { selector: { block_id: block.id }, label: block.label };
      }
    }
    return null;
  };

  const runQuery = async (promptText) => {
    const query = String(promptText || '').trim();
    if (!query || !state.layout) return;
    appendMsg(query, 'user');

    const direct = findDirectSeatMatch(query);
    if (direct) {
      if (direct.selector.block_id && !direct.selector.seat_id) {
        openBlock(direct.selector.block_id);
      } else {
        selectPosition(direct.selector);
      }
      appendMsg(`Siap! Aku arahkan kamera 3D ke ${direct.label}.`);
      return;
    }

    const qLower = query.toLowerCase();
    if (qLower.includes('murah') || qLower.includes('hemat') || qLower.includes('budget')) {
      const seats = (state.layout.seats || []).filter((s) => s.status !== 'sold');
      if (seats.length) {
        const cheapest = [...seats].sort((a, b) => (a.price || 0) - (b.price || 0))[0];
        selectPosition({ seat_id: cheapest.id });
        appendMsg(`Pilihan paling hemat jatuh ke ${cheapest.label} (${formatRupiah(cheapest.price)}). Kamera 3D sudah pindah ke sana.`);
        return;
      }
    }

    const presetKey = pickPresetForQuery(query);
    try {
      const data = await postJson(boot.api.recommend, {
        venue_id: state.venueId,
        preset: presetKey,
        body_height_cm: state.body,
        front_height_cm: state.front,
        film: boot.film,
      });
      const best = data && data.recommendations && data.recommendations[0];
      if (!best) {
        appendMsg('Maaf, belum ada posisi tersedia yang cocok untuk kriteria tersebut.');
        return;
      }
      selectPosition({ seat_id: best.seat_id });
      const presetObj = (state.layout.presets || []).find((p) => p.key === presetKey);
      if (presetObj) {
        state.preset = presetObj;
        syncPreset();
      }
      appendMsg(`Rekomendasi terbaik: ${best.label} (Skor ${Math.round(best.score)} · ${best.grade}). Kamera 3D sudah mengarah ke posisi ini.`);
    } catch (error) {
      appendMsg(`Gagal mencari posisi: ${error.message || 'coba lagi.'}`);
    }
  };

  fab.addEventListener('click', () => setOpen(drawer.hidden));
  if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

  document.addEventListener('click', (event) => {
    if (drawer.hidden) return;
    if (drawer.contains(event.target) || fab.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) setOpen(false);
  });

  if (pillsHost) {
    pillsHost.addEventListener('click', (event) => {
      const pill = event.target.closest('[data-tikbuddy-prompt]');
      if (!pill) return;
      runQuery(pill.dataset.tikbuddyPrompt);
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    runQuery(text);
  });
}

let lastSpatialGate = '';

function setSpatialStepUi(stepIndex, finished = false, gateLabel = '') {
  const hud = $('spatial-route-hud');
  const titleEl = $('spatial-route-title');
  if (!hud || !titleEl) return;
  const gateText = gateLabel ? ` (${gateLabel})` : '';
  const titles = [
    `Titik 1/3 \u00b7 Plaza Luar SUGBK${gateText}`,
    'Titik 2/3 \u00b7 Mulut Ramp Sektor',
    finished ? 'Titik 3/3 \u00b7 Sudut Pandang Kursi (Tiba)' : 'Titik 3/3 \u00b7 Sudut Pandang Kursi',
  ];
  const clamped = Math.max(0, Math.min(2, stepIndex));
  titleEl.textContent = titles[clamped];
  for (const dot of hud.querySelectorAll('.spatial-step-dot')) {
    const idx = Number(dot.dataset.spatialStep);
    dot.classList.toggle('is-active', idx === clamped && !finished);
    dot.classList.toggle('is-done', finished ? idx <= clamped : idx < clamped);
  }
  const skipBtn = $('btn-spatial-skip');
  if (skipBtn) skipBtn.textContent = finished ? 'Tutup' : 'Lewati';
}

hideSpatialRouteHud = () => {
  const hud = $('spatial-route-hud');
  if (hud) hud.hidden = true;
  if (scene && typeof scene.stopSpatialRoute === 'function') {
    scene.stopSpatialRoute({ snapToGoal: false });
  }
};

startSpatialRouteTour = (gateLabel = '') => {
  const hud = $('spatial-route-hud');
  if (!hud || !scene || !state.pov || !state.layout || state.layout.kind === 'cinema') return;
  if (gateLabel) lastSpatialGate = gateLabel;
  hud.hidden = false;
  setSpatialStepUi(0, false, lastSpatialGate);
  scene.playSpatialRoute(state.pov, lastSpatialGate, (step, finished) => {
    setSpatialStepUi(step, finished, lastSpatialGate);
  });
};

function initSpatialRoute() {
  const replayBtn = $('btn-spatial-replay');
  const skipBtn = $('btn-spatial-skip');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      if (!state.fullscreen) setTheaterFullscreen(true);
      startSpatialRouteTour(lastSpatialGate);
    });
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      if (scene && scene.spatialTour && typeof scene.stopSpatialRoute === 'function') {
        scene.stopSpatialRoute({ snapToGoal: true });
      } else {
        hideSpatialRouteHud();
      }
    });
  }
}

/* •••••••••••• */
/* Mode wayfinding (?mode=wayfinding): tur 5-Pos di GLB eksterior GBK    */
/* •••••••••••• */
const WAYFINDING_FALLBACK_TITLES = [
  'Pos 1: Kedatangan & Penukaran Wristband',
  'Pos 2: Pemeriksaan Tas & Skrining Tubuh',
  'Pos 3: Pindai E-Tiket & Gerbang Masuk',
  'Pos 4: Menuju Pintu Sektor Tribun',
  'Pos 5: Tiba di Kursi Anda',
];
const WAYFINDING_FALLBACK_DESCS = [
  'Mulai dari depan gerbang Coldplay, ikuti antrean kanopi putih menuju loket penukaran wristband.',
  'Siapkan tas untuk diperiksa petugas Security dan lewati gerbang walk-through metal detector.',
  'Pindai kode QR e-tiket Anda di turnstile gerbang utama sebelum masuk menuju sirkulasi stadion.',
  'Susuri concourse atau ramp menuju mulut pintu masuk fisik sektor Anda.',
  'Masuk ke mangkuk stadion dan nikmati pandangan langsung menuju panggung utama.',
];
let wayfindingRoute = null;

function syncWayfindingDockUI(step, t = 0, arrived = false) {
  wayfindingStep = Math.max(0, Math.min(4, step));
  const routeTitles = wayfindingRoute && Array.isArray(wayfindingRoute.stepTitles) ? wayfindingRoute.stepTitles : null;
  const routeDescs = wayfindingRoute && Array.isArray(wayfindingRoute.stepDescriptions) ? wayfindingRoute.stepDescriptions : null;

  const lblEl = $('wayfinding-label');
  if (lblEl) {
    lblEl.textContent = (routeTitles && routeTitles[wayfindingStep])
      || WAYFINDING_FALLBACK_TITLES[wayfindingStep];
  }
  const descEl = $('wayfinding-desc');
  if (descEl) {
    descEl.textContent = (routeDescs && routeDescs[wayfindingStep])
      || WAYFINDING_FALLBACK_DESCS[wayfindingStep];
  }

  const autoPrevBtn = $('wf-auto-prev');
  const stepPrevBtn = $('wf-step-prev');
  const stepNextBtn = $('wf-step-next');
  const autoNextBtn = $('wf-auto-next');
  const finishBtn = $('wf-finish');
  const finishReady = Boolean(arrived || t >= 0.98);
  if (autoPrevBtn) autoPrevBtn.disabled = t <= 0.01 && wayfindingStep === 0;
  if (stepPrevBtn) stepPrevBtn.disabled = t <= 0.005;
  if (stepNextBtn) stepNextBtn.disabled = t >= 0.995;
  if (autoNextBtn) autoNextBtn.hidden = finishReady;
  if (finishBtn) finishBtn.hidden = !finishReady;

  document.querySelectorAll('#wayfinding-dock .wayfinding-dot').forEach((dot, index) => {
    dot.classList.toggle('is-active', index === wayfindingStep);
    dot.classList.toggle('is-done', index < wayfindingStep);
  });
}

function setWayfindingStep(step, { instant = false } = {}) {
  if (!scene) return;
  const clamped = Math.max(0, Math.min(4, step));
  const ok = scene.goToWaypoint(clamped, { instant });
  if (!ok) {
    syncWayfindingDockUI(clamped, clamped / 4, clamped === 4);
  }
}

async function startWayfinding() {
  wayfindingOn = true;
  clearReservationTimers();
  document.body.classList.add('is-wayfinding-mode');
  setTheaterFullscreen(true);
  setVeil(true, 'Memuat rute spasial 3D…');
  const rawSeat = new URLSearchParams(window.location.search).get('seat')
    || (state.pov && state.pov.seat && state.pov.seat.seat_id)
    || 'cat3:R14:S163';
  await scene.enableWayfinding(rawSeat);        // gagal memuat GLB -> tur tetap jalan di stadion prosedural
  wayfindingRoute = typeof scene.getWayfindingRoute === 'function' ? scene.getWayfindingRoute() : null;
  const minimapEl = $('minimapContainer');
  const gateTagEl = $('minimapGateTag');
  const sectorTagEl = $('minimapSectorTag');
  if (wayfindingRoute) {
    if (gateTagEl) gateTagEl.textContent = String(wayfindingRoute.gateInfo?.gate || 'GATE 6').toUpperCase();
    if (sectorTagEl) sectorTagEl.textContent = `SEKTOR ${wayfindingRoute.sector || 16}`;
    const isStand = Boolean(wayfindingRoute.parsed?.isStanding);
    const isUpper = !isStand && (wayfindingRoute.ingressKind === 'upper' || wayfindingRoute.tierName === 'tier2');
    const tierText = isUpper ? 'Upper Tier' : 'Lower Tier';
    const modeChip = $('theater-chip-mode');
    if (modeChip) modeChip.textContent = isStand ? 'Berdiri · Festival' : `Duduk · ${tierText}`;
    const tierEl = $('posture-tier');
    if (tierEl) tierEl.textContent = tierText;
  }
  if (minimapEl) minimapEl.hidden = false;
  scene.onWayfindingProgress = ({ t, step, arrived }) => syncWayfindingDockUI(step, t, arrived);
  window.__titiketWayfindingStats = () => (typeof scene?.getWayfindingStats === 'function' ? scene.getWayfindingStats() : null);
  setVeil(false);
  setWayfindingStep(0, { instant: true });
}

function initWayfinding() {
  const autoPrev = $('wf-auto-prev');
  const stepPrev = $('wf-step-prev');
  const stepNext = $('wf-step-next');
  const autoNext = $('wf-auto-next');
  if (!autoPrev || !stepPrev || !stepNext || !autoNext) return;

  autoPrev.addEventListener('click', () => {
    if (scene && typeof scene.goToRelativeWaypoint === 'function') scene.goToRelativeWaypoint(-1);
    else setWayfindingStep(wayfindingStep - 1);
  });
  autoNext.addEventListener('click', () => {
    if (scene && typeof scene.goToRelativeWaypoint === 'function') scene.goToRelativeWaypoint(1);
    else setWayfindingStep(wayfindingStep + 1);
  });

  const bindHold = (btn, dir) => {
    const startHold = (event) => {
      event.preventDefault();
      if (btn.disabled) return;
      if (scene && typeof scene.setWayManualDir === 'function') scene.setWayManualDir(dir);
      try { btn.setPointerCapture?.(event.pointerId); } catch (_) {}
    };
    const endHold = () => {
      if (scene && typeof scene.setWayManualDir === 'function') scene.setWayManualDir(0);
    };
    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', endHold);
    btn.addEventListener('pointercancel', endHold);
    btn.addEventListener('lostpointercapture', endHold);
    btn.addEventListener('pointerleave', endHold);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  };

  bindHold(stepPrev, -1);
  bindHold(stepNext, 1);
  window.addEventListener('blur', () => scene?.setWayManualDir?.(0));
}

bindEvents();
initClusterSelector();
initSpatialRoute();
initWayfinding();
initSharePosition();
initConcertTimelapse();
initTikBuddy();
loadVenue(boot.venueId).catch(reportFatal);
