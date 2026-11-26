/**
 * Dynamic 3D Spatial Wayfinding Router untuk Stadion GBK (24 Sektor, 4 Plaza Utama, Rute 5-Pos SOP Konser).
 * Memetakan sembarang ID kursi (`catX:RY:SZ`, `CATX-Y-Z`, atau spot festival) ke 1 dari 4 Plaza Utama,
 * membangun rute 5-Pos menapak lantai & melalui bukaan fisik 24 vomitory (NOL clipping / NOL terbang atap),
 * dan menghasilkan 5 pose kamera & metadata HUD lengkap.
 */
import * as THREE from 'three';

export const GBK_RX = 117.5;
export const GBK_RZ = 159.2;

export const DEFAULT_GBK_SPEC = Object.freeze({
  version: 'gbk_solid_v1',
  rxRef: 117.5,
  rzRef: 159.2,
  tier1: {
    rx0: 79.35, rz0: 107.0, baseY: 4.60, treadX: 0.90, treadZ: 1.24, riser: 0.50, rows: 22,
    parapetRx: 77.15, parapetRz: 103.80, parapetHeight: 1.05, vomOpenRows: 6, aisleWidth: 2.2, vomWidth: 2.4, vomLatOffset: -2.8,
  },
  tier2: {
    rx0: 97.0, rz0: 131.4, baseY: 26.80, treadX: 0.88, treadZ: 1.19, riser: 0.50, rows: 13,
    parapetRx: 94.8, parapetRz: 128.5, parapetHeight: 1.05, vomOpenRows: 5, aisleWidth: 2.2, vomWidth: 2.4, vomLatOffset: -2.8,
  },
  concourseL1: { rxIn: 99.15, rzIn: 134.28, rxOut: 115.5, rzOut: 156.5, walkRx: 107.5, walkRz: 145.6, floorY: 0.42 },
  concourseL2: { rxIn: 108.44, rzIn: 146.87, rxOut: 116.5, rzOut: 157.8, walkRx: 113.0, walkRz: 153.1, floorY: 24.40 },
  pitchTunnel: { halfWidth: 3.2, yStartBlender: -136.0, yEndBlender: -103.80, floorY: 0.42 },
  plazaAnchors: {
    utara:   { gate: 'Gate 4',     plaza: 'Plaza Utara',    gateAngleDeg: 0.0,   bearingDeg: 0.0,   portalHalfWidth: 5.2, aOuter: 90.8 },
    timur:   { gate: 'Gate 5',     plaza: 'Plaza Timur',    gateAngleDeg: 90.0,  bearingDeg: 90.0,  portalHalfWidth: 5.2, aOuter: 67.0 },
    selatan: { gate: 'Gate 6',     plaza: 'Plaza Tenggara', gateAngleDeg: 140.0, bearingDeg: 140.0, portalHalfWidth: 5.2, aOuter: 77.5 },
    barat:   { gate: 'Gate 1 & 2', plaza: 'Plaza Barat',    gateAngleDeg: 270.0, bearingDeg: 270.0, portalHalfWidth: 5.2, aOuter: 67.0 },
  },
  validVomitoryAnglesDeg: Array.from({ length: 24 }, (_, k) => k * 15).filter((a) => a !== 180),
});

let _activeSpec = DEFAULT_GBK_SPEC;

function buildSerpentineWaypoints(originBl, fwBl, rtBl, aFac, aOuter) {
  const aWb = aOuter - 11.5;
  const zStart = aFac + 13.5;
  const zEnd = aWb - 5.5;
  const qIn = zStart + 5.0;
  const qOut = zEnd - 2.0;
  const span = Math.max(12.0, qOut - qIn);
  const pt = (a, b) => {
    const bx = originBl[0] + fwBl[0] * a + rtBl[0] * b;
    const by = originBl[1] + fwBl[1] * a + rtBl[1] * b;
    return [Number(bx.toFixed(3)), 0.35, Number((-by).toFixed(3))];
  };
  return [
    // Masuk ke Lajur 1 (b = -3.2) menuju dalam
    pt(qOut + 4.2, -1.5),
    pt(qOut + 1.0, -3.2),
    pt(qOut - 0.30 * span, -3.2),
    pt(qOut - 0.65 * span, -3.2),
    pt(qIn + 3.4, -3.2),
    // Tikungan balik U-turn 1 di ujung dalam ke Lajur 2 (b = 0.0)
    pt(qIn + 1.9, -2.5),
    pt(qIn + 1.5, -1.6),
    pt(qIn + 1.9, -0.7),
    pt(qIn + 3.4, 0.0),
    // Berbalik ke arah luar di Lajur 2 (b = 0.0)
    pt(qIn + 0.35 * span, 0.0),
    pt(qIn + 0.68 * span, 0.0),
    pt(qOut - 3.4, 0.0),
    // Tikungan balik U-turn 2 di ujung luar ke Lajur 3 (b = +3.2)
    pt(qOut - 1.9, 0.7),
    pt(qOut - 1.5, 1.6),
    pt(qOut - 1.9, 2.5),
    pt(qOut - 3.4, 3.2),
    // Masuk lagi ke arah dalam di Lajur 3 (b = +3.2) menuju Bag Check
    pt(qOut - 0.32 * span, 3.2),
    pt(qOut - 0.68 * span, 3.2),
    pt(qIn + 1.2, 3.2),
    pt(qIn - 1.4, 2.2),
    pt(qIn - 3.6, 0.5),
    pt(qIn - 5.2, 0.0),
  ];
}

function buildPlazaGeometryFromSpec(key, spec) {
  const anchors = spec?.plazaAnchors || DEFAULT_GBK_SPEC.plazaAnchors;
  const fallback = DEFAULT_GBK_SPEC.plazaAnchors[key];
  const anchor = { ...fallback, ...(anchors[key] || {}) };
  const angleDeg = Number(anchor.gateAngleDeg ?? anchor.bearingDeg ?? fallback.gateAngleDeg);
  const th = (angleDeg * Math.PI) / 180.0;
  const rxRef = spec?.rxRef || GBK_RX;
  const rzRef = spec?.rzRef || GBK_RZ;
  const ox = rxRef * Math.sin(th);
  const oy = rzRef * Math.cos(th);
  const nx = Math.sin(th) / rxRef;
  const ny = Math.cos(th) / rzRef;
  const nLen = Math.hypot(nx, ny) || 1.0;
  const fw = [nx / nLen, ny / nLen];
  const rt = [-fw[1], fw[0]];
  const aOuter = Number(anchor.aOuter ?? fallback.aOuter);
  const pt = (a, b, y = 0.35) => [
    Number((ox + fw[0] * a + rt[0] * b).toFixed(3)),
    y,
    Number((-(oy + fw[1] * a + rt[1] * b)).toFixed(3)),
  ];
  const l1 = spec?.concourseL1 || DEFAULT_GBK_SPEC.concourseL1;
  return {
    key,
    gate: anchor.gate,
    plaza: anchor.plaza,
    bearingDeg: angleDeg,
    gateAngleDeg: angleDeg,
    origin: [ox, oy],
    fw,
    rt,
    billboardStart: pt(aOuter + 9.0, 0.0, 0.35),
    underBillboard: pt(aOuter, 0.0, 0.35),
    pos1Wristband: pt(aOuter - 11.5, 0.0, 0.35),
    zigzag: buildSerpentineWaypoints([ox, oy], fw, rt, 1.0, aOuter),
    pos2Bag: pt(13.0, 0.0, 0.35),
    pos2Security: pt(9.5, 0.0, 0.35),
    pos3Turnstile: pt(5.0, 0.0, 0.35),
    postTurnstile: pt(2.6, 0.0, 0.36),
    portalClear: pt(-2.0, 0.0, 0.56),
    concoursePort: [
      Number((l1.walkRx * Math.sin(th)).toFixed(3)),
      0.56,
      Number((-l1.walkRz * Math.cos(th)).toFixed(3)),
    ],
  };
}

