/**
 * map_2d_picker.js — Peta 2D interaktif (SVG) + Sub-Position Picker.
 *
 *   Map2DPicker        denah kursi bioskop ATAU peta kategori Stadion GBK
 *   SubPositionPicker  pilih Baris Depan/Tengah/Belakang + Sisi + kursi perwakilan,
 *                      atau 4 spot berdiri untuk Festival / My Universe
 *
 * Modul ini hanya MENGGAMBAR data dari Python (`/api/venues/<id>/layout`) dan
 * melaporkan klik lewat callback. Koordinat SVG = koordinat dunia dalam meter
 * (sumbu x → kanan, sumbu z → bawah), jadi tidak ada rumus geometri di sini.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEAT_STOPS = [[239, 68, 68], [245, 158, 11], [34, 197, 94]];

export const formatRupiah = (amount) => 'Rp ' + Math.round(amount).toLocaleString('id-ID');

export const formatRupiahShort = (amount) => {
  const rounded = Math.round(Number(amount) || 0);
  if (rounded >= 1000 && rounded < 1000000 && rounded % 1000 === 0) {
    return `Rp ${rounded / 1000} rb`;
  }
  return formatRupiah(rounded);
};

/** Buat elemen SVG. */
function svg(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Buat elemen HTML tanpa innerHTML (aman dari injeksi). */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

/** Ikon dari sprite di templates/_icons.html. */
export function icon(name, extraClass = '') {
  const node = svg('svg', { class: `icon ${extraClass}`.trim(), 'aria-hidden': 'true' });
  svg('use', { href: `#i-${name}` }, node);
  return node;
}

function heatColor(t) {
  const scaled = Math.min(1, Math.max(0, t)) * (HEAT_STOPS.length - 1);
  const index = Math.min(HEAT_STOPS.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const rgb = HEAT_STOPS[index].map((v, k) => Math.round(v + (HEAT_STOPS[index + 1][k] - v) * frac));
  return `rgb(${rgb.join(',')})`;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/* ========================================================================== */
/* Peta 2D                                                                    */
/* ========================================================================== */
export class Map2DPicker {
  /**
   * @param {object} options
   * @param {HTMLElement} options.host      wadah SVG
   * @param {HTMLElement} options.legend    wadah legenda
   * @param {HTMLElement} options.tooltip   elemen tooltip (position: fixed)
   * @param {(selector: object) => void} options.onSelect  kursi / spot dipilih
   * @param {(blockId: string) => void} options.onBlock    blok kategori diklik
   */
  constructor({ host, legend, tooltip, onSelect, onBlock }) {
    this.host = host;
    this.legendHost = legend;
    this.tooltip = tooltip;
    this.onSelect = onSelect;
    this.onBlock = onBlock;
    this.layout = null;
    this.root = null;
    this.seatNodes = new Map();
    this.blockNodes = new Map();
    this.spotNodes = new Map();
    this.cartKeys = new Set();
    this.heat = null;
    this.heatRange = null;
    this.selectedSeat = null;
    this.selectedBlock = null;
    this.standingBlock = 'festival';
    this.mobileZoomed = false;
    this.lastTapTs = 0;
    this.friendSeatId = null;
    this.friendLayer = null;
    this.seatLayer = null;
    this.clusterLayer = null;
    this.clusterSeatIds = [];
    this.clusterMidpoint = null;
    this._cinemaScale = 100;
    this._resetBound = false;
    this._scrubActive = false;
    this._scrubTimer = null;
    this._scrubStart = null;
    this._scrubSeat = null;
    this._scrubAffected = [];
    this._suppressClickUntil = 0;
    this._loupeEl = null;
  }

  render(layout) {
    if (this._scrubTimer) {
      window.clearTimeout(this._scrubTimer);
      this._scrubTimer = null;
    }
    this._scrubActive = false;
    this._scrubStart = null;
    this._scrubSeat = null;
    this._clearScrubVisuals();
    this.layout = layout;
    this.seatNodes.clear();
    this.blockNodes.clear();
    this.spotNodes.clear();
    this.heat = null;
    this.heatRange = null;
    this.selectedSeat = null;
    this.selectedBlock = null;
    this.standingBlock = 'festival';
    this.friendSeatId = null;
    this.clusterSeatIds = [];
    this.clusterMidpoint = null;
    this.clusterLayer = null;
    this.resetMobileZoom();
    if (layout.kind === 'cinema') this._renderCinema();
    else this._renderStadium();
    this._bindEvents();
    this._bindZoomReset();
    this.renderLegend();
  }

  /* •••••••••••• Bioskop •••••••••••• */
  _buildScreenArc(screen) {
    if (screen.arc && screen.arc.length >= 2) {
      const pts = screen.arc.map((p) => [p[0], p[2]]);
      return pts[0][0] <= pts[pts.length - 1][0] ? pts : pts.slice().reverse();
    }
    const halfW = (screen.width || 12) / 2;
    const sag = Math.max(0.7, Math.min(1.45, (screen.width || 12) * 0.065));
    const steps = 20;
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const u = -1 + (2 * i) / steps;
      pts.push([u * halfW, sag * u * u]);
    }
    return pts;
  }

  _cinemaScreenLabel(layout, screen) {
    const name = String(layout.name || '').toUpperCase();
    if (screen.arc || name.includes('IMAX')) return 'LAYAR BIOSKOP · IMAX';
    if (name.includes('PREMIERE')) return 'LAYAR BIOSKOP · PREMIERE';
    if (name.includes('4DX')) return 'LAYAR BIOSKOP · 4DX';
    return 'LAYAR BIOSKOP';
  }

  _renderCinema() {
    const L = this.layout;
    const { room, spec, screen } = L;
    const S = this._cinemaScale;
    const halfW = room.width / 2;
    const root = svg('svg', {
      class: 'map-svg map-svg--cinema',
      viewBox: `${((-halfW - 1.4) * S).toFixed(1)} ${(-0.7 * S).toFixed(1)} ${((room.width + 2.8) * S).toFixed(1)} ${((room.depth + 1.4) * S).toFixed(1)}`,
      role: 'group',
      'aria-label': `Denah kursi ${L.name}. Layar berada di sisi atas.`,
    });

    svg('rect', {
      class: 'room',
      x: -halfW * S,
      y: -0.5 * S,
      width: room.width * S,
      height: (room.depth + 0.65) * S,
      rx: 0.4 * S,
    }, root);

    const screenPts = this._buildScreenArc(screen).map(([px, pz]) => [px * S, pz * S]);
    this.screenArcPts = screenPts;
    const labelPts = screenPts.map(([px, pz]) => [px, pz + 0.92 * S]);
    const path = 'M' + screenPts.map(([px, pz]) => `${px.toFixed(1)},${pz.toFixed(1)}`).join(' L');
    const labelPath = 'M' + labelPts.map(([px, pz]) => `${px.toFixed(1)},${pz.toFixed(1)}`).join(' L');
    const defs = svg('defs', {}, root);
    const uid = `screen-arc-${Math.random().toString(36).slice(2, 8)}`;
    svg('path', { id: uid, d: labelPath, fill: 'none' }, defs);

    svg('path', { class: 'screen-glow', d: path }, root);
    svg('path', { class: 'screen-line', d: path }, root);
    const screenText = svg('text', { class: 'screen-label', 'font-size': String(0.46 * S) }, root);
    const textPath = svg('textPath', {
      href: `#${uid}`,
      startOffset: '50%',
      'text-anchor': 'middle',
    }, screenText);
    textPath.textContent = this._cinemaScreenLabel(L, screen);
    this.cone = svg('path', { class: 'sight-cone', d: '' }, root);

    const seatW = spec.seat_pitch * 0.84 * S;
    const seatH = Math.min(spec.row_depth * 0.62, spec.seat_pitch * 0.84 * 1.05) * S;
    const hitW = spec.seat_pitch * S;
    const hitH = spec.row_depth * S;
    this.seatSize = { w: seatW, h: seatH };
    const minX = L.columns[0] * S - seatW / 2;
    const maxX = L.columns[L.columns.length - 1] * S + seatW / 2;
    for (const row of L.rows) {
      for (const x of [minX - 0.75 * S, maxX + 0.75 * S]) {
        svg('text', { class: 'row-label', x, y: row.z * S }, root).textContent = row.letter;
      }
    }
    for (const item of L.furniture || []) {
      svg('circle', { class: 'table-dot', cx: item.x * S, cy: item.z * S, r: 0.2 * S }, root);
    }

    this.clusterLayer = svg('g', { class: 'cluster-highlight-layer' }, root);
    const seatLayer = svg('g', {}, root);
    this.seatGrid = new Map();
    const rowCount = L.rows.length;
    const midRowMin = Math.floor(rowCount * 0.28);
    const midRowMax = Math.ceil(rowCount * 0.72);
    const sweetHalfW = room.width * 0.17;
    for (const seat of L.seats) {
      const sold = seat.status === 'sold';
      const isSweet = !sold && seat.row_index >= midRowMin && seat.row_index <= midRowMax && Math.abs(seat.x) <= sweetHalfW;
      const sx = seat.x * S;
      const sz = seat.z * S;
      const group = svg('g', {
        class: `seat${sold ? ' is-sold' : ''}${isSweet ? ' is-sweet' : ''}`,
        'data-id': seat.id,
        role: 'button',
        tabindex: '-1',
        'aria-label': `Baris ${seat.row} kursi ${seat.number}, ${sold ? 'terjual' : (isSweet ? 'sweet spot tersedia' : 'tersedia')}`,
      }, seatLayer);
      // Hitbox statis 1:1 (skala cm) agar pembesaran visual dan kuantisasi SVG tidak pernah menggeser klik kursor.
      svg('rect', {
        class: 'seat__hit', x: sx - hitW / 2, y: sz - hitH / 2,
        width: hitW, height: hitH, rx: seatW * 0.2,
      }, group);
      const visual = svg('g', { class: 'seat__visual' }, group);
      svg('rect', {
        class: 'seat__shape', x: sx - seatW / 2, y: sz - seatH / 2,
        width: seatW, height: seatH, rx: seatW * 0.22,
      }, visual);
      if (sold) {
        svg('line', {
          class: 'seat__slash', x1: sx - seatW * 0.3, y1: sz + seatH * 0.3,
          x2: sx + seatW * 0.3, y2: sz - seatH * 0.3,
        }, visual);
      }
      svg('text', { class: 'seat__num', x: sx, y: sz, style: `font-size:${(seatW * 0.44).toFixed(1)}px` }, visual)
        .textContent = seat.number;
      this.seatNodes.set(seat.id, { node: group, seat });
      this.seatGrid.set(`${seat.row_index}:${seat.number}`, seat.id);
    }
    const first = this.seatNodes.values().next().value;
    if (first) first.node.setAttribute('tabindex', '0');

    this.seatLayer = seatLayer;
    this.friendLayer = svg('g', { class: 'friend-seat-layer' }, root);
    this.badgeLayer = svg('g', {}, root);
    this.root = root;
    this.host.replaceChildren(root);
  }

  /* •••••••••••• Stadion •••••••••••• */
  _renderStadium() {
    const L = this.layout;
    const { bowl, stage } = L;
    const root = svg('svg', {
      class: 'map-svg map-svg--stadium',
      viewBox: '-124 -152 248 304',
      role: 'group',
      'aria-label': 'Peta kategori Stadion GBK. Panggung utama di sisi atas (Utara).',
    });
    const ring = (points) => 'M' + points.map((p) => `${p[0]},${p[2]}`).join(' L') + ' Z';

    for (const tier of bowl.tiers) {
      svg('path', { class: 'tier-bg', 'fill-rule': 'evenodd', d: `${ring(tier.outer)} ${ring(tier.inner)}` }, root);
    }
    svg('path', { class: 'pitch', d: ring(bowl.field_edge) }, root);
    // Lintasan lari 8 lajur: digambar SETELAH latar lantai dan SEBELUM poligon lapangan/panggung,
    // jadi cincinnya tidak tertutup lantai (bagian dalam ditutup lapangan Festival).
    svg('path', { class: 'running-track', d: ring(bowl.field_edge) }, root);
    for (const k of [0.985, 0.97, 0.955, 0.94, 0.925, 0.91, 0.895, 0.88]) {
      svg('path', { class: 'track-lane', d: ring(bowl.field_edge.map((p) => [p[0] * k, p[1], p[2] * k])) }, root);
    }

    // Area berdiri (Festival & My Universe berbagi lapangan yang sama).
    const festival = L.blocks.find((b) => b.id === 'festival');
    const field = svg('polygon', {
      class: 'block block--field', 'data-id': 'festival', fill: festival.color,
      points: L.field.outline.map((p) => p.join(',')).join(' '),
      role: 'button', tabindex: '0',
      'aria-label': 'Festival dan My Universe, area berdiri di lapangan',
    }, root);
    this.blockNodes.set('festival', field);
    svg('text', { class: 'block-label', x: 0, y: 60, fill: festival.text_color, style: 'font-size:5.4px' }, root)
      .textContent = 'FESTIVAL · MY UNIVERSE';

    // Blok tribun.
    for (const block of L.blocks) {
      if (block.standing) continue;
      const node = svg('polygon', {
        class: 'block', 'data-id': block.id, fill: block.color,
        points: block.outline.map((p) => p.join(',')).join(' '),
        role: 'button', tabindex: '0',
        'aria-label': `${block.label}, ${formatRupiah(block.price)}${block.restricted ? ', restricted view' : ''}`,
      }, root);
      this.blockNodes.set(block.id, node);
      const area = polygonArea(block.outline);
      if (area > 420) {
        const size = Math.min(7, Math.max(3.4, Math.sqrt(area) / 9));
        svg('text', {
          class: 'block-label', x: block.label_pos[0], y: block.label_pos[1],
          fill: block.text_color, style: `font-size:${size.toFixed(1)}px`,
        }, root).textContent = block.label.replace(/\s*\(.*\)$/, '');
      }
    }

    // Panggung, LED, runway, B-Stage, C-Stage.
    const deck = stage.deck;
    svg('rect', { class: 'stage-deck', x: deck.x0, y: deck.z0, width: deck.x1 - deck.x0, height: deck.z1 - deck.z0, rx: 2 }, root);
    svg('text', { class: 'stage-label', x: 0, y: (deck.z0 + deck.z1) / 2 + 3 }, root).textContent = 'PANGGUNG';
    for (const surface of L.targets[0].surfaces) {
      const [cx, , cz] = surface.center;
      const [nx, , nz] = surface.normal;
      const half = surface.width / 2;
      svg('line', {
        class: 'led-line',
        x1: cx - nz * half, y1: cz + nx * half, x2: cx + nz * half, y2: cz - nx * half,
      }, root);
    }
    const runway = stage.runway;
    svg('rect', { class: 'stage-part', x: runway.x0, y: runway.z0, width: runway.x1 - runway.x0, height: runway.z1 - runway.z0 }, root);
    for (const [key, letter] of [['b_stage', 'B'], ['c_stage', 'C']]) {
      const part = stage[key];
      const cx = part.center[0];
      const cz = part.center[2];
      const group = svg('g', {
        class: `landmark landmark--${key}`,
        tabindex: '0',
        role: 'img',
        'aria-label': part.label || `${letter}-Stage`,
        'data-title': part.label || `${letter}-Stage`,
        'data-detail': part.role || '',
      }, root);
      // Cincin barikade penonton di sekeliling B-Stage / C-Stage sesuai tata letak GBK.
      svg('circle', { class: 'stage-pit', cx, cy: cz, r: part.radius + (key === 'b_stage' ? 1.8 : 1.4) }, group);
      svg('circle', { class: `stage-part stage-part--${key}`, cx, cy: cz, r: part.radius }, group);
      svg('text', { class: 'stage-label', x: cx, y: cz, style: 'font-size:4.6px' }, group)
        .textContent = letter;
    }
    for (const occluder of L.occluders) {
      if (occluder.kind !== 'tower' && occluder.kind !== 'platform') continue;
      const cx = (occluder.min[0] + occluder.max[0]) / 2;
      const cz = (occluder.min[2] + occluder.max[2]) / 2;
      const isTower = occluder.kind === 'tower';
      const w = isTower ? 8.2 : 6.4;
      const h = isTower ? 6.2 : 4.8;
      const angle = isTower ? (cx < 0 ? 22 : -22) : 0;
      const group = svg('g', {
        class: `landmark landmark--${occluder.kind}`,
        transform: angle ? `rotate(${angle} ${cx} ${cz})` : '',
        tabindex: '0',
        role: 'img',
        'aria-label': occluder.label,
        'data-title': occluder.label,
        'data-detail': occluder.role || '',
      }, root);
      svg('rect', { class: 'tower', x: cx - w / 2, y: cz - h / 2, width: w, height: h, rx: 0.7 }, group);
      if (isTower) {
        // Silang truss menara delay di atas dek FOH/delay.
        svg('line', { class: 'tower-truss', x1: cx - 1.6, y1: cz - 1.6, x2: cx + 1.6, y2: cz + 1.6 }, group);
        svg('line', { class: 'tower-truss', x1: cx + 1.6, y1: cz - 1.6, x2: cx - 1.6, y2: cz + 1.6 }, group);
      } else {
        // Garis kanopi lengkung tenda FOH.
        svg('line', { class: 'tower-truss', x1: cx - w / 2 + 0.8, y1: cz, x2: cx + w / 2 - 0.8, y2: cz }, group);
      }
      svg('text', { class: 'tower-label', x: cx, y: cz + (isTower ? 0 : 0) }, group)
        .textContent = occluder.short || (isTower ? 'DLY' : 'FOH');
    }

    // Spot berdiri 1–4.
    for (const spot of L.standing_spots) {
      const group = svg('g', {
        class: 'spot', 'data-spot': spot.number, role: 'button', tabindex: '0',
        'aria-label': spot.label,
      }, root);
      svg('circle', { cx: spot.x, cy: spot.z, r: 4.4 }, group);
      svg('text', { x: spot.x, y: spot.z }, group).textContent = spot.number;
      this.spotNodes.set(spot.number, { node: group, spot });
    }

    // Penanda posisi penonton + kerucut pandang.
    this.marker = svg('g', { visibility: 'hidden' }, root);
    this.markerCone = svg('polygon', { class: 'viewer-cone' }, this.marker);
    this.markerLine = svg('line', { class: 'viewer-line' }, this.marker);
    this.markerPulse = svg('circle', { class: 'viewer-pulse', r: 3 }, this.marker);
    this.markerDot = svg('circle', { class: 'viewer-dot', r: 2.2 }, this.marker);

    this.badgeLayer = svg('g', {}, root);
    this.root = root;
    this.host.replaceChildren(root);
  }

  _runNoScroll(fn) {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const scroller = document.getElementById('seat-map-scroll');
    const msx = scroller ? scroller.scrollLeft : 0;
    const msy = scroller ? scroller.scrollTop : 0;
    fn();
    window.scrollTo(sx, sy);
    if (scroller) scroller.scrollTo(msx, msy);
    window.requestAnimationFrame(() => {
      window.scrollTo(sx, sy);
      if (scroller) scroller.scrollTo(msx, msy);
    });
  }

  _isCoarsePointer() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  }

  _isMobileViewport() {
    return this._isCoarsePointer() && window.matchMedia('(max-width: 640px)').matches;
  }

  _bindZoomReset() {
    if (this._resetBound) return;
    const btn = document.getElementById('btn-map-zoom-reset');
    if (!btn) return;
    this._resetBound = true;
    btn.addEventListener('click', () => this.resetMobileZoom());
  }

  zoomToPoint(clientX, clientY) {
    if (!this.root || !this.layout || this.layout.kind !== 'cinema' || !this._isMobileViewport()) return;
    const rect = this.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ox = Math.min(88, Math.max(12, ((clientX - rect.left) / rect.width) * 100));
    const oy = Math.min(90, Math.max(10, ((clientY - rect.top) / rect.height) * 100));
    this.root.style.transformOrigin = `${ox.toFixed(1)}% ${oy.toFixed(1)}%`;
    this.root.style.transform = 'scale(1.92)';
    this.root.classList.add('is-mobile-zoomed');
    this.mobileZoomed = true;
    const btn = document.getElementById('btn-map-zoom-reset');
    if (btn) btn.hidden = false;
  }

  resetMobileZoom() {
    if (this.root) {
      this.root.style.removeProperty('transform-origin');
      this.root.style.removeProperty('transform');
      this.root.classList.remove('is-mobile-zoomed');
    }
    this.mobileZoomed = false;
    const btn = document.getElementById('btn-map-zoom-reset');
    if (btn) btn.hidden = true;
  }

  /* •••••••••••• Mobile Loupe Scrubbing (Hanya Perangkat Sentuh <= 768px) •••••••••••• */
  _isScrubViewport() {
    return this._isCoarsePointer() && window.matchMedia('(max-width: 768px)').matches;
  }

  _ensureLoupeBubble() {
    if (this._loupeEl && document.body.contains(this._loupeEl)) return this._loupeEl;
    let bubble = document.getElementById('seat-loupe-bubble');
    if (!bubble) {
      bubble = h('div', {
        id: 'seat-loupe-bubble',
        class: 'seat-loupe-bubble',
        role: 'status',
        'aria-live': 'polite',
        hidden: true,
      },
      h('span', { class: 'seat-loupe-bubble__dot', 'aria-hidden': 'true' }),
      h('span', { class: 'seat-loupe-bubble__text' }));
      document.body.appendChild(bubble);
    }
    this._loupeEl = bubble;
    return bubble;
  }

  _findNearestSeatAtClient(clientX, clientY) {
    if (!this.root || !this.layout || this.layout.kind !== 'cinema') return null;
    const { seats, spec } = this.layout;
    if (!Array.isArray(seats) || !seats.length) return null;

    const ctm = typeof this.root.getScreenCTM === 'function' ? this.root.getScreenCTM() : null;
    if (ctm && typeof this.root.createSVGPoint === 'function') {
      try {
        const pt = this.root.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const local = pt.matrixTransform(ctm.inverse());
        const S = this._cinemaScale;
        const lx = local.x / S;
        const ly = local.y / S;
        const maxDist = Math.max(spec.seat_pitch || 0.65, spec.row_depth || 0.9) * 1.45;
        let best = null;
        let bestDist = maxDist;
        for (const seat of seats) {
          const d = Math.hypot(seat.x - lx, seat.z - ly);
          if (d < bestDist) {
            bestDist = d;
            best = seat;
          }
        }
        if (best) return best;
      } catch {
        // Fallback elementFromPoint di bawah.
      }
    }

    const hitEl = document.elementFromPoint(clientX, clientY);
    const seatGroup = hitEl && hitEl.closest ? hitEl.closest('.seat') : null;
    if (seatGroup && seatGroup.dataset.id) {
      const entry = this.seatNodes.get(seatGroup.dataset.id);
      if (entry) return entry.seat;
    }
    return null;
  }

  _clearScrubVisuals() {
    if (Array.isArray(this._scrubAffected)) {
      for (const node of this._scrubAffected) {
        node.classList.remove('is-loupe-focus', 'is-loupe-near');
      }
      this._scrubAffected = [];
    }
    if (this.root) this.root.classList.remove('is-scrubbing');
    const loupe = this._loupeEl || document.getElementById('seat-loupe-bubble');
    if (loupe) loupe.hidden = true;
  }

  _updateScrubAt(clientX, clientY) {
    const loupe = this._ensureLoupeBubble();
    const target = this._findNearestSeatAtClient(clientX, clientY);

    for (const node of this._scrubAffected) {
      node.classList.remove('is-loupe-focus', 'is-loupe-near');
    }
    this._scrubAffected = [];

    const clampedX = Math.min(window.innerWidth - 20, Math.max(20, clientX));
    const clampedY = Math.max(44, clientY - 50);
    loupe.style.left = `${clampedX.toFixed(1)}px`;
    loupe.style.top = `${clampedY.toFixed(1)}px`;

    if (!target) {
      this._scrubSeat = null;
      loupe.hidden = true;
      return;
    }

    this._scrubSeat = target;
    const focusEntry = this.seatNodes.get(target.id);
    if (focusEntry) {
      focusEntry.node.classList.add('is-loupe-focus');
      if (this.seatLayer && focusEntry.node.parentNode === this.seatLayer) {
        this.seatLayer.appendChild(focusEntry.node);
      }
      this._scrubAffected.push(focusEntry.node);
    }

    for (const seat of this.layout.seats) {
      if (seat.id === target.id) continue;
      if (Math.abs(seat.row_index - target.row_index) <= 1 && Math.abs(seat.number - target.number) <= 1) {
        const entry = this.seatNodes.get(seat.id);
        if (entry) {
          entry.node.classList.add('is-loupe-near');
          this._scrubAffected.push(entry.node);
        }
      }
    }

    const available = target.status !== 'sold' && target.id !== this.friendSeatId;
    loupe.classList.toggle('is-sold', !available);
    loupe.classList.toggle('is-available', available);
    const labelNode = loupe.querySelector('.seat-loupe-bubble__text');
    if (labelNode) {
      labelNode.textContent = `Baris ${target.row} · Kursi ${target.number} - ${available ? 'Tersedia' : 'Terisi'}`;
    }
    loupe.hidden = false;
  }

  _startScrubbing(clientX, clientY) {
    if (!this.root || !this.layout || this.layout.kind !== 'cinema') return;
    this._scrubActive = true;
    this.root.classList.add('is-scrubbing');
    this._hideTooltip();
    this._updateScrubAt(clientX, clientY);
  }

  _bindScrubEvents(root) {
    if (!this.layout || this.layout.kind !== 'cinema' || !this._isCoarsePointer()) return;

    root.addEventListener('touchstart', (event) => {
      if (!this._isScrubViewport() || event.touches.length !== 1) return;
      const touch = event.touches[0];
      this._scrubStart = { x: touch.clientX, y: touch.clientY };
      if (this._scrubTimer) window.clearTimeout(this._scrubTimer);
      this._scrubTimer = window.setTimeout(() => {
        this._scrubTimer = null;
        if (this._scrubStart) {
          this._startScrubbing(this._scrubStart.x, this._scrubStart.y);
        }
      }, 105);
    }, { passive: true });

    root.addEventListener('touchmove', (event) => {
      if (!this._isScrubViewport() || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!this._scrubActive && this._scrubStart) {
        const moved = Math.hypot(touch.clientX - this._scrubStart.x, touch.clientY - this._scrubStart.y);
        if (moved > 6) {
          if (this._scrubTimer) {
            window.clearTimeout(this._scrubTimer);
            this._scrubTimer = null;
          }
          this._startScrubbing(touch.clientX, touch.clientY);
        }
      }
      if (this._scrubActive) {
        event.preventDefault();
        this._updateScrubAt(touch.clientX, touch.clientY);
      }
    }, { passive: false });

    const finishScrub = (event) => {
      if (this._scrubTimer) {
        window.clearTimeout(this._scrubTimer);
        this._scrubTimer = null;
      }
      if (!this._scrubActive) {
        this._scrubStart = null;
        return;
      }
      const committed = event.type === 'touchend' ? this._scrubSeat : null;
      this._scrubActive = false;
      this._scrubStart = null;
      this._scrubSeat = null;
      this._suppressClickUntil = Date.now() + 350;
      this._clearScrubVisuals();
      if (committed && committed.status !== 'sold' && committed.id !== this.friendSeatId) {
        this._runNoScroll(() => this.onSelect({ seat_id: committed.id }));
      }
    };

    root.addEventListener('touchend', finishScrub, { passive: true });
    root.addEventListener('touchcancel', finishScrub, { passive: true });
  }

  /* •••••••••••• Interaksi •••••••••••• */
  _bindEvents() {
    const root = this.root;
    const pick = (event) => event.target.closest('.seat, .block, .spot, .landmark');
    this._bindScrubEvents(root);
    this._pointerDown = false;
    this._lastRaisedSeat = null;

    root.addEventListener('pointerdown', (event) => {
      this._pointerDown = true;
      if (pick(event)) event.preventDefault();
    });
    const releasePointer = () => { this._pointerDown = false; };
    root.addEventListener('pointerup', releasePointer);
    root.addEventListener('pointercancel', releasePointer);

    root.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'touch' || this._pointerDown) return;
      const seatNode = event.target.closest('.seat:not(.is-sold)');
      if (seatNode && this.seatLayer && seatNode !== this._lastRaisedSeat && seatNode.parentNode === this.seatLayer) {
        this._lastRaisedSeat = seatNode;
        this.seatLayer.appendChild(seatNode);
      }
    });

    root.addEventListener('click', (event) => {
      if (Date.now() < this._suppressClickUntil) return;
      const node = pick(event);
      const isMobileCinema = this.layout && this.layout.kind === 'cinema' && this._isMobileViewport();
      if (isMobileCinema) {
        const now = Date.now();
        const isDoubleTap = (now - this.lastTapTs) < 320;
        this.lastTapTs = now;

        if (isDoubleTap && !node) {
          if (this.mobileZoomed) this.resetMobileZoom();
          else this.zoomToPoint(event.clientX, event.clientY);
          return;
        }

        if (!this.mobileZoomed) {
          this.zoomToPoint(event.clientX, event.clientY);
          if (!node || node.classList.contains('landmark')) return;
        }
      }

      if (node && !node.classList.contains('landmark')) {
        this._runNoScroll(() => this._activate(node));
      }
    });
    root.addEventListener('keydown', (event) => {
      const node = pick(event);
      if (!node) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this._activate(node);
      } else if (node.classList.contains('seat') && event.key.startsWith('Arrow')) {
        event.preventDefault();
        this._moveSeatFocus(node.dataset.id, event.key);
      }
    });
    root.addEventListener('pointermove', (event) => {
      const node = pick(event);
      if (node) this._showTooltip(node, event.clientX, event.clientY);
      else this._hideTooltip();
    });
    root.addEventListener('pointerleave', () => this._hideTooltip());
    root.addEventListener('focusin', (event) => {
      const node = pick(event);
      if (!node) return;
      const box = node.getBoundingClientRect();
      this._showTooltip(node, box.left + box.width / 2, box.top);
    });
    root.addEventListener('focusout', () => this._hideTooltip());
  }

  _activate(node) {
    if (node.classList.contains('seat')) {
      this.onSelect({ seat_id: node.dataset.id });
    } else if (node.classList.contains('spot')) {
      this.onSelect({ block_id: this.standingBlock, spot: Number(node.dataset.spot) });
    } else {
      this.onBlock(node.dataset.id === 'festival' ? this.standingBlock : node.dataset.id);
    }
  }

  _moveSeatFocus(seatId, key) {
    const { seat } = this.seatNodes.get(seatId);
    const delta = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[key];
    const nextId = this.seatGrid.get(`${seat.row_index + delta[0]}:${seat.number + delta[1]}`);
    if (nextId) this.seatNodes.get(nextId).node.focus({ preventScroll: true });
  }

  _showTooltip(node, clientX, clientY) {
    const tip = this.tooltip;
    let title = '';
    let detail = '';
    if (node.classList.contains('seat')) {
      const { seat } = this.seatNodes.get(node.dataset.id);
      const isFriend = seat.id === this.friendSeatId;
      title = isFriend ? `Baris ${seat.row} · Kursi ${seat.number} (Kursi Teman Anda)` : `Baris ${seat.row} · Kursi ${seat.number}`;
      detail = `${isFriend ? 'Kursi Teman Anda' : (seat.status === 'sold' ? 'Terisi' : 'Tersedia')} · ${formatRupiahShort(this.layout.price)}`;
      const score = this.heat && this.heat.get(seat.id);
      if (score !== undefined && score !== null) detail += ` · skor ${score}`;
    } else if (node.classList.contains('spot')) {
      const { spot } = this.spotNodes.get(Number(node.dataset.spot));
      title = spot.label;
      detail = spot.description;
    } else if (node.classList.contains('landmark')) {
      title = node.dataset.title || '';
      detail = node.dataset.detail || '';
    } else {
      const id = node.dataset.id;
      const block = this.layout.blocks.find((b) => b.id === id);
      if (id === 'festival') {
        const universe = this.layout.blocks.find((b) => b.id === 'my_universe');
        title = 'Festival · My Universe';
        detail = `Free Standing (Berdiri Bebas) · ${formatRupiah(block.price)} / ${formatRupiah(universe.price)}`;
      } else {
        title = block.label;
        detail = `${formatRupiah(block.price)} · ${block.description}`;
      }
    }
    tip.replaceChildren(h('strong', { text: title }), h('span', { text: detail }));
    tip.hidden = false;
    const box = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - box.width - 8, Math.max(8, clientX + 14));
    const y = clientY - box.height - 12 < 8 ? clientY + 18 : clientY - box.height - 12;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  _hideTooltip() {
    this.tooltip.hidden = true;
  }

  /* •••••••••••• State dari luar •••••••••••• */
  /** Sorot kursi/blok aktif dan gambar garis pandang memakai angka dari Python. */
  setSelection(pov) {
    if (!this.layout || !this.root) return;
    if (this.layout.kind === 'cinema') {
      const previous = this.seatNodes.get(this.selectedSeat);
      if (previous) {
        previous.node.classList.remove('is-selected');
        previous.node.setAttribute('tabindex', '-1');
      }
      const current = this.seatNodes.get(pov.seat.seat_id);
      if (!current) return;
      for (const entry of this.seatNodes.values()) entry.node.setAttribute('tabindex', '-1');
      current.node.classList.add('is-selected');
      current.node.setAttribute('tabindex', '0');
      this.selectedSeat = pov.seat.seat_id;
      const inCluster = this.clusterSeatIds.length >= 2 && this.clusterSeatIds.includes(pov.seat.seat_id) && this.clusterMidpoint;
      if (!inCluster && this.clusterSeatIds.length) {
        this.setCluster([], null);
      }
      const [x, , z] = inCluster
        ? [this.clusterMidpoint.x, 0, this.clusterMidpoint.z]
        : pov.seat.floor;
      const sx = x * this._cinemaScale;
      const sz = z * this._cinemaScale;
      const pts = this.screenArcPts || [];
      if (pts.length >= 2) {
        const arcSegs = pts.map(([ax, az]) => `L${ax.toFixed(1)},${az.toFixed(1)}`).join(' ');
        this.cone.setAttribute('d', `M${sx.toFixed(1)},${sz.toFixed(1)} ${arcSegs} Z`);
      }
      return;
    }

    const frame = pov.seat_frame;
    const block = this.layout.blocks.find((b) => b.id === frame.block_id);
    const standing = Boolean(block && block.standing);
    if (standing) this.standingBlock = block.id;
    this.selectedBlock = frame.block_id;
    const activeKey = standing ? 'festival' : frame.block_id;
    for (const [id, node] of this.blockNodes) node.classList.toggle('is-selected', id === activeKey);
    for (const [number, entry] of this.spotNodes) {
      entry.node.classList.toggle('is-selected', standing && number === frame.spot);
    }
    this.root.classList.add('has-selection');

    const [x, , z] = pov.seat.floor;
    const yaw = pov.camera.yaw_rad;
    const half = (pov.camera.horizontal_fov_deg * Math.PI) / 360;
    const reach = 70;
    const tip = (angle) => `${x - Math.sin(angle) * reach},${z - Math.cos(angle) * reach}`;
    this.markerCone.setAttribute('points', `${x},${z} ${tip(yaw + half)} ${tip(yaw - half)}`);
    const lookAt = pov.camera.look_at;
    for (const [key, value] of Object.entries({ x1: x, y1: z, x2: lookAt[0], y2: lookAt[2] })) {
      this.markerLine.setAttribute(key, value);
    }
    for (const dot of [this.markerDot, this.markerPulse]) {
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', z);
    }
    this.marker.setAttribute('visibility', 'visible');
    this._syncCategoryButtons();
  }

  /** Sorot beberapa kursi berdampingan secara serentak di peta 2D + kapsul titik tengah. */
  setCluster(seatIds = [], midpoint = null) {
    this.clusterSeatIds = Array.isArray(seatIds) ? [...seatIds] : [];
    this.clusterMidpoint = midpoint || null;
    for (const { node } of this.seatNodes.values()) {
      node.classList.remove('is-cluster');
    }
    if (this.clusterLayer) this.clusterLayer.replaceChildren();
    if (!this.layout || this.layout.kind !== 'cinema' || this.clusterSeatIds.length < 2) return;

    const clusterEntries = this.clusterSeatIds
      .map((id) => this.seatNodes.get(id))
      .filter(Boolean);
    if (!clusterEntries.length) return;

    for (const entry of clusterEntries) {
      entry.node.classList.add('is-cluster');
    }

    const S = this._cinemaScale;
    const xs = clusterEntries.map((e) => e.seat.x * S);
    const zs = clusterEntries.map((e) => e.seat.z * S);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const z = zs.reduce((acc, v) => acc + v, 0) / zs.length;
    const midX = midpoint && Number.isFinite(Number(midpoint.x)) ? Number(midpoint.x) * S : (minX + maxX) / 2;
    const midZ = midpoint && Number.isFinite(Number(midpoint.z)) ? Number(midpoint.z) * S : z;
    const seatW = (this.seatSize && this.seatSize.w) || 0.48 * S;
    const seatH = (this.seatSize && this.seatSize.h) || 0.48 * S;

    if (this.clusterLayer) {
      svg('rect', {
        class: 'cluster-capsule',
        x: (minX - seatW * 0.64).toFixed(1),
        y: (z - seatH * 0.68).toFixed(1),
        width: ((maxX - minX) + seatW * 1.28).toFixed(1),
        height: (seatH * 1.36).toFixed(1),
        rx: (seatH * 0.5).toFixed(1),
      }, this.clusterLayer);
      svg('circle', {
        class: 'cluster-midpoint',
        cx: midX.toFixed(1),
        cy: midZ.toFixed(1),
        r: (seatW * 0.18).toFixed(1),
      }, this.clusterLayer);
    }

    const pts = this.screenArcPts || [];
    if (this.cone && pts.length >= 2) {
      const arcSegs = pts.map(([ax, az]) => `L${ax.toFixed(1)},${az.toFixed(1)}`).join(' ');
      this.cone.setAttribute('d', `M${midX.toFixed(1)},${midZ.toFixed(1)} ${arcSegs} Z`);
    }
  }

  setCart(keys) {
    this.cartKeys = new Set(keys);
    if (!this.layout || this.layout.kind !== 'cinema') return;
    for (const [id, entry] of this.seatNodes) {
      entry.node.classList.toggle('is-cart', this.cartKeys.has(`${this.layout.venue_id}|${id}`));
    }
  }

  /** Tandai kursi/blok milik teman sebagai terisi dengan badge "Kursi Teman Anda". */
  setFriendSeat(seatId) {
    this.friendSeatId = seatId || null;
    for (const { node, seat } of this.seatNodes.values()) {
      node.classList.remove('is-friend-seat');
      if (seat.status !== 'sold') {
        node.setAttribute('aria-label', `Baris ${seat.row} kursi ${seat.number}, tersedia`);
      }
    }
    for (const node of this.blockNodes.values()) node.classList.remove('is-friend-seat');
    if (this.friendLayer) this.friendLayer.replaceChildren();
    if (!seatId || !this.layout) return;

    if (this.layout.kind === 'cinema') {
      const entry = this.seatNodes.get(seatId);
      if (!entry || !this.friendLayer) return;
      const S = this._cinemaScale;
      const { node, seat } = entry;
      node.classList.add('is-friend-seat', 'is-sold');
      node.setAttribute('aria-label', `Baris ${seat.row} kursi ${seat.number}, Kursi Teman Anda`);
      const seatW = (this.seatSize && this.seatSize.w) || 0.48 * S;
      const seatH = (this.seatSize && this.seatSize.h) || 0.48 * S;
      const badgeW = Math.max(seatW * 3.4, 2.35 * S);
      const badgeH = Math.max(seatH * 0.72, 0.36 * S);
      const bx = seat.x * S;
      const by = seat.z * S - seatH * 0.96;
      const pill = svg('g', { class: 'friend-badge' }, this.friendLayer);
      svg('rect', {
        class: 'friend-badge-bg',
        x: bx - badgeW / 2,
        y: by - badgeH / 2,
        width: badgeW,
        height: badgeH,
        rx: badgeH / 2,
      }, pill);
      svg('text', {
        class: 'friend-badge-text',
        x: bx,
        y: by,
        style: `font-size:${(badgeH * 0.46).toFixed(1)}px`,
      }, pill).textContent = 'Kursi Teman Anda';
      return;
    }

    const prefix = String(seatId).includes(':') ? String(seatId).split(':')[0] : String(seatId);
    const blockKey = prefix === 'my_universe' ? 'festival' : prefix;
    const blockNode = this.blockNodes.get(blockKey);
    if (blockNode) blockNode.classList.add('is-friend-seat');
  }

  /** Tandai 3 rekomendasi (peringkat 1–3) di peta. */
  setRecommendations(list) {
    if (!this.badgeLayer) return;
    this.badgeLayer.replaceChildren();
    const cinema = this.layout.kind === 'cinema';
    const S = cinema ? this._cinemaScale : 1;
    for (const rec of list) {
      const [rawX, , rawZ] = rec.floor;
      const x = rawX * S;
      const z = rawZ * S;
      const radius = cinema ? this.seatSize.w * 0.5 : 5.2;
      const cy = cinema ? z - this.seatSize.h * 0.95 : z;
      const badge = svg('g', { class: 'reco-badge' }, this.badgeLayer);
      svg('circle', { cx: x, cy, r: radius, 'stroke-width': cinema ? 4 : 0.6 }, badge);
      svg('text', { x, y: cy, style: `font-size:${(radius * 1.25).toFixed(2)}px` }, badge).textContent = rec.rank;
    }
  }

  /** Warnai kursi/blok menurut skor Python. `null` mematikan heatmap. */
  setHeatmap(data) {
    if (!this.layout) return;
    const cinema = this.layout.kind === 'cinema';
    const clearFill = (node) => node.style.removeProperty('fill');
    if (!data) {
      this.heat = null;
      this.heatRange = null;
      if (cinema) {
        for (const entry of this.seatNodes.values()) {
          const shape = entry.node.querySelector('.seat__shape');
          if (shape) clearFill(shape);
        }
      } else for (const node of this.blockNodes.values()) clearFill(node);
      this.renderLegend();
      return;
    }
    const span = Math.max(1e-6, data.max - data.min);
    this.heatRange = [data.min, data.max];
    this.heat = new Map();
    if (cinema) {
      for (const cell of data.cells) {
        this.heat.set(cell.seat_id, cell.score);
        const entry = this.seatNodes.get(cell.seat_id);
        const shape = entry && entry.node.querySelector('.seat__shape');
        if (shape) shape.style.fill = heatColor((cell.score - data.min) / span);
      }
    } else {
      const best = new Map();
      for (const cell of data.cells) {
        const key = cell.group === 'my_universe' ? 'festival' : cell.group;
        best.set(key, Math.max(best.get(key) ?? -Infinity, cell.score));
      }
      for (const [id, score] of best) {
        this.heat.set(id, score);
        const node = this.blockNodes.get(id);
        if (node) node.style.fill = heatColor((score - data.min) / span);
      }
    }
    this.renderLegend();
  }

  flashCollision(seatId) {
    if (!seatId || !this.root) return;
    let target = null;
    if (this.seatNodes.has(seatId)) {
      target = this.seatNodes.get(seatId).node;
    } else if (String(seatId).includes(':')) {
      const [blockId, spotKey] = String(seatId).split(':');
      const spotNum = spotKey && spotKey.replace('spot', '');
      target = this.root.querySelector(`.spot[data-spot="${spotNum}"]`) || this.blockNodes.get(blockId) || null;
    }
    if (!target) return;
    target.classList.remove('is-collision');
    void target.getBoundingClientRect();
    target.classList.add('is-collision');
    window.setTimeout(() => target.classList.remove('is-collision'), 1900);
  }

  /* •••••••••••• Legenda •••••••••••• */
  renderLegend() {
    const host = this.legendHost;
    const L = this.layout;
    host.replaceChildren();
    if (this.heatRange) {
      host.append(h('div', { class: 'legend-heat' },
        h('span', { class: 'num', text: `Skor ${this.heatRange[0]}` }),
        h('span', { class: 'legend-heat__bar', role: 'img', 'aria-label': 'Merah = skor rendah, hijau = skor tinggi' }),
        h('span', { class: 'num', text: `${this.heatRange[1]}` })));
    }
    if (L.kind === 'cinema') {
      const swatch = (cls, label) => h('span', { class: 'legend-item' },
        h('span', { class: `legend-swatch ${cls}` }), label);
      host.append(
        swatch('legend-swatch--avail', 'Tersedia'),
        swatch('legend-swatch--cart', 'Terpilih'),
        swatch('legend-swatch--taken', 'Terisi'),
        swatch('legend-swatch--sweet', 'Rekomendasi POV'),
        swatch('legend-swatch--chosen', 'Pratinjau 3D'),
        h('span', { class: 'legend-note', text:
          `Semua kursi ${formatRupiahShort(L.price)}. Baris A = paling belakang (konvensi XXI), layar di sisi atas peta.` }),
      );
      return;
    }

    // Stadion: satu tombol per kategori tiket, seperti legenda peta resmi.
    const groups = new Map();
    for (const block of L.blocks) {
      if (!groups.has(block.category)) groups.set(block.category, block);
    }
    const list = h('ul', { class: 'category-list' });
    for (const [category, block] of groups) {
      const tags = [block.standing ? 'Free Standing' : 'Duduk Bernomor'];
      if (block.restricted) tags.push('restricted view');
      list.append(h('li', {},
        h('button', {
          class: 'category-btn', type: 'button', 'data-category': category, 'aria-pressed': 'false',
          onclick: () => this._runNoScroll(() => this.onBlock(block.id)),
        },
        h('span', { class: 'legend-swatch', style: `background:${block.color}` }),
        h('span', { class: 'category-btn__content' },
          h('span', { class: 'category-btn__name', text: category }),
          h('span', { class: 'category-btn__price num', text: formatRupiah(block.price) }),
          h('span', { class: 'category-btn__type', text: tags.join(' · ') })))));
    }
    host.append(list, h('p', {
      class: 'legend-note',
      text: 'B: B-Stage (ujung runway) · C: C-Stage (panggung akustik) · DLY: Menara Delay · FOH: Kontrol Suara & Lampu.',
    }));
    this._syncCategoryButtons();
  }

  _syncCategoryButtons() {
    if (!this.layout || this.layout.kind === 'cinema') return;
    const block = this.layout.blocks.find((b) => b.id === this.selectedBlock);
    for (const button of this.legendHost.querySelectorAll('.category-btn')) {
      button.setAttribute('aria-pressed', String(Boolean(block) && button.dataset.category === block.category));
    }
  }
}

