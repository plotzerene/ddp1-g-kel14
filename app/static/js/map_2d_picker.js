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
  }

  render(layout) {
    this.layout = layout;
    this.seatNodes.clear();
    this.blockNodes.clear();
    this.spotNodes.clear();
    this.heat = null;
    this.heatRange = null;
    this.selectedSeat = null;
    this.selectedBlock = null;
    this.standingBlock = 'festival';
    if (layout.kind === 'cinema') this._renderCinema();
    else this._renderStadium();
    this._bindEvents();
    this.renderLegend();
  }

  /* ---------------------------- Bioskop ---------------------------------- */
  _renderCinema() {
    const L = this.layout;
    const { room, spec, screen } = L;
    const halfW = room.width / 2;
    const root = svg('svg', {
      class: 'map-svg map-svg--cinema',
      viewBox: `${-halfW - 1.6} -2.6 ${room.width + 3.2} ${room.depth + 3.4}`,
      role: 'group',
      'aria-label': `Denah kursi ${L.name}. Layar berada di sisi atas.`,
    });

    svg('rect', { class: 'room', x: -halfW, y: -1, width: room.width, height: room.depth + 1, rx: 0.4 }, root);

    const arc = screen.arc;
    const edges = arc
      ? [[arc[0][0], arc[0][2]], [arc[arc.length - 1][0], arc[arc.length - 1][2]]]
      : [[-screen.width / 2, 0], [screen.width / 2, 0]];
    const path = arc
      ? 'M' + arc.map((p) => `${p[0]},${p[2]}`).join(' L')
      : `M${edges[0][0]},0 L${edges[1][0]},0`;
    svg('path', { class: 'screen-glow', d: path }, root);
    svg('path', { class: 'screen-line', d: path }, root);
    svg('text', { class: 'map-label', x: 0, y: -1.5 }, root).textContent = 'LAYAR';
    this.screenEdges = edges;
    this.cone = svg('polygon', { class: 'sight-cone', points: '' }, root);

    const seatW = spec.seat_pitch * 0.84;
    const seatH = Math.min(spec.row_depth * 0.62, seatW * 1.05);
    this.seatSize = { w: seatW, h: seatH };
    const minX = L.columns[0] - seatW / 2;
    const maxX = L.columns[L.columns.length - 1] + seatW / 2;
    for (const row of L.rows) {
      for (const x of [minX - 0.75, maxX + 0.75]) {
        svg('text', { class: 'row-label', x, y: row.z }, root).textContent = row.letter;
      }
    }
    for (const item of L.furniture || []) {
      svg('circle', { class: 'table-dot', cx: item.x, cy: item.z, r: 0.2 }, root);
    }

    const seatLayer = svg('g', {}, root);
    this.seatGrid = new Map();
    for (const seat of L.seats) {
      const sold = seat.status === 'sold';
      const group = svg('g', {
        class: `seat${sold ? ' is-sold' : ''}`,
        'data-id': seat.id,
        role: 'button',
        tabindex: '-1',
        'aria-label': `Baris ${seat.row} kursi ${seat.number}, ${sold ? 'terjual' : 'tersedia'}`,
      }, seatLayer);
      svg('rect', {
        class: 'seat__shape', x: seat.x - seatW / 2, y: seat.z - seatH / 2,
        width: seatW, height: seatH, rx: seatW * 0.22,
      }, group);
      if (sold) {
        svg('line', {
          class: 'seat__slash', x1: seat.x - seatW * 0.3, y1: seat.z + seatH * 0.3,
          x2: seat.x + seatW * 0.3, y2: seat.z - seatH * 0.3,
        }, group);
      }
      svg('text', { class: 'seat__num', x: seat.x, y: seat.z, style: `font-size:${(seatW * 0.44).toFixed(3)}px` }, group)
        .textContent = seat.number;
      this.seatNodes.set(seat.id, { node: group, seat });
      this.seatGrid.set(`${seat.row_index}:${seat.number}`, seat.id);
    }
    const first = this.seatNodes.values().next().value;
    if (first) first.node.setAttribute('tabindex', '0');

    this.badgeLayer = svg('g', {}, root);
    this.root = root;
    this.host.replaceChildren(root);
  }

  /* ---------------------------- Stadion ---------------------------------- */
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
    svg('text', { class: 'stage-label', x: 0, y: (deck.z0 + deck.z1) / 2 + 3 }, root).textContent = 'STAGE';
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

  /* ---------------------------- Interaksi -------------------------------- */
  _bindEvents() {
    const root = this.root;
    const pick = (event) => event.target.closest('.seat, .block, .spot, .landmark');

    root.addEventListener('click', (event) => {
      const node = pick(event);
      if (node && !node.classList.contains('landmark')) this._activate(node);
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
      title = `Baris ${seat.row} · Kursi ${seat.number}`;
      detail = `${seat.status === 'sold' ? 'Terjual' : 'Tersedia'} · ${formatRupiah(this.layout.price)}`;
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

  /* ---------------------------- State dari luar --------------------------- */
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
      const [x, , z] = pov.seat.floor;
      const [a, b] = this.screenEdges;
      this.cone.setAttribute('points', `${x},${z} ${a[0]},${a[1]} ${b[0]},${b[1]}`);
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

  setCart(keys) {
    this.cartKeys = new Set(keys);
    if (!this.layout || this.layout.kind !== 'cinema') return;
    for (const [id, entry] of this.seatNodes) {
      entry.node.classList.toggle('is-cart', this.cartKeys.has(`${this.layout.venue_id}|${id}`));
    }
  }

  /** Tandai 3 rekomendasi (peringkat 1–3) di peta. */
  setRecommendations(list) {
    if (!this.badgeLayer) return;
    this.badgeLayer.replaceChildren();
    const cinema = this.layout.kind === 'cinema';
    for (const rec of list) {
      const [x, , z] = rec.floor;
      const radius = cinema ? this.seatSize.w * 0.5 : 5.2;
      const cy = cinema ? z - this.seatSize.h * 0.95 : z;
      const badge = svg('g', { class: 'reco-badge' }, this.badgeLayer);
      svg('circle', { cx: x, cy, r: radius, 'stroke-width': cinema ? 0.04 : 0.6 }, badge);
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
      if (cinema) for (const entry of this.seatNodes.values()) clearFill(entry.node.firstChild);
      else for (const node of this.blockNodes.values()) clearFill(node);
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
        if (entry) entry.node.firstChild.style.fill = heatColor((cell.score - data.min) / span);
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

  /* ---------------------------- Legenda ---------------------------------- */
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
      const item = (color, label, border) => h('span', { class: 'legend-item' },
        h('span', { class: 'legend-swatch', style: `background:${color};${border ? `border-color:${border}` : ''}` }), label);
      host.append(
        item('#3A3F6B', 'Tersedia'),
        item('#27273B', 'Terjual (bergaris)'),
        item('#818CF8', 'Kursi kamu', '#fff'),
        item('#CA8A04', 'Di keranjang'),
        item('#EAB308', 'Rekomendasi 1–3'),
        h('span', { class: 'legend-note', text:
          `Semua kursi ${formatRupiah(L.price)}. Baris A = paling belakang (konvensi XXI), layar di sisi atas peta.` }),
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
          onclick: () => this.onBlock(block.id),
        },
        h('span', { class: 'legend-swatch', style: `background:${block.color}` }),
        h('span', { class: 'category-btn__name', text: category }),
        h('span', { class: 'category-btn__meta num', text: `${formatRupiah(block.price)} · ${tags.join(' · ')}` }))));
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
  }

  get isOpen() {
    return !this.root.hidden;
  }

  close() {
    this.root.hidden = true;
    this.root.replaceChildren();
    this.block = null;
  }

  /** Buka picker untuk satu blok. Mengembalikan selector bawaan blok tersebut. */
  open(blockId, layout) {
    this.layout = layout;
    const block = layout.blocks.find((b) => b.id === blockId);
    if (!block) return null;
    this.block = block;
    this.root.replaceChildren(this._header(block), ...(block.standing ? this._standing(block) : this._seated(block)));
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
    const detail = block.standing
      ? block.description
      : `${block.description} ${block.row_count} baris, ±${block.seats_per_row} kursi per baris.`;
    return h('header', { class: 'panel__head' },
      h('div', {},
        h('div', { class: 'picker__title' },
          h('span', { class: 'picker__swatch', style: `background:${block.color}` }),
          h('h2', { id: 'picker-title', text: block.standing ? `${block.label} — Pilih Kategori / Area` : `${block.label} — Pilih Kursi` }),
          ...chips),
        h('p', { class: 'panel__hint', text: detail })),
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
    this.bandGroup = this._segmented('Posisi baris',
      block.bands.map((b) => ({ key: b.key, label: b.label, note: `baris ${b.row}` })),
      this.choice.band, (band) => pick({ band }));
    this.sideGroup = this._segmented('Sisi blok',
      block.sides.map((s) => ({ key: s.key, label: s.label })),
      this.choice.side, (side) => pick({ side }));

    const cols = Math.max(...block.mini_grid.map((row) => row.length));
    this.gridHost = h('div', { class: 'mini-grid', style: `--cols:${cols}` });
    for (const row of block.mini_grid) {
      const line = h('div', { class: 'mini-grid__row' },
        h('span', { class: 'mini-grid__label num', text: `Baris ${row[0].row}` }));
      for (const cell of row) {
        line.append(h('button', {
          class: 'mini-seat num', type: 'button', 'data-seat': cell.seat_id, 'aria-pressed': 'false',
          'aria-label': `Baris ${cell.row} kursi ${cell.seat}`,
          onclick: () => this.onSelect({ seat_id: cell.seat_id }),
        }, String(cell.seat)));
      }
      this.gridHost.append(line);
    }

    return [
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'Baris' }), this.bandGroup),
      h('div', { class: 'picker__group' },
        h('span', { class: 'eyebrow', text: 'Sisi blok (dilihat menghadap lapangan)' }), this.sideGroup),
      h('div', { class: 'picker__group' },
        h('span', { class: 'eyebrow', text: 'Atau pilih kursi perwakilan' }), this.gridHost),
    ];
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
      h('div', { class: 'picker__group' }, h('span', { class: 'eyebrow', text: 'Pilih Kategori / Area' }), this.ticketGroup,
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
  }
}
