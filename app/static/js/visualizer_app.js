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
};

/* -------------------------------------------------------------------------- */
/* Util: API, toast, debounce                                                 */
/* -------------------------------------------------------------------------- */
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
  veil.classList.toggle('is-hidden', !visible);
  veil.classList.toggle('is-error', isError);
  veil.querySelector('.spinner').hidden = isError;
  if (text) $('veil-text').textContent = text;
}

/* -------------------------------------------------------------------------- */
/* Komponen                                                                   */
/* -------------------------------------------------------------------------- */
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

function syncTerminology(pov) {
  const standing = isStandingPov(pov);
  const cinema = state.layout && state.layout.kind === 'cinema';
  const stepperLabel = $('stepper-viz-label');
  if (stepperLabel) stepperLabel.textContent = standing ? 'Pilih Kategori (CAT) & POV 3D' : 'Pilih Kursi & POV 3D';
  $('map-title').textContent = standing ? 'Pilih Kategori / Area' : 'Pilih Kursi';
  $('map-hint').textContent = standing
    ? 'Klik area lapangan atau pilih spot berdiri di bawah.'
    : (cinema ? 'Klik kursi untuk melihat POV-nya.' : 'Klik blok kategori, lalu pilih kursi di panel yang muncul.');
  $('reco-title').textContent = standing ? 'Rekomendasi Posisi Otomatis' : 'Rekomendasi Kursi Otomatis';
  $('reco-hint').textContent = standing
    ? 'Pilih preferensi, lalu 3 posisi terbaik ditandai di peta.'
    : 'Pilih preferensi, lalu 3 kursi terbaik ditandai di peta.';
  const recoBtnLabel = $('btn-recommend').querySelector('span');
  if (recoBtnLabel && !$('btn-recommend').disabled) {
    recoBtnLabel.textContent = standing ? 'Cari 3 posisi terbaik' : 'Cari 3 kursi terbaik';
  }
  $('insight-title').textContent = standing ? 'Spot Insight' : 'Seat Insight';
}

/* -------------------------------------------------------------------------- */
/* Memuat venue                                                               */
/* -------------------------------------------------------------------------- */
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

  $('viz-title').textContent = layout.name;
  $('viz-tagline').textContent = layout.tagline;
  $('viz-eyebrow').textContent = layout.event ? layout.event.title : 'Visualizer';
  syncTerminology(null);
  document.title = `${layout.name} · titiket.com`;
  for (const tab of document.querySelectorAll('.venue-tab')) {
    const active = tab.dataset.venue === venueId;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active) $('viz-grid').setAttribute('aria-labelledby', tab.id);
  }
  if (pushHistory) window.history.pushState({ venueId }, '', venueUrl(boot.urls.studio, venueId) + filmQuery);

  picker.close();
  map.render(layout);
  map.setCart(state.cart.keys);
  renderTargets(layout);
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

/* -------------------------------------------------------------------------- */
/* Meminta & menerapkan POV                                                   */
/* -------------------------------------------------------------------------- */
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

  const standing = isStandingPov(pov);
  $('hud-seat').textContent = standing ? pov.seat.label : `${pov.seat.label} (Duduk Bernomor)`;
  $('hud-sub').textContent = standing
    ? `Free Standing (Berdiri Bebas) · ${formatRupiah(pov.seat.price)}`
    : `${pov.seat.category} · ${formatRupiah(pov.seat.price)}`;
  $('hud-score-value').textContent = Math.round(pov.score.total);
  $('hud-score-grade').textContent = pov.score.grade;
  $('eye-note').textContent = `Tinggi mata ${fixed(pov.viewer.eye_height_m, 2)} m dari lantai (${pov.viewer.posture_label}).`;
  for (const button of $('target-buttons').querySelectorAll('[data-target]')) {
    button.setAttribute('aria-pressed', String(button.dataset.target === pov.active_target));
  }
  for (const button of $('lens-buttons').children) {
    button.setAttribute('aria-pressed', String(button.dataset.lens === pov.camera.lens.mode));
  }
  updateInsight(pov);
  syncCart();
  renderCompare();
}

/** Pilih kursi (bioskop) atau spot/kursi stadion langsung dari peta. */
function selectPosition(selector) {
  if (state.layout.kind !== 'cinema') {
    const blockId = selector.block_id || String(selector.seat_id).split(':')[0];
    if (!picker.block || picker.block.id !== blockId) picker.open(blockId, state.layout);
    if (selector.spot) picker.choice.spot = selector.spot;
  }
  state.selector = selector;
  requestPov('glide');
}

/** Klik blok kategori → buka Sub-Position Picker dan tampilkan posisi bawaannya. */
function openBlock(blockId) {
  const selector = picker.open(blockId, state.layout);
  if (!selector) return;
  state.selector = selector;
  requestPov('glide');
}

/* -------------------------------------------------------------------------- */
/* Tombol target & lensa                                                      */
/* -------------------------------------------------------------------------- */
function renderTargets(layout) {
  const host = $('target-buttons');
  host.replaceChildren();
  for (const target of layout.targets) {
    host.append(h('button', {
      class: 'btn', type: 'button', 'data-target': target.id, 'aria-pressed': 'false',
      onclick: () => {
        state.targetId = target.id;
        if (scene) scene.resetLook();
        requestPov('glide');
      },
    }, icon('target'), target.button_label));
  }
  host.append(h('button', {
    class: 'btn btn--icon', type: 'button', 'aria-label': 'Kembalikan arah pandang',
    title: 'Kembalikan arah pandang', onclick: () => scene && scene.resetLook(),
  }, icon('reset')));
}

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