export const FOUR_MAIN_PLAZAS = {
  utara: buildPlazaGeometryFromSpec('utara', DEFAULT_GBK_SPEC),
  timur: buildPlazaGeometryFromSpec('timur', DEFAULT_GBK_SPEC),
  selatan: buildPlazaGeometryFromSpec('selatan', DEFAULT_GBK_SPEC),
  barat: buildPlazaGeometryFromSpec('barat', DEFAULT_GBK_SPEC),
};

export const GATE_TOPOLOGY = [
  { sectors: [1, 2, 3],    gate: FOUR_MAIN_PLAZAS.barat.gate,   plaza: FOUR_MAIN_PLAZAS.barat.plaza,   plazaKey: 'barat',   x: FOUR_MAIN_PLAZAS.barat.billboardStart[0],   z: FOUR_MAIN_PLAZAS.barat.billboardStart[2],   angleDeg: FOUR_MAIN_PLAZAS.barat.gateAngleDeg },
  { sectors: [4, 5, 6],    gate: FOUR_MAIN_PLAZAS.utara.gate,   plaza: FOUR_MAIN_PLAZAS.utara.plaza,   plazaKey: 'utara',   x: FOUR_MAIN_PLAZAS.utara.billboardStart[0],   z: FOUR_MAIN_PLAZAS.utara.billboardStart[2],   angleDeg: FOUR_MAIN_PLAZAS.utara.gateAngleDeg },
  { sectors: [7, 8, 9],    gate: FOUR_MAIN_PLAZAS.utara.gate,   plaza: FOUR_MAIN_PLAZAS.utara.plaza,   plazaKey: 'utara',   x: FOUR_MAIN_PLAZAS.utara.billboardStart[0],   z: FOUR_MAIN_PLAZAS.utara.billboardStart[2],   angleDeg: FOUR_MAIN_PLAZAS.utara.gateAngleDeg },
  { sectors: [10, 11, 12], gate: FOUR_MAIN_PLAZAS.timur.gate,   plaza: FOUR_MAIN_PLAZAS.timur.plaza,   plazaKey: 'timur',   x: FOUR_MAIN_PLAZAS.timur.billboardStart[0],   z: FOUR_MAIN_PLAZAS.timur.billboardStart[2],   angleDeg: FOUR_MAIN_PLAZAS.timur.gateAngleDeg },
  { sectors: [13, 14, 15], gate: FOUR_MAIN_PLAZAS.selatan.gate, plaza: FOUR_MAIN_PLAZAS.selatan.plaza, plazaKey: 'selatan', x: FOUR_MAIN_PLAZAS.selatan.billboardStart[0], z: FOUR_MAIN_PLAZAS.selatan.billboardStart[2], angleDeg: FOUR_MAIN_PLAZAS.selatan.gateAngleDeg },
  { sectors: [16, 17, 18], gate: FOUR_MAIN_PLAZAS.selatan.gate, plaza: FOUR_MAIN_PLAZAS.selatan.plaza, plazaKey: 'selatan', x: FOUR_MAIN_PLAZAS.selatan.billboardStart[0], z: FOUR_MAIN_PLAZAS.selatan.billboardStart[2], angleDeg: FOUR_MAIN_PLAZAS.selatan.gateAngleDeg },
  { sectors: [19, 20, 21], gate: FOUR_MAIN_PLAZAS.selatan.gate, plaza: FOUR_MAIN_PLAZAS.selatan.plaza, plazaKey: 'selatan', x: FOUR_MAIN_PLAZAS.selatan.billboardStart[0], z: FOUR_MAIN_PLAZAS.selatan.billboardStart[2], angleDeg: FOUR_MAIN_PLAZAS.selatan.gateAngleDeg },
  { sectors: [22, 23, 24], gate: FOUR_MAIN_PLAZAS.barat.gate,   plaza: FOUR_MAIN_PLAZAS.barat.plaza,   plazaKey: 'barat',   x: FOUR_MAIN_PLAZAS.barat.billboardStart[0],   z: FOUR_MAIN_PLAZAS.barat.billboardStart[2],   angleDeg: FOUR_MAIN_PLAZAS.barat.gateAngleDeg },
];

export function applyGbkGeometrySpec(spec) {
  if (spec && spec.tier1 && spec.tier2) {
    _activeSpec = {
      ...DEFAULT_GBK_SPEC,
      ...spec,
      tier1: { ...DEFAULT_GBK_SPEC.tier1, ...spec.tier1 },
      tier2: { ...DEFAULT_GBK_SPEC.tier2, ...spec.tier2 },
      concourseL1: { ...DEFAULT_GBK_SPEC.concourseL1, ...(spec.concourseL1 || {}) },
      concourseL2: { ...DEFAULT_GBK_SPEC.concourseL2, ...(spec.concourseL2 || {}) },
      pitchTunnel: { ...DEFAULT_GBK_SPEC.pitchTunnel, ...(spec.pitchTunnel || {}) },
      plazaAnchors: { ...DEFAULT_GBK_SPEC.plazaAnchors, ...(spec.plazaAnchors || {}) },
    };
    for (const k of ['utara', 'timur', 'selatan', 'barat']) {
      FOUR_MAIN_PLAZAS[k] = buildPlazaGeometryFromSpec(k, _activeSpec);
    }
    for (const row of GATE_TOPOLOGY) {
      const pl = FOUR_MAIN_PLAZAS[row.plazaKey];
      if (pl) {
        row.gate = pl.gate;
        row.plaza = pl.plaza;
        row.x = pl.billboardStart[0];
        row.z = pl.billboardStart[2];
        row.angleDeg = pl.gateAngleDeg;
      }
    }
  }
  return _activeSpec;
}

export function getGbkGeometrySpec() {
  return _activeSpec;
}

export const TIER_SPECS = Object.freeze({
  tier1: Object.freeze({ fMin: 0.679, fMax: 0.840, yMin: 4.6, yMax: 15.1, maxRows: 22 }),
  tier2: Object.freeze({ fMin: 0.829, fMax: 0.919, yMin: 26.8, yMax: 32.8, maxRows: 13 }),
});

/**
 * Metrik presisi baris diskrit `rowIdx` tersinkronisasi 1:1 dengan pelat beton padat Blender (`gbk_geometry_spec.json`).
 */
export function gbkTierRowMetrics(tier, rowIdx) {
  const name = (tier === 'tier2' || tier === 2) ? 'tier2' : 'tier1';
  const ts = _activeSpec[name];
  const r = Math.max(0, Math.min(ts.rows - 1, Math.round(rowIdx)));
  const rx = ts.rx0 + (r + 0.5) * ts.treadX;
  const rz = ts.rz0 + (r + 0.5) * ts.treadZ;
  const y = ts.baseY + r * ts.riser;
  const s = rx / (_activeSpec.rxRef || GBK_RX);
  return { tierName: name, rowIdx: r, rx, rz, y, s };
}

/**
 * Ketinggian Y Three.js permukaan undakan beton mangkuk padat GBK tersinkronisasi 1:1 dengan Blender.
 */
export function gbkBowlY(tier, s, _bearingDeg = 0) {
  const name = (tier === 'tier2' || tier === 2) ? 'tier2' : 'tier1';
  const ts = _activeSpec[name];
  const rx = s * (_activeSpec.rxRef || GBK_RX);
  const rCont = (rx - ts.rx0) / ts.treadX - 0.5;
  const rIdx = Math.max(0, Math.min(ts.rows - 1, Math.round(rCont)));
  return ts.baseY + rIdx * ts.riser;
}

export const PITCH_OBSTACLES = Object.freeze([
  { name: 'FOH_Main',        x: 0.0,   z: 37.5,  r: 5.5 },
  { name: 'FOH_Tent_L',      x: -12.0, z: 37.0,  r: 4.2 },
  { name: 'FOH_Tent_R',      x: 12.0,  z: 37.0,  r: 4.2 },
  { name: 'Delay_Tower_L',   x: -20.5, z: 13.35, r: 4.5 },
  { name: 'Delay_Tower_R',   x: 20.5,  z: 13.35, r: 4.5 },
  { name: 'Camera_Riser_1',  x: 16.5,  z: -8.0,  r: 3.8 },
  { name: 'Camera_Riser_2',  x: -18.0, z: 24.0,  r: 3.8 },
  { name: 'BStage_Platform', x: 0.0,   z: -9.95, r: 6.0, intermediateOnly: true },
]);

