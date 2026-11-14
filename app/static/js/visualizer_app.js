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
import { Map2DPicker, SubPositionPicker, formatRupiah, h, icon } from './map_2d_picker.js';
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
  heatmap: false,
  compareOn: false,
  compareMode: 'pip',
  photoIndex: 0,
  photoKey: '',
  fullscreen: false,
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
    badgeEl.hidden = isConcert;
  }
  if (posterEl) {
    const posterSrc = (layout.media && layout.media.poster) || '';
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

async function handleLockExpiredModal() {
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
  if (lockLabel) lockLabel.textContent = standing ? 'Batas waktu kunci tiket' : 'Batas waktu kunci kursi';
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
  $('reco-title').textContent = standing ? 'Rekomendasi Spot Otomatis' : 'Rekomendasi Kursi Otomatis';
  $('reco-hint').textContent = standing
    ? 'Pilih preferensi spot berdiri.'
    : 'Pilih preferensi kursi.';
  const recoBtnLabel = $('btn-recommend').querySelector('span');
  if (recoBtnLabel && !$('btn-recommend').disabled) {
    recoBtnLabel.textContent = standing ? 'Cari 3 spot terbaik' : 'Cari 3 kursi terbaik';
  }
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

  const vizApp = $('viz-app');
  if (vizApp) vizApp.dataset.kind = layout.kind;
  const screenBanner = $('cinema-screen-banner');
  if (screenBanner) screenBanner.hidden = layout.kind !== 'cinema';
  const displayGroup = $('deck-display-group');
  if (displayGroup) displayGroup.hidden = layout.kind !== 'cinema';
  const compareBtn = $('btn-compare');
  if (compareBtn) compareBtn.hidden = layout.kind !== 'cinema';
  if (layout.kind !== 'cinema') state.compareOn = false;

  $('viz-title').textContent = layout.name;
  const vizTagline = $('viz-tagline');
  if (vizTagline) vizTagline.textContent = layout.tagline;
  $('viz-eyebrow').textContent = layout.event ? layout.event.title : 'Visualizer';
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
  $('battery').hidden = layout.kind === 'cinema';
  $('reco-results').replaceChildren();
  $('btn-heatmap').setAttribute('aria-pressed', 'false');
  const fourDX = $('btn-4dx');
  fourDX.hidden = !layout.features.four_dx;
  fourDX.setAttribute('aria-pressed', 'false');

  if (scene) scene.loadVenue(layout);
  state.selector = layout.default_selector;
  if (layout.kind !== 'cinema') picker.open(layout.default_selector.block_id, layout);
  await requestPov('jump');
  syncMedia();
  if (scene) setVeil(false);
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
    }, controller.signal);
    if (controller.signal.aborted) return;
    state.pov = pov;
    applyPov(pov, mode);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  }
}

const requestPovSoon = debounce(() => requestPov('quick'), 45);