/* ========================================================================== */
/* Sub-Position Picker                                                        */
/* ========================================================================== */
export class SubPositionPicker {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {(selector: object) => void} options.onSelect
   */
  constructor({ root, onSelect }) {
    this.root = root;
    this.onSelect = onSelect;
    this.layout = null;
    this.block = null;
    this.choice = { band: 'tengah', side: 'tengah', spot: 3 };
    this.clusterSeatIds = [];
  }

  get isOpen() {
    return !this.root.hidden;
  }

  setClusterSeats(seatIds = []) {
    this.clusterSeatIds = Array.isArray(seatIds) ? [...seatIds] : [];
    if (!this.gridHost) return;
    const set = new Set(this.clusterSeatIds);
    for (const btn of this.gridHost.querySelectorAll('.mini-seat')) {
      btn.classList.toggle('is-cluster', set.has(btn.dataset.seat));
    }
  }

  close() {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.block = null;
    this.current = null;
  }

  /** Buka picker untuk satu blok. Mengembalikan selector bawaan blok tersebut. */
  open(blockId, layout) {
    this.layout = layout;
    const block = layout.blocks.find((b) => b.id === blockId);
    if (!block) return null;
    this.block = block;
    this.root.replaceChildren(h('div', { class: 'picker__grabber', 'aria-hidden': 'true' }), this._header(block), ...(block.standing ? this._standing(block) : this._seated(block)));
    this.root.hidden = false;
    return this.currentSelector();
  }