const VALID_VOMITORY_ANGLES = Array.from({ length: 24 }, (_, k) => k * 15).filter((a) => a !== 180);

const CATEGORY_BLOCKS = {
  ultimate: { label: 'ULTIMATE EXPERIENCE', tier: 'tier1', bearingStart: 84,  bearingEnd: 97,  seatsPerRow: 36,  rows: 26 },
  cat1:     { label: 'CAT 1',               tier: 'tier1', bearingStart: 84,  bearingEnd: 97,  seatsPerRow: 36,  rows: 26 },
  cat2a:    { label: 'CAT 2A',              tier: 'tier1', bearingStart: 242, bearingEnd: 294, seatsPerRow: 130, rows: 26 },
  cat2b_n:  { label: 'CAT 2B (Utara)',      tier: 'tier1', bearingStart: 66,  bearingEnd: 84,  seatsPerRow: 48,  rows: 26 },
  cat2b_s:  { label: 'CAT 2B (Selatan)',    tier: 'tier1', bearingStart: 97,  bearingEnd: 118, seatsPerRow: 54,  rows: 26 },
  cat2:     { label: 'CAT 2A',              tier: 'tier1', bearingStart: 242, bearingEnd: 294, seatsPerRow: 130, rows: 26 },
  cat3:     { label: 'CAT 3',               tier: 'tier1', bearingStart: 118, bearingEnd: 242, seatsPerRow: 326, rows: 32 },
  cat4a:    { label: 'CAT 4A',              tier: 'tier2', bearingStart: 228, bearingEnd: 294, seatsPerRow: 168, rows: 22 },
  cat4b:    { label: 'CAT 4B',              tier: 'tier2', bearingStart: 66,  bearingEnd: 132, seatsPerRow: 168, rows: 22 },
  cat4:     { label: 'CAT 4A',              tier: 'tier2', bearingStart: 228, bearingEnd: 294, seatsPerRow: 168, rows: 22 },
  cat5a:    { label: 'CAT 5A',              tier: 'tier2', bearingStart: 198, bearingEnd: 228, seatsPerRow: 80,  rows: 22 },
  cat5b:    { label: 'CAT 5B',              tier: 'tier2', bearingStart: 132, bearingEnd: 162, seatsPerRow: 80,  rows: 22 },
  cat5:     { label: 'CAT 5B',              tier: 'tier2', bearingStart: 132, bearingEnd: 162, seatsPerRow: 80,  rows: 22 },
  cat6:     { label: 'CAT 6',               tier: 'tier2', bearingStart: 162, bearingEnd: 198, seatsPerRow: 96,  rows: 22 },
  cat7a:    { label: 'CAT 7A',              tier: 'tier2', bearingStart: 294, bearingEnd: 306, seatsPerRow: 34,  rows: 22 },
  cat7b:    { label: 'CAT 7B',              tier: 'tier2', bearingStart: 54,  bearingEnd: 66,  seatsPerRow: 34,  rows: 22 },
  cat7:     { label: 'CAT 7A',              tier: 'tier2', bearingStart: 294, bearingEnd: 306, seatsPerRow: 34,  rows: 22 },
  cat8a:    { label: 'CAT 8A',              tier: 'tier2', bearingStart: 306, bearingEnd: 318, seatsPerRow: 34,  rows: 22 },
  cat8b:    { label: 'CAT 8B',              tier: 'tier2', bearingStart: 42,  bearingEnd: 54,  seatsPerRow: 34,  rows: 22 },
  cat8:     { label: 'CAT 8A',              tier: 'tier2', bearingStart: 306, bearingEnd: 318, seatsPerRow: 34,  rows: 22 },
  vip:      { label: 'VIP',                 tier: 'tier1', bearingStart: 168, bearingEnd: 192, seatsPerRow: 60,  rows: 16 },
};

const STANDING_SPOTS = [
  { x: -16.5, z: -36.0, label: 'Spot 1: Bibir Panggung Kiri' },
  { x: 18.0,  z: -34.0, label: 'Spot 2: Kanan Panggung' },
  { x: -24.0, z: -24.0, label: 'Spot 3: Tengah Kiri' },
  { x: 0.0,   z: -16.0, label: 'Spot 4: Sekitar B-Stage' },
  { x: 26.0,  z: 8.0,   label: 'Spot 5: Tengah Kanan' },
  { x: -16.0, z: 28.0,  label: 'Spot 6: Area Belakang' },
];

const DEFAULT_SEAT_ID = 'cat3:R14:S163';
const CLEARANCE_FLOOR = 0.20;
const BEACON_OFFSET_Y = 1.05;
const SEAT_EYE_OFFSET_Y = 1.2;
const WALK_EYE_OFFSET_Y = 1.65;

// 8 Ramp Spiral Eksterior GBK (`GBK_Spiral_Ramps_Outer`, 2.5 putaran: dasar menghadap luar, puncak menghadap masuk)
const OUTER_SPIRAL_RAMPS = Array.from({ length: 8 }, (_, k) => {
  const angleDeg = 22.5 + 45.0 * k;
  const rAng = THREE.MathUtils.degToRad(angleDeg);
  return {
    index: k + 1,
    rAng,
    cx: 128.0 * Math.cos(rAng),
    cz: -170.0 * Math.sin(rAng),
    bearingDeg: wrapDeg(90.0 - angleDeg),
  };
});

function buildSpiralRampPoints(ramp, samples = 64) {
  const pts = [];
  const inwardTh = Math.atan2(ramp.cz, -ramp.cx);
  const thEnd = inwardTh;
  const thStart = thEnd - 2.0 * Math.PI * 3.5;
  const rMid = 5.0; // (R_IN=2.6 + R_OUT=7.4)/2 di Blender
  // Titik ancang luar tepat di mulut bawah ramp menghadap keluar apron taman
  const apX = ramp.cx + 9.2 * Math.cos(thStart);
  const apY = -ramp.cz + 9.2 * Math.sin(thStart);
  pts.push(new THREE.Vector3(apX, 0.48, -apY));
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const th = thStart + (thEnd - thStart) * t;
    const y = 0.56 + (24.54 - 0.56) * t;
    const bx = ramp.cx + rMid * Math.cos(th);
    const by = -ramp.cz + rMid * Math.sin(th);
    pts.push(new THREE.Vector3(bx, y, -by));
  }
  pts.push(new THREE.Vector3(
    ramp.cx + 7.8 * Math.cos(thEnd),
    24.54,
    -(-ramp.cz + 7.8 * Math.sin(thEnd)),
  ));
  return pts;
}

function buildConcourseArc(rx, rz, y0, fromDeg, toDeg, includeStart = false, y1 = null) {
  const d = ((toDeg - fromDeg + 540) % 360) - 180;
  const steps = Math.max(1, Math.ceil(Math.abs(d) / 6));
  const targetY = y1 === null ? y0 : y1;
  const pts = [];
  for (let i = includeStart ? 0 : 1; i <= steps; i += 1) {
    const frac = i / steps;
    pts.push(ellipsePoint(rx, rz, y0 + (targetY - y0) * frac, wrapDeg(fromDeg + d * frac)));
  }
  return pts;
}

function sampleMaxRouteY(curve, steps = 140) {
  let maxY = 0;
  for (let i = 0; i <= steps; i += 1) {
    const y = curve.getPointAt(i / steps).y;
    if (y > maxY) maxY = y;
  }
  return Math.round(maxY * 100) / 100;
}

function wrapDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

function angularDelta(a, b) {
  const diff = Math.abs(wrapDeg(a) - wrapDeg(b));
  return Math.min(diff, 360 - diff);
}

function nearestValidVomitory(bearingDeg, plazaBearingDeg) {
  let best = VALID_VOMITORY_ANGLES[0];
  let bestScore = Infinity;
  for (const va of VALID_VOMITORY_ANGLES) {
    const dSeat = angularDelta(bearingDeg, va);
    const dPlaza = angularDelta(plazaBearingDeg, va);
    const sc = dSeat + dPlaza * 0.002;
    if (sc < bestScore) {
      bestScore = sc;
      best = va;
    }
  }
  return best;
}