/* -------------------------------------------------------------------------- */
/* Seat Insight: cincin skor, 5 bar, baterai halangan (konser), spesifikasi   */
/* -------------------------------------------------------------------------- */
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
  parts.screen = parts.fov ?? parts.visibility;                      // bioskop: layar · konser: LED & panggung
  parts.obstruction = pov.clear_view_pct;                            // kepala penonton + struktur panggung
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

/* -------------------------------------------------------------------------- */
/* Keranjang                                                                  */
/* -------------------------------------------------------------------------- */
function syncCart() {
  const pov = state.pov;
  const count = state.cart.count;
  for (const badge of document.querySelectorAll('[data-cart-count]')) {
    badge.textContent = count;
    badge.hidden = count === 0;
  }
  const checkout = $('btn-checkout');
  checkout.setAttribute('aria-disabled', String(count === 0));
  $('checkout-count').textContent = count;
  $('checkout-count').hidden = count === 0;
  map.setCart(state.cart.keys);

  const button = $('btn-cart');
  if (!pov) {
    button.disabled = true;
    return;
  }
  const standing = isStandingPov(pov);
  const inCart = state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
  const sold = pov.seat.status === 'sold';
  $('cta-seat').textContent = standing
    ? `${pov.seat.label} (Free Standing)`
    : `${pov.seat.label} (Duduk Bernomor)`;
  $('cta-price').textContent = formatRupiah(pov.seat.price);
  button.disabled = sold;
  if (standing) {
    $('btn-cart-label').textContent = inCart ? 'Hapus Tiket dari Keranjang' : 'Tambah Tiket ke Keranjang';
    $('btn-checkout-label').textContent = 'Pilih Tiket & Lanjut ke Checkout';
    checkout.setAttribute('aria-disabled', 'false');
  } else {
    $('btn-cart-label').textContent = sold
      ? 'Kursi sudah terjual'
      : inCart ? 'Hapus Kursi dari Keranjang' : 'Tambah Kursi ke Keranjang';
    $('btn-checkout-label').textContent = 'Lanjut ke Checkout';
  }
  // Satu CTA utama: "Tambah" sebelum masuk keranjang, "Checkout" sesudahnya.
  button.classList.toggle('btn--primary', !inCart);
  checkout.classList.toggle('btn--primary', inCart);
}

async function toggleCart() {
  const pov = state.pov;
  if (!pov) return;
  const standing = isStandingPov(pov);
  const button = $('btn-cart');
  const payload = {
    venue_id: state.venueId, seat_id: pov.seat.seat_id,
    body_height_cm: state.body, front_height_cm: state.front, film: boot.film,
  };
  const inCart = state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
  button.disabled = true;
  try {
    const data = await postJson(inCart ? boot.api.cartRemove : boot.api.cart, payload);
    state.cart = data;
    toast(data.message || (standing ? 'Tiket dihapus dari keranjang.' : 'Kursi dihapus dari keranjang.'));
  } catch (error) {
    if (error.data && Array.isArray(error.data.keys)) state.cart = error.data;
    toast(error.message, 'error');
  } finally {
    syncCart();
  }
}

/* -------------------------------------------------------------------------- */
/* Rekomendasi kursi                                                          */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* Heatmap                                                                    */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/* Bandingkan dengan foto asli                                                */
/* -------------------------------------------------------------------------- */
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
  $('btn-compare').setAttribute('aria-pressed', String(state.compareOn));
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

/* -------------------------------------------------------------------------- */
/* Video & audio                                                              */
/* -------------------------------------------------------------------------- */
function setButtonIcon(button, name) {
  button.querySelector('use').setAttribute('href', `#i-${name}`);
}

function syncMedia() {
  if (!scene) {
    $('media-note').textContent = 'Kontrol video nonaktif karena WebGL tidak tersedia.';
    return;
  }
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
  $('media-note').textContent = media.note
    || (media.muted ? `${media.label} · suara masih mati, tekan tombol speaker.` : `${media.label} · suara menyesuaikan posisi ini.`);
}

/* -------------------------------------------------------------------------- */
/* Pengikatan event                                                           */
/* -------------------------------------------------------------------------- */
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
      if (tab.dataset.venue !== state.venueId) loadVenue(tab.dataset.venue, true).catch(reportFatal);
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
  $('btn-checkout').addEventListener('click', async (event) => {
    const pov = state.pov;
    const inCart = Boolean(pov) && state.cart.keys.includes(`${state.venueId}|${pov.seat.seat_id}`);
    if (isStandingPov(pov) && !inCart) {
      // "Pilih Tiket & Lanjut ke Checkout": spot yang sedang dilihat masuk keranjang dulu, baru pindah halaman.
      event.preventDefault();
      try {
        state.cart = await postJson(boot.api.cart, {
          venue_id: state.venueId, seat_id: pov.seat.seat_id,
          body_height_cm: state.body, front_height_cm: state.front, film: boot.film,
        });
        window.location.assign(boot.urls.checkout);      // event.currentTarget sudah null setelah await
      } catch (error) {
        if (error.data && Array.isArray(error.data.keys)) state.cart = error.data;
        syncCart();
        toast(error.message, 'error');
      }
      return;
    }
    if (state.cart.count === 0) {
      event.preventDefault();
      toast('Tambahkan minimal satu kursi ke keranjang dulu.', 'error');
    }
  });
  $('btn-recommend').addEventListener('click', recommend);
  $('btn-heatmap').addEventListener('click', (event) => {
    state.heatmap = !state.heatmap;
    event.currentTarget.setAttribute('aria-pressed', String(state.heatmap));
    refreshHeatmap();
  });

  // Pembanding foto.
  $('btn-compare').addEventListener('click', () => {
    state.compareOn = !state.compareOn;
    renderCompare();
  });
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

  $('btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if ($('viewport').requestFullscreen) $('viewport').requestFullscreen();
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