  currentSelector() {
    if (!this.block) return null;
    return this.block.standing
      ? { block_id: this.block.id, spot: this.choice.spot }
      : { block_id: this.block.id, band: this.choice.band, side: this.choice.side };
  }

  _header(block) {
    const chips = [h('span', { class: 'chip chip--accent num', text: formatRupiah(block.price) })];
    if (block.restricted) chips.push(h('span', { class: 'chip chip--warning' }, icon('alert', 'icon--sm'), 'Restricted view'));
    chips.push(h('span', { class: 'chip', text: block.standing ? 'Free Standing (Berdiri Bebas)' : 'Duduk Bernomor' }));
    return h('header', { class: 'panel__head' },
      h('div', {},
        h('div', { class: 'picker__title' },
          h('span', { class: 'picker__swatch', style: `background:${block.color}` }),
          h('h2', { id: 'picker-title', text: block.standing ? `${block.label} — Pilih Spot Berdiri` : block.label }),
          ...chips),
        block.standing ? h('p', { class: 'panel__hint', text: block.description }) : null),
      h('button', {
        class: 'btn btn--icon btn--ghost', type: 'button', 'aria-label': 'Tutup pemilih posisi',
        onclick: () => this.close(),
      }, icon('x')));
  }

  _segmented(label, items, activeKey, onPick) {
    const group = h('div', { class: 'segmented', role: 'group', 'aria-label': label });
    for (const item of items) {
      group.append(h('button', {
        class: 'segmented__btn', type: 'button', 'data-key': item.key,
        'aria-pressed': String(item.key === activeKey),
        onclick: () => onPick(item.key),
      }, item.label, item.note ? h('small', { class: 'num', text: item.note }) : null));
    }
    return group;
  }