function applyPov(pov, mode) {
  if (scene) scene.applyPov(pov, mode);
  map.setSelection(pov);
  picker.sync(pov, state.selector);
  syncTerminology(pov);
  if (state.layout && state.layout.kind !== 'cinema') {
    const rawSeat = String(pov.seat && pov.seat.seat_id || '');
    const activeBlock = (state.selector && state.selector.block_id) || (rawSeat.includes(':') ? rawSeat.split(':')[0] : rawSeat);
    syncVenueTabs(activeBlock);
  }

  const standing = isStandingPov(pov);
  $('hud-seat').textContent = standing ? pov.seat.label : `${pov.seat.label} (Duduk Bernomor)`;
  const spotSel = $('spotlight-selection');
  if (spotSel) {
    spotSel.textContent = `${pov.seat.label} · ${pov.seat.category} · ${formatRupiah(pov.seat.price)}`;
  }
  $('hud-sub').textContent = standing
    ? `Free Standing (Berdiri Bebas) · ${formatRupiah(pov.seat.price)}`
    : `${pov.seat.category} · ${formatRupiah(pov.seat.price)}`;
  $('hud-score-value').textContent = Math.round(pov.score.total);
  $('hud-score-grade').textContent = pov.score.grade;
  $('eye-note').textContent = `Tinggi mata ${fixed(pov.viewer.eye_height_m, 2)} m dari lantai (${pov.viewer.posture_label}).`;
  for (const button of document.querySelectorAll('#lens-buttons [data-lens]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lens === pov.camera.lens.mode));
  }
  updateInsight(pov);
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
function updateInsight(pov) {
  const target = pov.targets[pov.active_target];
  const sound = pov.acoustics;
  const total = pov.score.total;
  const ring = $('score-ring');
  ring.setAttribute('stroke-dashoffset', String(100 - total));       // pathLength lingkaran = 100
  ring.style.stroke = total < 40 ? 'var(--color-destructive)' : total < 55 ? 'var(--color-warning)' : '';
  $('score-value').textContent = fixed(total, 1);
  $('score-grade').textContent = pov.score.grade;

  const parts = Object.fromEntries(pov.score.breakdown.map((item) => [item.key, item.value]));
  parts.screen = parts.fov ?? parts.visibility;                      // bioskop: layar & konser: LED & panggung
  parts.obstruction = pov.clear_view_pct;                            // kepala penonton + struktur panggung
  updateQuickHudMetrics(pov, target, parts);
  for (const row of $('bars').children) {
    const key = row.dataset.key;
    row.querySelector('.bars__fill').style.transform = `scaleX(${parts[key] / 100})`;
    row.querySelector('.bars__num').textContent = key === 'acoustic'
      ? `${Math.round(sound.spl_db)} dB` : Math.round(parts[key]);
  }

  // Konser: baterai memakai angka yang sama dengan bar "Bebas Halangan".
  const free = pov.clear_view_pct >= 85;
  const verdict = free ? 'Bebas Halangan' : 'Terhalang Sebagian';
  $('battery').classList.toggle('is-partial', !free);
  $('battery').setAttribute('aria-label', verdict);
  $('battery-fill').style.transform = `scaleY(${pov.clear_view_pct / 100})`;
  $('battery-label').textContent = verdict;

  const coverage = target.coverage;
  const rows = [
    [`Jarak ke ${target.label}`, `${fixed(target.distance_m, 1)} m`],
    ['Tinggi mata', `${fixed(pov.viewer.eye_height_m, 2)} m`],
    ['Posisi dari tengah', `${fixed(target.off_axis_deg, 1)}°`],
    ['Jeda suara', `${Math.round(sound.delay_ms)} ms`],
    ['Level suara', `${fixed(sound.spl_db, 1)} dB`],
    ['Gaung ruangan', `${fixed(sound.rt60_s, 2)} s`],
    ['Lensa', pov.camera.lens.label],
  ];
  if (coverage) {
    rows.splice(1, 0, ['Ukuran layar di pandangan',
      `${fixed(coverage.horizontal_deg, 1)}° × ${fixed(coverage.vertical_deg, 1)}°`]);
  }
  if (parts.proximity !== undefined) rows.push(['Kedekatan ke panggung', `${Math.round(parts.proximity)} / 100`]);
  $('spec-list').replaceChildren(...rows.flatMap(([term, text]) => [h('dt', { text: term }), h('dd', { text })]));
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

  const seatEl = $('cta-seat');
  if (hasCart) {
    if (summaryLbl) {
      summaryLbl.textContent = `${count} ${standing ? 'Tiket Terpilih' : (state.layout && state.layout.kind === 'concert' ? 'Tiket Terpilih' : 'Kursi Terpilih')}`;
    }
    if (seatEl) {
      const chips = (state.cart.items || []).map((item) => h('span', { class: 'seat-chip', text: item.seat_label }));
      seatEl.replaceChildren(...chips);
    }
    $('cta-price').textContent = formatRupiah(state.cart.subtotal);
  } else {
    if (summaryLbl) summaryLbl.textContent = standing ? 'Posisi Terpilih' : 'Kursi Terpilih';
    if (seatEl) {
      seatEl.textContent = standing
        ? `${pov.seat.label} (Free Standing)`
        : `${pov.seat.label} (Duduk Bernomor)`;
    }
    $('cta-price').textContent = formatRupiah(pov.seat.price);
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
  host.replaceChildren();
  state.preset = layout.presets[0];
  for (const preset of layout.presets) {
    host.append(h('button', {
      class: 'preset', type: 'button', role: 'radio', 'data-key': preset.key,
      'aria-checked': String(preset.key === state.preset.key),
      onclick: () => {
        state.preset = preset;
        syncPreset();
      },
    }, preset.label));
  }
  syncPreset();
}

function syncPreset() {
  for (const button of $('preset-list').children) {
    button.setAttribute('aria-checked', String(button.dataset.key === state.preset.key));
  }
  $('preset-desc').textContent = state.preset.description;
}

async function recommend() {
  const button = $('btn-recommend');
  const label = button.querySelector('span');
  const results = $('reco-results');
  const standingActive = isStandingPov(state.pov);
  button.disabled = true;
  label.textContent = standingActive ? 'Menilai semua posisi…' : 'Menilai semua kursi…';
  try {
    const data = await postJson(boot.api.recommend, {
      venue_id: state.venueId,
      preset: state.preset.key,
      body_height_cm: state.body,
      front_height_cm: state.front,
    });
    map.setRecommendations(data.recommendations);
    results.replaceChildren();
    if (data.note) {
      results.append(h('p', { class: 'reco-note' }, icon('alert'), h('span', { text: data.note })));
    }
    for (const rec of data.recommendations) {
      const recStanding = String(rec.seat_id).startsWith('festival:') || String(rec.seat_id).startsWith('my_universe:');
      results.append(h('article', { class: 'reco-card' },
        h('div', { class: 'reco-card__head' },
          h('span', { class: 'reco-card__rank num', text: String(rec.rank) }),
          h('div', { class: 'reco-card__title' },
            h('strong', { text: rec.label }),
            h('span', { class: 'num', text: `${rec.category} · ${formatRupiah(rec.price)} · ${rec.grade}` })),
          h('span', { class: 'reco-card__score num', text: String(Math.round(rec.score)), title: 'Sightline Score' })),
        h('ul', {}, rec.reasons.map((reason) => h('li', { text: reason }))),
        h('button', {
          class: 'btn', type: 'button',
          onclick: () => selectPosition({ seat_id: rec.seat_id }),
        }, icon('eye'), recStanding ? 'Lihat POV spot ini' : 'Lihat POV kursi ini')));
    }
    if (data.recommendations.length) {
      toast(`${data.evaluated} posisi dinilai, 3 terbaik ditandai di peta.`);
      selectPosition({ seat_id: data.recommendations[0].seat_id });
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    label.textContent = isStandingPov(state.pov) ? 'Cari 3 posisi terbaik' : 'Cari 3 kursi terbaik';
  }
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
    if (state.heatmap) refreshHeatmapSoon();
  });
}

function bindEvents() {
  bindSlider('range-body', 'out-body', 'body');
  bindSlider('range-front', 'out-front', 'front');

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
    const banner = $('cinema-screen-banner');
    const mapWrap = spotlightAnchor.parentElement.querySelector('.map-wrap');
    spotlightBody.replaceChildren(...[legend, banner, mapWrap].filter(Boolean));
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
      spotlightBody.querySelector('#cinema-screen-banner'),
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
  $('btn-recommend').addEventListener('click', recommend);
  $('btn-heatmap').addEventListener('click', (event) => {
    state.heatmap = !state.heatmap;
    event.currentTarget.setAttribute('aria-pressed', String(state.heatmap));
    refreshHeatmap();
  });

  // Pembanding foto.
  const compareBtn = $('btn-compare');
  if (compareBtn) {
    compareBtn.addEventListener('click', () => {
      state.compareOn = !state.compareOn;
      renderCompare();
    });
  }
  for (const button of $('compare-mode').children) {
    button.addEventListener('click', () => {
      state.compareMode = button.dataset.mode;
      for (const other of $('compare-mode').children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      renderCompare();
    });
  }
  $('compare-prev').addEventListener('click', () => stepPhoto(-1));
  $('compare-next').addEventListener('click', () => stepPhoto(1));

  const onTheaterResize = () => {
    if (state.fullscreen && scene) scene.resize(window.innerWidth, window.innerHeight);
  };

  function setTheaterFullscreen(on) {
    const vp = $('viewport');
    const fsHud = $('fullscreen-hud');
    const expandBtn = $('btn-fullscreen');
    if (!vp) return;
    state.fullscreen = Boolean(on);
    vp.classList.toggle('is-fullscreen-theater', state.fullscreen);
    document.body.classList.toggle('is-theater-open', state.fullscreen);
    if (fsHud) fsHud.hidden = !state.fullscreen;
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
    if (event.key === 'Escape' && state.fullscreen) {
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

bindEvents();
loadVenue(boot.venueId).catch(reportFatal);