function ellipseLatPoint(rx, rz, vomAngle, latMeters = 0, y = 0) {
  const rad = THREE.MathUtils.degToRad(vomAngle);
  const base = ellipsePoint(rx, rz, y, vomAngle);
  if (!latMeters) return base;
  const rxC = rx * Math.sin(rad);
  const rzC = -rz * Math.cos(rad);
  const rLen = Math.hypot(rxC, rzC) || 1;
  base.x += (-rzC / rLen) * latMeters;
  base.z += (rxC / rLen) * latMeters;
  return base;
}

function aislePoint(tier, s, vomAngle, latMeters = 0, yOverride = null) {
  const refRx = _activeSpec.rxRef || GBK_RX;
  const refRz = _activeSpec.rzRef || GBK_RZ;
  const y = yOverride !== null ? yOverride : gbkBowlY(tier, s, vomAngle) + 0.14;
  return ellipseLatPoint(s * refRx, s * refRz, vomAngle, latMeters, y);
}

/**
 * Tangga lorong tribun 100% LURUS RADIAL (NOL zigzag/switchback):
 *   1. Landing datar >= 3.0 m keluar mulut Vomitory menuju sumbu lorong tangga (theta = vomAngle).
 *   2. Garis lurus radial konstan `vomAngle` menaiki pelat tangga padat tiap 1 baris hingga row target.
 *   3. Berhenti rapi di lorong sejajar baris kursi target.
 */
function buildStraightRadialAisle(tierName, rowIdxTarget, vomAngle, startLat = -2.8) {
  const ts = _activeSpec[tierName];
  const mouthY = ts.baseY + 0.14;
  const walkRx = 0.5 * (ts.parapetRx + 0.40 + ts.rx0);
  const walkRz = 0.5 * (ts.parapetRz + 0.40 + ts.rz0);
  const midRx = walkRx + 0.45 * (ts.rx0 - walkRx);
  const midRz = walkRz + 0.45 * (ts.rz0 - walkRz);
  const pts = [];

  // Segmen 1: Busur U-turn fillet mulus 5-titik (R >= 1.6 m) keluar mulut Vomitory menuju sumbu lorong tangga (lat = 0)
  pts.push(ellipseLatPoint(ts.rx0 - 0.15, ts.rz0 - 0.20, vomAngle, startLat, mouthY));
  pts.push(ellipseLatPoint(midRx, midRz, vomAngle, startLat * 0.88, mouthY));
  pts.push(ellipseLatPoint(walkRx + 0.12, walkRz + 0.15, vomAngle, startLat * 0.50, mouthY));
  const vomTurnIdx = pts.length;
  pts.push(ellipseLatPoint(midRx, midRz, vomAngle, startLat * 0.14, mouthY));
  pts.push(ellipseLatPoint(ts.rx0, ts.rz0, vomAngle, 0.0, mouthY));

  // Segmen 2 & 3: Lurus radial mengikuti theta_aisle konstan per baris hingga baris kursi target
  const maxR = Math.max(0, Math.min(ts.rows - 1, Math.round(rowIdxTarget)));
  const stairStartIdx = pts.length;
  for (let r = 0; r <= maxR; r += 1) {
    const m = gbkTierRowMetrics(tierName, r);
    pts.push(ellipsePoint(m.rx, m.rz, m.y + 0.14, vomAngle));
  }
  return { pts, vomTurnIdx, stairStartIdx };
}

function buildRowArc(tier, rowIdx, rx, rz, vomAngle, bearingDeg) {
  const signedArc = ((bearingDeg - vomAngle + 540) % 360) - 180;
  if (Math.abs(signedArc) <= 0.4) return [];
  const rowY = gbkTierRowMetrics(tier, rowIdx).y + 0.16;
  const arcStopDelta = signedArc > 0
    ? Math.max(0.35, signedArc - 0.9)
    : Math.min(-0.35, signedArc + 0.9);
  const pts = [];
  if (Math.abs(arcStopDelta) > 0.75) {
    const guardDeg = wrapDeg(vomAngle + Math.sign(arcStopDelta) * 0.5);
    pts.push(ellipsePoint(rx, rz, rowY, guardDeg));
  }
  const minFrac = Math.abs(arcStopDelta) > 0.75 ? 0.5 / Math.abs(arcStopDelta) : 0.0;
  const steps = Math.max(1, Math.ceil(Math.abs(arcStopDelta) / 3.0));
  for (let i = 1; i <= steps; i += 1) {
    const frac = i / steps;
    if (frac <= minFrac + 1e-3 && i < steps) continue;
    const deg = wrapDeg(vomAngle + arcStopDelta * frac);
    pts.push(ellipsePoint(rx, rz, rowY, deg));
  }
  return pts;
}

/**
 * Menghaluskan dan membelokkan waypoint lapangan festival menjauhi menara/tenda/FOH/panggung B-Stage.
 */
export function avoidPitchObstacles(pitchPts, obstacles = PITCH_OBSTACLES) {
  const pts = pitchPts.map((p) => p.clone());
  for (let pass = 0; pass < 4; pass += 1) {
    // 1. Dorong titik interior keluar radius obstacle
    for (let i = 1; i < pts.length - 1; i += 1) {
      const p = pts[i];
      for (const obs of obstacles) {
        const dx = p.x - obs.x;
        const dz = p.z - obs.z;
        const dist = Math.hypot(dx, dz);
        if (dist < obs.r + 0.55) {
          const safe = obs.r + 0.85;
          if (dist > 1e-4) {
            p.x = obs.x + (dx / dist) * safe;
            p.z = obs.z + (dz / dist) * safe;
          } else {
            p.x = obs.x + safe;
          }
        }
      }
    }
    // 2. Periksa tiap segmen lurus agar tidak memotong lingkaran obstacle di tengah segmen
    const expanded = [pts[0]];
    let split = false;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const vx = b.x - a.x;
      const vz = b.z - a.z;
      const lenSq = vx * vx + vz * vz;
      let detour = null;
      if (lenSq > 0.25) {
        for (const obs of obstacles) {
          if (obs.intermediateOnly && i === pts.length - 2) continue;
          const t = Math.max(0.05, Math.min(0.95, ((obs.x - a.x) * vx + (obs.z - a.z) * vz) / lenSq));
          const cx = a.x + vx * t;
          const cz = a.z + vz * t;
          const d = Math.hypot(cx - obs.x, cz - obs.z);
          if (d < obs.r) {
            const safe = obs.r + 0.9;
            let nx = cx - obs.x;
            let nz = cz - obs.z;
            if (Math.hypot(nx, nz) < 0.05) {
              nx = -vz;
              nz = vx;
            }
            const nLen = Math.hypot(nx, nz) || 1.0;
            detour = new THREE.Vector3(obs.x + (nx / nLen) * safe, 0.5 * (a.y + b.y), obs.z + (nz / nLen) * safe);
            split = true;
            break;
          }
        }
      }
      if (detour) expanded.push(detour);
      expanded.push(b);
    }
    pts.length = 0;
    pts.push(...expanded);
    if (!split) break;
  }
  return pts;
}

function ellipsePoint(rx, rz, y, angleDeg) {
  const rad = THREE.MathUtils.degToRad(angleDeg);
  return new THREE.Vector3(rx * Math.sin(rad), y, -rz * Math.cos(rad));
}

function resolveBlockKey(token) {
  const key = String(token || '').toLowerCase().trim();
  if (key === 'festival' || key === 'my_universe' || key === 'floor') return key;
  if (CATEGORY_BLOCKS[key]) return key;
  if (key === 'cat2b') return 'cat2b_s';
  if (key.startsWith('vip')) return 'vip';
  return 'cat3';
}

export function resolvePlazaForBearing(bearingDeg) {
  const theta = wrapDeg(bearingDeg);
  if (theta < 45 || theta >= 315) return FOUR_MAIN_PLAZAS.utara;
  if (theta >= 45 && theta < 118) return FOUR_MAIN_PLAZAS.timur;
  if (theta >= 118 && theta < 225) return FOUR_MAIN_PLAZAS.selatan;
  return FOUR_MAIN_PLAZAS.barat;
}