  _seated(block) {
    const pick = (patch) => {
      Object.assign(this.choice, patch);
      this.onSelect(this.currentSelector());
    };
    const rowSeats = block.row_seats;                    // jumlah kursi per baris (indeks 0 = baris 1)
    const searchError = h('p', { class: 'picker__search-error', hidden: true });
    const field = (iconName, label, attrs) => {
      const input = h('input', { type: 'number', inputmode: 'numeric', min: 1, step: 1, class: 'picker__search-input num', ...attrs });
      return [input, h('label', { class: 'picker__field' }, icon(iconName, 'icon--sm'), h('span', { text: label }), input)];
    };
    const [rowInput, rowField] = field('ticket', 'Baris', { max: rowSeats.length, placeholder: '14', 'aria-label': 'Nomor baris' });
    const [seatInput, seatField] = field('seat', 'Nomor Kursi', { max: Math.max(...rowSeats), placeholder: '49', 'aria-label': 'Nomor kursi' });
    this.rowInput = rowInput;
    this.seatInput = seatInput;

    // Kursi di baris baru yang paling dekat secara sudut (bearing) = kursi tepat di depan/belakang kursi lama.
    const snapSeat = (fromRow, fromSeat, toRow) => {
      const fromCount = rowSeats[fromRow - 1], toCount = rowSeats[toRow - 1];
      return Math.min(toCount, Math.max(1, Math.round(((fromSeat - 0.5) / fromCount) * toCount + 0.5)));
    };
    const apply = (rowChanged) => {
      const row = Math.round(Number(rowInput.value)), prev = this.current;
      if (!rowInput.value || row < 1 || row > rowSeats.length) {
        searchError.textContent = `Baris tersedia: 1–${rowSeats.length}.`;
        searchError.hidden = false;
        return;
      }
      let seat = Math.round(Number(seatInput.value));
      if (rowChanged || !seatInput.value) {
        seat = prev ? snapSeat(prev.row, prev.seat, row) : Math.ceil(rowSeats[row - 1] / 2);
        seatInput.value = String(seat);
      }
      if (seat < 1 || seat > rowSeats[row - 1]) {
        searchError.textContent = `Baris ${row} punya kursi 1–${rowSeats[row - 1]}.`;
        searchError.hidden = false;
        return;
      }
      searchError.hidden = true;
      seatInput.max = String(rowSeats[row - 1]);
      this.current = { row, seat };
      this.onSelect({ block_id: block.id, row, seat });
    };
    rowInput.addEventListener('change', () => apply(true));
    seatInput.addEventListener('change', () => apply(false));
    const searchForm = h('form', {
      class: 'picker__search-form',
      onsubmit: (event) => { event.preventDefault(); apply(String(this.current && this.current.row) !== rowInput.value); },
    }, rowField, seatField, h('button', { type: 'submit', hidden: true }));

    this.bandGroup = this._segmented('Posisi baris',
      block.bands.map((b) => ({
        key: b.key,
        label: `${b.label.replace(/^Baris\s+/, '')} (${b.row})`,   // kanvas 08A/B: Depan (1) · Tengah (14) · Belakang (27)
      })),
      this.choice.band, (band) => pick({ band }));
    this.sideGroup = this._segmented('Sisi blok',
      block.sides.map((s) => ({ key: s.key, label: s.label })),
      this.choice.side, (side) => pick({ side }));

    const cols = Math.max(...block.mini_grid.map((row) => row.length));
    this.gridHost = h('div', { class: 'mini-grid', style: `--cols:${cols}` });
    this.activeRow = null;
    for (const row of block.mini_grid) {
      const rowNo = row[0].row;
      const line = h('div', { class: 'mini-grid__row', 'data-row': String(rowNo) },
        h('button', {
          class: 'mini-grid__label num', type: 'button', 'aria-pressed': 'false',
          'aria-label': `Pilih baris ${rowNo}`, text: `Baris ${rowNo}`,
          onclick: () => this._pickRow(rowNo),
        }));
      for (const cell of row) {
        line.append(h('button', {
          class: 'mini-seat num', type: 'button', 'data-seat': cell.seat_id, 'aria-pressed': 'false',
          'aria-label': `Baris ${cell.row} kursi ${cell.seat}`, disabled: true,
          onclick: () => this.onSelect({ seat_id: cell.seat_id }),
        }, String(cell.seat)));
      }
      this.gridHost.append(line);
    }

    this.summarySeatEl = h('strong', { class: 'picker-drawer__summary-seat num', text: `${block.label} · Pilih Kursi` });
    const footer = h('div', { class: 'picker-drawer__footer' },
      h('div', { class: 'picker-drawer__summary' },
        this.summarySeatEl,
        h('span', { class: 'picker-drawer__summary-price num', text: formatRupiah(block.price) })),
      h('button', {
        type: 'button',
        class: 'btn btn--teal-primary liquid-glass-btn-primary',
        onclick: () => {
          const vp = document.getElementById('viewport');
          if (vp && typeof vp.scrollIntoView === 'function') {
            vp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          this.close();
        },
      }, 'Lihat POV 3D Kursi Ini'));

    return [
      h('div', { class: 'picker__group' }, searchForm, searchError),
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'BARIS' }), this.bandGroup),
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'SISI BLOK' }), this.sideGroup),
      h('div', { class: 'picker__group' },
        h('div', { class: 'picker__matrix-head' },
          h('span', { class: 'eyebrow', text: 'Kursi Perwakilan' }),
          h('span', { class: 'picker__matrix-hint', text: 'Pilih baris dulu, lalu nomor kursi' }),
          h('div', { class: 'picker__matrix-legend' },
            h('span', {}, h('i', { class: 'mini-dot mini-dot--avail' }), 'Tersedia'),
            h('span', {}, h('i', { class: 'mini-dot mini-dot--taken' }), 'Terisi'),
            h('span', {}, h('i', { class: 'mini-dot mini-dot--picked' }), 'Dipilih'))),
        this.gridHost),
      footer,
    ];
  }

  /** Pilih baris dulu: hanya nomor kursi pada baris aktif yang bisa ditekan. */
  _pickRow(rowNo) {
    this.activeRow = rowNo;
    if (!this.gridHost) return;
    for (const line of this.gridHost.querySelectorAll('.mini-grid__row')) {
      const active = Number(line.dataset.row) === Number(rowNo);
      line.classList.toggle('is-row-active', active);
      line.querySelector('.mini-grid__label').setAttribute('aria-pressed', String(active));
      for (const seat of line.querySelectorAll('.mini-seat')) seat.disabled = !active;
    }
  }

  _standing(block) {
    const standingBlocks = this.layout.blocks.filter((b) => b.standing);
    this.ticketGroup = this._segmented('Jenis tiket berdiri',
      standingBlocks.map((b) => ({ key: b.id, label: b.label, note: formatRupiah(b.price) })),
      block.id, (blockId) => {
        if (blockId === this.block.id) return;
        this.open(blockId, this.layout);
        this.onSelect(this.currentSelector());
      });
    this.spotHost = h('div', { class: 'spot-grid' });
    for (const spot of this.layout.standing_spots) {
      this.spotHost.append(h('button', {
        class: 'spot-card', type: 'button', 'data-spot': spot.number,
        'aria-pressed': String(spot.number === this.choice.spot),
        onclick: () => {
          this.choice.spot = spot.number;
          this.onSelect(this.currentSelector());
        },
      },
      h('span', { class: 'spot-card__num num', text: String(spot.number) }),
      h('strong', { text: spot.label }),
      h('span', { text: spot.description })));
    }
    const perks = block.perks.length ? `Termasuk: ${block.perks.join(', ')}.` : 'Area berdiri bebas di lapangan.';
    return [
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'Pilih Kategori (CAT)' }), this.ticketGroup,
        h('p', { class: 'panel__hint', text: perks })),
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'Pilih Spot Berdiri' }), this.spotHost),
    ];
  }

  /**
   * Samakan sorotan tombol dengan posisi yang benar-benar dihitung Python.
   * `selector` = pilihan terakhir pengguna; bila berisi band/side, tombol itulah yang disorot.
   */
  sync(pov, selector = {}) {
    if (!this.block || !this.isOpen) return;
    const frame = pov.seat_frame;
    if (frame.block_id !== this.block.id) return;
    const press = (host, attr, value) => {
      if (!host) return;
      for (const button of host.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.getAttribute(attr) === String(value)));
      }
    };
    if (this.block.standing) {
      this.choice.spot = frame.spot;
      press(this.spotHost, 'data-spot', frame.spot);
      return;
    }
    const viaBand = Boolean(selector && selector.band);
    if (viaBand) Object.assign(this.choice, { band: selector.band, side: selector.side });
    const band = viaBand
      ? this.block.bands.find((b) => b.key === selector.band)
      : this.block.bands.find((b) => b.row === frame.row);
    press(this.bandGroup, 'data-key', band ? band.key : '');
    press(this.sideGroup, 'data-key', viaBand ? selector.side : '');
    press(this.gridHost, 'data-seat', pov.seat.seat_id);
    if (frame.row && this.gridHost) this._pickRow(frame.row);   // baris kursi aktif ikut terbuka
    if (frame.row && frame.seat && this.rowInput) {
      this.current = { row: frame.row, seat: frame.seat };
      this.rowInput.value = String(frame.row);
      this.seatInput.value = String(frame.seat);
      this.seatInput.max = String(this.block.row_seats[frame.row - 1]);
    }
    if (this.summarySeatEl && frame.row && frame.seat) {
      this.summarySeatEl.textContent = `Baris ${frame.row} · Kursi ${frame.seat}`;
    }
    this.setClusterSeats(this.clusterSeatIds);
  }
}