/**
 * Menguraikan parameter URL `?seat=` dalam berbagai format (`catX:RY:SZ`, `CATX-Y-Z`, atau spot standing).
 */
export function parseSeatParam(rawSeat) {
  const raw = String(rawSeat || '').trim() || DEFAULT_SEAT_ID;
  const lower = raw.toLowerCase();

  const standMatch = /^(festival|my_universe|floor)(?:[:_-](?:spot)?(\d+))?$/.exec(lower);
  if (standMatch) {
    const spotNum = Math.max(1, Math.min(6, Number.parseInt(standMatch[2] || '1', 10) || 1));
    const catLabel = standMatch[1] === 'my_universe' ? 'MY UNIVERSE' : standMatch[1].toUpperCase();
    return {
      raw,
      normalizedId: `${standMatch[1]}:spot${spotNum}`,
      catKey: standMatch[1],
      catLabel,
      row: 1,
      seat: spotNum,
      isStanding: true,
      spotNumber: spotNum,
    };
  }

  const normalizedSep = lower.replace(/[^a-z0-9_]+/g, ':');
  const tokens = normalizedSep.split(':').filter(Boolean);
  let catToken = 'cat3';
  let row = 14;
  let seat = 163;

  if (tokens.length >= 1) {
    catToken = tokens[0];
    if (tokens[1] === 'r' && tokens[2]) {
      row = Number.parseInt(tokens[2].replace(/^r/, ''), 10) || 14;
      seat = Number.parseInt((tokens[3] || '163').replace(/^s/, ''), 10) || 163;
    } else {
      const nums = tokens.slice(1).map((t) => Number.parseInt(t.replace(/^[rs]/, ''), 10)).filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length >= 1) row = nums[0];
      if (nums.length >= 2) seat = nums[1];
    }
  }

  const catKey = resolveBlockKey(catToken);
  const block = CATEGORY_BLOCKS[catKey] || CATEGORY_BLOCKS.cat3;
  const clampedRow = Math.max(1, Math.min(block.rows, row));
  const clampedSeat = Math.max(1, Math.min(block.seatsPerRow, seat));

  return {
    raw,
    normalizedId: `${catKey}:R${clampedRow}:S${clampedSeat}`,
    catKey,
    catLabel: block.label,
    row: clampedRow,
    seat: clampedSeat,
    isStanding: false,
    spotNumber: null,
  };
}

export class WayfindingRouter {
  constructor({ calibratedSouthData = null } = {}) {
    this.calibratedSouthData = calibratedSouthData;
  }

  setCalibratedSouthData(data) {
    this.calibratedSouthData = data || null;
  }

  /**
   * Menghitung koordinat 3D kursi tersinkronisasi presisi dengan mesh mangkuk GBK Blender.
   */
  resolveSeatPosition(parsed) {
    if (parsed.isStanding) {
      const idx = Math.max(0, Math.min(STANDING_SPOTS.length - 1, (parsed.spotNumber || 1) - 1));
      const spot = STANDING_SPOTS[idx];
      const angleDeg = wrapDeg(THREE.MathUtils.radToDeg(Math.atan2(spot.x, -spot.z)));
      const seatPos = new THREE.Vector3(spot.x, 0.15, spot.z);
      const beaconPos = new THREE.Vector3(seatPos.x, seatPos.y + BEACON_OFFSET_Y, seatPos.z);
      const seatEyePos = new THREE.Vector3(seatPos.x, seatPos.y + WALK_EYE_OFFSET_Y, seatPos.z);
      const seatLookAt = new THREE.Vector3(0.0, 9.0, -68.0);
      return { bearingDeg: angleDeg, tierName: 'festival', rx: 28.0, rz: 36.0, seatF: 0.25, seatPos, beaconPos, seatEyePos, seatLookAt };
    }

    const block = CATEGORY_BLOCKS[parsed.catKey] || CATEGORY_BLOCKS.cat3;
    const effTier = (block.tier === 'tier1' && parsed.row <= 25) ? 'tier1' : 'tier2';
    const spec = _activeSpec[effTier];
    const rowOffset = (block.tier === 'tier1' && parsed.row > 25)
      ? Math.max(0, Math.min(spec.rows - 1, parsed.row - 26))
      : Math.max(0, Math.min(block.rows - 1, parsed.row - 1));
    const maxBlockRows = (block.tier === 'tier1' && parsed.row > 25) ? spec.rows : block.rows;
    const rowFrac = Math.max(0, Math.min(1, rowOffset / Math.max(1, maxBlockRows - 1)));
    const rowIdx = Math.max(0, Math.min(spec.rows - 1, Math.round(rowFrac * (spec.rows - 1))));
    const metrics = gbkTierRowMetrics(effTier, rowIdx);
    const { rx, rz, y, s: f } = metrics;

    const seatFrac = Math.max(0.04, Math.min(0.96, (parsed.seat - 0.5) / block.seatsPerRow));
    let bearingDeg = wrapDeg(block.bearingEnd - seatFrac * (block.bearingEnd - block.bearingStart));
    const validVoms = _activeSpec.validVomitoryAnglesDeg || VALID_VOMITORY_ANGLES;
    for (const va of validVoms) {
      const signed = ((bearingDeg - va + 540) % 360) - 180;
      const radVa = THREE.MathUtils.degToRad(va);
      const spd = Math.hypot(rx * Math.cos(radVa), rz * Math.sin(radVa)) || 100;
      const lat = THREE.MathUtils.degToRad(signed) * spd;
      // Hindari koridor tangga [-1.45, +1.45] serta parit vomitory [-4.3, -1.35] pada baris rendah
      if (rowIdx < spec.vomOpenRows && lat >= -4.4 && lat <= 1.55) {
        const pushLat = lat < -2.6 ? -4.55 : 1.75;
        bearingDeg = wrapDeg(va + THREE.MathUtils.radToDeg(pushLat / spd));
        break;
      }
      if (Math.abs(lat) < 1.55) {
        bearingDeg = wrapDeg(va + THREE.MathUtils.radToDeg((lat >= 0 ? 1.75 : -1.75) / spd));
        break;
      }
    }

    const seatPos = ellipsePoint(rx, rz, y, bearingDeg);
    const beaconPos = new THREE.Vector3(seatPos.x, seatPos.y + BEACON_OFFSET_Y, seatPos.z);
    const seatEyePos = new THREE.Vector3(seatPos.x, seatPos.y + SEAT_EYE_OFFSET_Y, seatPos.z);
    const seatLookAt = new THREE.Vector3(0.0, 8.0, -38.0);

    return { bearingDeg, tierName: effTier, rowIdx, rx, rz, seatF: f, seatPos, beaconPos, seatEyePos, seatLookAt };
  }

  /**
   * Memetakan sudut keliling kursi ke salah satu dari 24 Sektor & Plaza Utama terdekat.
   */
  resolveSectorAndGate(bearingDeg) {
    const theta = wrapDeg(bearingDeg);
    const sector = Math.max(1, Math.min(24, Math.round(theta / 15) % 24 || 24));
    const plazaInfo = resolvePlazaForBearing(theta);
    return {
      sector,
      gateInfo: {
        gate: plazaInfo.gate,
        plaza: plazaInfo.plaza,
        plazaKey: plazaInfo.key,
        x: plazaInfo.billboardStart[0],
        z: plazaInfo.billboardStart[2],
        angleDeg: plazaInfo.bearingDeg,
      },
      plazaInfo,
    };
  }

  /**
   * Memetakan progres kurva `u` (0..1) ke progres zona culling (0..1):
   *   p < 0.35 (sebelum pos3Turnstile): Zone_Exterior ON, Zone_Interior OFF
   *   0.35 <= p < 0.70 (pos3 -> mouth vomitory): kedua zona aktif (transisi mulus)
   *   p >= 0.70 (di dalam mangkuk/tribun/lapangan): Zone_Exterior OFF, Zone_Interior ON
   */
  progressFromU(u, anchors) {
    const t = Math.max(0, Math.min(1, u));
    const pos3 = anchors.pos3 ?? anchors.tentsEnd ?? 0.36;
    const mouth = anchors.mouth ?? anchors.pos4 ?? 0.90;
    if (t < pos3) return 0.35 * (t / Math.max(0.001, pos3));
    if (t < mouth) return 0.35 + 0.35 * ((t - pos3) / Math.max(0.001, mouth - pos3));
    return 0.70 + 0.30 * ((t - mouth) / Math.max(0.001, 1 - mouth));
  }

  zoneStateForProgress(progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (p < 0.35) return { exteriorVisible: true, interiorVisible: false, phase: 'exterior' };
    if (p < 0.70) return { exteriorVisible: true, interiorVisible: true,  phase: 'transition' };
    return { exteriorVisible: false, interiorVisible: true, phase: 'interior' };
  }

  _make5PosCopy(parsed, gateInfo, sector, ingressKind) {
    const stepTitles = [
      `Pos 1: Kedatangan & Penukaran Wristband (${gateInfo.plaza})`,
      `Pos 2: Pemeriksaan Tas & Skrining Tubuh (${gateInfo.gate})`,
      `Pos 3: Pindai E-Tiket & Gerbang Masuk (${gateInfo.gate})`,
      ingressKind === 'festival'
        ? `Pos 4: Menuju Terowongan Lapangan (Pitch Tunnel)`
        : `Pos 4: Menuju Pintu Sektor ${sector}`,
      parsed.isStanding
        ? `Pos 5: Tiba di Area Festival (${parsed.catLabel} · Spot ${parsed.spotNumber})`
        : `Pos 5: Tiba di Kursi Anda (${parsed.catLabel} · Baris ${parsed.row} · Kursi ${parsed.seat})`,
    ];

    let pos4Desc = `Susuri koridor Lower Concourse menuju mulut pintu masuk fisik Vomitory Sektor ${sector}.`;
    if (ingressKind === 'festival') {
      pos4Desc = `Susuri koridor concourse menuju mulut Terowongan Lapangan Selatan ke area Festival.`;
    } else if (ingressKind === 'upper') {
      pos4Desc = `Naiki Ramp Spiral Luar menuju Upper Concourse hingga berdiri di pintu Vomitory Sektor ${sector}.`;
    }

    const stepDescriptions = [
      `Mulai dari depan gerbang Coldplay, ikuti antrean kanopi putih menuju loket penukaran wristband.`,
      `Siapkan tas untuk diperiksa petugas Security dan lewati gerbang walk-through metal detector.`,
      `Pindai kode QR e-tiket Anda di turnstile gerbang utama sebelum masuk menuju sirkulasi stadion.`,
      pos4Desc,
      parsed.isStanding
        ? `Masuk dari terowongan melewati samping menara FOH menuju titik berdiri Anda menghadap panggung utama.`
        : `Masuk ke mangkuk stadion, naiki tangga lorong, dan nikmati pandangan dari samping kursi Anda menghadap panggung.`,
    ];
    return { stepTitles, stepDescriptions };
  }

  /**
   * Rute 5-Pos terkalibrasi penuh untuk `cat3:R14:S163` menggunakan `gbk_wayfinding.json` dari Blender.
   */
  _buildCalibratedSouthRoute(parsed, data) {
    const points = data.path.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    const endPt = points[points.length - 1];
    const seatPos = data.beacon
      ? new THREE.Vector3(data.beacon[0], data.beacon[1] - BEACON_OFFSET_Y, data.beacon[2])
      : endPt.clone().setY(endPt.y - CLEARANCE_FLOOR);
    const beaconPos = data.beacon
      ? new THREE.Vector3(data.beacon[0], data.beacon[1] - 0.45, data.beacon[2])
      : new THREE.Vector3(seatPos.x, seatPos.y + BEACON_OFFSET_Y, seatPos.z);
    const seatLookAt = data.looks && data.looks[4]
      ? new THREE.Vector3(data.looks[4][0], data.looks[4][1], data.looks[4][2])
      : new THREE.Vector3(0.0, 10.0, 5.0);

    const anchors = {
      pos1: 0.0,
      step0: 0.0,
      pos2: data.anchors?.pos2 ?? 0.3479,
      pos3: data.anchors?.pos3 ?? 0.3673,
      tentsEnd: data.anchors?.tentsEnd ?? 0.3673,
      rampBase: data.anchors?.rampBase ?? 0.6942,
      pos4: Math.min(0.96, data.anchors?.pos4 ?? data.anchors?.mouth ?? 0.96),
      mouth: Math.min(0.96, data.anchors?.mouth ?? data.anchors?.pos4 ?? 0.96),
      end: 1.0,
    };

    const plazaInfo = FOUR_MAIN_PLAZAS.selatan;
    const gateInfo = {
      gate: plazaInfo.gate,
      plaza: plazaInfo.plaza,
      plazaKey: plazaInfo.key,
      x: plazaInfo.billboardStart[0],
      z: plazaInfo.billboardStart[2],
      angleDeg: plazaInfo.bearingDeg,
    };
    const sector = 16;

    const p0Pos = curve.getPointAt(0.0).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));
    const p0Look = data.looks?.[0]
      ? new THREE.Vector3(data.looks[0][0], data.looks[0][1], data.looks[0][2])
      : curve.getPointAt(0.04).add(new THREE.Vector3(0, 2.2, 0));

    const p1Pos = curve.getPointAt(anchors.pos2).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));
    const p1Look = curve.getPointAt(Math.min(1, anchors.pos2 + 0.04)).add(new THREE.Vector3(0, 1.5, 0));

    const p2Pos = curve.getPointAt(anchors.pos3).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));
    const p2Look = curve.getPointAt(Math.min(1, anchors.pos3 + 0.04)).add(new THREE.Vector3(0, 1.5, 0));

    const p3Pos = curve.getPointAt(anchors.pos4).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));
    const p3Look = curve.getPointAt(Math.min(1, anchors.pos4 + 0.01)).add(new THREE.Vector3(0, 1.2, 0));

    const aisleEye = curve.getPointAt(1.0).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));
    const maxRouteY = sampleMaxRouteY(curve);
    const { stepTitles, stepDescriptions } = this._make5PosCopy(parsed, gateInfo, sector, 'lower');

    const us = [0.0, anchors.pos2, anchors.pos3, anchors.pos4, 1.0];
    const poses = [
      [p0Pos, p0Look],
      [p1Pos, p1Look],
      [p2Pos, p2Look],
      [p3Pos, p3Look],
      [aisleEye, seatLookAt],
    ];

    return {
      parsed,
      sector,
      gateInfo,
      plazaKey: plazaInfo.key,
      tierName: 'tier1',
      ingressKind: 'lower',
      maxRouteY,
      bearingDeg: 180.0,
      seatPos,
      beaconPos,
      seatEyePos: aisleEye,
      seatLookAt,
      curve,
      points,
      pathLength: Math.round(curve.getLength() * 100) / 100,
      anchors,
      waypoints: us.map((u, i) => ({
        u,
        progress: this.progressFromU(u, anchors),
        pos: poses[i][0],
        look: poses[i][1],
        title: stepTitles[i],
      })),
      stepTitles,
      stepDescriptions,
      usesCalibratedSouth: true,
    };
  }

  /**
   * Sistem graf rute universal 5-Pos berbasis 4 Plaza Utama + 24 bukaan Vomitory fisik (NOL clipping, NOL terbang atap).
   */
  resolve(rawSeat) {
    const parsed = parseSeatParam(rawSeat);
    const { bearingDeg, tierName, rowIdx, rx, rz, seatPos, beaconPos, seatLookAt } = this.resolveSeatPosition(parsed);
    const { sector, gateInfo, plazaInfo } = this.resolveSectorAndGate(parsed.isStanding ? 180.0 : bearingDeg);

    // Bangun segmen Pos 1 (depan billboard Coldplay -> loket Wristband) -> S-curve lebar -> Pos 2 Bag/MetalDet (b=0) -> Pos 3 Turnstile (b=0)
    const v3 = (arr) => new THREE.Vector3(arr[0], arr[1], arr[2]);
    const pts = [
      v3(plazaInfo.billboardStart),
      v3(plazaInfo.underBillboard),
      v3(plazaInfo.pos1Wristband),
      ...plazaInfo.zigzag.map(v3),
    ];
    const pos2Idx = pts.length;
    pts.push(v3(plazaInfo.pos2Bag));
    pts.push(v3(plazaInfo.pos2Security));
    const pos3Idx = pts.length;
    pts.push(v3(plazaInfo.pos3Turnstile));
    // Semua kategori WAJIB lurus menembus Turnstile hingga >= 2.0 m melewatinya sebelum belok/lanjut ke portal
    if (plazaInfo.postTurnstile) {
      pts.push(v3(plazaInfo.postTurnstile));
    }

    let rampBaseIdx = pos3Idx;
    let vomIdx = pos3Idx;
    let ingressKind = 'lower';
    let stairAngularDevDeg = 0;
    let chosenVomAngle = null;

    const ptPlaza = (a, b, y = 0.38) => new THREE.Vector3(
      plazaInfo.origin[0] + plazaInfo.fw[0] * a + plazaInfo.rt[0] * b,
      y,
      -(plazaInfo.origin[1] + plazaInfo.fw[1] * a + plazaInfo.rt[1] * b),
    );
    const pushConcourseVomFillet = (walkRx, walkRz, enterRx, enterRz, yVal, fromDeg, vomAngle, vomLat) => {
      const rLocal = Math.hypot(walkRx * Math.cos(THREE.MathUtils.degToRad(vomAngle)), walkRz * Math.sin(THREE.MathUtils.degToRad(vomAngle))) || 110;
      const inDeg = wrapDeg(vomAngle + THREE.MathUtils.radToDeg(vomLat / rLocal));
      const dArc = ((inDeg - fromDeg + 540) % 360) - 180;
      const arcSign = dArc >= 0 ? 1 : -1;
      const filletDeg = Math.abs(dArc) >= 2.5 ? wrapDeg(inDeg - arcSign * 1.8) : fromDeg;
      if (angularDelta(fromDeg, filletDeg) >= 1.0) {
        pts.push(...buildConcourseArc(walkRx, walkRz, yVal, fromDeg, filletDeg, false));
      }
      pts.push(ellipsePoint(0.65 * walkRx + 0.35 * enterRx, 0.65 * walkRz + 0.35 * enterRz, yVal, wrapDeg(inDeg - arcSign * 0.65)));
      pts.push(ellipseLatPoint(0.25 * walkRx + 0.75 * enterRx, 0.25 * walkRz + 0.75 * enterRz, vomAngle, vomLat * 1.06, yVal));
      pts.push(ellipseLatPoint(enterRx, enterRz, vomAngle, vomLat, yVal));
    };

    if (parsed.isStanding) {
      ingressKind = 'festival';
      const l1 = _activeSpec.concourseL1;
      pts.push(v3(plazaInfo.portalClear));
      pts.push(v3(plazaInfo.concoursePort));
      pts.push(ellipsePoint(l1.walkRx, l1.walkRz, 0.56, plazaInfo.bearingDeg));
      pts.push(...buildConcourseArc(l1.walkRx, l1.walkRz, 0.56, plazaInfo.bearingDeg, 180.0, false));
      const tunEntry = new THREE.Vector3(0.0, 0.56, 136.0);
      vomIdx = pts.length;
      pts.push(
        tunEntry,
        new THREE.Vector3(0.0, 0.56, 120.0),
        new THREE.Vector3(0.0, 0.56, 104.2),
        new THREE.Vector3(0.0, 0.36, 102.0),
        new THREE.Vector3(0.0, 0.36, 91.0),
      );
      const laneX = seatPos.x >= 0 ? 28.0 : -28.0;
      const rawPitch = [
        new THREE.Vector3(laneX * 0.35, 0.36, 82.0),
        new THREE.Vector3(laneX * 0.85, 0.36, 68.0),
        new THREE.Vector3(laneX, 0.36, 55.2),
      ];
      const stopZ = (Math.abs(seatPos.x) < 9.0 && seatPos.z < -2.0)
        ? seatPos.z - 1.5
        : Math.max(seatPos.z + 6.0, -34.0);
      for (let z = 44.0; z > stopZ + 2.0; z -= 14.0) {
        rawPitch.push(new THREE.Vector3(laneX, 0.36, z));
      }
      if (Math.abs(seatPos.x) < 9.0 && seatPos.z < -2.0) {
        // Spot B-Stage: masuk dari sisi utara B-Stage agar tidak memotong platform B-Stage
        rawPitch.push(
          new THREE.Vector3(laneX, 0.36, -16.5),
          new THREE.Vector3(laneX * 0.42, 0.36, -17.2),
        );
      } else {
        rawPitch.push(new THREE.Vector3(laneX, 0.36, stopZ));
      }
      rawPitch.push(new THREE.Vector3(seatPos.x, 0.36, seatPos.z));
      pts.push(...avoidPitchObstacles(rawPitch, PITCH_OBSTACLES));
    } else if (tierName === 'tier2' || parsed.row > 25) {
      ingressKind = 'upper';
      const ts2 = _activeSpec.tier2;
      const l2 = _activeSpec.concourseL2;
      let vomAngle = nearestValidVomitory(bearingDeg, plazaInfo.bearingDeg);
      const signedVom = ((bearingDeg - vomAngle + 540) % 360) - 180;
      if (rowIdx < ts2.vomOpenRows && signedVom < 0) {
        const altVom = nearestValidVomitory(wrapDeg(bearingDeg - 14), plazaInfo.bearingDeg);
        if ((((bearingDeg - altVom + 540) % 360) - 180) >= 0) vomAngle = altVom;
      }
      chosenVomAngle = vomAngle;

      let bestRamp = OUTER_SPIRAL_RAMPS[0];
      let bestScore = Infinity;
      for (const ramp of OUTER_SPIRAL_RAMPS) {
        const sc = angularDelta(ramp.bearingDeg, vomAngle) * 0.65 + angularDelta(ramp.bearingDeg, plazaInfo.bearingDeg) * 0.35;
        if (sc < bestScore) {
          bestScore = sc;
          bestRamp = ramp;
        }
      }

      const diffB = ((bestRamp.bearingDeg - plazaInfo.bearingDeg + 540) % 360) - 180;
      const signB = diffB >= 0 ? 1 : -1;
      const absDiff = Math.abs(diffB);
      // Baru berbelok melengkung halus (R >= 2.5 m) ke apron depan pilar setelah >= 2.4 m lolos dari Turnstile
      // Catatan: +rt_vec berarah -dtheta (CCW), sehingga arah +signB (+dtheta, CW) bersesuaian dengan -signB * b
      pts.push(ptPlaza(2.2, -signB * 2.8, 0.39));
      pts.push(ptPlaza(4.6, -signB * 7.2, 0.40));
      pts.push(ptPlaza(8.8, -signB * 13.0, 0.42));
      const stepMid = Math.min(9.8, absDiff * 0.56);
      const endOff = Math.min(10.0, absDiff * 0.40);
      pts.push(ellipsePoint(132.5, 175.5, 0.42, wrapDeg(plazaInfo.bearingDeg + signB * stepMid)));
      if (absDiff > stepMid + endOff + 0.6) {
        pts.push(...buildConcourseArc(140.5, 185.0, 0.42, wrapDeg(plazaInfo.bearingDeg + signB * stepMid), wrapDeg(bestRamp.bearingDeg - signB * endOff), false));
      } else {
        pts.push(ellipsePoint(140.5, 185.0, 0.42, wrapDeg(bestRamp.bearingDeg - signB * endOff)));
      }
      const spiralPts = buildSpiralRampPoints(bestRamp, 64);
      rampBaseIdx = pts.length;
      pts.push(...spiralPts);
      pts.push(ellipsePoint(l2.rxOut - 0.2, l2.rzOut - 0.2, l2.floorY + 0.14, bestRamp.bearingDeg));
      pts.push(ellipsePoint(l2.walkRx, l2.walkRz, l2.floorY + 0.14, bestRamp.bearingDeg));

      // Susuri Upper Concourse lalu masuk fillet melengkung menuju mulut Vomitory Atas (lat = -2.8 m)
      const vomLat = ts2.vomLatOffset; // -2.8 m
      pushConcourseVomFillet(l2.walkRx, l2.walkRz, l2.rxIn + 1.0, l2.rzIn + 1.3, l2.floorY + 0.14, bestRamp.bearingDeg, vomAngle, vomLat);

      // Masuk Vomitory Atas (datar s/d baris 6 pada Z=24.54 -> tanjakan landai ke Row 0 Z=26.94)
      const r6x = ts2.rx0 + 6 * ts2.treadX;
      const r6z = ts2.rz0 + 6 * ts2.treadZ;
      const mouthY = ts2.baseY + 0.14;
      pts.push(ellipseLatPoint(r6x, r6z, vomAngle, vomLat, l2.floorY + 0.14));
      for (let stepK = 1; stepK <= 4; stepK += 1) {
        const frac = stepK / 4;
        const rkx = r6x + (ts2.rx0 - r6x) * frac;
        const rkz = r6z + (ts2.rz0 - r6z) * frac;
        pts.push(ellipseLatPoint(rkx, rkz, vomAngle, vomLat, l2.floorY + 0.14 + (mouthY - (l2.floorY + 0.14)) * frac));
      }

      const aisleRes = buildStraightRadialAisle('tier2', rowIdx, vomAngle, vomLat);
      vomIdx = pts.length + aisleRes.vomTurnIdx;
      const stairOffsetIdx = pts.length + aisleRes.stairStartIdx;
      pts.push(...aisleRes.pts);
      for (let si = stairOffsetIdx; si < pts.length; si += 1) {
        const spDeg = wrapDeg(THREE.MathUtils.radToDeg(Math.atan2(pts[si].x / GBK_RX, -pts[si].z / GBK_RZ)));
        stairAngularDevDeg = Math.max(stairAngularDevDeg, angularDelta(spDeg, vomAngle));
      }
    } else {
      ingressKind = 'lower';
      const ts1 = _activeSpec.tier1;
      const l1 = _activeSpec.concourseL1;
      let vomAngle = nearestValidVomitory(bearingDeg, plazaInfo.bearingDeg);
      if (plazaInfo.key === 'selatan' && angularDelta(bearingDeg, 165) <= 16.0) {
        vomAngle = 165;
      } else {
        const signedVom = ((bearingDeg - vomAngle + 540) % 360) - 180;
        if (rowIdx < ts1.vomOpenRows && signedVom < 0) {
          const altVom = nearestValidVomitory(wrapDeg(bearingDeg - 14), plazaInfo.bearingDeg);
          if ((((bearingDeg - altVom + 540) % 360) - 180) >= 0) vomAngle = altVom;
        }
      }
      chosenVomAngle = vomAngle;

      pts.push(v3(plazaInfo.portalClear));
      rampBaseIdx = pts.length;
      pts.push(v3(plazaInfo.concoursePort));
      pts.push(ellipsePoint(l1.walkRx, l1.walkRz, 0.56, plazaInfo.bearingDeg));
      const vomLat = ts1.vomLatOffset; // -2.8 m
      const rxEntry = l1.rxIn + 0.8;
      const rzEntry = l1.rzIn + 1.1;
      pushConcourseVomFillet(l1.walkRx, l1.walkRz, rxEntry, rzEntry, 0.56, plazaInfo.bearingDeg, vomAngle, vomLat);

      // Terowongan Vomitory Bawah lurus (lat = -2.8 m): Z=0.56 m (L1) -> Z=4.74 m (Row 0 Walkway)
      const mouthY = ts1.baseY + 0.14;
      for (let stepK = 1; stepK <= 5; stepK += 1) {
        const frac = stepK / 5;
        const rkx = rxEntry + (ts1.rx0 - rxEntry) * frac;
        const rkz = rzEntry + (ts1.rz0 - rzEntry) * frac;
        pts.push(ellipseLatPoint(rkx, rkz, vomAngle, vomLat, 0.56 + (mouthY - 0.56) * frac));
      }

      const aisleRes = buildStraightRadialAisle('tier1', rowIdx, vomAngle, vomLat);
      vomIdx = pts.length + aisleRes.vomTurnIdx;
      const stairOffsetIdx = pts.length + aisleRes.stairStartIdx;
      pts.push(...aisleRes.pts);
      for (let si = stairOffsetIdx; si < pts.length; si += 1) {
        const spDeg = wrapDeg(THREE.MathUtils.radToDeg(Math.atan2(pts[si].x / GBK_RX, -pts[si].z / GBK_RZ)));
        stairAngularDevDeg = Math.max(stairAngularDevDeg, angularDelta(spDeg, vomAngle));
      }
    }

    let aisleToSeatArc = [];
    if (!parsed.isStanding && pts.length > 0 && chosenVomAngle !== null) {
      const stopPt = pts[pts.length - 1];
      const rawRow = buildRowArc(tierName, rowIdx, rx, rz, chosenVomAngle, bearingDeg);
      aisleToSeatArc = [stopPt.clone(), ...rawRow, seatPos.clone().setY(seatPos.y + 0.18)];
    }

    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    let totalChord = 0;
    const cumChord = [0];
    for (let i = 1; i < pts.length; i += 1) {
      totalChord += pts[i].distanceTo(pts[i - 1]);
      cumChord.push(totalChord);
    }
    const uAt = (idx) => (totalChord > 0 ? cumChord[Math.min(idx, cumChord.length - 1)] / totalChord : 0);

    const pos2U = Math.min(0.62, Math.max(0.14, uAt(pos2Idx)));
    const pos3U = Math.min(0.68, Math.max(pos2U + 0.02, uAt(pos3Idx)));
    const rampBaseU = Math.min(0.88, Math.max(pos3U + 0.02, uAt(rampBaseIdx)));
    const pos4U = Math.min(0.978, Math.max(pos3U + 0.06, uAt(vomIdx)));
    const anchors = {
      pos1: 0.0,
      step0: 0.0,
      pos2: pos2U,
      pos3: pos3U,
      tentsEnd: pos3U,
      rampBase: rampBaseU,
      pos4: pos4U,
      mouth: pos4U,
      end: 1.0,
    };

    const { stepTitles, stepDescriptions } = this._make5PosCopy(parsed, gateInfo, sector, ingressKind);
    const lookAlong = (u, dy = 1.5, ahead = 0.04) => {
      const pAhead = curve.getPointAt(Math.min(1.0, u + ahead));
      return new THREE.Vector3(pAhead.x, pAhead.y + dy, pAhead.z);
    };
    const eyeAt = (u) => curve.getPointAt(u).add(new THREE.Vector3(0, WALK_EYE_OFFSET_Y, 0));

    const us = [0.0, pos2U, pos3U, pos4U, 1.0];
    const poses = [
      [eyeAt(0.0), lookAlong(0.0, 2.2, 0.05)],
      [eyeAt(pos2U), lookAlong(pos2U, 1.5, 0.04)],
      [eyeAt(pos3U), lookAlong(pos3U, 1.5, 0.04)],
      [eyeAt(pos4U), lookAlong(pos4U, 1.2, 0.03)],
      [eyeAt(1.0), seatLookAt],
    ];

    return {
      parsed,
      sector,
      gateInfo,
      plazaKey: plazaInfo.key,
      tierName,
      ingressKind,
      chosenVomAngle,
      stairAngularDevDeg: Math.round(stairAngularDevDeg * 1000) / 1000,
      geometrySpecVersion: _activeSpec.version || 'gbk_solid_v1',
      maxRouteY: sampleMaxRouteY(curve),
      bearingDeg,
      seatPos,
      beaconPos,
      seatEyePos: poses[4][0],
      seatLookAt,
      curve,
      points: pts,
      aisleToSeatArc,
      pathLength: Math.round(curve.getLength() * 100) / 100,
      anchors,
      waypoints: us.map((u, i) => ({
        u,
        progress: this.progressFromU(u, anchors),
        pos: poses[i][0],
        look: poses[i][1],
        title: stepTitles[i],
      })),
      stepTitles,
      stepDescriptions,
      usesCalibratedSouth: false,
    };
  }
}
