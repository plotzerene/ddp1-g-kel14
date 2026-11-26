/**
 * pov_3d_three.js — Renderer WebGL (Three.js) untuk pandangan orang pertama.
 *
 *   PovScene         membangun studio bioskop / Stadion GBK dari JSON layout Python,
 *                    menaruh kamera di posisi mata, dan menganimasikan semuanya
 *   MediaController  satu elemen <video> → VideoTexture di layar/LED + rantai Web Audio
 *                    (Delay, BiquadFilter, Convolver, Panner) yang disetir angka Python
 *
 * ATURAN: file ini tidak menghitung posisi mata, yaw/pitch, FOV, halangan, maupun
 * parameter akustik. Semua itu datang dari `/api/pov`. Yang ada di sini hanya
 * penggambaran (geometri dekoratif, shader, interpolasi halus antar-nilai Python).
 */
import * as THREE from 'three';
import { MODEL_SPECS, bakeParts, loadModel } from './model_assets.js';
import { WayfindingRouter, GBK_RX, GBK_RZ, gbkBowlY, applyGbkGeometrySpec, getGbkGeometrySpec } from './wayfinding_router.js';
import { MinimapRadar } from './minimap_controller.js';

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Mode wayfinding (?mode=wayfinding): tur 5-Pos di sepanjang kurva jalan (`gbk_wayfinding.json` & `WayfindingRouter`)
 * pada GLB eksterior GBK (`gbkExterior`). Koordinat GLB & JSON = koordinat app (x timur, y atas, z selatan).
 */
const WAY_DATA_URL = new URL('../models/gbk_wayfinding.json', import.meta.url);
const GEOM_SPEC_URL = new URL('../data/gbk_geometry_spec.json', import.meta.url);
const WAYPOINT_SEAT_ID = 'cat3:R14:S163';   // kursi acuan default bila URL tanpa ?seat=
const WAY_EYE = 1.65;                       // tinggi mata berjalan di rel kurva (m)
const WAY_FOV = 60;
const WAY_TWEEN_DURATION = 2.2;             // durasi transisi tombol auto-jump 2,2 detik (easeInOutCubic)
const WAY_RAIL_SPEED = 0.06;                // Δt per detik berjalan di rel (W / S / Panah Atas / Bawah)
const WAY_HOLD_SPEED = 0.042;               // Δt per detik menahan tombol panah tunggal [‹] / [›]
const WAY_CONCERT_PALETTE = [0xa5f3fc, 0x818cf8, 0xfde68a]; // spektrum konser tunggal luar–dalam: cool cyan, soft violet-blue, warm gold

/**
 * Timeline masuk studio bioskop (detik sejak viewport bioskop dibuka) — tanpa jeda tunggu:
 *   0     lampu ruangan langsung terang; layar hitam, video dijeda di frame 0; proyektor mati
 *   0–3   DIMMING : lampu ruangan meredup halus (smoothstep) → 0 tepat 3 detik
 *   2–3             proyektor menyala (berkas volumetrik) + layar fade-in dari hitam ke video
 *   3+    SHOWTIME: lampu ruangan padam total, trailer diputar, pantulan layar (SpotLight) mengikuti adegan
 * Lampu lorong (aisle step lights) tidak ikut dimming: menyala terus.
 */
const ENTRANCE = {
  hold: 0, dim: 3, houseOff: 0,   // tanpa jeda tunggu: meredup sejak detik 0 selama 3 detik
  ignite: 2, igniteFade: 1,       // proyektor + layar menyala di detik 2–3
  level: 0.65,                    // intensitas nominal ambient champagne lampu ruangan
  fill: 0.35,                     // fill ambient abu-abu netral
  key: 1.4,                       // downlight plafon depan-atas (nominal)
  backRatio: 0.45,                // fill belakang-atas relatif terhadap key
  keyGain: 1.0,                   // pengali satuan fisik three.js
  // Lantai kecerahan (baseline) saat showtime: ruangan tidak boleh menjadi ruang hampa hitam.
  floor: 0.14,                    // ambient minimum nominal 0,12–0,16, biru-malam sejuk #141926 — TIDAK pernah 0
  floorGain: 26,                  // pengali satuan fisik (#141926 sendiri hanya ±0,02 → tanpa pengali tak terlihat; dikalibrasi visual)
  bounceFloor: 0.10,              // pantulan layar minimum, walau frame film hitam
  bounceMax: 1.2,                 // pantulan dinamis 0,0 → 1,2 mengikuti kecerahan frame di atas lantai
  ambientGain: 2.4,               // pengali satuan fisik three.js (albedo kain/karpet gelap ≪ 1)
};

const XYLO_PALETTES = [
  [0x3d6bff, 0x25e07a, 0xff2d55],
  [0xffffff, 0xff8ad8, 0xc9b8ff],
  [0xffd23d, 0xff7a1a, 0xffffff],
  [0x9b5cff, 0x2de2e6, 0xff4fa3],
];

/** PRNG deterministik untuk dekorasi (posisi kerumunan, kelap-kelip). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function shortestAngle(from, to) {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

function getSmoothLookAheadYaw(curve, t) {
  const clampT = clamp(t, 0, 1);
  if (clampT >= 0.985) {
    const tan = curve.getTangentAt(clampT);
    return Math.atan2(-tan.x, -tan.z);
  }
  const p0 = curve.getPointAt(clampT);
  const p1 = curve.getPointAt(Math.min(1, clampT + 0.010));
  const p2 = curve.getPointAt(Math.min(1, clampT + 0.022));
  const p3 = curve.getPointAt(Math.min(1, clampT + 0.036));
  const dx = (p1.x - p0.x) * 0.45 + (p2.x - p0.x) * 0.35 + (p3.x - p0.x) * 0.20;
  const dz = (p1.z - p0.z) * 0.45 + (p2.z - p0.z) * 0.35 + (p3.z - p0.z) * 0.20;
  return Math.atan2(-dx, -dz);
}

/** Gabungkan beberapa geometri (posisi + normal) agar satu InstancedMesh cukup per bahan. */
function mergeGeometries(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((sum, g) => sum + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let offset = 0;
  for (const g of parts) {
    position.set(g.attributes.position.array, offset * 3);
    normal.set(g.attributes.normal.array, offset * 3);
    offset += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  for (const g of [...list, ...parts]) g.dispose();
  return merged;
}

function buildSmoothCameraYProfile(groundedPts, windowRadius = 4) {
  const n = groundedPts.length;
  const smoothY = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    let wSum = 0;
    for (let k = -windowRadius; k <= windowRadius; k += 1) {
      const idx = Math.max(0, Math.min(n - 1, i + k));
      const w = (windowRadius + 1) - Math.abs(k);
      sum += groundedPts[idx].y * w;
      wSum += w;
    }
    smoothY[i] = sum / wSum;
  }
  return groundedPts.map((p, i) => new THREE.Vector3(p.x, smoothY[i], p.z));
}

function boxPart(w, h, d, x, y, z, rotX = 0) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  if (rotX) geometry.rotateX(rotX);
  geometry.translate(x, y, z);
  return geometry;
}

/** Skala kedalaman (z) kursi hall GLB, dipakai bersama oleh penempatan kursi dan manekin penonton. */
const HALL_DEPTH_SCALE = 1.05;
const MOTION_SCALE = 1.05;
/**
 * Manekin duduk: titik asal = permukaan bantalan tepat di bawah pinggul; tubuh atas berputar ke belakang
 * terhadap sendi pinggul (`pivot` di atas bantalan). `back` = jarak pusat pinggul ke punggung (setengah tebal torso).
 */
const FIGURE = { pivot: 0.08, back: 0.1 };
/** Jarak barikade FOH dari tepi tenda (m); penonton Festival berdiri tepat di luarnya. */
const FOH_BARRIER = 1.6;

/** Interpolasi linear profil [[y, z], …] (urut naik menurut y), dijepit di kedua ujung. */
function sampleProfile(profile, y) {
  if (y <= profile[0][0]) return profile[0][1];
  for (let i = 1; i < profile.length; i += 1) {
    const [y1, z1] = profile[i];
    if (y <= y1) {
      const [y0, z0] = profile[i - 1];
      return z0 + ((z1 - z0) * (y - y0)) / (y1 - y0);
    }
  }
  return profile[profile.length - 1][1];
}

/**
 * Siluet penonton duduk low-poly yang proporsional (satu geometri → satu InstancedMesh): kepala bulat, leher,
 * bahu, torso, lengan di sandaran tangan, paha, betis, dan kaki. Menghadap −z, asal di bantalan (lihat FIGURE).
 * Tubuh atas direbahkan `recline` derajat agar punggung sejajar sandaran kursi.
 */
function seatedFigureGeometry({ recline = 0, cushion = 0.44, kneeZ = -0.42 } = {}) {
  const shape = (geometry, x, y, z, { rotX = 0, rotZ = 0, scale = null } = {}) => {
    if (scale) geometry.scale(...scale);
    if (rotZ) geometry.rotateZ(rotZ);
    if (rotX) geometry.rotateX(rotX);
    geometry.translate(x, y, z);
    return geometry;
  };
  const capsule = (radius, length, radial = 10) => new THREE.CapsuleGeometry(radius, Math.max(0.01, length), 3, radial);
  const pair = (make) => [-1, 1].map(make);
  const upper = [
    shape(capsule(0.13, 0.26), 0, 0.3, 0, { scale: [1.22, 1, 0.78] }),                            // torso 0,04–0,56
    shape(capsule(0.07, 0.25), 0, 0.53, 0.005, { rotZ: Math.PI / 2, scale: [1, 1, 0.85] }),        // bahu ±0,195
    ...pair((s) => shape(capsule(0.048, 0.2, 8), s * 0.205, 0.39, 0.01)),                         // lengan atas
    shape(new THREE.CylinderGeometry(0.046, 0.054, 0.13, 10), 0, 0.615, 0),                       // leher
    shape(new THREE.SphereGeometry(0.1, 14, 12), 0, 0.77, -0.008, { scale: [0.94, 1.08, 1] }),     // kepala
  ];
  const tilt = THREE.MathUtils.degToRad(recline);
  for (const geometry of upper) {
    geometry.translate(0, -FIGURE.pivot, 0);
    geometry.rotateX(tilt);                       // +x-rotasi = puncak kepala condong ke +z (ke sandaran)
    geometry.translate(0, FIGURE.pivot, 0);
  }
  const thigh = 0.02 - kneeZ;
  const lower = [
    shape(capsule(0.1, 0.17), 0, 0.09, 0, { rotZ: Math.PI / 2, scale: [1, 1, 0.9] }),              // panggul
    ...pair((s) => shape(capsule(0.075, thigh - 0.15), s * 0.1, 0.085, (0.02 + kneeZ) / 2, { rotX: Math.PI / 2 })),
    ...pair((s) => shape(capsule(0.055, cushion - 0.105, 8), s * 0.1, (0.165 - cushion) / 2, kneeZ + 0.02)),
    ...pair((s) => shape(new THREE.BoxGeometry(0.1, 0.08, 0.24), s * 0.1, 0.04 - cushion, kneeZ - 0.06)),
    ...pair((s) => shape(capsule(0.042, 0.24, 8), s * 0.235, 0.17, -0.1, { rotX: Math.PI / 2 })),  // lengan bawah
  ];
  const geometry = mergeGeometries([...upper, ...lower]);
  geometry.computeBoundingBox();
  return geometry;
}

function makeGlowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeStripeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 32;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 8, 32);
  g.fillStyle = '#6f6f78';
  g.fillRect(0, 0, 8, 11);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ========================================================================== */
/* Media: video + audio                                                       */
/* ========================================================================== */
/**
 * Karpet bioskop tebal (cut-pile): warna dasar polos gelap + derau serat sangat halus berkontras rendah
 * (±4%, sesekali serat ±8%). Tanpa kisi, garis ubin, atau motif terang — dari jauh mipmap meratakannya jadi polos.
 */
function makeCarpetTexture(hex) {
  const base = new THREE.Color(hex).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const rand = mulberry32(0x0e1118);
  for (let i = 0; i < size * size; i += 1) {
    const fiber = rand() < 0.03 ? (rand() - 0.5) * 0.16 : 0;
    const k = 1 + (rand() - 0.5) * 0.08 + fiber;
    image.data[i * 4] = clamp(base.r * 255 * k, 0, 255);
    image.data[i * 4 + 1] = clamp(base.g * 255 * k, 0, 255);
    image.data[i * 4 + 2] = clamp(base.b * 255 * k, 0, 255);
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Plafon gantung akustik: ubin 60 × 60 cm hitam matte dengan rangka T-bar tipis dan perforasi halus. */
function makeCeilingTexture(hex) {
  const base = new THREE.Color(hex);
  const css = (c) => `#${c.getHexString()}`;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = css(base.clone().offsetHSL(0, 0, 0.008));      // perforasi
  for (let y = 12; y < 128; y += 12) for (let x = 12; x < 128; x += 12) ctx.fillRect(x, y, 2, 2);
  ctx.strokeStyle = css(base.clone().offsetHSL(0, 0, 0.014));   // rangka T-bar (nyaris menyatu dengan hitam)
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Pendar cove light: amber di atas (sambungan dinding–plafon), memudar ke bawah di sepanjang dinding. */
function makeCoveTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Skala UV ke meter (1 ubin = `tile` m) agar motif karpet berukuran sama di lantai maupun undakan. */
function scaleUv(geometry, faces, tile) {
  const uv = geometry.attributes.uv;
  faces.forEach(([u, v], f) => {
    for (let i = 0; i < 4; i += 1) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * u) / tile, (uv.getY(k) * v) / tile);
    }
  });
  return geometry;
}

/** Plat decking pelindung rumput (modular turf protection): panel abu-abu gelap 2 × 2 m dengan sambungan tipis. */
function makeDeckTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#242933';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, 125, 125);
  ctx.fillStyle = '#191d23';                       // sedikit variasi agar tidak datar
  ctx.fillRect(10, 10, 108, 108);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.5, 0.5);                    // UV ShapeGeometry = meter → 1 tile = 2 m
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Gradasi alfa untuk kerucut sorot: terang di sumber (puncak), memudar ke ujung lebar. */
function makeBeamAlphaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, '#fff');                // baris atas kanvas = v 1 = puncak kerucut (sumber cahaya)
  gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(canvas);
}

class MediaController {
  constructor() {
    const video = document.createElement('video');
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    this.video = video;
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;

    // Fallback prosedural bila file video tidak ada / gagal diputar.
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = 320;
    this.procCanvas.height = 180;
    this.procCtx = this.procCanvas.getContext('2d');
    this.procTexture = new THREE.CanvasTexture(this.procCanvas);
    this.procTexture.colorSpace = THREE.SRGBColorSpace;
    this.usingFallback = true;
    this.fallbackPaused = false;
    this.loadingVideo = false;          // video diminta tetapi belum siap: tampilkan frame gelap, bukan animasi demo

    this.sampler = document.createElement('canvas');
    this.sampler.width = 16;
    this.sampler.height = 9;
    this.samplerCtx = this.sampler.getContext('2d', { willReadFrequently: true });
    this.color = { r: 0.25, g: 0.25, b: 0.4, luma: 0.25 };
    this.energy = 0;
    this.lastLuma = 0.25;

    this.materials = new Set();
    this.currentUrl = null;
    this.label = '';
    this.note = '';
    this.volume = 0.7;
    this.muted = true;
    this.profile = null;
    this.ctx = null;
    this.graph = null;
    this.forward = new THREE.Vector3();
    this.onChange = () => {};
    this.onAspect = () => {};

    video.addEventListener('loadeddata', () => {
      this.loadingVideo = false;
      this._useVideo();
    });
    video.addEventListener('loadedmetadata', () => this.onAspect(this.aspect));
    video.addEventListener('error', () => {
      this.loadingVideo = false;
      if (this.currentUrl) this._useFallback('Video tidak bisa diputar — memakai animasi pengganti.');
    });
    for (const type of ['play', 'pause']) video.addEventListener(type, () => this.onChange());
  }

  get texture() {
    return this.usingFallback ? this.procTexture : this.videoTexture;
  }

  get aspect() {
    const v = this.video;
    return !this.usingFallback && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  }

  get playing() {
    return this.usingFallback ? !this.fallbackPaused : !this.video.paused;
  }

  bind(material) {
    this.materials.add(material);
    material.map = this.texture;
  }

  _swapTexture() {
    for (const material of this.materials) {
      material.map = this.texture;
      material.needsUpdate = true;
    }
    this.onAspect(this.aspect);
    this.onChange();
  }

  _useVideo() {
    this.usingFallback = false;
    this.note = '';
    this._swapTexture();
  }

  _useFallback(note) {
    this.usingFallback = true;
    this.note = note;
    this._swapTexture();
  }

  setSource(url, label = '') {
    this.label = label;
    this.standbyActive = false;
    if (!url) {
      this.loadingVideo = false;
      this.currentUrl = null;
      this.video.removeAttribute('src');
      this.video.load();
      this._useFallback('File video belum ada di reference_assets/videos — memakai animasi pengganti.');
      return;
    }
    if (this.currentUrl !== url) {
      this.currentUrl = url;
      this.loadingVideo = true;
      this.video.src = url;
      this.video.load();
    }
    this.play();
  }

  play() {
    if (this.usingFallback && !this.currentUrl) {
      this.fallbackPaused = false;
      this.onChange();
      return;
    }
    const promise = this.video.play();
    if (promise) promise.catch(() => this.onChange());
  }

  /** Standby sebelum film mulai: video dijeda dan diputar ulang ke frame 0 (layar sendiri dihitamkan oleh adegan). */
  standby() {
    this.standbyActive = true;
    if (this.usingFallback && !this.currentUrl) {
      this.fallbackPaused = true;
      this.onChange();
      return;
    }
    const video = this.video;
    const rewind = () => {
      if (!this.standbyActive) return;
      video.pause();
      video.currentTime = 0;
    };
    rewind();
    if (video.readyState < 1) video.addEventListener('loadedmetadata', rewind, { once: true });
    this.onChange();
  }

  /** Akhiri standby: trailer diputar dari awal. */
  start() {
    this.standbyActive = false;
    if (!(this.usingFallback && !this.currentUrl) && this.video.readyState >= 1) this.video.currentTime = 0;
    this.play();
  }

  toggle() {
    if (this.usingFallback && !this.currentUrl) {
      this.fallbackPaused = !this.fallbackPaused;
      this.onChange();
    } else if (this.video.paused) {
      this.play();
    } else {
      this.video.pause();
    }
  }

  /** Dipanggil tiap frame: gambar animasi pengganti bila perlu. */
  tick(time) {
    if (!this.usingFallback || this.fallbackPaused) return;
    const g = this.procCtx;
    if (this.loadingVideo) {
      g.fillStyle = '#0a0b10';
      g.fillRect(0, 0, 320, 180);
      this.procTexture.needsUpdate = true;
      return;
    }
    const hue = (time * 24) % 360;
    const gradient = g.createLinearGradient(0, 0, 320, 180);
    gradient.addColorStop(0, `hsl(${hue}, 70%, 34%)`);
    gradient.addColorStop(1, `hsl(${(hue + 90) % 360}, 75%, 16%)`);
    g.fillStyle = gradient;
    g.fillRect(0, 0, 320, 180);
    for (let i = 0; i < 6; i += 1) {
      g.fillStyle = `hsla(${(hue + i * 55) % 360}, 90%, 62%, 0.4)`;
      g.beginPath();
      g.arc(160 + Math.sin(time * 0.7 + i) * 120, 90 + Math.cos(time * 0.9 + i * 1.7) * 60, 22 + i * 4, 0, TAU);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = '600 18px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('TiketPOV · video demo', 160, 96);
    this.procTexture.needsUpdate = true;
  }

  /** Rata-rata warna frame video → cahaya layar, warna Xyloband, pemicu efek 4DX. */
  sample() {
    const source = this.usingFallback ? this.procCanvas : this.video;
    if (!this.usingFallback && this.video.readyState < 2) return;
    try {
      this.samplerCtx.drawImage(source, 0, 0, 16, 9);
      const data = this.samplerCtx.getImageData(0, 0, 16, 9).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const n = (data.length / 4) * 255;
      r /= n;
      g /= n;
      b /= n;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const k = 0.35;
      this.color.r += (r - this.color.r) * k;
      this.color.g += (g - this.color.g) * k;
      this.color.b += (b - this.color.b) * k;
      this.color.luma += (luma - this.color.luma) * k;
      this.energy = this.energy * 0.6 + Math.min(1, Math.abs(luma - this.lastLuma) * 6) * 0.4;
      this.lastLuma = luma;
    } catch (error) {
      /* frame belum siap: lewati sampel ini */
    }
  }

  /* •••••••••••• Web Audio •••••••••••• */
  /** Harus dipanggil dari gesture pengguna (klik). */
  async unlockAudio() {
    if (!this.graph) this._buildGraph();
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.profile) this.applyAcoustics(this.profile);
    return Boolean(this.graph);
  }

  _buildGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      const ctx = new AudioContextClass();
      const source = ctx.createMediaElementSource(this.video);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 20000;
      lowpass.Q.value = 0.7;
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;            // redaman jarak sudah dihitung Python
      const dry = ctx.createGain();
      const convolver = ctx.createConvolver();
      const wet = ctx.createGain();
      wet.gain.value = 0;
      const echoDelay = ctx.createDelay(2.0);
      const echoGain = ctx.createGain();
      echoGain.gain.value = 0;
      const master = ctx.createGain();
      master.gain.value = 0;

      // ponytail: jeda rambat suara (acoustics.delay_ms) sengaja tidak diterapkan — suara harus sinkron
      // dengan gambar di layar 3D. Angkanya tetap tampil di "Spesifikasi Teknis".
      source.connect(analyser);
      source.connect(lowpass);
      source.connect(echoDelay);
      echoDelay.connect(echoGain);
      echoGain.connect(lowpass);
      lowpass.connect(panner);
      panner.connect(dry);
      dry.connect(master);
      lowpass.connect(convolver);
      convolver.connect(wet);
      wet.connect(master);
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.graph = { analyser, lowpass, panner, dry, convolver, wet, echoDelay, echoGain, master };
      this.spectrum = new Uint8Array(analyser.frequencyBinCount);
      this.irRt60 = 0;
      this.video.muted = false;            // suara kini lewat graph; senyap/tidak diatur master gain
      this.video.volume = 1;               // cegah video.volume=0 memblokir sampel menuju MediaElementAudioSourceNode
      this._applyGain();
    } catch (error) {
      this.graph = null;
    }
  }

  _applyGain() {
    const level = this.muted ? 0 : this.volume * (this.profile ? this.profile.gain : 1);
    if (this.graph) {
      this.video.muted = false;
      if (this.video.volume !== 1) this.video.volume = 1;
      if (!this.muted && this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      this.graph.master.gain.setTargetAtTime(level, this.ctx.currentTime, 0.05);
    } else {
      this.video.muted = this.muted;
      this.video.volume = clamp(level, 0, 1);
    }
  }

  async setMuted(muted) {
    this.muted = muted;
    if (!muted) {
      if (this.volume <= 0) this.volume = 0.7;
      await this.unlockAudio();
    }
    this._applyGain();
    this.onChange();
  }

  async setVolume(volume) {
    this.volume = clamp(volume, 0, 1);
    if (this.volume > 0 && this.muted) {
      await this.setMuted(false);
      return;
    }
    if (this.volume === 0 && !this.muted) {
      await this.setMuted(true);
      return;
    }
    this._applyGain();
    this.onChange();
  }

  /** Terapkan `acoustics.web_audio` dari Python ke node Web Audio. */
  applyAcoustics(profile) {
    this.profile = profile;
    this._applyGain();
    if (!this.graph) return;
    const now = this.ctx.currentTime;
    const { lowpass, panner, dry, wet, echoDelay, echoGain, convolver } = this.graph;
    lowpass.frequency.setTargetAtTime(profile.lowpass_hz, now, 0.08);
    wet.gain.setTargetAtTime(profile.reverb_wet, now, 0.1);
    dry.gain.setTargetAtTime(1 - profile.reverb_wet * 0.5, now, 0.1);
    echoDelay.delayTime.setTargetAtTime(clamp(profile.echo_delay_s, 0, 1.9), now, 0.12);
    echoGain.gain.setTargetAtTime(profile.echo_gain, now, 0.1);
    const [x, y, z] = profile.source_position;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, now, 0.1);
      panner.positionY.setTargetAtTime(y, now, 0.1);
      panner.positionZ.setTargetAtTime(z, now, 0.1);
    } else {
      panner.setPosition(x, y, z);
    }
    if (Math.abs(this.irRt60 - profile.reverb_rt60_s) > 0.05) {
      this.irRt60 = profile.reverb_rt60_s;
      convolver.buffer = this._impulse(profile.reverb_rt60_s);
    }
  }

  /** Impulse response sintetis: derau yang meluruh −60 dB tepat pada RT60. */
  _impulse(rt60) {
    const duration = clamp(rt60, 0.2, 4.0);
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * Math.exp((-6.91 * i) / (rate * duration));
      }
    }
    return buffer;
  }

  bassLevel() {
    if (!this.graph) return 0;
    this.graph.analyser.getByteFrequencyData(this.spectrum);
    let sum = 0;
    for (let i = 1; i < 9; i += 1) sum += this.spectrum[i];
    return sum / (8 * 255);
  }

  updateListener(camera) {
    if (!this.graph) return;
    const listener = this.ctx.listener;
    const p = camera.position;
    camera.getWorldDirection(this.forward);
    const f = this.forward;
    if (listener.positionX) {
      listener.positionX.value = p.x;
      listener.positionY.value = p.y;
      listener.positionZ.value = p.z;
      listener.forwardX.value = f.x;
      listener.forwardY.value = f.y;
      listener.forwardZ.value = f.z;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else {
      listener.setPosition(p.x, p.y, p.z);
      listener.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }
}

/* ========================================================================== */
/* Scene                                                                      */
/* ========================================================================== */
export class PovScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} host  pembungkus yang menentukan ukuran canvas
   */
  constructor(canvas, host) {
    this.canvas = canvas;
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.4, 1600.0);
    this.camera.rotation.order = 'YXZ';
    this.world = new THREE.Group();      // geometri venue
    this.local = new THREE.Group();      // detail di sekitar kursi terpilih
    this.scene.add(this.world, this.local);
    this.wayGroup = new THREE.Group();   // GLB eksterior + lampunya; di luar `world` supaya tidak ikut dibuang loadVenue
    this.wayGroup.visible = false;
    this.scene.add(this.wayGroup);
    this.wayfinding = null;              // { step, u, tween } selama tur wayfinding aktif
    this._wayKeys = new Set();
    this._wayManualDir = 0;
    this._latchedForwardSign = null;     // dikunci 1x saat keydown/pointerdown agar belokan U 100% bebas jitter
    this._waySnapYaw = true;
    this.onWayfindingProgress = null;
    this._wayLoad = null;
    this._way = null;                    // aset terpasang: kurva, zona, InstancedMesh, pita rute, lampu panggung, langit
    this._wayCamCurve = null;            // kurva elevasi kamera halus terpisah dari mikro-undakan pita lantai
    this._waySnapCamY = true;
    this.minimap = null;                 // MinimapRadar 2D top-down HUD saat mode wayfinding aktif

    this.layout = null;
    this.pov = null;
    this.updaters = [];
    this.screenMeshes = [];
    this.sharedMaterials = [];
    this.sharedTextures = [];
    this.concertPhase = 'peak_show';
    this.stadiumAtmo = null;
    this.spatialTour = null;
    this.crowdCenter = null;
    this.crowdRadius = 0;
    this.uiTheme = (document.documentElement.getAttribute('data-theme') || 'dark');
    this.fourDX = { on: false, level: 0, config: null, pivot: null };
    this.sampleTimer = 0;
    this.onAspect = null;
    this.onInteract = null;

    this.media = new MediaController();
    this.media.onAspect = () => this.screenMeshes.forEach((mesh) => this._fitScreenUV(mesh));
    this.glowTexture = makeGlowTexture();
    this.stripeTexture = makeStripeTexture();
    this.vivid = new THREE.Color(0x4f7cff);
    this.clock = new THREE.Clock();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Nilai kamera: `goal` = angka dari Python, `view` = nilai yang sedang ditampilkan (dihaluskan).
    this.view = { pos: new THREE.Vector3(0, 1.2, 10), yaw: 0, pitch: 0, fov: 55 };
    this.goal = { pos: new THREE.Vector3(0, 1.2, 10), yaw: 0, pitch: 0, fov: 55 };
    this.look = { yaw: 0, pitch: 0, yawNow: 0, pitchNow: 0 };   // offset dari seretan pengguna
    this.damping = 5;
    this.idleResetMs = 3000;
    this._idleTimer = null;
    this._isDragging = false;
    this._autoResetting = false;

    // Hook debugging: buka halaman dengan ?debug3d lalu pakai `__pov` di console (kamera, statistik render).
    if (new URLSearchParams(window.location.search).has('debug3d')) window.__pov = this;

    this._bindPointer();
    this._bindWayKeys();
    window.addEventListener('titiket:themechange', (event) => {
      const next = (event && event.detail && event.detail.theme) || 'dark';
      this.uiTheme = next;
      if (this.renderer) {
        this.renderer.toneMappingExposure = next === 'light' ? 1.08 : 1.12;
      }
    });
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(host);
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  /* •••••••••••• Utilitas •••••••••••• */
  _std(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, depthWrite: true, depthTest: true, ...extra });
  }

  _basic(color, extra = {}) {
    return new THREE.MeshBasicMaterial({ color, depthWrite: true, depthTest: true, ...extra });
  }

  _glowMaterial(color, opacity) {
    return new THREE.MeshBasicMaterial({
      color, map: this.glowTexture, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
  }

  _box(w, h, d, material, x, y, z, parent = this.world) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  /** Bahan yang dipakai lintas grup: tidak ikut dibuang saat detail kursi dibangun ulang. */
  _shared(material) {
    material.userData.shared = true;
    this.sharedMaterials.push(material);
    return material;
  }

  _clearGroup(group) {
    group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        if (!material.userData.shared) material.dispose();
      }
      if (object.isInstancedMesh) object.dispose();
    });
    group.clear();
  }

  resize(explicitWidth, explicitHeight) {
    const width = Math.max(1, Math.floor(explicitWidth || this.host.clientWidth));
    const height = Math.max(1, Math.floor(explicitHeight || this.host.clientHeight));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.onAspect) this.onAspect(width / height);
  }

  _resize() {
    this.resize();
  }

  get aspect() {
    return this.camera.aspect;
  }

  /* •••••••••••• Kontrol kamera •••••••••••• */
  _clearIdleReset() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._autoResetting = false;
  }

  _scheduleIdleReset() {
    if (this._isDragging) return;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this.resetLook({ auto: true });
    }, this.idleResetMs);
  }

  _bindPointer() {
    const canvas = this.canvas;
    let lastX = 0;
    let lastY = 0;
    const limitPitch = () => {
      const base = this.wayfinding ? this.view.pitch : this.goal.pitch;
      this.look.pitch = clamp(this.look.pitch, -1.45 - base, 1.45 - base);
    };

    canvas.addEventListener('pointerdown', (event) => {
      this._isDragging = true;
      this._clearIdleReset();
      this.stopSpatialRoute();
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
      if (this.onInteract) this.onInteract();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this._isDragging) return;
      this._clearIdleReset();
      const radPerPixel = THREE.MathUtils.degToRad(this.camera.fov) / Math.max(1, canvas.clientHeight);
      this.look.yaw += (event.clientX - lastX) * radPerPixel;
      this.look.pitch += (event.clientY - lastY) * radPerPixel;
      limitPitch();
      lastX = event.clientX;
      lastY = event.clientY;
    });
    const stop = () => {
      this._isDragging = false;
      canvas.classList.remove('is-dragging');
      if (!this.wayGroup.visible && (Math.abs(this.look.yaw) > 0.002 || Math.abs(this.look.pitch) > 0.002)) {
        this._scheduleIdleReset();
      }
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('dblclick', () => this.resetLook());
    canvas.addEventListener('keydown', (event) => {
      if (this.wayGroup.visible && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        return; // Dalam mode wayfinding, Panah Atas/Bawah menggerakkan rel lewat _bindWayKeys
      }
      const step = THREE.MathUtils.degToRad(6);
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) {
        event.preventDefault();
        this._clearIdleReset();
        this.stopSpatialRoute();
        this.look.yaw += moves[event.key][0];
        this.look.pitch += moves[event.key][1];
        limitPitch();
        this._scheduleIdleReset();
        if (this.onInteract) this.onInteract();
      } else if (event.key === 'Home' || event.key === '0') {
        this.resetLook();
      }
    });
  }

  /** Kembali ke arah pandang yang dihitung Python. */
  resetLook({ auto = false } = {}) {
    if (!auto) this._clearIdleReset();
    this.look.yaw = 0;
    this.look.pitch = 0;
    if (auto) this._autoResetting = true;
  }

  /* •••••••••••• Memuat venue •••••••••••• */
  loadVenue(layout) {
    this._clearGroup(this.world);
    this._clearGroup(this.local);
    for (const material of this.sharedMaterials) material.dispose();
    this.sharedMaterials = [];
    for (const texture of this.sharedTextures) texture.dispose();
    this.sharedTextures = [];
    this.media.materials.clear();
    this.updaters = [];
    this.screenMeshes = [];
    this.layout = layout;
    this.pov = null;
    this.spectators = null;
    this.seatFit = null;
    this.seatSets = null;
    this.farCrowd = null;
    this.xylo = null;
    this.frontGroup = null;
    this.lightSeq = null;
    this.houseLit = null;
    this.stadiumAtmo = null;
    this.spatialTour = null;
    this.wayfinding = null;
    this._wayKeys.clear();
    this.wayGroup.visible = false;
    this.world.visible = true;
    this.local.visible = true;
    this.concertPhase = 'peak_show';
    this.crowdCenter = null;
    this.crowdRadius = 0;
    this.uiTheme = (document.documentElement.getAttribute('data-theme') || 'dark');
    this.fourDX = { on: false, level: 0, config: null, pivot: null };
    this.scene.fog = null;
    if (layout.kind === 'cinema') this._buildCinema(layout);
    else this._buildStadium(layout);
    this.media.setSource(layout.media.video, layout.media.video_label);
    if (layout.kind === 'cinema') this.media.standby();       // film menunggu sampai lampu ruangan mulai meredup
  }

  /* •••••••••••• Layar / LED •••••••••••• */
  _buildSurface(surface, parent = this.world) {
    let geometry;
    if (surface.shape === 'curved') {
      geometry = this._curvedScreenGeometry(surface);
    } else {
      if (surface.shape === 'circle') {
        geometry = new THREE.CircleGeometry(surface.width / 2, 72);
      } else if (surface.shape === 'semicircle') {
        geometry = new THREE.CircleGeometry(surface.width / 2, 48, 0, Math.PI);
        geometry.translate(0, -surface.height / 2, 0);
      } else {
        geometry = new THREE.PlaneGeometry(surface.width, surface.height);
      }
      const position = geometry.attributes.position;
      const base = new Float32Array(position.count * 2);
      for (let i = 0; i < position.count; i += 1) {
        base[i * 2] = position.getX(i) / surface.width + 0.5;
        base[i * 2 + 1] = position.getY(i) / surface.height + 0.5;
      }
      geometry.userData.baseUV = base;
    }
    // Layar/videotron: opaque solid, wajib menulis & menguji depth agar sinar cahaya tidak tembus.
    const material = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: false, depthWrite: true, depthTest: true, colorWrite: true });
    this.media.bind(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0;
    if (surface.shape !== 'curved') {
      mesh.position.set(...surface.center);
      mesh.rotation.y = surface.yaw_rad;
    }
    mesh.userData.surface = surface;
    this.screenMeshes.push(mesh);
    this._fitScreenUV(mesh);
    parent.add(mesh);
    return mesh;
  }

  /** Layar lengkung dibangun dari titik busur yang dihitung Python (`screen.arc`). */
  _curvedScreenGeometry(surface) {
    const arc = surface.arc;
    const n = arc.length - 1;
    const half = surface.height / 2;
    const position = new Float32Array((n + 1) * 6);
    const uv = new Float32Array((n + 1) * 4);
    const base = new Float32Array((n + 1) * 4);
    const index = [];
    arc.forEach(([x, y, z], i) => {
      position.set([x, y - half, z, x, y + half, z], i * 6);
      base.set([i / n, 0, i / n, 1], i * 4);
      if (i < n) index.push(i * 2, (i + 1) * 2, i * 2 + 1, i * 2 + 1, (i + 1) * 2, (i + 1) * 2 + 1);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.userData.baseUV = base;
    return geometry;
  }

  /** Video di-"cover" ke bentuk layar (seperti object-fit: cover). */
  _fitScreenUV(mesh) {
    const geometry = mesh.geometry;
    const base = geometry.userData.baseUV;
    const surface = mesh.userData.surface;
    const surfaceAspect = surface.width / surface.height;
    const videoAspect = this.media.aspect;
    const scaleU = videoAspect > surfaceAspect ? surfaceAspect / videoAspect : 1;
    const scaleV = videoAspect > surfaceAspect ? 1 : videoAspect / surfaceAspect;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i += 1) {
      uv.setXY(i, 0.5 + (base[i * 2] - 0.5) * scaleU, 0.5 + (base[i * 2 + 1] - 0.5) * scaleV);
    }
    uv.needsUpdate = true;
  }

  /* ======================================================================= */
  /* BIOSKOP                                                                 */
  /* ======================================================================= */
  _buildCinema(L) {
    const { room, theme, spec, screen } = L;
    const W = room.width;
    const D = room.depth;
    const H = room.height;
    const z0 = room.wall_z;
    const length = D - z0;
    const zMid = (D + z0) / 2;
    this.scene.background = new THREE.Color(0x08090c);

    // Ruangan: kotak dilihat dari dalam + lantai, plafon, dinding depan hitam. Palet bioskop modern (dari tema):
    // panel akustik arang, pilar & slat walnut gelap/hitam-abu, plafon hitam pekat, karpet motif biru dongker/abu gelap.
    const matte = { roughness: 0.95, metalness: 0 };      // kain/cat matte total, tanpa kilau & tanpa emissive
    // Cat studio sengaja gelap agar film menonjol. Saat lampu ruangan menyala, reflektansi dinding/plafon/karpet
    // diangkat sementara (`lit`) supaya interior terbaca jelas, lalu kembali ke warna asli saat lampu padam.
    const lit = [];
    this.houseLit = lit;                       // juga dipakai kursi (kulit sofa) yang dimuat belakangan
    const hsl = { h: 0, s: 0, l: 0 };
    const roomMaterial = (color, extra, { lift = 0.07, cap = 0.15, boost = 0, sat = 0.12 } = {}) => {
      const material = this._std(color, extra);
      const base = material.color.clone();
      const lifted = base.clone();
      if (boost) lifted.multiplyScalar(boost);
      else {
        lifted.getHSL(hsl);
        lifted.setHSL(hsl.h, Math.min(hsl.s, sat), Math.min(cap, hsl.l + lift));      // saturasi dibatasi: tetap netral/arang
      }
      lit.push({ material, base, lifted });
      return material;
    };
    // Dinding polos = alur bayangan (shadow reveal) di antara panel kain; panelnya dipasang terpisah di bawah.
    const shell = new THREE.Mesh(new THREE.BoxGeometry(W, H, length), this._std(0x05060a, { ...matte, side: THREE.BackSide }));
    shell.position.set(0, H / 2, zMid);
    this.world.add(shell);
    const tile = 0.8;
    const carpetTexture = makeCarpetTexture(theme.carpet);
    this.sharedTextures.push(carpetTexture);
    const carpet = roomMaterial(0xffffff, { roughness: 0.98, metalness: 0, map: carpetTexture }, { boost: 1.7 });
    const floor = new THREE.Mesh(scaleUv(new THREE.PlaneGeometry(W, length), [[W, length]], tile), carpet);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.003, zMid);
    // Plafon gantung akustik HITAM MATTE pekat: grid ubin 60 × 60 cm + slot diffuser AC linear hitam.
    const ceilingTexture = makeCeilingTexture(theme.ceiling);
    this.sharedTextures.push(ceilingTexture);
    const ceiling = new THREE.Mesh(scaleUv(new THREE.PlaneGeometry(W, length), [[W, length]], 0.6),
      roomMaterial(0xffffff, { roughness: 0.98, metalness: 0, map: ceilingTexture }, { boost: 1.25 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, H - 0.003, zMid);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this._basic(0x020202));
    front.position.set(0, H / 2, z0 + 0.01);
    this.world.add(floor, ceiling, front);

    // Undakan tiap baris.
    const treadStart = (row) => row.z - spec.row_depth / 2 - 0.1;
    const nosing = this._std(0x15161a, matte);
    L.rows.forEach((row, i) => {
      if (row.y <= 0) return;
      const start = treadStart(row);
      const end = i === L.rows.length - 1 ? D : treadStart(L.rows[i + 1]);
      const w = W; const h = row.y; const d = end - start;
      const tread = new THREE.Mesh(scaleUv(new THREE.BoxGeometry(w, h, d),
        [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]], tile), carpet);
      tread.position.set(0, h / 2, (start + end) / 2);
      this.world.add(tread);
      this._box(W, 0.02, 0.05, nosing, 0, row.y + 0.011, start + 0.03);
    });
    const floorAt = (z) => {
      let y = 0;
      for (const row of L.rows) if (treadStart(row) <= z) y = row.y;
      return y;
    };

    // Lampu lorong (aisle step lights): titik LED amber kecil di tepi tiap undakan sepanjang lorong samping.
    // Material unlit dan TIDAK terhubung ke lampu ruangan/dimming → menyala terus, juga saat film diputar
    // (standar keselamatan bioskop). Dua lapis: inti LED #FEF3C7 + pendar lembut amber #F59E0B (opacity 0.4)
    // yang jatuh ke lantai.
    const ledsPerStep = 5;
    const sideX = [-(W / 2 - 0.3), W / 2 - 0.3];
    const ledCount = L.rows.length * sideX.length * ledsPerStep;
    const ledGlowGeometry = new THREE.PlaneGeometry(0.5, 0.5);
    ledGlowGeometry.rotateX(-Math.PI / 2);
    const ledGlow = new THREE.InstancedMesh(ledGlowGeometry, this._shared(new THREE.MeshBasicMaterial({
      map: this.glowTexture, color: 0xf59e0b, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false })), ledCount);
    const ledCore = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.025, 0.07),
      this._shared(this._basic(0xfef3c7, { toneMapped: false })), ledCount);
    const matrix = new THREE.Matrix4();
    let count = 0;
    for (const row of L.rows) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < ledsPerStep; k += 1) {
          const x = side * (W / 2 - 0.3 - k * 0.22);
          matrix.makeTranslation(x, row.y + 0.03, treadStart(row) + 0.07);
          ledCore.setMatrixAt(count, matrix);
          matrix.makeTranslation(x, row.y + 0.016, treadStart(row) + 0.07);
          ledGlow.setMatrixAt(count, matrix);
          count += 1;
        }
      }
    }
    ledGlow.frustumCulled = false;
    ledCore.frustumCulled = false;
    this.world.add(ledGlow, ledCore);

    // Plakat huruf baris di dinding samping (terbaca saat lampu ruangan menyala, gelap saat film diputar).
    const plaqueGeometry = new THREE.PlaneGeometry(0.34, 0.34);
    const letterTextures = new Map();
    const letterMaterial = (letter) => {
      if (!letterTextures.has(letter)) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1b1c20';
        ctx.fillRect(0, 0, 64, 64);
        ctx.strokeStyle = '#b8955a';
        ctx.lineWidth = 3;
        ctx.strokeRect(3, 3, 58, 58);
        ctx.fillStyle = '#f3e7d0';
        ctx.font = '700 38px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, 32, 34);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        this.sharedTextures.push(texture);
        letterTextures.set(letter, this._shared(this._std(0xffffff, { map: texture, roughness: 0.95, metalness: 0 })));
      }
      return letterTextures.get(letter);
    };
    for (const row of L.rows) {
      for (const side of [-1, 1]) {
        const plaque = new THREE.Mesh(plaqueGeometry, letterMaterial(row.letter));
        plaque.position.set(side * (W / 2 - 0.11), row.y + 1.0, row.z);
        plaque.rotation.y = -side * Math.PI / 2;
        this.world.add(plaque);
      }
    }

    // Dinding: modul panel kain akustik lebar (fabric-wrapped) dengan alur bayangan tipis di antaranya, dibingkai pilar.
    // Regular/IMAX/4DX: slate charcoal; The Premiere: mocha gelap + pilar walnut. Tanpa jeruji/bilah vertikal.
    const pilaster = roomMaterial(theme.wall_accent, matte, { lift: 0.012, cap: 0.035, sat: 0.1 });
    const pilasterZ = [];
    for (let z = 2.6; z < D - 0.6; z += 2.6) pilasterZ.push(z);
    for (const z of pilasterZ) {
      for (const side of [-1, 1]) this._box(0.1, H, 0.55, pilaster, side * (W / 2 - 0.05), H / 2, z);
    }
    const panelZ = [];
    for (let z = z0 + 0.55; z < D - 0.45; z += 1.04) if (pilasterZ.every((p) => Math.abs(z - p) > 0.82)) panelZ.push(z);
    const tiers = Math.max(2, Math.ceil((H - 0.3) / 2.4));
    const tierHeight = (H - 0.3) / tiers;
    const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, tierHeight - 0.04, 1.0),
      roomMaterial(0xffffff, matte, { boost: 3 }), panelZ.length * tiers * 2);
    const fabric = new THREE.Color(theme.wall);
    const swatch = new THREE.Color();
    const rand = mulberry32(hashString(L.venue_id));
    let panelIndex = 0;
    panelZ.forEach((z) => {
      for (let tier = 0; tier < tiers; tier += 1) {
        for (const side of [-1, 1]) {
          panels.setMatrixAt(panelIndex, new THREE.Matrix4().makeTranslation(
            side * (W / 2 - 0.025), 0.15 + (tier + 0.5) * tierHeight, z));
          panels.setColorAt(panelIndex, swatch.copy(fabric).multiplyScalar(0.9 + rand() * 0.2));   // variasi kain halus
          panelIndex += 1;
        }
      }
    });
    panels.frustumCulled = false;
    this.world.add(panels);

    // Speaker surround dinding: 4 kotak hitam matte di tiap dinding (siluet, dengan satu driver bundar).
    const speakerBody = this._std(0x090a0f, { roughness: 0.92, metalness: 0 });
    const speakerCone = this._std(0x14151b, { roughness: 0.9, metalness: 0 });
    for (let i = 0; i < 4; i += 1) {
      const z = z0 + 3 + ((length - 6) * i) / 3;
      const y = Math.min(H - 1.2, floorAt(z) + 3.0);
      for (const side of [-1, 1]) {
        this._box(0.3, 0.75, 0.45, speakerBody, side * (W / 2 - 0.2), y, z);
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 20), speakerCone);
        cone.rotation.z = Math.PI / 2;
        cone.position.set(side * (W / 2 - 0.36), y, z);
        this.world.add(cone);
      }
    }

    // Slot diffuser AC linear (hitam) memanjang di plafon: tiga jalur putus-putus.
    const slotMaterial = this._std(0x020203, { roughness: 0.9, metalness: 0 });
    for (const x of [-W * 0.3, 0, W * 0.3]) {
      for (let z = z0 + 2; z < D - 4; z += 5) this._box(0.14, 0.03, 3.8, slotMaterial, x, H - 0.015, z + 1.9);
    }

    // Layar + pencahayaan bioskop asli: saat film diputar satu-satunya sumber cahaya utama adalah pantulan layar.
    const screenMesh = this._buildSurface(screen);
    // Ambient LANTAI (selalu menyala, juga saat showtime): biru-malam/charcoal sejuk #141926 dengan intensitas nominal 0,14.
    // Warnanya dipakai sebagai RONA dingin (dinormalkan ke kanal terbesar) karena #141926 mentah ≈ 0,02 cahaya; kontur
    // kursi, sandaran kepala, dan siluet penonton tetap samar-samar terbaca bahkan saat frame film hitam pekat.
    const floorTint = new THREE.Color(0x141926);
    floorTint.multiplyScalar(1 / Math.max(floorTint.r, floorTint.g, floorTint.b));
    const ambient = new THREE.AmbientLight(floorTint, ENTRANCE.floor * ENTRANCE.floorGain);
    // SpotLight lembut persis di depan layar, menghadap kursi penonton. decay 2 (hukum kuadrat terbalik):
    // baris depan (A–C) lebih terang, makin ke belakang makin remang. `intensity` 1,2–1,5 dinyatakan sebagai
    // iluminasi di pusat penonton, jadi kandela = 1,35 × jarak² (satuan fisik three.js).
    const screenLight = new THREE.SpotLight(0xf0f0ff, 1, 0, 0.66, 1, 2);       // kerucut ±38°: ke kursi, bukan ke plafon/dinding
    screenLight.position.set(0, screen.center[1], 1.2);
    const audience = new THREE.Vector3(0, floorAt(zMid) + 1.0, zMid + 2);
    screenLight.target.position.copy(audience);
    const referenceDistance = screenLight.position.distanceTo(audience);
    const neutral = new THREE.Color(0xf0f0ff);
    const tint = new THREE.Color();

    // Lampu ruangan (house lights), terang di detik 0 lalu meredup ke 0 selama 3 detik: (1) ambient warm champagne #FFE8D6 intensitas nominal 0,65
    // yang menyinari kursi & lorong merata tanpa bayangan ekstrem, (2) cove light: pendar amber lembut dari sambungan
    // dinding–plafon ke panel dinding. Tidak ada titik lampu di plafon (tidak ada lingkaran spotlight).
    const houseAmbient = new THREE.AmbientLight(0xffe8d6, 0);
    // Fill ambient abu-abu netral (nominal 0,35): bayangan di bawah kursi tidak menjadi lubang hitam.
    const houseFill = new THREE.AmbientLight(0xa9a9a9, 0);
    // Downlight terfokus dari plafon depan-atas ([0, 6,5, 2] = dekat layar), menyorot miring ke deretan kursi: warm white 3200K
    // (#FFF1E0), nominal 1,4 di detik 0 lalu meredup halus ke 0 pada detik 0–3. (Sumbu z kursi kita positif ke belakang studio,
    // jadi targetnya pusat penonton, bukan z negatif.) DirectionalLight = merata di semua baris, tanpa bayangan keras.
    const houseKey = new THREE.DirectionalLight(0xfff1e0, 0);
    houseKey.position.set(0, Math.min(H - 0.4, 6.5), 2);
    houseKey.target.position.set(0, floorAt(zMid) + 0.3, zMid);
    // Fill lemah dari belakang-atas: penonton melihat PUNGGUNG kursi di depannya, yang tak tersentuh cahaya dari depan.
    const houseBack = new THREE.DirectionalLight(0xfff1e0, 0);
    houseBack.position.set(0, Math.min(H - 0.4, floorAt(D) + 5.5), D - 1);
    houseBack.target.position.set(0, floorAt(zMid) + 0.3, zMid - 2);
    const coveTexture = makeCoveTexture();
    this.sharedTextures.push(coveTexture);
    const coveMaterial = this._shared(new THREE.MeshBasicMaterial({
      map: coveTexture, color: 0xffa94d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false }));
    for (const side of [-1, 1]) {
      const cove = new THREE.Mesh(new THREE.PlaneGeometry(length, Math.min(3.2, H * 0.3)), coveMaterial);
      cove.position.set(side * (W / 2 - 0.075), H - Math.min(3.2, H * 0.3) / 2 - 0.02, zMid);
      cove.rotation.y = -side * Math.PI / 2;
      this.world.add(cove);
    }
    this.world.add(ambient, houseAmbient, houseFill, houseKey, houseKey.target, houseBack, houseBack.target,
      screenLight, screenLight.target);

    // Berkas proyektor (kerucut cahaya volumetrik): dari bilik belakang atas ke layar. Kerucut elips (puncak di lensa,
    // alas = ukuran layar), additive, putih kebiruan. Shader memudarkan tepi siluet (|N·V|²) dan memudar ke arah
    // layar, sehingga tampak seperti cahaya berdebu, bukan poligon datar. Opacity akhir 0,12–0,20; MATI sampai
    // detik penyalaan.
    const apex = new THREE.Vector3(0, Math.min(H - 0.5, room.back_floor_y + 2.45), D - 0.25);
    const base = new THREE.Vector3(screen.center[0], screen.center[1], 0);
    const radiusX = screen.width / 2;
    const radiusY = screen.height / 2;
    const segments = 48;
    const ring = Array.from({ length: segments + 1 }, (_, i) => {
      const a = (i / segments) * TAU;
      return new THREE.Vector3(base.x + Math.cos(a) * radiusX, base.y + Math.sin(a) * radiusY, base.z);
    });
    const ringNormal = (i) => {
      const prev = ring[(i + segments - 1) % segments];
      const next = ring[(i + 1) % segments];
      const edge = ring[i].clone().sub(apex);
      const normal = next.clone().sub(prev).cross(edge).normalize();
      return normal.dot(ring[i].clone().sub(base)) < 0 ? normal.negate() : normal;
    };
    const beamPositions = [];
    const beamNormals = [];
    const beamAlong = [];
    for (let i = 0; i < segments; i += 1) {
      const n0 = ringNormal(i);
      const n1 = ringNormal(i + 1);
      const mid = n0.clone().add(n1).normalize();
      beamPositions.push(apex.x, apex.y, apex.z, ring[i].x, ring[i].y, ring[i].z, ring[i + 1].x, ring[i + 1].y, ring[i + 1].z);
      beamNormals.push(mid.x, mid.y, mid.z, n0.x, n0.y, n0.z, n1.x, n1.y, n1.z);
      beamAlong.push(1, 0.25, 0.25);
    }
    const beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', new THREE.Float32BufferAttribute(beamPositions, 3));
    beamGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(beamNormals, 3));
    beamGeometry.setAttribute('along', new THREE.Float32BufferAttribute(beamAlong, 1));
    const beamMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xcfdcff) }, uOpacity: { value: 0 } },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float along;
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vAlong;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          vAlong = along;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vAlong;
        void main() {
          float facing = abs(dot(normalize(vNormal), normalize(vView)));
          float alpha = facing * facing * vAlong * uOpacity;
          gl_FragColor = vec4(uColor * alpha, alpha);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.visible = false;
    beam.renderOrder = 1;
    beam.frustumCulled = false;
    this.world.add(beam);

    // ---- State machine masuk-studio (jam = detik frame yang benar-benar tampil) ----
    //  0     lampu ruangan langsung terang, layar HITAM & video dijeda di frame 0, proyektor mati, lampu lorong menyala
    //  0–3   DIMMING  : lampu ruangan → 0 (smoothstep 3 detik); detik 2–3 proyektor menyala dan layar fade-in dari hitam
    //  3+    SHOWTIME : lampu ruangan padam total, trailer diputar, SpotLight pantulan layar mengikuti adegan
    const seq = ENTRANCE;
    const showtime = seq.hold + seq.dim;
    const smooth = (x) => {
      const k = clamp(x, 0, 1);
      return k * k * (3 - 2 * k);
    };
    this.lightSeq = { t: 0, last: null, phase: 'dimming', house: 1, screen: 0, projector: 0, started: false };
    this.updaters.push((dt, time) => {
      const q = this.lightSeq;
      // Jam hanya maju untuk frame yang tampil: jeda panjang (kompilasi shader, tab tersembunyi) dihitung
      // paling banyak 0,25 detik, jadi 3 detik transisi tidak habis sebelum terlihat.
      if (q.last === null) q.last = time;
      q.t += clamp(time - q.last, 0, 0.25);
      q.last = time;
      const t = q.t;
      q.phase = t < showtime ? 'dimming' : 'showtime';
      q.house = 1 - smooth((t - seq.hold) / seq.dim) * (1 - seq.houseOff);      // 1 → 0 selama 3 detik (detik 0–3)
      q.projector = smooth((t - seq.ignite) / seq.igniteFade);                     // menyala di detik 2–3
      q.screen = smooth((t - seq.ignite) / (showtime - seq.ignite));              // fade-in 2 → 3
      if (!q.started && t >= showtime) {                                          // showtime: trailer diputar
        q.started = true;
        this.media.start();
      }
    });
    this.updaters.push(() => {
      const state = this.lightSeq;
      const c = this.media.color;
      houseAmbient.intensity = seq.level * seq.ambientGain * state.house;
      houseFill.intensity = seq.fill * seq.ambientGain * state.house;
      houseKey.intensity = seq.key * seq.keyGain * state.house;           // 1,4 → 0 selama detik 0–3
      houseBack.intensity = seq.key * seq.backRatio * seq.keyGain * state.house;
      for (const { material, base, lifted } of lit) material.color.lerpColors(base, lifted, state.house);
      coveMaterial.opacity = 0.42 * state.house;                  // cove light ikut padam bersama lampu ruangan
      screenMesh.material.color.setScalar(state.screen);          // 0 = hitam pekat total (tanpa gambar sama sekali)
      beam.visible = state.projector > 0.001;
      beamMaterial.uniforms.uOpacity.value = state.projector * (0.12 + 0.08 * clamp(c.luma * 1.6, 0, 1)) * 2.2;   // 2,2: |N·V|²·fade rata-rata ≈ 0,45 → tampak 0,12–0,20
      // Warna pantulan mengikuti pendaran film, tetapi tetap didominasi putih-hangat netral.
      tint.setRGB(c.r, c.g, c.b);
      const peak = Math.max(tint.r, tint.g, tint.b, 0.001);
      screenLight.color.copy(neutral).lerp(tint.multiplyScalar(1 / peak), 0.3);
      // Pantulan layar = lantai 0,10 + pantulan dinamis 0,0–1,2 ∝ kecerahan frame: adegan terang menyorot kursi,
      // adegan gelap kembali ke lantai (remang-remang), tidak pernah hilang jadi void hitam.
      screenLight.intensity = 1.35 * referenceDistance * referenceDistance
        * (seq.bounceFloor + clamp(c.luma * 2.4, 0, seq.bounceMax)) * state.screen;
      ambient.intensity = seq.floor * seq.floorGain * (1 + this.fourDX.level * this.media.energy);   // kilat 4DX (hanya saat efek aktif)
    });

    this._buildCinemaSeats(L);
    this._buildSpectators(L);
    this._buildFurniture(L);
    if (L.features.four_dx) this._buildFourDX(L);
  }

  /** Bagian-bagian kursi per tipe (koordinat lokal: lantai di y=0, menghadap −z). */
  _seatParts(type, seatHeight, theme) {
    const h = seatHeight;
    if (type === 'recliner') {
      return [
        { geometry: mergeGeometries([
          boxPart(0.74, 0.22, 0.62, 0, h - 0.11, -0.05),
          boxPart(0.74, 0.86, 0.18, 0, h + 0.36, 0.38, 0.38),
          boxPart(0.66, 0.1, 0.56, 0, 0.45, -0.66),
        ]), material: this._std(theme.seat, { roughness: 0.55 }) },
        { geometry: mergeGeometries([
          boxPart(0.14, 0.34, 0.8, -0.44, h + 0.02, 0),
          boxPart(0.14, 0.34, 0.8, 0.44, h + 0.02, 0),
          boxPart(0.8, 0.26, 0.7, 0, 0.13, 0.05),
        ]), material: this._std(theme.armrest, { roughness: 0.6 }) },
        { geometry: boxPart(0.44, 0.24, 0.04, 0, h + 0.64, 0.38, 0.38), material: this._std(theme.headrest) },
      ];
    }
    if (type === 'motion') {
      return [
        { geometry: mergeGeometries([
          boxPart(0.52, 0.14, 0.5, 0, h - 0.07, -0.04),
          boxPart(0.52, 0.78, 0.12, 0, h + 0.36, 0.26, 0.14),
        ]), material: this._std(theme.seat, { roughness: 0.5 }) },
        { geometry: mergeGeometries([
          boxPart(0.08, 0.22, 0.48, -0.3, h + 0.1, 0),
          boxPart(0.08, 0.22, 0.48, 0.3, h + 0.1, 0),
          boxPart(0.5, 0.05, 0.1, 0, 0.18, -0.46),
          boxPart(0.6, h - 0.14, 0.62, 0, (h - 0.14) / 2, 0.04),
        ]), material: this._std(theme.base, { roughness: 0.7, metalness: 0.3 }) },
        { geometry: boxPart(0.5, 0.03, 0.03, 0, h + 0.74, 0.31), material: this._std(new THREE.Color(theme.seat_piping).multiplyScalar(0.25), { roughness: 0.9 }) },
      ];
    }
    return [
      { geometry: mergeGeometries([
        boxPart(0.48, 0.12, 0.46, 0, h - 0.06, -0.04),
        boxPart(0.48, 0.66, 0.1, 0, h + 0.3, 0.24, 0.16),
      ]), material: this._std(theme.seat, { roughness: 0.8 }) },
      { geometry: mergeGeometries([
        boxPart(0.06, 0.2, 0.44, -0.27, h + 0.1, 0),
        boxPart(0.06, 0.2, 0.44, 0.27, h + 0.1, 0),
        boxPart(0.36, h - 0.12, 0.3, 0, (h - 0.12) / 2, 0.05),
      ]), material: this._std(theme.armrest, { roughness: 0.7 }) },
    ];
  }

  _buildCinemaSeats(L) {
    const parts = this._seatParts(L.seat_type, L.seat_height, L.theme);
    const matrix = new THREE.Matrix4();
    const meshes = parts.map(({ geometry, material }) => new THREE.InstancedMesh(geometry, material, L.seats.length));
    L.seats.forEach((seat, i) => {
      matrix.makeTranslation(seat.x, seat.y, seat.z);
      for (const mesh of meshes) mesh.setMatrixAt(i, matrix);
    });
    for (const mesh of meshes) {
      mesh.frustumCulled = false;
      this.world.add(mesh);
    }
    this.seatSets = { meshes, seats: L.seats };
    this.seatById = new Map(L.seats.map((seat) => [seat.id, seat]));
    this.seatByGrid = new Map(L.seats.map((seat) => [`${seat.row_index}:${seat.number}`, seat]));
    // Kursi prosedural = placeholder/cadangan. 4DX tidak menampilkan balok kotak sama sekali: placeholdernya
    // disembunyikan dan baru dimunculkan bila model kursi gagal dimuat.
    if (L.seat_type === 'motion') for (const mesh of meshes) mesh.visible = false;
    this._upgradeCinemaSeats(L).catch((error) => {
      console.warn('[3D] Model kursi gagal dimuat, memakai kursi prosedural:', error);
      if (this.layout === L && this.seatSets) for (const mesh of this.seatSets.meshes) mesh.visible = true;
    });
  }

  /**
   * Dasar gerak hidrolik 4DX per kursi (koordinat lokal: lantai y=0, pusat kursi di x=z=0): pelat bawah bundar, selongsong
   * + batang piston, dua silinder hidrolik samping, dan pelat atas tempat kursi bertumpu. Semua silinder/bundar — tidak ada
   * balok kotak. Ikut bergerak bersama kursi karena memakai indeks instance yang sama.
   */
  _motionBaseGeometry(height) {
    const part = (radiusTop, radiusBottom, h, x, y, z) => {
      const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, h, 28, 1);
      geometry.translate(x, y, z);
      return geometry;
    };
    const plate = 0.02;
    const cap = 0.026;
    const stroke = Math.max(0.02, height - plate - cap);
    return mergeGeometries([
      part(0.27, 0.28, plate, 0, plate / 2, 0),                                 // pelat bawah
      part(0.085, 0.085, stroke * 0.55, 0, plate + stroke * 0.275, 0),          // selongsong piston
      part(0.05, 0.05, stroke * 0.55, 0, plate + stroke * 0.725, 0),            // batang piston
      part(0.032, 0.032, stroke, -0.19, plate + stroke / 2, 0.02),              // silinder hidrolik kiri
      part(0.032, 0.032, stroke, 0.19, plate + stroke / 2, 0.02),               // silinder hidrolik kanan
      part(0.25, 0.25, cap, 0, height - cap / 2, 0),                            // pelat atas (dudukan kursi)
    ]);
  }

  /**
   * Ganti kursi prosedural dengan model GLB (tetap InstancedMesh: 1 draw call per material).
   *   regular (Regular 2D, IMAX)  → kursi dari cinemamovie_theater_interior/seat.glb, 1 instance per kursi
   *   recliner (The Premiere)     → sofa cinema_theater_lounge_sofa, 1 instance per PASANGAN recliner
   *   motion (4DX)                → kursi yang sama + dasar gerak hidrolik di bawahnya; tiap kursi satu indeks instance,
   *                                 jadi animasi 4DX (rotasi terhadap pivot blok) tetap menggerakkan kursi + dasarnya
   * Skala di-bake ke geometri sehingga matriks instance tetap translasi murni (dipakai juga oleh animasi 4DX).
   */
  async _upgradeCinemaSeats(L) {
    const modelKey = { regular: 'hallSeat', recliner: 'loungeSofa', motion: 'hallSeat' }[L.seat_type];
    const motion = L.seat_type === 'motion';
    if (!modelKey) return;
    const spec = MODEL_SPECS[modelKey];
    const root = await loadModel(modelKey);
    if (this.layout !== L || !this.seatSets) return;            // venue sudah diganti selama memuat

    // Titik penempatan: kursi tunggal, atau titik tengah tiap pasangan (grup) untuk sofa 2 kursi.
    let spots;
    if (modelKey === 'loungeSofa') {
      const groups = new Map();
      for (const seat of L.seats) {
        if (!seat.group) continue;
        if (!groups.has(seat.group)) groups.set(seat.group, []);
        groups.get(seat.group).push(seat);
      }
      if (![...groups.values()].every((g) => g.length === 2)) return;
      spots = [...groups.values()].map(([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }));
    } else {
      spots = L.seats;
    }

    // Skala: tinggi dudukan mengikuti `seat_height` dari Python, lebar mengikuti jarak antar-kursi.
    // 4DX: kursi memakai skala 1,05 (proporsi alami) dan DIANGKAT di atas dasar hidrolik setinggi sisa `seat_height`.
    const motionScale = MOTION_SCALE;
    const baseHeight = motion ? Math.max(0.08, L.seat_height - spec.seatTop * motionScale) : 0;
    const sy = motion ? motionScale : L.seat_height / spec.seatTop;
    let sx = 1;
    if (motion) {
      sx = motionScale;
    } else if (modelKey === 'hallSeat') {
      // Regular & IMAX: kursi dempet berbagi sandaran tangan (shared armrest) seperti XXI/IMAX asli. Lebar
      // diskalakan sehingga sandaran tangan kanan kursi n menumpuk tepat di sandaran tangan kiri kursi n+1:
      // tidak ada celah di antara nomor berurutan; celah hanya di lorong (aisle) dari Python.
      const xs = [...L.columns].sort((a, b) => a - b);
      const pitch = Math.min(...xs.slice(1).map((x, i) => x - xs[i]).filter((d) => d > 0.2));
      sx = clamp(pitch / (spec.width - spec.armrest), 0.9, 1.4);
    }
    // Sofa The Premiere: SEMUA mesh di-override dengan satu material kulit espresso terpadu (tanpa tekstur bawaan yang
    // punya seam putih di tepi/jahitan). Kursi hall: tetap memakai mesh aslinya, material dikalibrasi di bawah.
    const leather = modelKey === 'loungeSofa' ? new THREE.MeshStandardMaterial({
      color: 0x1a1816, roughness: 0.65, metalness: 0.12, flatShading: false }) : null;
    const parts = bakeParts(root, { scale: [sx, sy, modelKey === 'hallSeat' ? HALL_DEPTH_SCALE : 1], override: leather });
    if (motion) {
      for (const { geometry } of parts) geometry.translate(0, baseHeight, 0);     // kursi duduk di atas dasar hidrolik
      parts.push({ geometry: this._motionBaseGeometry(baseHeight), material: this._std(0x2a2d33, { roughness: 0.5, metalness: 0.6 }) });
    }
    for (const { material } of parts) {
      // Tidak ada emissive pada kursi mana pun: kursi hanya terlihat bila ada cahaya (lampu ruangan / pantulan layar).
      material.emissive.set(0x000000);
      material.emissiveIntensity = 0;
      material.emissiveMap = null;
      if (modelKey === 'hallSeat' && motion) {
        if (/brown/i.test(material.name)) {
          // 4DX: jok kulit arang gelap.
          material.color.set(0x1c1e24);
          material.roughness = 0.75;
          material.metalness = 0.15;
        } else if (/blk/i.test(material.name)) {
          // Rangka & sandaran tangan: abu-abu gelap sedikit metalik sebagai aksen.
          material.color.set(0x30333b);
          material.roughness = 0.55;
          material.metalness = 0.35;
        }
      } else if (modelKey === 'hallSeat') {
        if (/brown/i.test(material.name)) {
          // Jok = kain beludru marun gelap (#6B1124, deep wine): matte total, menyerap cahaya.
          material.color.set(L.theme.seat);
          material.roughness = 0.95;
          material.metalness = 0;
        } else {
          // Rangka belakang & sandaran tangan: plastik doff hitam arang.
          material.color.set(0x18181b);
          material.roughness = 0.85;
          material.metalness = 0.05;
        }
      } else if (this.houseLit) {
        // Kulit sangat gelap: reflektansinya diangkat sementara saat lampu ruangan menyala (seperti dinding/karpet),
        // lalu kembali ke 0x1A1816 begitu lampu padam — tidak pernah menyala sendiri.
        this.houseLit.push({ material, base: material.color.clone(), lifted: material.color.clone().multiplyScalar(3) });
      }
    }

    const matrix = new THREE.Matrix4();
    const meshes = parts.map(({ geometry, material }) => {
      const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
      spots.forEach((spot, i) => mesh.setMatrixAt(i, matrix.makeTranslation(spot.x, spot.y, spot.z)));
      mesh.frustumCulled = false;
      return mesh;
    });

    for (const old of this.seatSets.meshes) {
      this.world.remove(old);
      old.geometry.dispose();
      old.material.dispose();
      old.dispose();
    }
    this.world.add(...meshes);
    this.seatSets.meshes = meshes;
    this.seatSets.model = modelKey;
  }

  /**
   * Cara manekin duduk di kursi studio ini (koordinat lokal kursi, lantai y=0): tinggi puncak bantalan, muka
   * sandaran di ketinggian pinggul, sudut sandaran, dan posisi lutut. Diturunkan dari skala model GLB yang sama
   * dengan `_upgradeCinemaSeats`, jadi pinggul selalu menempel bantalan dan punggung menyandar tanpa menembus.
   */
  _seatFit(L) {
    const recliner = L.seat_type === 'recliner';
    const motion = L.seat_type === 'motion';
    const spec = MODEL_SPECS[recliner ? 'loungeSofa' : 'hallSeat'];
    const sy = motion ? MOTION_SCALE : L.seat_height / spec.seatTop;
    const sz = recliner ? 1 : HALL_DEPTH_SCALE;
    const lift = motion ? Math.max(0.08, L.seat_height - spec.seatTop * MOTION_SCALE) : 0;   // dasar hidrolik 4DX
    const cushion = lift + spec.cushionTop * sy;
    const backZ = sampleProfile(spec.backFront, (cushion + FIGURE.pivot - lift) / sy) * sz;
    const hipZ = backZ - FIGURE.back - 0.012;
    // Sofa 2 kursi: manekin duduk di pusat bantalan (±cushionX dari pusat pasangan), bukan di x kursi Python.
    const pairCenter = new Map();
    if (recliner) {
      const groups = new Map();
      for (const seat of L.seats) if (seat.group) groups.set(seat.group, [...(groups.get(seat.group) || []), seat.x]);
      for (const [group, xs] of groups) pairCenter.set(group, xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    const fit = {
      cushion, backZ, recline: spec.reclineDeg, pairX: recliner ? spec.cushionX : 0, pairCenter,
      kneeZ: Math.min(-0.42, spec.cushionFront * sz - hipZ - 0.05),
    };
    const probe = seatedFigureGeometry(fit);
    fit.top = probe.boundingBox.max.y;                          // puncak kepala manekin skala 1 di atas bantalan
    probe.dispose();
    return fit;
  }

  /** Matriks manekin di sebuah kursi: skala seragam (tak pernah gepeng), pinggul di bantalan, punggung di sandaran. */
  _figureMatrix(seat, fit, scale, yaw = 0) {
    let x = seat.x;
    if (fit.pairX && fit.pairCenter.has(seat.group)) {
      const center = fit.pairCenter.get(seat.group);
      x = center + Math.sign(seat.x - center || 1) * fit.pairX;
    }
    const z = seat.z + fit.backZ - scale * FIGURE.back - 0.012;
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, seat.y + fit.cushion, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(scale, scale, scale));
  }

  /** Penonton di kursi terjual: satu manekin duduk seragam per kursi (variasi hanya skala ±6% dan sedikit putaran). */
  _buildSpectators(L) {
    this.seatFit = this._seatFit(L);
    const sold = L.seats.filter((seat) => seat.status === 'sold');
    if (!sold.length) return;
    const fit = this.seatFit;
    const material = this._std(0x0b0c10, { roughness: 1, metalness: 0 });      // siluet penonton: hitam pekat matte #0B0C10
    const body = new THREE.InstancedMesh(seatedFigureGeometry(fit), material, sold.length);
    body.frustumCulled = false;
    const base = sold.map((seat, i) => {
      const hash = hashString(seat.id);
      const matrix = this._figureMatrix(seat, fit, 0.94 + ((hash >>> 8) % 120) / 1000, ((hash % 100) / 100 - 0.5) * 0.1);
      body.setMatrixAt(i, matrix);
      return matrix;
    });
    this.world.add(body);
    this.spectators = { body, base, seats: sold, index: new Map(sold.map((seat, i) => [seat.id, i])), hidden: [] };
  }

  /** Sembunyikan siluet generik di kursi sendiri dan kursi tepat di depan (diganti versi Python). */
  _hideSpectators(seatIds) {
    const set = this.spectators;
    if (!set) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const i of set.hidden) set.body.setMatrixAt(i, set.base[i]);
    set.hidden = seatIds.map((id) => set.index.get(id)).filter((i) => i !== undefined);
    for (const i of set.hidden) set.body.setMatrixAt(i, zero);
    set.body.instanceMatrix.needsUpdate = true;
  }

  /** Meja samping The Premiere: polos, tanpa lampu/bola menyala (tidak ada sumber cahaya dekat mata penonton). */
  _buildFurniture(L) {
    if (!L.furniture.length) return;
    const wood = this._std(L.theme.table, { roughness: 0.95, metalness: 0 });
    for (const item of L.furniture) {
      const topMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 20), wood);
      topMesh.position.set(item.x, item.y + 0.62, item.z - 0.05);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 10), wood);
      stem.position.set(item.x, item.y + 0.3, item.z - 0.05);
      this.world.add(topMesh, stem);
    }
  }

  /* •••••••••••• Efek 4DX •••••••••••• */
  _buildFourDX(L) {
    const config = L.features.four_dx;
    const rand = mulberry32(41);
    const count = 360;
    const position = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      position.set([(rand() - 0.5) * 5, rand() * 1.8 - 0.4, -rand() * 7], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    const material = new THREE.PointsMaterial({
      map: this.glowTexture, color: 0xcfe2ff, size: 0.11, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const wind = new THREE.Points(geometry, material);
    wind.frustumCulled = false;
    wind.visible = false;
    this.world.add(wind);
    this.fourDX = { on: false, level: 0, roll: 0, pitch: 0, heave: 0, config, pivot: null, wind };

    // Amplitudo gerak berasal dari Python (MotionSeat.MOTION).
    const rollMax = THREE.MathUtils.degToRad(config.motion.roll_deg);
    const pitchMax = THREE.MathUtils.degToRad(config.motion.pitch_deg);
    const pivots = L.seats.map((seat) => vec(config.block_pivots[seat.group]));
    const toPivot = new THREE.Matrix4();
    const fromPivot = new THREE.Matrix4();
    const rotate = new THREE.Matrix4();
    const euler = new THREE.Euler();
    const sway = new THREE.Matrix4();
    const scratch = new THREE.Matrix4();
    let wasMoving = false;

    this.updaters.push((dt, time) => {
      const fx = this.fourDX;
      // Intensitas mengikuti trailer: dentuman bass (bila audio aktif) atau perubahan kecerahan frame.
      const drive = this.media.playing ? Math.max(this.media.bassLevel() * 1.5, this.media.energy * 2.2, 0.12) : 0;
      const target = fx.on && !this.reducedMotion ? clamp(drive, 0, 1) : 0;
      fx.level += (target - fx.level) * (1 - Math.exp(-5 * dt));
      const moving = fx.level > 0.004;
      fx.roll = moving ? rollMax * fx.level * Math.sin(time * TAU * 0.9) : 0;
      fx.pitch = moving ? pitchMax * fx.level * Math.sin(time * TAU * 0.63 + 1.2) : 0;
      fx.heave = moving ? config.motion.heave_m * fx.level * Math.sin(time * TAU * 7.0) : 0;

      wind.visible = fx.on && fx.level > 0.02;
      if (wind.visible) {
        material.opacity = 0.5 * fx.level;
        const speed = config.wind_speed_ms * (0.4 + fx.level);
        for (let i = 0; i < count; i += 1) {
          let z = position[i * 3 + 2] + speed * dt;
          if (z > 0.8) z -= 7.8;
          position[i * 3 + 2] = z;
        }
        geometry.attributes.position.needsUpdate = true;
      }

      if (!moving && !wasMoving) return;
      wasMoving = moving;
      // Semua blok bergerak serempak; tiap blok berputar terhadap pivotnya sendiri.
      euler.set(fx.pitch, 0, fx.roll);
      rotate.makeRotationFromEuler(euler);
      rotate.setPosition(0, fx.heave, 0);
      const spectators = this.spectators;
      L.seats.forEach((seat, i) => {
        const pivot = pivots[i];
        toPivot.makeTranslation(pivot.x, pivot.y, pivot.z);
        fromPivot.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
        sway.multiplyMatrices(toPivot, rotate).multiply(fromPivot);
        scratch.makeTranslation(seat.x, seat.y, seat.z).premultiply(sway);
        for (const mesh of this.seatSets.meshes) mesh.setMatrixAt(i, scratch);
        const k = spectators ? spectators.index.get(seat.id) : undefined;
        if (k !== undefined && !spectators.hidden.includes(k)) {
          spectators.body.setMatrixAt(k, scratch.multiplyMatrices(sway, spectators.base[k]));
        }
      });
      for (const mesh of this.seatSets.meshes) mesh.instanceMatrix.needsUpdate = true;
      if (spectators) spectators.body.instanceMatrix.needsUpdate = true;
    });
  }

  /** Nyalakan/matikan simulasi 4DX (hanya berpengaruh di studio 4DX). */
  async setFourDX(on) {
    if (!this.fourDX.config) return false;
    this.fourDX.on = on;
    if (on) await this.media.unlockAudio();    // analyser butuh AudioContext aktif
    return true;
  }

  /* ======================================================================= */
  /* STADION GBK                                                             */
  /* ======================================================================= */
  _ringStrip(inner, outer, material, { vRepeat = 1, drop = 0, parent = this.world } = {}) {
    const n = inner.length;
    const position = new Float32Array(n * 6);
    const uv = new Float32Array(n * 4);
    const index = [];
    for (let i = 0; i < n; i += 1) {
      position.set([inner[i][0], inner[i][1] - drop, inner[i][2], outer[i][0], outer[i][1] - drop, outer[i][2]], i * 6);
      uv.set([i * 2, 0, i * 2, vRepeat], i * 4);
      if (i < n - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
  }

  _buildStadium(L) {
    const { bowl, stage } = L;
    this.scene.background = new THREE.Color(0x03040a);
    this.scene.fog = new THREE.FogExp2(0x060817, 0.0013);
    const rand = mulberry32(2023);

    // Langit malam + bintang.
    const skyGeometry = new THREE.SphereGeometry(1300, 24, 14);
    const skyColors = new Float32Array(skyGeometry.attributes.position.count * 3);
    const horizon = new THREE.Color(0x151c40);
    const zenith = new THREE.Color(0x02030a);
    const mixed = new THREE.Color();
    for (let i = 0; i < skyGeometry.attributes.position.count; i += 1) {
      const t = Math.pow(clamp(skyGeometry.attributes.position.getY(i) / 700, 0, 1), 0.6);
      mixed.copy(horizon).lerp(zenith, t);
      skyColors.set([mixed.r, mixed.g, mixed.b], i * 3);
    }
    skyGeometry.setAttribute('color', new THREE.BufferAttribute(skyColors, 3));
    const skyMesh = new THREE.Mesh(skyGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.world.add(skyMesh);
    const starPositions = [];
    for (let i = 0; i < 700; i += 1) {
      const theta = rand() * TAU;
      const phi = Math.acos(rand() * 0.92);
      starPositions.push(1150 * Math.sin(phi) * Math.cos(theta), 1150 * Math.cos(phi) + 30, 1150 * Math.sin(phi) * Math.sin(theta));
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({
      color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false }));
    this.world.add(stars);

    // Cahaya: malam biru + cahaya panggung yang mengikuti video.
    const ambientLight = new THREE.AmbientLight(0x8fa2ff, 0.3);
    const hemiLight = new THREE.HemisphereLight(0x2b3a7a, 0x05060a, 0.5);
    const stageLight = new THREE.PointLight(0xffffff, 60, 0, 1.0);
    stageLight.position.set(0, 18, stage.deck.z1 + 5);
    this.world.add(ambientLight, hemiLight, stageLight);

    this.stadiumAtmo = {
      skyGeometry,
      skyColors,
      stars,
      ambientLight,
      hemiLight,
      stageLight,
      beams: [],
      lasers: null,
      laserMaterial: null,
      rain: null,
      beamScale: 1,
      stageScale: 1,
      crowdRatio: 1,
      localGroups: [],
      phase: 'peak_show',
    };

    // Warna aksen bersama (pita LED, tepi runway, sorot) mengikuti warna dominan video.
    const accent = this._basic(0xffffff, { toneMapped: false });
    const accentDim = this._basic(0xffffff, { toneMapped: false });
    const white = new THREE.Color(0xffffff);
    const hsl = { h: 0, s: 0, l: 0 };
    this.updaters.push(() => {
      const c = this.media.color;
      this.vivid.setRGB(c.r, c.g, c.b).getHSL(hsl);
      this.vivid.setHSL(hsl.h, Math.max(0.7, hsl.s), 0.56);
      const scale = this.stadiumAtmo ? this.stadiumAtmo.stageScale : 1;
      stageLight.visible = scale > 0.01;
      stageLight.color.copy(this.vivid).lerp(white, 0.35);
      stageLight.intensity = (30 + 120 * c.luma) * scale;
      accent.color.copy(this.vivid);
      accentDim.color.copy(this.vivid).multiplyScalar(0.3);
    });

    // Lapangan.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), this._std(0x0a0c15, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.world.add(ground);
    // Lantai SUGBK: elips 110 × 165 m. Cincin luar = lintasan lari atletik merah bata (8 lajur) dari bibir
    // tribun bawah ke dalam; lapangan di dalamnya + seluruh Area Festival ditutup plat pelindung rumput abu-abu gelap.
    const deckTexture = makeDeckTexture();
    this.sharedTextures.push(deckTexture);
    const track = this._buildRunningTrack(bowl);
    const floorShape = new THREE.Shape(track.inner.map(([x, , z]) => new THREE.Vector2(x, -z)));
    const decking = new THREE.Mesh(new THREE.ShapeGeometry(floorShape, 48), this._std(0x111419, {
      roughness: 0.95, metalness: 0, map: deckTexture, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    decking.rotation.x = -Math.PI / 2;
    decking.position.y = 0.04;
    this.world.add(decking);
    // Area Festival berdiri: plat turf cover terpisah, sedikit lebih tinggi dari lapangan (menutup ujung lajur di
    // tikungan selatan seperti di konser GBK asli) dengan bibir tepi tipis yang lebih terang.
    const outline = L.field.outline;
    const festivalShape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const festival = new THREE.Mesh(new THREE.ShapeGeometry(festivalShape, 48), this._std(0x14171c, {
      roughness: 0.95, metalness: 0, map: deckTexture, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    festival.rotation.x = -Math.PI / 2;
    festival.position.y = 0.1;
    const lip = [...outline, outline[0]];
    this.world.add(festival);
    this._ringStrip(lip.map(([x, z]) => [x, 0.1, z]), lip.map(([x, z]) => [x, 0.0, z]),
      this._std(0x2a2f38, { roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide }));

    // Mangkuk tribun prosedural dari cincin titik yang dihitung Python (koordinat kategori tiket GBK).
    const seatMaterial = this._std(0x232844, { roughness: 1, map: this.stripeTexture, side: THREE.DoubleSide });
    const wall = this._std(0x0d0f1a, { roughness: 1, side: THREE.DoubleSide });
    const [lower, upper] = bowl.tiers;
    for (const tier of bowl.tiers) {
      const rows = Math.round((tier.depth_end - tier.depth_start) / bowl.row_depth);
      this._ringStrip(tier.inner, tier.outer, seatMaterial, { vRepeat: rows, drop: 0.34 });
    }
    this._ringStrip(bowl.field_edge, lower.inner, wall);
    this._ringStrip(lower.outer, upper.inner, wall);
    this._ringStrip(upper.outer, upper.outer.map((p, i) => [p[0], bowl.roof.outer[i][1], p[2]]), wall);
    const ribbon = this._basic(0xffffff, {
      toneMapped: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this._ringStrip(lower.inner.map((p) => [p[0], p[1] - 0.9, p[2]]), lower.inner.map((p) => [p[0], p[1] - 0.25, p[2]]), ribbon);
    this.updaters.push(() => ribbon.color.copy(accentDim.color));

    // Atap cincin GBK: kanopi + rangka baja + lampu tepi.
    this._ringStrip(bowl.roof.inner, bowl.roof.outer, this._basic(0x10152a, { side: THREE.DoubleSide }));
    const truss = [];
    const { inner: roofIn, outer: roofOut } = bowl.roof;
    for (let i = 0; i < roofIn.length - 1; i += 1) {
      const mid = lerp3(roofIn[i], roofOut[i], 0.5);
      const midNext = lerp3(roofIn[i + 1], roofOut[i + 1], 0.5);
      truss.push(...roofIn[i], ...roofIn[i + 1], ...roofOut[i], ...roofOut[i + 1], ...mid, ...midNext);
      if (i % 2 === 0) truss.push(...roofIn[i], ...roofOut[i], ...roofIn[i], ...midNext, ...mid, ...roofOut[i + 1]);
    }
    const trussGeometry = new THREE.BufferGeometry();
    trussGeometry.setAttribute('position', new THREE.Float32BufferAttribute(truss.map((v, k) => (k % 3 === 1 ? v - 0.3 : v)), 3));
    this.world.add(new THREE.LineSegments(trussGeometry, new THREE.LineBasicMaterial({
      color: 0xc3ccea, transparent: true, opacity: 0.4 })));
    const rimGeometry = new THREE.BufferGeometry();
    rimGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roofIn.flatMap((p) => [p[0], p[1] - 0.5, p[2]]), 3));
    this.world.add(new THREE.Points(rimGeometry, new THREE.PointsMaterial({
      color: 0xfff3d6, size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0.9, fog: false })));

    this._buildStage(L, accent, accentDim);
    this._buildXylobands(L, rand);
    this._buildRain(L, rand);
    this._buildStadiumExterior(bowl);
    this._buildFarCrowd(rand);
  }

  /**
   * Eksterior ring SUGBK (plaza luar + ring pilar temu gelang + suar pintu masuk)
   * agar animasi transisi Rute Spasial 3D dari Plaza Luar -> Ramp -> Kursi memiliki konteks arsitektural.
   */
  _buildStadiumExterior(bowl) {
    if (!bowl || !bowl.roof || !Array.isArray(bowl.roof.outer) || !bowl.roof.outer.length) return;
    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(215, 48),
      this._std(0x141925, { roughness: 0.94, metalness: 0.04 }),
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = -0.015;
    this.world.add(plaza);

    const roofOuter = bowl.roof.outer;
    const apronIn = roofOuter.map((p) => [p[0] * 1.03, 0.07, p[2] * 1.03]);
    const apronOut = roofOuter.map((p) => [p[0] * 1.24, 0.05, p[2] * 1.24]);
    this._ringStrip(apronIn, apronOut, this._std(0x1e2536, { roughness: 0.9, metalness: 0.08, side: THREE.DoubleSide }));

    const pillarCount = 48;
    const pillarGeo = new THREE.BoxGeometry(1.75, 34, 2.35);
    const pillarMat = this._std(0x283246, { roughness: 0.65, metalness: 0.25 });
    const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, pillarCount);
    const dummy = new THREE.Object3D();
    const beaconPositions = [];
    for (let i = 0; i < pillarCount; i += 1) {
      const idx = Math.floor((i / pillarCount) * (roofOuter.length - 1));
      const p = roofOuter[idx];
      const len = Math.max(1, Math.hypot(p[0], p[2]));
      const px = p[0] + (p[0] / len) * 2.4;
      const pz = p[2] + (p[2] / len) * 2.4;
      dummy.position.set(px, 17, pz);
      dummy.rotation.set(0, Math.atan2(p[0], p[2]), 0);
      dummy.updateMatrix();
      pillars.setMatrixAt(i, dummy.matrix);
      if (i % 6 === 0) {
        beaconPositions.push(px * 1.07, 2.8, pz * 1.07);
      }
    }
    pillars.instanceMatrix.needsUpdate = true;
    this.world.add(pillars);

    if (beaconPositions.length) {
      const beaconGeo = new THREE.BufferGeometry();
      beaconGeo.setAttribute('position', new THREE.Float32BufferAttribute(beaconPositions, 3));
      this.world.add(new THREE.Points(beaconGeo, new THREE.PointsMaterial({
        color: 0x5eead4, size: 4.5, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false,
      })));
    }
  }
  /**
   * Lintasan lari atletik khas SUGBK: cincin elips merah bata (#8B2522) antara lapangan dan bibir tribun bawah
   * (CAT 1/CAT 2), 8 lajur × 1,22 m. Garis lajur putih tipis dipanggang ke tekstur (v = melintang lintasan) sehingga
   * mipmap memudarkannya dengan rapi dari kejauhan, tanpa garis geometri yang berkedip.
   * @returns {{inner: number[][], outer: number[][]}} tepi dalam/luar (dipakai untuk plat lapangan di dalamnya)
   */
  _buildRunningTrack(bowl) {
    const lanes = 8;
    const lane = 1.22;
    const line = 0.05;
    const curb = 0.12;                  // jarak garis lajur pertama dari tepi dalam (kerb)
    const apron = 0.55;                 // sisa merah di luar lajur 8 sampai dinding tribun
    const width = curb + lanes * lane + apron;
    const steps = 240;
    const ring = (inset, y) => Array.from({ length: steps + 1 }, (_, i) => {
      const b = (i / steps) * TAU;
      return [(bowl.rx_inner - inset) * Math.sin(b), y, -(bowl.rz_inner - inset) * Math.cos(b)];
    });
    const inner = ring(width, 0.05);
    const outer = ring(0.02, 0.05);

    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8b2522';
    ctx.fillRect(0, 0, 4, 512);
    ctx.fillStyle = '#e9e6e1';
    const px = (meters) => 512 - (meters / width) * 512;      // v = 0 (tepi dalam) di bawah kanvas
    for (let k = 0; k <= lanes; k += 1) {
      const d = curb + k * lane;
      ctx.fillRect(0, px(d + line / 2), 4, Math.max(1.5, (line / width) * 512));
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    this.sharedTextures.push(texture);
    const material = this._std(0xffffff, {
      map: texture, roughness: 0.88, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // _ringStrip memberi u = i·2 (searah lintasan) dan v 0 → 1 (melintang): tepat untuk tekstur lajur.
    this._ringStrip(inner, outer, material);
    return { inner, outer };
  }

  _buildLatticeBox(cx, yStart, cz, w, yEnd, d, steel, parent = this.world, step = 3.4, post = 0.24) {
    const h = Math.max(0.5, yEnd - yStart);
    const dx = w / 2 - post / 2;
    const dz = d / 2 - post / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this._box(post, h, post, steel, cx + sx * dx, yStart + h / 2, cz + sz * dz, parent);
      }
    }
    const tiers = Math.max(2, Math.round(h / step));
    for (let i = 0; i <= tiers; i += 1) {
      const y = yStart + (i / tiers) * (h - 0.15);
      for (const sz of [-1, 1]) this._box(w, 0.18, 0.18, steel, cx, y, cz + sz * dz, parent);
      for (const sx of [-1, 1]) this._box(0.18, 0.18, d, steel, cx + sx * dx, y, cz, parent);
      if (i > 0) {
        const yPrev = yStart + ((i - 1) / tiers) * (h - 0.15);
        for (const sz of [-1, 1]) {
          this._buildTrussSpan([cx - dx, yPrev, cz + sz * dz], [cx + dx, y, cz + sz * dz], steel, 0.11, parent);
          this._buildTrussSpan([cx + dx, yPrev, cz + sz * dz], [cx - dx, y, cz + sz * dz], steel, 0.11, parent);
        }
        for (const sx of [-1, 1]) {
          this._buildTrussSpan([cx + sx * dx, yPrev, cz - dz], [cx + sx * dx, y, cz + dz], steel, 0.11, parent);
        }
      }
    }
  }

  _buildTrussSpan(a, b, material, thickness = 0.22, parent = this.world) {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const delta = new THREE.Vector3().subVectors(end, start);
    const len = delta.length();
    if (len < 1e-4) return null;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, len), material);
    mesh.position.copy(start).addScaledVector(delta, 0.5);
    mesh.lookAt(end);
    parent.add(mesh);
    return mesh;
  }

  _buildScaffoldTower(occluder, steel, dark, edge) {
    const [x0, y0, z0] = occluder.min;
    const [x1, y1, z1] = occluder.max;
    const w = x1 - x0;
    const h = y1 - y0;
    const d = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;

    // Inti scrim akustik tipis di dalam rangka agar tetap merepresentasikan blokir garis pandang Python.
    const scrimMat = this._std(0x0b0d14, { roughness: 0.95, metalness: 0.1 });
    const core = this._box(w * 0.72, Math.max(0.5, h - 2.8), d * 0.72, scrimMat, cx, 2.8 + (h - 2.8) / 2, cz);
    const coreEdges = new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry), edge);
    coreEdges.position.copy(core.position);
    this.world.add(coreEdges);

    // Alas beton/baja pada tinggi dek panggung + rangka menara Layher.
    this._box(w + 0.5, 2.8, d + 0.5, dark, cx, 1.4, cz);
    this._buildLatticeBox(cx, y0, cz, w, y1, d, steel, this.world, 3.4, 0.26);
  }

  _buildCompoundDeck(parent, w, d, deckH, dark, railMat) {
    this._box(w, deckH, d, dark, 0, deckH / 2, 0, parent);
    // Pagar barikade keliling dek agar area teknis aman dari kerumunan Festival.
    const railW = w + 1.4;
    const railD = d + 1.4;
    for (const sz of [-1, 1]) this._box(railW, 0.08, 0.08, railMat, 0, 1.05, sz * railD / 2, parent);
    for (const sx of [-1, 1]) this._box(0.08, 0.08, railD, railMat, sx * railW / 2, 1.05, 0, parent);
    for (const sx of [-1, -0.33, 0.33, 1]) {
      for (const sz of [-1, 1]) this._box(0.08, 1.05, 0.08, railMat, sx * railW / 2, 0.52, sz * railD / 2, parent);
    }
    for (const sz of [-0.5, 0, 0.5]) {
      for (const sx of [-1, 1]) this._box(0.08, 1.05, 0.08, railMat, sx * railW / 2, 0.52, sz * railD / 2, parent);
    }
    // Tangga akses di sisi belakang dek.
    for (let s = 0; s < 3; s += 1) {
      this._box(1.4, 0.35, 0.45, railMat, 0, 0.25 + s * 0.42, d / 2 + 0.9 - s * 0.32, parent);
    }
  }

  _buildCanopyRoof(parent, x, y, z, width, length, radius, mat) {
    const arch = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, length, 18, 1, true, -Math.PI * 0.42, Math.PI * 0.84),
      mat,
    );
    arch.rotation.x = Math.PI / 2;
    arch.scale.set((width / 2) / radius, 1, 0.48);
    arch.position.set(x, y, z);
    parent.add(arch);
  }

  /**
   * Platform FOH (Front of House) di tengah Festival, persis seukuran penghalang Python (`platform`):
   * riser rendah, tenda persegi berangka truss kotak yang tertutup kain hitam matte #18181B (atap limas, dinding
   * samping penuh, dinding belakang setinggi pinggang agar operator tetap terlihat, muka depan terbuka ke panggung),
   * meja mixer audio + konsol lampu menghadap panggung dengan monitor LED mini redup yang menghadap operator,
   * dan barikade baja di sekelilingnya. Penonton Festival berdiri tepat di luar barikade (lihat `crowdKeepOut`).
   */
  _buildFohTent(occluder) {
    const [x0, , z0] = occluder.min;
    const [x1, height, z1] = occluder.max;
    const w = x1 - x0;
    const d = z1 - z0;
    const group = new THREE.Group();
    group.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.world.add(group);
    const fabric = this._std(0x18181b, { roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
    const trussMat = this._std(0x18181b, { roughness: 0.6, metalness: 0.4 });
    const riserH = 0.4;
    const post = 0.3;
    const eave = height - 0.35;

    this._box(w, riserH, d, this._std(0x101013, { roughness: 0.9 }), 0, riserH / 2, 0, group);
    // Rangka truss kotak: 4 tiang sudut + balok keliling di bawah atap (satu mesh gabungan).
    const frame = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        frame.push(boxPart(post, eave - riserH, post, sx * (w / 2 - post / 2), riserH + (eave - riserH) / 2, sz * (d / 2 - post / 2)));
      }
    }
    for (const sz of [-1, 1]) frame.push(boxPart(w, post, post, 0, eave - post / 2, sz * (d / 2 - post / 2)));
    for (const sx of [-1, 1]) frame.push(boxPart(post, post, d, sx * (w / 2 - post / 2), eave - post / 2, 0));
    group.add(new THREE.Mesh(mergeGeometries(frame), trussMat));
    // Atap limas rendah (kerucut 4 sisi diputar 45° lalu diregangkan ke ukuran tenda).
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, true), fabric);
    roof.rotation.y = Math.PI / 4;                                  // rotasi di dalam, skala di grup luar
    const roofPivot = new THREE.Group();
    roofPivot.scale.set(w + 0.3, height + 0.45 - eave, d + 0.3);
    roofPivot.position.y = eave + (height + 0.45 - eave) / 2;
    roofPivot.add(roof);
    group.add(roofPivot);
    // Kain penutup: samping penuh, belakang setinggi pinggang + lis atas, depan hanya lis atas (valance).
    const panel = (pw, ph, x, y, z, rotY) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), fabric);
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotY;
      group.add(mesh);
    };
    for (const sx of [-1, 1]) panel(d - post, eave - riserH, sx * (w / 2 - 0.05), riserH + (eave - riserH) / 2, 0, Math.PI / 2);
    panel(w - post, 1.15, 0, riserH + 0.575, d / 2 - 0.05, 0);
    for (const sz of [-1, 1]) panel(w - post, 0.6, 0, eave - 0.3, sz * (d / 2 - 0.05), 0);

    // Meja kontrol: mixer audio (kiri) + konsol lampu (kanan) menghadap panggung (−z); operator di sisi +z.
    const deskZ = -d / 2 + 0.85;
    const deskTop = riserH + 0.85;
    const deskW = (w - 1.2) / 2;
    const housing = this._std(0x0c0c0f, { roughness: 0.7, metalness: 0.3 });
    const surface = this._std(0x1c1d22, { roughness: 0.55, metalness: 0.4 });
    for (const [side, tintHex] of [[-1, 0x2d5f8a], [1, 0x5b4a8c]]) {
      const cx = side * (deskW / 2 + 0.15);
      this._box(deskW, 0.85, 0.75, housing, cx, riserH + 0.425, deskZ, group);
      const top = this._box(deskW, 0.06, 0.8, surface, cx, deskTop + 0.05, deskZ + 0.02, group);
      top.rotation.x = -0.12;                                       // permukaan fader miring ke arah operator
      // Strip LED fader/meter: titik-titik redup di permukaan konsol.
      const meters = this._basic(new THREE.Color(tintHex).multiplyScalar(0.55), { toneMapped: false });
      this._box(deskW - 0.2, 0.012, 0.05, meters, cx, deskTop + 0.09, deskZ + 0.18, group);
      // Monitor mini (2 per konsol) berdiri di tepi depan meja, layar menghadap operator (+z), sedikit menengadah.
      const screen = this._basic(new THREE.Color(tintHex).multiplyScalar(0.7), { toneMapped: false });
      const glow = this._glowMaterial(tintHex, 0.22);
      for (const k of [-0.25, 0.25]) {
        const mx = cx + k * deskW;
        this._box(0.62, 0.4, 0.05, housing, mx, deskTop + 0.33, deskZ - 0.3, group).rotation.x = -0.18;
        const display = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.33), screen);
        display.position.set(mx, deskTop + 0.33, deskZ - 0.27);
        display.rotation.x = -0.18;
        const halo = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.9), glow);
        halo.position.set(mx, deskTop + 0.3, deskZ - 0.2);
        halo.rotation.x = -0.18;
        group.add(display, halo);
      }
    }
    // Dua operator berdiri di belakang meja.
    const crew = this._std(0x0d0d14, { roughness: 1 });
    for (const x of [-deskW / 2, deskW / 2]) {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 1.0, 3, 8), crew);
      body.position.set(x, riserH + 0.69, deskZ + 0.85);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), crew);
      head.position.set(x, riserH + 1.49, deskZ + 0.85);
      group.add(body, head);
    }

    // Barikade baja keliling (pagar crowd barrier) dengan celah akses di sisi belakang.
    const gap = FOH_BARRIER;
    const bw = w + gap * 2;
    const bd = d + gap * 2;
    const rails = [];
    const run = (ax, az, bx, bz, skip = null) => {
      const length = Math.hypot(bx - ax, bz - az);
      const posts = Math.max(2, Math.round(length / 1.1) + 1);
      for (let i = 0; i < posts; i += 1) {
        const t = i / (posts - 1);
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        if (skip && skip(px, pz)) continue;
        rails.push(boxPart(0.06, 1.1, 0.06, px, 0.55, pz));
        rails.push(boxPart(0.5, 0.04, 0.5, px, 0.02, pz));                       // kaki pelat
      }
      const horizontal = Math.abs(bz - az) < 1e-6;
      for (const y of [1.08, 0.55, 0.12]) {
        if (horizontal && skip) {
          for (const [s0, s1] of [[ax, -0.9], [0.9, bx]]) rails.push(boxPart(Math.abs(s1 - s0), 0.05, 0.05, (s0 + s1) / 2, y, az));
        } else {
          rails.push(horizontal ? boxPart(length, 0.05, 0.05, (ax + bx) / 2, y, az) : boxPart(0.05, 0.05, length, ax, y, (az + bz) / 2));
        }
      }
    };
    run(-bw / 2, -bd / 2, bw / 2, -bd / 2);
    run(-bw / 2, bd / 2, bw / 2, bd / 2, (px) => Math.abs(px) < 0.9);
    run(-bw / 2, -bd / 2, -bw / 2, bd / 2);
    run(bw / 2, -bd / 2, bw / 2, bd / 2);
    group.add(new THREE.Mesh(mergeGeometries(rails), this._std(0x3f4552, { roughness: 0.45, metalness: 0.6 })));
  }

  _buildCircularFence(cx, cz, radius, railMat, gapAngle = null) {
    const posts = 18;
    const ringPoints = [];
    for (let i = 0; i < posts; i += 1) {
      const a = (i / posts) * TAU;
      if (gapAngle !== null && Math.abs(shortestAngle(a, gapAngle)) < 0.35) continue;
      const px = cx + Math.sin(a) * radius;
      const pz = cz + Math.cos(a) * radius;
      this._box(0.08, 1.05, 0.08, railMat, px, 0.52, pz);
      ringPoints.push([px, 1.0, pz]);
    }
    for (let i = 0; i < ringPoints.length; i += 1) {
      const p1 = ringPoints[i];
      const p2 = ringPoints[(i + 1) % ringPoints.length];
      if (Math.hypot(p2[0] - p1[0], p2[2] - p1[2]) < 3.5) {
        this._buildTrussSpan(p1, p2, railMat, 0.06);
      }
    }
  }

  _buildStage(L, accent, accentDim) {
    const { stage } = L;
    const deck = stage.deck;
    const dark = this._std(0x0c0c12, { roughness: 0.8 });
    const deckDepth = deck.z1 - deck.z0;
    const deckCenterZ = (deck.z0 + deck.z1) / 2;
    this._box(deck.x1 - deck.x0, deck.y, deckDepth, dark, 0, deck.y / 2, deckCenterZ);
    this._box(deck.x1 - deck.x0, 0.25, 0.1, accent, 0, deck.y - 0.2, deck.z1 + 0.05);

    // Dek sayap kiri/kanan agar menara scaffolding dan tiang LED samping berdiri kokoh di atas panggung.
    const wingDepth = 18.0;
    const wingCenterZ = -66.5;
    for (const side of [-1, 1]) {
      this._box(12.0, deck.y, wingDepth, dark, side * 35.5, deck.y / 2, wingCenterZ);
      this._box(12.0, 0.18, 0.1, accentDim, side * 35.5, deck.y - 0.16, wingCenterZ + wingDepth / 2 + 0.05);
    }

    const steel = this._std(0x2e3548, { roughness: 0.48, metalness: 0.35 });
    const edge = new THREE.LineBasicMaterial({ color: 0x3d4360 });
    const black = this._basic(0x050506);

    // Tiga permukaan LED (video yang sama diputar serempak) + kabinet & penyangga struktural.
    const frame = this._basic(0xf2f4ff, { toneMapped: false, side: THREE.DoubleSide });
    const backing = this._basic(0x040405, { side: THREE.DoubleSide });
    const housingMat = this._std(0x0a0b10, { roughness: 0.75, metalness: 0.35 });
    for (const surface of L.targets[0].surfaces) {
      const mesh = this._buildSurface(surface);
      const normal = vec(surface.normal);
      const radius = surface.width / 2;
      const isCircle = surface.shape === 'circle';
      const ring = new THREE.Mesh(isCircle
        ? new THREE.RingGeometry(radius, radius + 0.32, 72)
        : new THREE.RingGeometry(radius, radius + 0.36, 48, 1, 0, Math.PI), frame);
      const plate = new THREE.Mesh(isCircle
        ? new THREE.CircleGeometry(radius + 0.5, 48)
        : new THREE.CircleGeometry(radius + 0.5, 32, 0, Math.PI), backing);
      for (const [part, shift] of [[ring, 0.03], [plate, -0.08]]) {
        part.position.copy(mesh.position).addScaledVector(normal, shift);
        if (!isCircle) part.position.y -= surface.height / 2;
        part.rotation.y = surface.yaw_rad;
        this.world.add(part);
      }

      if (isCircle) {
        // Kabinet belakang bundar + dua tiang penopang dari dek + lengan kantilever ke menara scaffold.
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.45, radius + 0.45, 0.65, 48), housingMat);
        drum.rotation.order = 'YXZ';
        drum.rotation.y = surface.yaw_rad;
        drum.rotation.x = Math.PI / 2;
        drum.position.copy(mesh.position).addScaledVector(normal, -0.42);
        this.world.add(drum);

        const tangent = new THREE.Vector3(normal.z, 0, -normal.x).normalize();
        const backCenter = mesh.position.clone().addScaledVector(normal, -0.88);
        const sideSign = Math.sign(mesh.position.x) || 1;
        for (const offset of [-2.6, 2.6]) {
          const postX = backCenter.x + tangent.x * offset;
          const postZ = backCenter.z + tangent.z * offset;
          this._buildTrussSpan([postX, deck.y, postZ], [postX, 22.6, postZ], steel, 0.34);
          this._box(1.1, 0.45, 1.1, dark, postX, deck.y + 0.22, postZ);
        }
        // Rangka silang di belakang drum + lengan baja menyambung ke menara scaffold (z = -67.25).
        for (const armY of [7.5, 13.5, 19.5, 22.6]) {
          const leftPt = [backCenter.x - tangent.x * 4.5, armY, backCenter.z - tangent.z * 4.5];
          const rightPt = [backCenter.x + tangent.x * 4.5, armY, backCenter.z + tangent.z * 4.5];
          this._buildTrussSpan(leftPt, rightPt, steel, 0.26);
        }
        for (const [anchorX, armY, postOff] of [
          [sideSign * 22.5, 8.5, -sideSign * 2.6],
          [sideSign * 22.5, 18.0, -sideSign * 2.6],
          [sideSign * 38.25, 8.5, sideSign * 2.6],
          [sideSign * 38.25, 18.0, sideSign * 2.6],
          [sideSign * 30.25, 22.6, 0],
        ]) {
          const targetPt = [
            backCenter.x + tangent.x * postOff,
            armY,
            backCenter.z + tangent.z * postOff,
          ];
          this._buildTrussSpan([anchorX, armY, -67.25], targetPt, steel, 0.28);
          this._buildTrussSpan([anchorX, armY - 3.2, -67.25], targetPt, steel, 0.16);
        }
      } else {
        // Dudukan plinth + penopang belakang untuk LED tengah setengah lingkaran.
        this._box(surface.width + 1.4, 0.75, 1.4, dark, mesh.position.x, deck.y + 0.35, mesh.position.z - 0.35);
        for (const xOff of [-7.5, 0, 7.5]) {
          this._buildTrussSpan([xOff, deck.y, mesh.position.z - 0.8], [xOff, 14.8, mesh.position.z - 0.8], steel, 0.32);
          this._buildTrussSpan([xOff, 14.8, mesh.position.z - 0.8], [xOff, 14.8, deck.z0 + 0.4], steel, 0.24);
        }
      }
    }

    // Penghalang yang dipakai uji garis pandang Python digambar persis di posisi yang sama dengan detail realistis.
    for (const occluder of L.occluders) {
      const size = [0, 1, 2].map((k) => occluder.max[k] - occluder.min[k]);
      const center = [0, 1, 2].map((k) => (occluder.max[k] + occluder.min[k]) / 2);
      if (occluder.kind === 'pillar') {
        this._buildScaffoldTower(occluder, steel, dark, edge);
        continue;
      }
      if (occluder.kind === 'speaker') {
        // Line array digantung dengan bumper atas dan kabel sling baja dari cantilever truss panggung.
        const modules = 10;
        const stepH = size[1] / modules;
        const sideSign = Math.sign(center[0]) || 1;
        this._box(size[0] + 0.3, 0.35, size[2] + 0.3, steel, center[0], occluder.max[1] + 0.18, center[2]);
        for (let m = 0; m < modules; m += 1) {
          const boxY = occluder.min[1] + (m + 0.5) * stepH;
          this._box(size[0], stepH * 0.84, size[2], black, center[0], boxY, center[2]);
        }
        // Kabel sling + lengan truss PA yang memanjang dari pilar scaffold dalam ke atas speaker.
        for (const sx of [-0.45, 0.45]) {
          this._buildTrussSpan(
            [center[0] + sx, occluder.max[1] + 0.25, center[2]],
            [center[0] + sx, 22.6, center[2]],
            steel, 0.08,
          );
        }
        this._buildTrussSpan([sideSign * 22.5, 22.6, -67.25], [center[0], 22.6, center[2] - 0.4], steel, 0.34);
        this._buildTrussSpan([sideSign * 22.5, 19.2, -67.25], [center[0], 22.6, center[2] - 0.4], steel, 0.2);
        continue;
      }

      const railMat = this._std(0x525b76, { roughness: 0.45, metalness: 0.65 });
      const canopyMat = this._std(0x94a3b8, { roughness: 0.45, metalness: 0.4, side: THREE.DoubleSide });

      if (occluder.kind === 'tower') {
        // Dek gabungan Menara Delay + tenda kanopi lengkung teknis di lapangan tengah (sesuai foto GBK).
        const compound = new THREE.Group();
        compound.position.set(center[0], 0, center[2]);
        compound.rotation.y = center[0] < 0 ? -0.36 : 0.36;
        this.world.add(compound);

        const deckH = 1.6;
        this._buildCompoundDeck(compound, 8.2, 6.2, deckH, dark, railMat);
        // Kanopi lengkung perak pelindung rak audio di samping kaki menara.
        const shelterX = center[0] < 0 ? -1.8 : 1.8;
        this._buildCanopyRoof(compound, shelterX, 2.35, 0, 3.8, 4.4, 2.0, canopyMat);
        for (const sx of [-1.7, 1.7]) {
          for (const sz of [-2.0, 2.0]) {
            this._box(0.14, 1.6, 0.14, steel, shelterX + sx, deckH + 0.8, sz, compound);
          }
        }
        // Menara rangka baja terbuka (open lattice) setinggi 16 m + lengan speaker PA + bar lampu hijau.
        const towerX = center[0] < 0 ? 1.5 : -1.5;
        this._buildLatticeBox(towerX, deckH, 0, 2.1, occluder.max[1], 2.1, steel, compound, 2.8, 0.2);
        // Lengan outrigger atas + dual line-array PA menghadap tribun selatan (+Z).
        this._box(3.4, 0.26, 0.32, steel, towerX, occluder.max[1] - 0.6, 0.9, compound);
        for (const lx of [-1.05, 1.05]) {
          for (let m = 0; m < 6; m += 1) {
            this._box(0.85, 0.45, 0.9, black, towerX + lx, occluder.max[1] - 1.3 - m * 0.56, 1.15 + m * 0.04, compound);
          }
        }
        const greenSpot = this._basic(0x6ee7b7, { toneMapped: false });
        for (let p = 0; p < 4; p += 1) {
          this._box(0.32, 0.42, 0.22, greenSpot, towerX, occluder.max[1] - 1.5 - p * 0.85, 1.28, compound);
        }
        continue;
      }

      if (occluder.kind === 'platform') {
        this._buildFohTent(occluder);
        continue;
      }

      const solid = occluder.kind === 'wall' ? dark : steel;
      this._box(size[0], size[1], size[2], solid, center[0], center[1], center[2]);
    }

    // Rangka truss utama: jembatan bentang atas menyatukan kedua sisi scaffold & atap panggung tengah.
    const pillar = L.occluders.find((occluder) => occluder.kind === 'pillar');
    const trussZ = pillar ? (pillar.min[2] + pillar.max[2]) / 2 : -67.25;
    for (const side of [-1, 1]) {
      for (const y of [6, 12, 18, 22.6]) this._box(12.5, 0.35, 0.35, steel, side * 30.25, y, trussZ);
      this._buildTrussSpan([side * 22.5, 22.6, trussZ], [side * 22.5, 15.0, deck.z0 + 1], steel, 0.28);
    }
    this._box(78.0, 0.45, 0.45, steel, 0, 22.6, trussZ);
    this._box(62.0, 0.38, 0.38, steel, 0, 15.0, deck.z0 + 1);
    for (const x of [-28, -14, 0, 14, 28]) {
      this._buildTrussSpan([x, 15.0, deck.z0 + 1], [x, 22.6, trussZ], steel, 0.22);
      if (Math.abs(x) >= 14) {
        this._buildTrussSpan([x, deck.y, deck.z0 + 1], [x, 15.0, deck.z0 + 1], steel, 0.26);
      }
    }

    // Runway + B-Stage (ujung runway) + C-Stage (panggung akustik bundar di belakang Festival).
    const runway = stage.runway;
    const runwayLength = runway.z1 - runway.z0;
    const runwayMid = (runway.z0 + runway.z1) / 2;
    this._box(runway.x1 - runway.x0, runway.y, runwayLength, dark, 0, runway.y / 2, runwayMid);
    for (const x of [runway.x0 + 0.06, runway.x1 - 0.06]) this._box(0.12, 0.06, runwayLength, accent, x, runway.y + 0.03, runwayMid);

    const railMatStage = this._std(0x525b76, { roughness: 0.45, metalness: 0.65 });
    const woodDeck = this._std(0x3a2a1e, { roughness: 0.85 });
    const amberGlow = this._basic(0xfbbf24, { toneMapped: false });
    const warmRing = this._basic(0xf59e0b, { toneMapped: false });
    for (const key of ['b_stage', 'c_stage']) {
      const { center, radius } = stage[key];
      const isC = key === 'c_stage';
      const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 0.15, center[1], 48), dark);
      body.position.set(center[0], center[1] / 2, center[2]);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.18, 48), isC ? woodDeck : accentDim);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(center[0], center[1] + 0.01, center[2]);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.09, 8, 64), isC ? warmRing : accent);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(center[0], center[1], center[2]);
      this.world.add(body, floor, rim);

      if (!isC) {
        // B-Stage: undakan apron luar + pagar pit barikade + riser tengah + piano & mikrofon.
        const apron = new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.95, radius + 1.05, 0.75, 48), housingMat);
        apron.position.set(center[0], 0.375, center[2]);
        const riser = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.1, 0.25, 32), housingMat);
        riser.position.set(center[0], center[1] + 0.13, center[2]);
        this.world.add(apron, riser);
        this._buildCircularFence(center[0], center[2], radius + 1.85, railMatStage, Math.PI);
        this._box(1.5, 0.75, 0.85, black, center[0] - 0.8, center[1] + 0.62, center[2] - 0.2);
        for (const mx of [-1.9, 0.2, 1.8]) {
          this._box(0.05, 1.45, 0.05, railMatStage, center[0] + mx, center[1] + 0.95, center[2] + 1.4);
          this._box(0.55, 0.25, 0.4, housingMat, center[0] + mx, center[1] + 0.14, center[2] + radius - 0.8);
        }
      } else {
        // C-Stage: panggung pulau akustik bundar + tangga akses + barikade keliling + lampu hangat & instrumen.
        this._buildCircularFence(center[0], center[2], radius + 1.15, railMatStage, Math.PI);
        for (let s = 0; s < 3; s += 1) {
          this._box(1.2, 0.32, 0.42, railMatStage, center[0], 0.25 + s * 0.38, center[2] - radius - 0.55 + s * 0.28);
        }
        // Piano akustik tegak + stand mikrofon + 3 lampu lantai panggung hangat.
        this._box(1.45, 1.05, 0.65, black, center[0] - 0.6, center[1] + 0.53, center[2] - 0.6);
        for (const [mx, mz] of [[0.7, 0.4], [-0.2, 1.3], [1.4, -0.4]]) {
          this._box(0.05, 1.35, 0.05, railMatStage, center[0] + mx, center[1] + 0.68, center[2] + mz);
        }
        for (const [lx, lz] of [[-2.0, 2.0], [0, -2.2], [2.1, 1.6]]) {
          this._box(0.3, 0.18, 0.3, amberGlow, center[0] + lx, center[1] + 0.09, center[2] + lz);
        }
      }
    }

    // Empat personel band sebagai pembanding skala.
    const performer = this._std(0xd9dbe6, { roughness: 0.6, emissive: 0x333344 });
    for (const x of [-7, -2.5, 2.5, 7]) {
      const figure = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.3, 3, 8), performer);
      figure.position.set(x, deck.y + 0.87, stage.performer_z);
      this.world.add(figure);
    }

    // Kerucut sorot (spotlight cones): transparan, additive, opacity 0.15–0.20, memudar ke ujung. Dua baris:
    // dari rangka tengah panggung (y=15) dan dari rangka atap panggung (y=22,6), diarahkan ke udara/penonton.
    const beamGeometry = new THREE.CylinderGeometry(0.25, 3.4, 80, 14, 1, true);
    beamGeometry.translate(0, -40, 0);
    const beamAlpha = makeBeamAlphaTexture();
    this.sharedTextures.push(beamAlpha);
    const beams = [];
    const down = new THREE.Vector3(0, -1, 0);
    const roofZ = (L.occluders.find((o) => o.kind === 'pillar') || { min: [0, 0, -69], max: [0, 0, -65.5] });
    const roofTrussZ = (roofZ.min[2] + roofZ.max[2]) / 2;
    // Fixture fisik: lampu sorot (moving head) dipasang pada bar lampu di depan pilar atap (y=23,5) dan pada
    // tiang samping di sayap panggung. Pangkal berkas menempel tepat di lensa fixture; sinar yang melintasi
    // pilar, speaker, atau videotron di depannya terhalang depth test (struktur renderOrder 0, sinar renderOrder 2).
    const fixtureZ = roofZ.max[2] + 1.6;                       // di depan muka pilar atap, tidak terbenam di dalamnya
    const barY = 23.55;
    const fixtureMetal = this._std(0x1b1d26, { roughness: 0.45, metalness: 0.7 });
    const rigSteel = this._std(0x2e3548, { roughness: 0.48, metalness: 0.35 });
    // Bar lampu + lengan penyangga ke muka pilar kiri/kanan (opaque, menulis depth).
    this._box(58, 0.34, 0.34, rigSteel, 0, barY, fixtureZ);
    for (const px of [-22.5, 22.5, -38.25, 38.25]) {
      this._box(0.4, 0.4, fixtureZ - roofZ.max[2] + 0.4, rigSteel, px, barY - 0.4, (fixtureZ + roofZ.max[2]) / 2);
    }
    // Tiang samping di dek sayap (di luar tepi videotron bulat) sebagai dudukan fixture.
    const poleZ = -61.5;
    const poleXs = [-40.9, 40.9];
    for (const px of poleXs) this._box(0.5, 23.0 - deck.y, 0.5, rigSteel, px, (23.0 + deck.y) / 2, poleZ);
    const beamSources = [
      ...Array.from({ length: 12 }, (_, i) => [-27.5 + i * 5, 22.6, fixtureZ]),
      ...poleXs.flatMap((px) => [12, 15.5, 19, 22].map((y) => [px, y, poleZ + 0.25 + 0.45])),
    ];
    const lensGeometry = new THREE.CircleGeometry(0.34, 20);
    const housingGeometry = new THREE.CylinderGeometry(0.42, 0.34, 1.1, 18);   // belakang (+Y) lebih lebar, lensa di -Y
    const fixtures = beamSources.map((origin) => {
      const group = new THREE.Group();
      const body = new THREE.Mesh(housingGeometry, fixtureMetal);
      body.position.y = 0.55;
      group.add(body);
      const lensMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff, toneMapped: false, transparent: false, depthWrite: true, depthTest: true, colorWrite: true });
      const lens = new THREE.Mesh(lensGeometry, lensMaterial);
      lens.rotation.x = Math.PI / 2;           // normal lensa menghadap arah berkas (-Y lokal)
      lens.position.y = -0.005;
      group.add(lens);
      group.position.set(...origin);
      group.renderOrder = 0;
      this.world.add(group);
      return { group, lensMaterial };
    });
    beamSources.forEach((origin) => {
      const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.17, alphaMap: beamAlpha, blending: THREE.AdditiveBlending,
        depthTest: true,     // WAJIB true: berkas terhalang tiang / videotron / panggung di depannya
        depthWrite: false,   // antar berkas tidak saling memotong
        side: THREE.DoubleSide, fog: false,
      }));
      beam.position.set(...origin);              // apex tepat di permukaan lensa fixture
      beam.renderOrder = 2;                      // digambar setelah seluruh struktur solid
      beam.frustumCulled = false;
      this.world.add(beam);
      beams.push(beam);
    });
    const laserCount = 18;
    const laserPositions = new Float32Array(laserCount * 6);
    const laserGeometry = new THREE.BufferGeometry();
    laserGeometry.setAttribute('position', new THREE.BufferAttribute(laserPositions, 3));
    const laserMaterial = new THREE.LineBasicMaterial({
      color: 0x39ff9a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending,
      depthTest: true, depthWrite: false, fog: false });
    const lasers = new THREE.LineSegments(laserGeometry, laserMaterial);
    lasers.renderOrder = 2;
    lasers.frustumCulled = false;
    this.world.add(lasers);
    if (this.stadiumAtmo) {
      this.stadiumAtmo.beams = beams;
      this.stadiumAtmo.lasers = lasers;
      this.stadiumAtmo.laserMaterial = laserMaterial;
    }
    const direction = new THREE.Vector3();
    const tint = new THREE.Color();
    const lensWhite = new THREE.Color(0xffffff);
    this.updaters.push((dt, time) => {
      const motion = this.reducedMotion ? 0 : time;
      const beamScale = this.stadiumAtmo ? this.stadiumAtmo.beamScale : 1;
      const lasersActive = !this.stadiumAtmo || this.stadiumAtmo.phase === 'peak_show';
      beams.forEach((beam, i) => {
        beam.visible = beamScale > 0.01;
        if (!beam.visible) return;
        const yaw = Math.sin(motion * 0.3 + i * 0.9) * 0.7;
        const tilt = 0.5 + Math.sin(motion * 0.23 + i * 1.7) * 0.32;
        direction.set(Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt) * 0.55 - 0.1, Math.cos(yaw) * Math.cos(tilt)).normalize();
        beam.quaternion.setFromUnitVectors(down, direction);
        fixtures[i].group.quaternion.copy(beam.quaternion);   // fixture ikut menghadap arah berkas
        tint.copy(this.vivid).offsetHSL(i * 0.07, 0, 0);
        beam.material.color.copy(tint);
        fixtures[i].lensMaterial.color.copy(tint).lerp(lensWhite, 0.55);
        beam.material.opacity = (0.15 + 0.05 * this.media.color.luma) * beamScale;       // 0.15–0.20 * scale
      });
      lasers.visible = lasersActive;
      if (!lasersActive) return;
      for (let i = 0; i < laserCount; i += 1) {
        const originX = i < laserCount / 2 ? -12 : 12;
        const fan = ((i % (laserCount / 2)) / (laserCount / 2 - 1) - 0.5) * 1.3 + Math.sin(motion * 0.5) * 0.3;
        const lift = 0.1 + 0.1 * Math.sin(motion + i);
        laserPositions.set([
          originX, 22.6, fixtureZ,
          originX + Math.sin(fan) * 260, 22.6 + lift * 260, fixtureZ + Math.cos(fan) * 260,
        ], i * 6);
      }
      laserGeometry.attributes.position.needsUpdate = true;
      laserMaterial.opacity = 0.18 + 0.4 * this.media.energy;
    });
  }

  _buildRain(L, rand) {
    const MAX_RAIN = 3000;
    const positions = new Float32Array(MAX_RAIN * 3);
    const speeds = new Float32Array(MAX_RAIN);
    for (let i = 0; i < MAX_RAIN; i += 1) {
      positions[i * 3] = (rand() - 0.5) * 120.0;
      positions[i * 3 + 1] = rand() * 54.0;
      positions[i * 3 + 2] = (rand() - 0.5) * 120.0;
      speeds[i] = 0.8 + rand() * 0.45;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setDrawRange(0, 0);

    const bowl = L.bowl || { rx_inner: 55.0, rz_inner: 82.5 };
    const uniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 24.0 },
      uWindX: { value: 2.5 },
      uOpacity: { value: 0.0 },
      uSize: { value: 14.0 },
      uColor: { value: new THREE.Color(0xcbd5e1) },
      uCamPos: { value: new THREE.Vector3() },
      uRoofRx: { value: Number(bowl.rx_inner || 55.0) + 6.0 },
      uRoofRz: { value: Number(bowl.rz_inner || 82.5) + 6.0 },
      uRoofY: { value: 35.0 },
    };
    const material = this._shared(new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uTime;
        uniform float uSpeed;
        uniform float uWindX;
        uniform float uSize;
        uniform vec3 uCamPos;
        uniform float uRoofRx;
        uniform float uRoofRz;
        uniform float uRoofY;
        attribute float aSpeed;
        varying float vAlpha;
        void main() {
          float wx = mod(position.x - uCamPos.x + uTime * uWindX + 60.0, 120.0) - 60.0 + uCamPos.x;
          float wz = mod(position.z - uCamPos.z + 60.0, 120.0) - 60.0 + uCamPos.z;
          float wy = mod(position.y - uTime * uSpeed * aSpeed, 54.0);
          float roofRatio = length(vec2(wx / uRoofRx, wz / uRoofRz));
          float roofMask = wy < uRoofY ? (1.0 - smoothstep(0.98, 1.18, roofRatio)) : 1.0;
          vec4 mvPosition = modelViewMatrix * vec4(wx, wy, wz, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          float dist = max(1.5, -mvPosition.z);
          gl_PointSize = clamp(uSize * (12.0 / dist), 1.5, 9.5);
          vAlpha = clamp(roofMask * (1.0 - smoothstep(42.0, 62.0, dist)), 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        void main() {
          float dx = abs(gl_PointCoord.x - 0.5);
          if (dx > 0.16) discard;
          float streak = clamp(1.0 - dx * 6.25, 0.0, 1.0);
          float vFade = smoothstep(0.0, 0.2, gl_PointCoord.y) * smoothstep(1.0, 0.8, gl_PointCoord.y);
          float alpha = streak * vFade * uOpacity * vAlpha;
          if (alpha < 0.02) discard;
          gl_FragColor = vec4(uColor, alpha);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
    }));

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    points.renderOrder = 3;
    this.world.add(points);
    if (this.stadiumAtmo) {
      this.stadiumAtmo.rain = { points, geometry, material, uniforms, maxCount: MAX_RAIN };
    }
    this.updaters.push((dt, time) => {
      if (!points.visible) return;
      uniforms.uTime.value = this.reducedMotion ? time * 0.15 : time;
      uniforms.uCamPos.value.copy(this.camera.position);
    });
  }

  /** Ribuan gelang LED (Xyloband) di tribun dan lapangan: satu draw call, warna di shader. */
  _buildXylobands(L, rand) {
    const { bowl } = L;
    const step = bowl.bearings[1] - bowl.bearings[0];
    const positions = [];
    const seeds = [];
    const ringPoint = (tier, bearing, t) => {
      const b = ((bearing % 360) + 360) % 360;
      const i = Math.min(bowl.bearings.length - 2, Math.floor(b / step));
      const f = b / step - i;
      return lerp3(lerp3(tier.inner[i], tier.inner[i + 1], f), lerp3(tier.outer[i], tier.outer[i + 1], f), t);
    };
    for (const block of L.blocks) {
      if (block.standing) continue;
      for (const range of block.tiers) {
        const tier = bowl.tiers.find((t) => t.name === range.name);
        const span = tier.depth_end - tier.depth_start;
        const t0 = (range.depth_start - tier.depth_start) / span;
        const t1 = (range.depth_end - tier.depth_start) / span;
        const arc = block.bearing[1] - block.bearing[0];
        const area = (arc / 360) * TAU * 105 * (range.depth_end - range.depth_start);
        for (let n = Math.round(area * 0.55); n > 0; n -= 1) {
          const p = ringPoint(tier, block.bearing[0] + rand() * arc, t0 + rand() * (t1 - t0));
          positions.push(p[0], p[1] + 1.0 + rand() * 0.5, p[2]);
          seeds.push(rand());
        }
      }
    }

    // Lapangan: sampling tolak di dalam poligon area Festival, di luar panggung/runway.
    const outline = L.field.outline;
    this.insideField = (x, z) => {
      let hit = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
        const [xi, zi] = outline[i];
        const [xj, zj] = outline[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
      }
      return hit;
    };
    const { runway, b_stage: bStage, c_stage: cStage } = L.stage;
    // Zona bebas penonton di sekitar struktur lapangan (kotak berorientasi): barikade FOH dan dek menara delay.
    this.crowdKeepOut = L.occluders.filter((o) => o.kind === 'platform' || o.kind === 'tower').map((o) => {
      const cx = (o.min[0] + o.max[0]) / 2;
      const cz = (o.min[2] + o.max[2]) / 2;
      if (o.kind === 'platform') {
        const pad = FOH_BARRIER + 0.4;
        return { kind: o.kind, cx, cz, rot: 0, hx: (o.max[0] - o.min[0]) / 2 + pad, hz: (o.max[2] - o.min[2]) / 2 + pad };
      }
      return { kind: o.kind, cx, cz, rot: cx < 0 ? -0.36 : 0.36, hx: 5.3, hz: 4.6 };   // = dek 8,2 × 6,2 m + pagar + tangga
    });
    const insideZone = (zone, x, z, grow = 0) => {
      const dx = x - zone.cx;
      const dz = z - zone.cz;
      const c = Math.cos(zone.rot);
      const s = Math.sin(zone.rot);
      return Math.abs(dx * c - dz * s) < zone.hx + grow && Math.abs(dx * s + dz * c) < zone.hz + grow;
    };
    this.insideKeepOut = (x, z, grow = 0) => this.crowdKeepOut.some((zone) => insideZone(zone, x, z, grow));
    this.clearOfStage = (x, z) => {
      if (this.insideKeepOut(x, z)) return false;
      if (x > runway.x0 - 1.4 && x < runway.x1 + 1.4 && z < runway.z1 + 1.4) return false;
      if (Math.hypot(x - bStage.center[0], z - bStage.center[2]) < bStage.radius + 1.5) return false;
      return Math.hypot(x - cStage.center[0], z - cStage.center[2]) >= cStage.radius + 1.5;
    };
    for (let placed = 0, tries = 0; placed < 5200 && tries < 30000; tries += 1) {
      const x = (rand() - 0.5) * 84;
      const z = -53 + rand() * 123;
      if (!this.insideField(x, z) || !this.clearOfStage(x, z)) continue;
      positions.push(x, 1.3 + rand() * 0.7, z);
      seeds.push(rand());
      placed += 1;
    }

    const uniforms = {
      uTime: { value: 0 }, uBeat: { value: 0.3 }, uProj: { value: 600 }, uWave: { value: 0.5 }, uGlow: { value: 1.0 },
      uColorA: { value: new THREE.Color(XYLO_PALETTES[0][0]) },
      uColorB: { value: new THREE.Color(XYLO_PALETTES[0][1]) },
      uColorC: { value: new THREE.Color(XYLO_PALETTES[0][2]) },
    };
    const material = this._shared(new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSeed;
        uniform float uTime;
        uniform float uBeat;
        uniform float uProj;
        uniform float uWave;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform vec3 uColorC;
        varying vec3 vColor;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          float dist = max(0.5, -mv.z);
          float pick = fract(aSeed * 7.31 + floor(uTime * 0.2) * 0.37);
          vec3 color = pick < 0.5 ? uColorA : (pick < 0.82 ? uColorB : uColorC);
          float sweep = 0.5 + 0.5 * sin(world.x * 0.045 + world.z * 0.03 - uTime * 1.7);
          color = mix(color, uColorA, sweep * uWave);
          float twinkle = 0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 5.0) + aSeed * 60.0);
          vColor = color * twinkle * (0.55 + 0.9 * uBeat);
          gl_PointSize = clamp(0.24 * uProj / dist, 1.6, 42.0);
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vColor;
        uniform float uGlow;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float alpha = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vColor * alpha * uGlow, alpha * uGlow);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.world.add(points);
    this.xylo = { material, uniforms, points };

    const palettes = XYLO_PALETTES.map((set) => set.map((hex) => new THREE.Color(hex)));
    const blend = new THREE.Color();
    this.updaters.push((dt, time) => {
      const palette = palettes[Math.floor(time / 7) % palettes.length];
      const rate = 1 - Math.exp(-1.5 * dt);
      blend.copy(palette[0]).lerp(this.vivid, 0.5);
      uniforms.uColorA.value.lerp(blend, rate);
      uniforms.uColorB.value.lerp(palette[1], rate);
      uniforms.uColorC.value.lerp(palette[2], rate);
      uniforms.uTime.value = this.reducedMotion ? 0 : time;
      const beat = clamp(Math.max(this.media.bassLevel(), this.media.energy, this.media.color.luma * 0.6), 0, 1);
      uniforms.uBeat.value += (beat - uniforms.uBeat.value) * (1 - Math.exp(-6 * dt));
      uniforms.uProj.value = this.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    });
  }

  /** Kerumunan jauh di lapangan sebagai siluet (InstancedMesh). */
  _buildFarCrowd(rand) {
    const people = [];
    for (let tries = 0; people.length < 2600 && tries < 20000; tries += 1) {
      const x = (rand() - 0.5) * 86;                     // sebaran merata di seluruh oval Festival
      const z = -53 + rand() * 123;
      if (!this.insideField(x, z) || !this.clearOfStage(x, z)) continue;
      people.push({ x, z, h: 1.5 + rand() * 0.32 });
    }
    // Kerumunan rapat menempel barikade FOH (sisi depan/samping/belakang), seperti penonton yang berkumpul di sana.
    for (const zone of this.crowdKeepOut.filter((z) => z.kind === 'platform')) {
      const perimeter = 4 * (zone.hx + zone.hz);
      for (let placed = 0, tries = 0; placed < 90 && tries < 600; tries += 1) {
        let t = rand() * perimeter;
        const out = 0.05 + Math.pow(rand(), 1.6) * 2.6;
        let x;
        let z;
        if (t < 2 * zone.hx) { x = zone.cx - zone.hx + t; z = zone.cz - zone.hz - out; }
        else if ((t -= 2 * zone.hx) < 2 * zone.hx) { x = zone.cx - zone.hx + t; z = zone.cz + zone.hz + out; }
        else if ((t -= 2 * zone.hx) < 2 * zone.hz) { x = zone.cx - zone.hx - out; z = zone.cz - zone.hz + t; }
        else { t -= 2 * zone.hz; x = zone.cx + zone.hx + out; z = zone.cz - zone.hz + t; }
        if (!this.insideField(x, z) || !this.clearOfStage(x, z)) continue;
        if (people.some((p) => Math.abs(p.x - x) < 0.45 && Math.abs(p.z - z) < 0.45)) continue;
        people.push({ x, z, h: 1.5 + rand() * 0.32 });
        placed += 1;
      }
    }
    const material = this._basic(0x05060c);
    const body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.19, 0.72, 2, 6), material, people.length);
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), material, people.length);
    body.frustumCulled = false;
    head.frustumCulled = false;
    this.world.add(body, head);
    this.farCrowd = { body, head, people };
    this._layoutFarCrowd(null, 0);
  }

  /** Susun ulang kerumunan jauh; kosongkan radius di sekitar penonton berdiri (diisi kerumunan detail). */
  _layoutFarCrowd(center, radius) {
    this.crowdCenter = center;
    this.crowdRadius = radius;
    const crowd = this.farCrowd;
    if (!crowd) return;
    const ratio = this.stadiumAtmo ? this.stadiumAtmo.crowdRatio : 1;
    const matrix = new THREE.Matrix4();
    const none = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    crowd.people.forEach((person, i) => {
      const hidden = center && Math.hypot(person.x - center.x, person.z - center.z) < radius;
      const kept = ((i * 73 + 17) % 100) < ratio * 100;
      const s = hidden || !kept ? 0 : 1;
      matrix.compose(position.set(person.x, person.h * 0.409, person.z), none,
        scale.set(1.2 * s, ((person.h * 0.818) / 1.1) * s, s));
      crowd.body.setMatrixAt(i, matrix);
      matrix.compose(position.set(person.x, person.h - 0.11, person.z), none, scale.set(s, s, s));
      crowd.head.setMatrixAt(i, matrix);
    });
    crowd.body.instanceMatrix.needsUpdate = true;
    crowd.head.instanceMatrix.needsUpdate = true;
  }

  /* ======================================================================= */
  /* DETAIL DI SEKITAR KURSI                                                 */
  /* ======================================================================= */
  _buildLocal(pov) {
    this._clearGroup(this.local);
    this.frontGroup = null;
    if (this.stadiumAtmo) this.stadiumAtmo.localGroups = [];
    const frame = pov.seat_frame;
    const rig = new THREE.Group();
    rig.position.copy(vec(frame.origin));
    rig.rotation.y = Math.atan2(-frame.facing[0], -frame.facing[2]);
    this.local.add(rig);

    if (frame.seat_type === 'tribune') {
      this._buildTribuneLocal(rig, frame, pov);
      this._layoutFarCrowd(null, 0);
    } else if (frame.seat_type === 'festival') {
      this._buildCrowdLocal(frame, pov);
    } else {
      const own = this.seatById.get(pov.seat.seat_id);
      const frontSeat = own ? this.seatByGrid.get(`${own.row_index - 1}:${own.number}`) : null;
      this._hideSpectators([pov.seat.seat_id, frontSeat ? frontSeat.id : null].filter(Boolean));
      if (this.fourDX.config && frame.motion) this.fourDX.pivot = vec(frame.motion.pivot);
      if (this.fourDX.wind) this.fourDX.wind.position.set(pov.eye[0], pov.eye[1] - 0.3, pov.eye[2] - 0.2);
    }
    // Tidak ada mesh kaki/badan POV sendiri: saat kamera menunduk, kaki prosedural selalu menabrak sandaran kursi
    // di depan (terutama sofa The Premiere). Pandangan orang pertama cukup dari posisi mata Python.
    this._buildFrontSpectator(pov);
  }

  /** Penonton tepat di depan: ukurannya persis dari Python (slider "Tinggi Penonton di Depan"). */
  _buildFrontSpectator(pov) {
    if (this.frontGroup) {
      this._clearGroup(this.frontGroup);
      this.local.remove(this.frontGroup);
      this.frontGroup = null;
    }
    const spectator = pov.front_spectator;
    if (!spectator.present) return;
    if (this.layout.kind === 'cinema' && this.seatFit) {
      this._buildFrontFigure(spectator);
      return;
    }
    const standing = spectator.posture === 'standing';
    const yaw = standing ? pov.camera.yaw_rad : Math.atan2(-pov.seat_frame.facing[0], -pov.seat_frame.facing[2]);
    const group = new THREE.Group();
    group.position.set(spectator.floor[0], 0, spectator.floor[2]);
    group.rotation.y = yaw;
    const skin = this.layout.kind === 'cinema'
      ? this._std(0x0b0c10, { roughness: 1, metalness: 0 })                    // siluet penonton di depan: #0B0C10 matte
      : this._std(0x12121c, { roughness: 1, emissive: 0x0b0a24 });
    const floorY = spectator.floor[1];
    const lean = spectator.lean_back_m;            // +z lokal = ke belakang
    const radius = spectator.head_radius_m;

    const head = new THREE.Mesh(new THREE.SphereGeometry(radius, 18, 14), skin);
    head.position.set(0, spectator.head_top_y - radius, lean);
    const shoulders = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.085, Math.max(0.05, spectator.shoulder_width_m - 0.17), 3, 8), skin);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.set(0, spectator.shoulder_y - 0.07, lean);
    const bodyBottom = standing ? floorY : floorY + 0.4;
    const bodyHeight = Math.max(0.36, spectator.shoulder_y - bodyBottom);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, Math.max(0.04, bodyHeight - 0.32), 3, 8), skin);
    torso.position.set(0, bodyBottom + bodyHeight / 2, lean * 0.55);
    group.add(head, shoulders, torso);
    this.local.add(group);
    this.frontGroup = group;
  }

  /**
   * Bioskop: penonton di depan memakai manekin yang sama dengan penonton lain (bentuk seragam), duduk di bantalan
   * kursi depan. Skalanya seragam dan dipilih agar puncak kepala tepat di `head_top_y` Python (slider tinggi
   * penonton), jadi siluet yang terlihat sama dengan yang dipakai hitungan halangan.
   */
  _buildFrontFigure(spectator) {
    const fit = this.seatFit;
    const [fx, fy, fz] = spectator.floor;
    let seat = null;
    let best = Infinity;
    for (const candidate of this.layout.seats) {
      const d = Math.hypot(candidate.x - fx, candidate.z - fz);
      if (d < best) {
        best = d;
        seat = candidate;
      }
    }
    const spot = { x: fx, y: fy, z: fz, group: seat && best < 0.05 ? seat.group : null };
    const scale = clamp((spectator.head_top_y - fy - fit.cushion) / fit.top, 0.75, 1.35);
    const mesh = new THREE.Mesh(seatedFigureGeometry(fit), this._std(0x0b0c10, { roughness: 1, metalness: 0 }));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(this._figureMatrix(spot, fit, scale));
    const group = new THREE.Group();
    group.add(mesh);
    this.local.add(group);
    this.frontGroup = group;
  }

  /** Tribun di sekitar kursi: undakan, kursi, penonton, gelang LED, pagar baris depan. */
  _buildTribuneLocal(rig, frame, pov) {
    const depth = frame.row_depth;
    const rise = frame.row_rise;
    const pitch = frame.seat_pitch;
    const half = 15;
    const rows = [];
    for (let k = -Math.min(2, frame.rows_behind); k <= Math.min(8, frame.rows_ahead); k += 1) rows.push(k);
    const rand = mulberry32(hashString(pov.seat.seat_id));
    const width = (half * 2 + 1) * pitch + 1;
    const matrix = new THREE.Matrix4();

    const steps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(width, rise + 0.3, depth), this._std(0x191b24, { roughness: 1 }), rows.length);
    rows.forEach((k, i) => {
      matrix.makeTranslation(0, -k * rise - (rise + 0.3) / 2, -k * depth);
      steps.setMatrixAt(i, matrix);
    });
    rig.add(steps);

    const seatGeometry = mergeGeometries([boxPart(0.42, 0.05, 0.38, 0, 0.42, 0.03), boxPart(0.42, 0.34, 0.04, 0, 0.62, 0.23)]);
    const seats = new THREE.InstancedMesh(seatGeometry, this._std(0x5a1218, { roughness: 0.9 }), rows.length * (half * 2 + 1));
    const hasFront = pov.front_spectator.present;
    const people = [];
    let index = 0;
    for (const k of rows) {
      for (let j = -half; j <= half; j += 1) {
        matrix.makeTranslation(j * pitch, -k * rise, -k * depth);
        seats.setMatrixAt(index, matrix);
        index += 1;
        const self = k === 0 && j === 0;
        const front = k === 1 && j === 0 && hasFront;
        const person = {
          x: j * pitch, y: -k * rise, z: -k * depth + 0.08,
          sit: 0.78 + rand() * 0.14, raised: rand() < 0.3, seed: rand(), present: rand() < 0.9,
        };
        // Baris depan: hanya baris di belakang yang terisi, jadi tak ada kepala yang masuk pandangan.
        if (!self && !front && person.present && !(frame.is_front_row && k >= 0)) people.push(person);
      }
    }
    rig.add(seats);

    if (people.length) {
      const dark = this._std(0x0b0b11, { roughness: 1 });
      const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.105, 10, 8), dark, people.length);
      const torsos = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.17, 0.3, 2, 8), dark, people.length);
      const none = new THREE.Quaternion();
      const wide = new THREE.Vector3(1.2, 1, 1);
      const position = new THREE.Vector3();
      const bands = [];
      const seeds = [];
      const headBase = [];
      const torsoBase = [];
      people.forEach((person, i) => {
        matrix.makeTranslation(person.x, person.y + 0.42 + person.sit - 0.105, person.z);
        heads.setMatrixAt(i, matrix);
        headBase.push(matrix.clone());
        matrix.compose(position.set(person.x, person.y + 0.72, person.z), none, wide);
        torsos.setMatrixAt(i, matrix);
        torsoBase.push(matrix.clone());
        bands.push(person.x + 0.2, person.y + (person.raised ? 1.45 + person.seed * 0.2 : 0.78), person.z - (person.raised ? 0.1 : 0.25));
        seeds.push(person.seed);
      });
      for (const mesh of [heads, torsos]) mesh.frustumCulled = false;
      rig.add(heads, torsos);
      if (this.stadiumAtmo) {
        this.stadiumAtmo.localGroups.push({ mesh: heads, base: headBase }, { mesh: torsos, base: torsoBase });
        this._syncLocalCrowdDensity();
      }
      this._addBandPoints(rig, bands, seeds);
    }
    for (const mesh of [steps, seats]) mesh.frustumCulled = false;

    if (frame.rows_ahead === 0) {            // pagar di depan baris pertama tingkat tribun
      const rail = this._std(0x9aa0b5, { metalness: 0.6, roughness: 0.4 });
      this._box(width, 0.05, 0.05, rail, 0, 1.0, -0.62, rig);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.0), new THREE.MeshBasicMaterial({
        color: 0x9db4ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
      glass.position.set(0, 0.5, -0.62);
      rig.add(glass);
    }
  }

  /** Gelang LED di dekat kamera memakai shader yang sama dengan tribun (warna selalu serempak). */
  _addBandPoints(parent, positions, seeds) {
    if (!this.xylo || !positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const points = new THREE.Points(geometry, this.xylo.material);
    points.frustumCulled = false;
    parent.add(points);
  }

  /** Kerumunan berdiri di sekitar penonton Festival: kepala, bahu, tangan & HP terangkat. */
  _buildCrowdLocal(frame, pov) {
    const origin = vec(frame.origin);
    const spacing = frame.crowd_spacing;
    const radius = 11;
    const yaw = pov.camera.yaw_rad;
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const front = pov.front_spectator.present ? pov.front_spectator.floor : null;
    const rand = mulberry32(hashString(pov.seat.seat_id + pov.active_target));
    const reach = Math.ceil(radius / spacing);
    const people = [];
    for (let i = -reach; i <= reach; i += 1) {
      for (let j = -reach; j <= reach; j += 1) {
        const dx = (i + (j & 1 ? 0.5 : 0)) * spacing + (rand() - 0.5) * spacing * 0.35;
        const dz = j * spacing * 0.87 + (rand() - 0.5) * spacing * 0.35;
        const person = {
          x: origin.x + dx, z: origin.z + dz,
          h: 1.5 + rand() * 0.32, raised: rand() < 0.2, phone: rand() < 0.6, seed: rand(),
        };
        const distance = Math.hypot(dx, dz);
        if (distance < 0.5 || distance > radius) continue;
        // Tidak ada lengan terangkat di depan kamera dalam jarak dekat: pandangan ke panggung tetap bersih.
        if (person.raised && distance < 3.5 && (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / distance > 0.45) person.raised = false;
        if (front && Math.hypot(person.x - front[0], person.z - front[2]) < 0.42) continue;
        if (!this.insideField(person.x, person.z) || !this.clearOfStage(person.x, person.z)) continue;
        people.push(person);
      }
    }
    this._layoutFarCrowd(origin, radius);

    const skin = this._std(0x0d0d14, { roughness: 1 });
    const raisedCount = Math.max(1, people.filter((p) => p.raised).length);
    const bodies = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.17, 0.72, 3, 8), skin, Math.max(1, people.length));
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.105, 12, 10), skin, Math.max(1, people.length));
    const arms = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.035, 0.44, 2, 6), skin, raisedCount);
    const matrix = new THREE.Matrix4();
    const none = new THREE.Quaternion();
    const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const mesh of [bodies, heads, arms]) {
      mesh.setMatrixAt(0, zero);
      mesh.frustumCulled = false;
    }
    const bands = [];
    const seeds = [];
    const bodyBase = [];
    const headBase = [];
    let armIndex = 0;
    people.forEach((person, i) => {
      const shoulder = person.h * 0.818;
      matrix.compose(position.set(person.x, shoulder / 2, person.z), facing, scale.set(1.25, shoulder / 1.06, 1));
      bodies.setMatrixAt(i, matrix);
      bodyBase.push(matrix.clone());
      matrix.compose(position.set(person.x, person.h - 0.105, person.z), none, scale.set(1, 1, 1));
      heads.setMatrixAt(i, matrix);
      headBase.push(matrix.clone());
      const side = person.seed < 0.5 ? -0.22 : 0.22;
      const handX = person.x + right.x * side;
      const handZ = person.z + right.z * side;
      if (person.raised) {
        matrix.compose(position.set(handX, shoulder + 0.24, handZ), none, scale.set(1, 1, 1));
        arms.setMatrixAt(armIndex, matrix);
        armIndex += 1;
        bands.push(handX, shoulder + 0.42, handZ);
      } else {
        bands.push(handX, person.h * 0.5, handZ);
      }
      seeds.push(person.seed);
    });
    this.local.add(bodies, heads, arms);
    if (this.stadiumAtmo) {
      arms.visible = this.stadiumAtmo.crowdRatio > 0.35;
      this.stadiumAtmo.localGroups.push({ mesh: bodies, base: bodyBase }, { mesh: heads, base: headBase }, { mesh: arms, isArms: true });
      this._syncLocalCrowdDensity();
    }
    this._addBandPoints(this.local, bands, seeds);
  }

  _syncLocalCrowdDensity() {
    const atmo = this.stadiumAtmo;
    if (!atmo || !atmo.localGroups.length) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const group of atmo.localGroups) {
      if (group.isArms) {
        group.mesh.visible = atmo.crowdRatio > 0.35;
        continue;
      }
      group.base.forEach((mat, i) => {
        const kept = ((i * 73 + 17) % 100) < atmo.crowdRatio * 100;
        group.mesh.setMatrixAt(i, kept ? mat : zero);
      });
      group.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Ubah atmosfer stadion GBK berdasarkan waktu konser (`open_gate` | `golden_hour` | `transition_rain` | `peak_show`).
   */
  setConcertPhase(phase = 'peak_show') {
    const valid = ['open_gate', 'golden_hour', 'transition_rain', 'peak_show'].includes(phase) ? phase : 'peak_show';
    this.concertPhase = valid;
    const atmo = this.stadiumAtmo;
    if (!atmo || !this.layout || this.layout.kind === 'cinema') return;
    atmo.phase = valid;

    const presets = {
      open_gate: {
        bg: 0xbae6fd,
        fogColor: 0xcfe8ff,
        fogDensity: 0.00055,
        horizon: 0xdbeafe,
        zenith: 0x38bdf8,
        starsVisible: false,
        ambientColor: 0xffffff,
        ambientInt: 1.15,
        hemiSky: 0xe0f2fe,
        hemiGround: 0x64748b,
        hemiInt: 1.1,
        beamScale: 0,
        stageScale: 0,
        xyloGlow: 0,
        crowdRatio: 0.12,
        rainCount: 0,
        rainSpeed: 18.0,
        rainWindX: 1.5,
        rainOpacity: 0.0,
        rainColor: 0xcbd5e1,
        rainSize: 13.0,
      },
      golden_hour: {
        bg: 0xd97343,
        fogColor: 0x8a3b20,
        fogDensity: 0.00125,
        horizon: 0xfb923c,
        zenith: 0x4c1d95,
        starsVisible: false,
        ambientColor: 0xfed7aa,
        ambientInt: 0.72,
        hemiSky: 0xfdba74,
        hemiGround: 0x27192d,
        hemiInt: 0.85,
        beamScale: 0.30,
        stageScale: 0.45,
        xyloGlow: 0.22,
        crowdRatio: 0.55,
        rainCount: 1200,
        rainSpeed: 18.0,
        rainWindX: 2.2,
        rainOpacity: 0.36,
        rainColor: 0xffedd5,
        rainSize: 13.0,
      },
      transition_rain: {
        bg: 0x162033,
        fogColor: 0x1e293b,
        fogDensity: 0.00215,
        horizon: 0x334155,
        zenith: 0x0b1120,
        starsVisible: false,
        ambientColor: 0x94a3b8,
        ambientInt: 0.44,
        hemiSky: 0x475569,
        hemiGround: 0x0f172a,
        hemiInt: 0.62,
        beamScale: 0.62,
        stageScale: 0.72,
        xyloGlow: 0.58,
        crowdRatio: 0.84,
        rainCount: 3000,
        rainSpeed: 32.0,
        rainWindX: 5.5,
        rainOpacity: 0.64,
        rainColor: 0xcbd5e1,
        rainSize: 18.0,
      },
      peak_show: {
        bg: 0x03040a,
        fogColor: 0x060817,
        fogDensity: 0.0013,
        horizon: 0x151c40,
        zenith: 0x02030a,
        starsVisible: true,
        ambientColor: 0x8fa2ff,
        ambientInt: 0.3,
        hemiSky: 0x2b3a7a,
        hemiGround: 0x05060a,
        hemiInt: 0.5,
        beamScale: 1.0,
        stageScale: 1.0,
        xyloGlow: 1.0,
        crowdRatio: 1.0,
        rainCount: 0,
        rainSpeed: 24.0,
        rainWindX: 2.0,
        rainOpacity: 0.0,
        rainColor: 0xcbd5e1,
        rainSize: 14.0,
      },
    };
    const cfg = presets[valid];
    this.scene.background = new THREE.Color(cfg.bg);
    this.scene.fog = new THREE.FogExp2(cfg.fogColor, cfg.fogDensity);
    const posAttr = atmo.skyGeometry.attributes.position;
    const horizon = new THREE.Color(cfg.horizon);
    const zenith = new THREE.Color(cfg.zenith);
    const mixed = new THREE.Color();
    for (let i = 0; i < posAttr.count; i += 1) {
      const t = Math.pow(clamp(posAttr.getY(i) / 700, 0, 1), 0.6);
      mixed.copy(horizon).lerp(zenith, t);
      atmo.skyColors.set([mixed.r, mixed.g, mixed.b], i * 3);
    }
    atmo.skyGeometry.attributes.color.needsUpdate = true;

    atmo.stars.visible = cfg.starsVisible;
    atmo.ambientLight.color.setHex(cfg.ambientColor);
    atmo.ambientLight.intensity = cfg.ambientInt;
    atmo.hemiLight.color.setHex(cfg.hemiSky);
    atmo.hemiLight.groundColor.setHex(cfg.hemiGround);
    atmo.hemiLight.intensity = cfg.hemiInt;
    atmo.beamScale = cfg.beamScale;
    atmo.stageScale = cfg.stageScale;
    atmo.crowdRatio = cfg.crowdRatio;

    if (atmo.rain) {
      const { points, geometry, uniforms, maxCount } = atmo.rain;
      const count = Math.max(0, Math.min(maxCount, cfg.rainCount || 0));
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      uniforms.uSpeed.value = cfg.rainSpeed;
      uniforms.uWindX.value = cfg.rainWindX;
      uniforms.uOpacity.value = cfg.rainOpacity;
      uniforms.uSize.value = cfg.rainSize;
      uniforms.uColor.value.setHex(cfg.rainColor);
    }

    if (atmo.lasers) atmo.lasers.visible = valid === 'peak_show';
    if (atmo.beams) atmo.beams.forEach((b) => { b.visible = cfg.beamScale > 0.01; });
    if (this.xylo) {
      this.xylo.uniforms.uGlow.value = cfg.xyloGlow;
      if (this.xylo.points) this.xylo.points.visible = cfg.xyloGlow > 0.01;
    }
    this._layoutFarCrowd(this.crowdCenter, this.crowdRadius);
    this._syncLocalCrowdDensity();
  }

  /* ======================================================================= */
  /* MENERAPKAN HASIL PYTHON                                                 */
  /* ======================================================================= */
  /**
   * @param {object} pov      respons `/api/pov`
   * @param {'jump'|'glide'|'quick'} mode  jump = langsung, glide = meluncur antar kursi,
   *                                           quick = mengikuti slider
   * @param {object|null} options  opsional `{ clusterCenter: { x, y, z } }` untuk membidik titik tengah kluster
   */
  applyPov(pov, mode = 'glide', options = null) {
    const clusterCenter = options && options.clusterCenter ? options.clusterCenter : null;
    const clusterKey = clusterCenter
      ? `${Number(clusterCenter.x).toFixed(2)},${Number(clusterCenter.z).toFixed(2)}`
      : '';
    const previous = this.pov;
    const seatChanged = !previous || previous.seat.seat_id !== pov.seat.seat_id
      || previous.venue_id !== pov.venue_id
      || clusterKey !== (this._lastClusterKey || '');
    const targetChanged = !previous || previous.active_target !== pov.active_target;
    this._lastClusterKey = clusterKey;
    if (seatChanged && this.spatialTour && this.spatialTour.seatId !== pov.seat.seat_id) {
      this.stopSpatialRoute();
    }
    this.pov = pov;

    const camera = pov.camera;
    if (clusterCenter && Number.isFinite(Number(clusterCenter.x)) && Number.isFinite(Number(clusterCenter.z))
        && Array.isArray(camera.look_at)) {
      const px = Number(clusterCenter.x);
      const py = Number.isFinite(Number(camera.position[1])) ? Number(camera.position[1]) : Number(clusterCenter.y || 1.2);
      const pz = Number(clusterCenter.z);
      const [lx, ly, lz] = camera.look_at;
      const dx = lx - px;
      const dy = ly - py;
      const dz = lz - pz;
      this.goal.pos.set(px, py, pz);
      this.goal.yaw = Math.atan2(-dx, -dz);
      this.goal.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    } else {
      this.goal.pos.set(...camera.position);
      this.goal.yaw = camera.yaw_rad;
      this.goal.pitch = camera.pitch_rad;
    }
    this.goal.fov = camera.fov_deg;
    const minFar = Math.max(3000.0, camera.far || 3000.0);
    if (this.camera.near !== camera.near || this.camera.far !== minFar) {
      this.camera.near = camera.near || 0.1;
      this.camera.far = minFar;
      this.camera.updateProjectionMatrix();
    }
    if (seatChanged || targetChanged) this.resetLook();
    this.damping = mode === 'quick' ? 14 : 4.5;
    if (mode === 'jump' || this.reducedMotion) {
      this.view.pos.copy(this.goal.pos);
      this.view.yaw = this.goal.yaw;
      this.view.pitch = this.goal.pitch;
      this.view.fov = this.goal.fov;
      this.look.yawNow = 0;
      this.look.pitchNow = 0;
      this.camera.fov = this.goal.fov;
      this.camera.updateProjectionMatrix();
    }

    const standingRetarget = targetChanged && pov.seat_frame.seat_type === 'festival';
    if (seatChanged || standingRetarget) this._buildLocal(pov);
    else this._buildFrontSpectator(pov);
    this.media.applyAcoustics(pov.acoustics.web_audio);
  }

  /**
   * Memulai transisi kamera 3-titik: Plaza Luar SUGBK -> Mulut Ramp Sektor -> Sudut Pandang Kursi.
   */
  playSpatialRoute(pov, gateLabel = '', onWaypoint = null) {
    if (!pov || !pov.camera || !this.layout || this.layout.kind === 'cinema') return false;
    const seatId = pov.seat && pov.seat.seat_id ? pov.seat.seat_id : '';
    const goalPos = this.goal.pos.clone();
    const goalYaw = this.goal.yaw;
    const goalPitch = this.goal.pitch;
    const goalFov = this.goal.fov || pov.camera.fov_deg || 55;

    let horizLen = Math.hypot(goalPos.x, goalPos.z);
    let ux = horizLen >= 10 ? goalPos.x / horizLen : 0.28;
    let uz = horizLen >= 10 ? goalPos.z / horizLen : 0.96;
    if (horizLen < 10) {
      const gate = String(gateLabel || '').toUpperCase();
      if (gate.includes('TIMUR')) { ux = 0.92; uz = 0.39; }
      else if (gate.includes('BARAT')) { ux = -0.92; uz = 0.39; }
      else if (gate.includes('TENGGARA')) { ux = 0.751; uz = 0.660; }
    }

    const lookAngles = (from, to) => {
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const dz = to[2] - from[2];
      return {
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.max(0.001, Math.hypot(dx, dz))),
      };
    };

    const p0 = new THREE.Vector3(ux * 150, 44, uz * 172);
    const l0 = lookAngles([p0.x, p0.y, p0.z], [ux * 48, 20, uz * 56]);

    const roofInnerR = 1 / Math.max(0.001, Math.hypot(ux / 57, uz / 83));
    const p1R = Math.min(roofInnerR, Math.max(horizLen + 14, 46));
    const p1 = new THREE.Vector3(ux * p1R, clamp(goalPos.y + 11, 22, 31), uz * p1R);
    const stageTarget = Array.isArray(pov.camera.look_at) ? pov.camera.look_at : [0, 10, -35];
    const l1 = lookAngles([p1.x, p1.y, p1.z], [stageTarget[0] * 0.65, Math.max(8, stageTarget[1]), stageTarget[2]]);

    this.resetLook();
    this.look.yaw = 0;
    this.look.pitch = 0;
    this.look.yawNow = 0;
    this.look.pitchNow = 0;

    if (this.reducedMotion) {
      this.spatialTour = null;
      this.view.pos.copy(goalPos);
      this.view.yaw = goalYaw;
      this.view.pitch = goalPitch;
      this.view.fov = goalFov;
      if (typeof onWaypoint === 'function') onWaypoint(2, true);
      return true;
    }

    if (this.camera.far < 1600) {
      this.camera.far = 1600;
      this.camera.updateProjectionMatrix();
    }

    this.spatialTour = {
      seatId,
      elapsed: 0,
      lastMs: performance.now(),
      duration: 4.2,
      split: 0.48,
      activeStep: -1,
      onWaypoint,
      waypoints: [
        { pos: p0, yaw: l0.yaw, pitch: l0.pitch, fov: 64 },
        { pos: p1, yaw: l1.yaw, pitch: l1.pitch, fov: 58 },
        { pos: goalPos, yaw: goalYaw, pitch: goalPitch, fov: goalFov },
      ],
    };
    this.view.pos.copy(p0);
    this.view.yaw = l0.yaw;
    this.view.pitch = l0.pitch;
    this.view.fov = 64;
    if (typeof onWaypoint === 'function') {
      this.spatialTour.activeStep = 0;
      onWaypoint(0, false);
    }
    return true;
  }

  stopSpatialRoute({ snapToGoal = false } = {}) {
    if (!this.spatialTour) return;
    const { onWaypoint } = this.spatialTour;
    this.spatialTour = null;
    if (snapToGoal) {
      this.view.pos.copy(this.goal.pos);
      this.view.yaw = this.goal.yaw;
      this.view.pitch = this.goal.pitch;
      this.view.fov = this.goal.fov;
      if (typeof onWaypoint === 'function') onWaypoint(2, true);
    }
    if (this.pov && this.pov.camera && this.camera.far !== this.pov.camera.far) {
      this.camera.far = this.pov.camera.far;
      this.camera.updateProjectionMatrix();
    }
  }

  _tickSpatialRoute(dt) {
    const tour = this.spatialTour;
    if (!tour) return;
    const nowMs = performance.now();
    const wallDt = Number.isFinite(tour.lastMs) ? (nowMs - tour.lastMs) / 1000 : dt;
    tour.lastMs = nowMs;
    tour.elapsed += clamp(wallDt, 0.001, 0.25);
    const t = clamp(tour.elapsed / tour.duration, 0, 1);
    const [w0, w1, w2] = tour.waypoints;
    const view = this.view;

    if (t < tour.split) {
      const seg = t / tour.split;
      const s = seg * seg * (3 - 2 * seg);
      view.pos.lerpVectors(w0.pos, w1.pos, s);
      // Melengkung mulus melewati bibir atap luar SUGBK agar tidak menembus dinding tribun atas.
      view.pos.y += Math.sin(seg * Math.PI) * 16;
      view.yaw = w0.yaw + shortestAngle(w0.yaw, w1.yaw) * s;
      view.pitch = w0.pitch + (w1.pitch - w0.pitch) * s;
      view.fov = w0.fov + (w1.fov - w0.fov) * s;
    } else {
      const seg = (t - tour.split) / (1 - tour.split);
      const s = seg * seg * (3 - 2 * seg);
      view.pos.lerpVectors(w1.pos, w2.pos, s);
      view.yaw = w1.yaw + shortestAngle(w1.yaw, w2.yaw) * s;
      view.pitch = w1.pitch + (w2.pitch - w1.pitch) * s;
      view.fov = w1.fov + (w2.fov - w1.fov) * s;
    }
    const step = t < 0.35 ? 0 : (t < 0.84 ? 1 : 2);

    if (step !== tour.activeStep) {
      tour.activeStep = step;
      if (typeof tour.onWaypoint === 'function') tour.onWaypoint(step, false);
    }

    if (t >= 1) {
      this.spatialTour = null;
      view.pos.copy(this.goal.pos);
      view.yaw = this.goal.yaw;
      view.pitch = this.goal.pitch;
      view.fov = this.goal.fov;
      if (this.pov && this.pov.camera && this.camera.far !== this.pov.camera.far) {
        this.camera.far = this.pov.camera.far;
        this.camera.updateProjectionMatrix();
      }
      if (typeof tour.onWaypoint === 'function') tour.onWaypoint(2, true);
    }
  }

  /**
   * Mode wayfinding: pasang GLB eksterior (Stadium_Core + Zone_Exterior + Zone_Interior) dan data jalur/kursi/barikade
   * (`gbk_wayfinding.json`), lalu sembunyikan stadion prosedural karena mangkuk + panggung di GLB bertumpuk dengannya.
   * Gagal memuat (404/jaringan) → tetap di stadion prosedural dan tur mendarat di POV kursi.
   * @returns {Promise<boolean>} true bila aset terpasang
   */
  async enableWayfinding(rawSeat = null) {
    if (!this.layout || this.layout.kind === 'cinema') return false;
    const seatArg = rawSeat || (this.pov && this.pov.seat && this.pov.seat.seat_id) || WAYPOINT_SEAT_ID;
    if (!this._wayLoad) {
      const dataPromise = fetch(WAY_DATA_URL)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      const specPromise = fetch(GEOM_SPEC_URL)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
      this._wayLoad = Promise.all([loadModel('gbkExterior'), dataPromise, specPromise]).then(([source, json, geomSpec]) => {
        if (geomSpec) applyGbkGeometrySpec(geomSpec);
        this._buildWay(source, json, seatArg);
        return true;
      }).catch(() => {
        this._wayLoad = null;
        return false;
      });
    } else if (this._way && rawSeat) {
      this._applyWayRoute(seatArg);
    }
    const ok = await this._wayLoad;
    this.wayGroup.visible = ok;
    this.world.visible = !ok;       // lampu `world` ikut padam; GLB memakai lampunya sendiri + langit/xylo restorasi
    this.local.visible = !ok;
    if (ok) {
      this._wayKeys.clear();
      this._wayManualDir = 0;
      this.camera.near = 0.4;
      this.camera.far = 1600.0;
      this.camera.updateProjectionMatrix();
      this.scene.background = new THREE.Color(0x03040a);
      this.scene.fog = new THREE.FogExp2(0x0B1020, 0.0012);
      this.scene.environment = this._getWayNightEnvMap();
    }
    return ok;
  }

  getWayfindingRoute() {
    return this._way ? this._way.route : null;
  }

  getWayfindingStats() {
    const info = this.renderer?.info?.render;
    const way = this._way;
    const u = this.wayfinding ? this.wayfinding.u : 0;
    return {
      drawCalls: info ? info.calls : 0,
      triangles: info ? info.triangles : 0,
      t: Number(u.toFixed(4)),
      progress: way ? Number((way.progress ?? 0).toFixed(4)) : 0,
      arrived: u >= 0.98,
      posCount: 5,
      plazaKey: way?.route?.plazaKey || null,
      zoneExteriorVisible: Boolean(way?.exterior?.visible),
      zoneInteriorVisible: Boolean(way?.interior?.visible),
      zoneCull: way ? {
        zone: way.cullZone,
        exteriorOnly: way.exteriorOnlyMeshes.length,
        interiorOnly: way.interiorOnlyMeshes.length,
        exteriorOnlyVisible: way.exteriorOnlyMeshes.filter((m) => m.visible).length,
        interiorOnlyVisible: way.interiorOnlyMeshes.filter((m) => m.visible).length,
      } : null,
      xyloVisible: false,
      seatId: way?.route?.parsed?.normalizedId || null,
      sector: way?.route?.sector ?? null,
      gate: way?.route?.gateInfo?.gate || null,
      plaza: way?.route?.gateInfo?.plaza || null,
      ingressKind: way?.route?.ingressKind || null,
      maxRouteY: way?.route?.maxRouteY ?? null,
      maxVerticalSpikeM: way?.route?.maxVerticalSpikeM ?? 0,
      maxSlopeDeg: way?.route?.maxSlopeDeg ?? 0,
      maxStairAngularDevDeg: way?.route?.stairAngularDevDeg ?? 0,
      geometrySpecVersion: way?.route?.geometrySpecVersion || 'gbk_solid_v1',
      hasSmoothCamCurve: Boolean(this._wayCamCurve),
      lightLedIntersections: way ? this._countLightLedIntersections(way) : 0,
      physicalSeatsRenderedCount: way?.physicalSeatsRenderedCount ?? 0,
      pathLength: way?.route?.pathLength ?? 0,
      step: this.wayfinding?.step ?? null,
      animating: Boolean(this.wayfinding?.tween),
      lookYaw: Number((this.look?.yaw ?? 0).toFixed(4)),
      lookPitch: Number((this.look?.pitch ?? 0).toFixed(4)),
      cameraFar: this.camera.far,
      tweenDuration: WAY_TWEEN_DURATION,
      hasFog: Boolean(this.scene.fog),
      searchlightCount: way?.searchlights?.count ?? 0,
      stageLightCount: way?.stageLights?.count ?? 0,
      laserCount: way?.stageLights?.laserCount ?? 0,
      pinOpacity: Number((way?.pinOpacity ?? 1).toFixed(3)),
      forwardSign: this.wayfinding ? this._wayForwardSign() : 1,
      minimapReady: Boolean(this.minimap && this.minimap.ctx),
      cameraPos: this.view?.pos ? [Number(this.view.pos.x.toFixed(2)), Number(this.view.pos.y.toFixed(2)), Number(this.view.pos.z.toFixed(2))] : null,
    };
  }

  /** 3 lampu global ringan, tanpa bayangan: fill hemisfer + key + rim hangat. */
  _wayLights() {
    const hemi = new THREE.HemisphereLight(0x9db8e8, 0x7a7068, 1.0);
    const key = new THREE.DirectionalLight(0xeef4ff, 1.15);
    key.position.set(140, 180, 110);
    const rim = new THREE.DirectionalLight(0xffd9b3, 0.45);
    rim.position.set(-130, 90, -120);
    return [hemi, key, rim];
  }

  /** Kubah langit malam konser Jakarta (zenith 0x03040a, horizon 0x0c1328) + bintang dalam 1 draw call. */
  _buildWaySky() {
    const skyGeometry = new THREE.SphereGeometry(1300, 24, 14);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color(0x03040a) },
        uHorizon: { value: new THREE.Color(0x0c1328) },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        float hash31(vec3 p) {
          p = fract(p * vec3(443.897, 441.423, 437.195));
          p += dot(p, p.yzx + 19.19);
          return fract((p.x + p.y) * p.z);
        }
        void main() {
          float h = pow(clamp(vDir.y, 0.0, 1.0), 0.65);
          vec3 col = mix(uHorizon, uTop, h);
          vec3 cell = floor(vDir * 240.0);
          float rnd = hash31(cell);
          float star = smoothstep(0.9965, 0.9998, rnd) * smoothstep(0.08, 0.35, vDir.y);
          col += vec3(0.75, 0.84, 1.0) * star * 0.85;
          gl_FragColor = vec4(col, 1.0);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    skyMesh.frustumCulled = false;
    return skyMesh;
  }

  /** Partikel LED wristbands (Xylobands) menempel di kursi terisi & lantai Festival (bebas partikel gaib di area kosong). */
  _buildWayXylobands(parent, seatsSouth = null) {
    const rand = mulberry32(2026);
    const positions = [];
    const seeds = [];
    const ellipsePt = (rx, rz, y, deg) => {
      const r = deg * (Math.PI / 180);
      return [rx * Math.sin(r), y, -rz * Math.cos(r)];
    };

    // 1. Kursi fisik CAT 3 Selatan dari InstancedMesh GLB (1 titik tepat di atas tiap kursi)
    if (seatsSouth && seatsSouth.isInstancedMesh) {
      seatsSouth.updateWorldMatrix(true, false);
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      for (let i = 0; i < seatsSouth.count; i += 1) {
        seatsSouth.getMatrixAt(i, m);
        m.decompose(pos, quat, scl);
        pos.applyMatrix4(seatsSouth.matrixWorld);
        positions.push(pos.x, pos.y + 0.55, pos.z);
        seeds.push(rand());
      }
    }

    // 2. Tier 1 mangkuk tribun terisi (hanya sektor berkursi 102..258 deg, lewati celah lorong |x| < 3.5 dan blok selatan 172..188 deg)
    for (let i = 0; i < 1600; i += 1) {
      const deg = 102 + rand() * 156;
      if (deg >= 172 && deg <= 188) continue;
      const frac = rand();
      const rx = 75 + frac * 17;
      const rz = 104 + frac * 22;
      const y = 6.8 + frac * 14.0 + 0.55;
      const [x, py, z] = ellipsePt(rx, rz, y, deg);
      if (Math.abs(x) < 3.5) continue;
      positions.push(x, py, z);
      seeds.push(rand());
    }

    // 3. Tier 2 atas terisi (hanya sektor berkursi 106..254 deg, lewati celah lorong |x| < 3.5)
    for (let i = 0; i < 1300; i += 1) {
      const deg = 106 + rand() * 148;
      const frac = rand();
      const rx = 93 + frac * 17;
      const rz = 122 + frac * 20;
      const y = 22.5 + frac * 13.0 + 0.55;
      const [x, py, z] = ellipsePt(rx, rz, y, deg);
      if (Math.abs(x) < 3.5) continue;
      positions.push(x, py, z);
      seeds.push(rand());
    }

    // 4. Lapangan Festival di atas karpet Terraplas z in [-44, 29] (hindari runway, B-Stage, FOH z>29, & 2 panggung kamera broadcast)
    for (let placed = 0, tries = 0; placed < 1200 && tries < 6000; tries += 1) {
      const x = (rand() - 0.5) * 62;
      const z = -44 + rand() * 73;
      if ((x * x) / (33 * 33) + (z * z) / (47 * 47) > 1.0) continue;
      if (Math.abs(x) < 2.6 && z < -6) continue;
      if (Math.hypot(x, z + 10) < 6.8) continue;
      if (Math.hypot(x - 16.5, z + 8.0) < 3.2) continue;  // Panggung kamera Timur-Tengah Blender (16.5, 8.0)
      if (Math.hypot(x + 18.0, z - 24.0) < 3.2) continue; // Panggung kamera Barat Blender (-18.0, -24.0)
      positions.push(x, 1.35 + rand() * 0.45, z);
      seeds.push(rand());
      placed += 1;
    }

    const uniforms = {
      uTime: { value: 0 },
      uBeat: { value: 0.45 },
      uProj: { value: 600 },
      uWave: { value: 0.6 },
      uGlow: { value: 1.0 },
      uColorA: { value: new THREE.Color(XYLO_PALETTES[0][0]) },
      uColorB: { value: new THREE.Color(XYLO_PALETTES[0][1]) },
      uColorC: { value: new THREE.Color(XYLO_PALETTES[0][2]) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSeed;
        uniform float uTime;
        uniform float uBeat;
        uniform float uProj;
        uniform float uWave;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform vec3 uColorC;
        varying vec3 vColor;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vec4 mv = viewMatrix * world;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          float dist = max(0.5, -mv.z);
          float pick = fract(aSeed * 7.31 + floor(uTime * 0.2) * 0.37);
          vec3 color = pick < 0.5 ? uColorA : (pick < 0.82 ? uColorB : uColorC);
          float sweep = 0.5 + 0.5 * sin(world.x * 0.045 + world.z * 0.03 - uTime * 1.7);
          color = mix(color, uColorA, sweep * uWave);
          float twinkle = 0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 5.0) + aSeed * 60.0);
          vColor = color * twinkle * (0.65 + 0.85 * uBeat);
          gl_PointSize = clamp(0.28 * uProj / dist, 1.8, 42.0);
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vColor;
        uniform float uGlow;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float alpha = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vColor * alpha * uGlow, alpha * uGlow);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    parent.add(points);
    const palettes = XYLO_PALETTES.map((set) => set.map((hex) => new THREE.Color(hex)));
    return { points, material, uniforms, palettes };
  }

  _createWayLedTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    const state = { canvas, ctx, texture, lastDraw: -1 };
    this._updateWayLedTexture(state, 0, 0.35);
    return state;
  }

  _updateWayLedTexture(state, time, energy = 0.35) {
    if (!state || !state.ctx) return;
    const { ctx, canvas, texture } = state;
    const w = canvas.width;
    const h = canvas.height;
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#071324');
    grad.addColorStop(0.5, '#130c29');
    grad.addColorStop(1, '#091b2e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Gelombang audio-reaktif neon cyan & magenta agar layar konser terasa hidup
    const amp = 14 + Math.min(1, energy) * 26;
    for (let layer = 0; layer < 3; layer += 1) {
      ctx.beginPath();
      const freq = 0.032 + layer * 0.015;
      const phase = time * (2.2 + layer * 0.9) + layer * 1.4;
      const baseY = h * (0.42 + layer * 0.14);
      for (let x = 0; x <= w; x += 6) {
        const y = baseY + Math.sin(x * freq + phase) * (amp * (1 - layer * 0.22))
          + Math.cos(x * freq * 1.7 - phase * 1.3) * 8;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 3.2 - layer * 0.7;
      ctx.strokeStyle = layer % 2 === 0 ? 'rgba(0, 245, 212, 0.92)' : 'rgba(255, 42, 133, 0.88)';
      ctx.stroke();
    }

    // Lingkaran pulsasi di tengah bingkai videotron
    const pulseR = 16 + Math.abs(Math.sin(time * 2.4)) * (14 + energy * 18);
    const radial = ctx.createRadialGradient(w * 0.5, h * 0.5, 2, w * 0.5, h * 0.5, pulseR * 1.6);
    radial.addColorStop(0, 'rgba(0, 245, 212, 0.95)');
    radial.addColorStop(0.45, 'rgba(255, 42, 133, 0.55)');
    radial.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = radial;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.5, pulseR * 1.6, 0, Math.PI * 2);
    ctx.fill();

    texture.needsUpdate = true;
    state.lastDraw = time;
  }

  _ensurePlanarLEDGeometry(srcGeometry, splitLeftRight = false) {
    const geom = srcGeometry.clone();
    const pos = geom.attributes.position;
    if (!pos) return geom;
    const count = pos.count;
    const uvArray = new Float32Array(count * 2);
    const computeBounds = (pred) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i += 1) {
        const x = pos.getX(i);
        if (!pred(x)) continue;
        const y = pos.getY(i);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return {
        minX,
        spanX: Math.max(0.01, maxX - minX),
        minY,
        spanY: Math.max(0.01, maxY - minY),
      };
    };

    if (splitLeftRight) {
      const leftB = computeBounds((x) => x < 0);
      const rightB = computeBounds((x) => x >= 0);
      for (let i = 0; i < count; i += 1) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const b = x < 0 ? leftB : rightB;
        uvArray[i * 2] = clamp((x - b.minX) / b.spanX, 0, 1);
        uvArray[i * 2 + 1] = clamp((y - b.minY) / b.spanY, 0, 1);
      }
    } else {
      const allB = computeBounds(() => true);
      for (let i = 0; i < count; i += 1) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        uvArray[i * 2] = clamp((x - allB.minX) / allB.spanX, 0, 1);
        uvArray[i * 2 + 1] = clamp((y - allB.minY) / allB.spanY, 0, 1);
      }
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    return geom;
  }

  /**
   * Bangun environment map IBL stadium malam prosedural via PMREMGenerator untuk pantulan logam & beton basah.
   */
  _getWayNightEnvMap() {
    if (this._wayEnvMap) return this._wayEnvMap;
    if (!this.renderer) return null;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();

    const domeGeo = new THREE.SphereGeometry(60, 32, 20);
    const colAttr = new Float32Array(domeGeo.attributes.position.count * 3);
    const pos = domeGeo.attributes.position;
    const cZenith = new THREE.Color(0x09132b);
    const cHorizon = new THREE.Color(0x1f365c);
    const cNadir = new THREE.Color(0x05070e);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i) / 60;
      if (y >= 0) {
        tmp.copy(cHorizon).lerp(cZenith, Math.pow(y, 0.55));
      } else {
        tmp.copy(cHorizon).lerp(cNadir, Math.pow(-y, 0.50));
      }
      colAttr[i * 3] = tmp.r;
      colAttr[i * 3 + 1] = tmp.g;
      colAttr[i * 3 + 2] = tmp.b;
    }
    domeGeo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
    const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(domeGeo, domeMat));

    const panelGeo = new THREE.PlaneGeometry(24, 8);
    const envPanels = [
      { pos: [0, 12, -38], rotY: 0, color: 0x38bdf8 },
      { pos: [-34, 9, 10], rotY: Math.PI * 0.4, color: 0xf59e0b },
      { pos: [34, 9, 10], rotY: -Math.PI * 0.4, color: 0xe2e8f0 },
      { pos: [0, 10, 38], rotY: Math.PI, color: 0x818cf8 },
    ];
    const panelMats = [];
    for (const p of envPanels) {
      const pm = new THREE.MeshBasicMaterial({ color: p.color, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(panelGeo, pm);
      mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
      mesh.rotation.y = p.rotY;
      envScene.add(mesh);
      panelMats.push(pm);
    }

    const rt = pmrem.fromScene(envScene, 0.04);
    this._wayEnvMap = rt.texture;
    domeGeo.dispose();
    domeMat.dispose();
    panelGeo.dispose();
    panelMats.forEach((m) => m.dispose());
    pmrem.dispose();
    return this._wayEnvMap;
  }

  /**
   * Rakit isi tur dari GLB + `WayfindingRouter` seat-agnostic.
   * Total draw call dipertahankan <= 35 lewat instancing GLB, frustum culling, dan Zone Culling aktif.
   */
  _buildWay(source, calibratedSouthData, rawSeat) {
    const root = source.clone(true);                // geometri & material dibagi dengan cache `loadModel`
    const named = (name) => root.getObjectByName(name);
    const exterior = named('Zone_Exterior');
    const interior = named('Zone_Interior');
    const core = named('Stadium_Core');
    const seatTemplate = named('Master_Seat_Asset');
    const barTemplate = named('Master_Barricade_Asset');
    const beacon = named('Seat_Target_Beacon');
    const targetSeat = named('Seat_R14_S163_TARGET');

    const ledAnim = this._createWayLedTexture();
    const ledScreens = [];
    const walkableMeshes = [];

    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.frustumCulled = true;
      const lower = (obj.name || '').toLowerCase();
      const matName = (Array.isArray(obj.material) ? '' : (obj.material?.name || '')).toLowerCase();
      const inCore = Boolean(core && (obj === core || obj.parent === core || lower.startsWith('stadium_core')));
      const excludedWalk = [
        'emissive', 'props', 'signage', 'led_', 'roof', 'kaca', 'beacon', 'seat', 'barricade',
        'crowd', 'truss', 'speaker', 'stage_', 'foh_', 'tent_', 'portal_frame', 'pager_',
        'downlight', 'runway_edgelight', '_0128', '_0018', '_0019', 'color_m00', 'material.005',
        'material_0', 'wall', 'tower', 'gbk_wall_', 'gbk_facade_', 'gbk_roof_', 'parapet', 'pillar', 'fascia',
        'gbk_oculus_floodlight', 'catwalk', 'ribs', 'spaceframe',
        'garuda', 'plaque', 'glazing', 'monument', 'cauldron', 'fountain', 'tree', 'bench',
        'planter', 'markings', 'planet', 'kinetic', 'mojo', 'mots', 'subwoofer', 'totem',
        'utilities', 'hvac', 'duct', 'pilaster', 'wainscot', 'louver', 'curb', 'overhang', 'gantry',
      ].some((k) => lower.includes(k) || matName.includes(k));
      const isWalkable = !excludedWalk && [
        'plaza_asphalt', 'plaza_paving', 'park_greenery', 'bstage_floor', 'ramp_concrete',
        'tribune_step', 'lintasan_lari', 'material_3', 'tribune_grey', 'tribune_red',
        'gbk_bowl_concrete', 'gbk_aisle_concrete',
      ].some((k) => lower.includes(k) || matName.includes(k));
      if (isWalkable) walkableMeshes.push(obj);

      // Anisotropic filtering & IBL envMapIntensity untuk ketajaman tekstur PBR pada grazing angles
      const maxAniso = Math.min(4, this.renderer?.capabilities?.getMaxAnisotropy?.() || 4);
      const allMats = Array.isArray(obj.material) ? obj.material : [obj.material];
      allMats.forEach((m) => {
        if (!m) return;
        const mn = (m.name || '').toLowerCase();
        ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'].forEach((slot) => {
          const tex = m[slot];
          if (tex && tex.isTexture) {
            tex.anisotropy = maxAniso;
            tex.needsUpdate = true;
          }
        });
        if (mn.includes('garuda_3d') || mn.includes('bronzegold')) {
          m.transparent = false;
          m.metalness = 0.88;
          m.roughness = 0.28;
          m.side = THREE.FrontSide;
        } else if (mn.includes('garuda_gold')) {
          m.alphaTest = 0.45;
          m.transparent = false;
          m.side = THREE.DoubleSide;
        } else if (mn.includes('coldplay_gantry')) {
          m.side = THREE.DoubleSide;
          m.emissiveIntensity = 0.95;
        }
        if ('envMapIntensity' in m) {
          if (mn.includes('garuda_3d') || mn.includes('bronzegold') || mn.includes('garuda_gold')) {
            m.envMapIntensity = 1.35;
          } else if (lower.includes('roof') || lower.includes('truss') || lower.includes('ribs') || lower.includes('spaceframe') || lower.includes('pillar') || mn.includes('roof')) {
            m.envMapIntensity = 0.85;
          } else if (mn.includes('plaza_paving') || lower.includes('paving')) {
            m.envMapIntensity = 0.42;
          } else if (mn.includes('plaza_asphalt') || lower.includes('asphalt')) {
            m.envMapIntensity = 0.38;
          } else if (lower.includes('greenery') || mn.includes('greenery') || mn.includes('foliage')) {
            m.envMapIntensity = 0.40;
          } else {
            m.envMapIntensity = 0.60;
          }
        }
        if (mn.includes('road_markings')) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = -2;
          m.polygonOffsetUnits = -2;
          m.needsUpdate = true;
        }
        if (mn.includes('mots_planet') || mn.includes('kinetic') || mn.includes('garuda_uplight') || mn.includes('monument_flame')) {
          m.emissiveIntensity = 1.85;
          m.toneMapped = false;
          m.needsUpdate = true;
        }
      });

      // Nyalakan bola lampu jalan pedestrian warm-white di Plaza Tenggara
      if (lower.includes('lamp_warmwhite') || matName.includes('lamp_warmwhite')) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (mat) {
            mat.emissive = new THREE.Color(0xffe0ad);
            mat.emissiveIntensity = 2.0;
            mat.toneMapped = false;
            mat.needsUpdate = true;
          }
        });
        return;
      }

      // Karpet proteksi konser Terraplas (pertahankan PBR map jika sudah tersedia dari GLB)
      if (!obj.material?.map && (lower.includes('pitch_grass_fill') || lower.includes('grass') || lower.includes('material_3') || matName.includes('material_3'))) {
        obj.material = new THREE.MeshStandardMaterial({
          color: 0x1e242d,
          roughness: 0.85,
          metalness: 0.1,
          side: THREE.DoubleSide,
        });
        return;
      }

      // Aktifkan videotron panggung dinamis pada layar utama & piringan samping
      if (lower.includes('led_main') || lower.includes('led_center') || lower.includes('led_side') || lower.includes('led_left') || lower.includes('led_right')) {
        const isMain = lower.includes('led_main') || lower.includes('led_center');
        const isSide = lower.includes('led_side');
        obj.geometry = this._ensurePlanarLEDGeometry(obj.geometry, isSide);
        const ledMat = new THREE.MeshStandardMaterial({
          color: 0x0b1020,
          map: ledAnim.texture,
          emissive: new THREE.Color(isMain ? 0xa5f3fc : 0x818cf8),
          emissiveMap: ledAnim.texture,
          emissiveIntensity: 1.5,
          roughness: 0.25,
          metalness: 0.05,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        obj.material = ledMat;
        ledScreens.push({ mesh: obj, material: ledMat, isMain, boundVideo: false });
        return;
      }

      // Pastikan seluruh atap, kanopi, dan tribun dua-sisi; bebaskan lintasan lari dari Z-fighting
      if (inCore || lower.includes('roof') || lower.includes('canopy') || lower.includes('tribune') || lower.includes('lintasan_lari')) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (!mat) return;
          mat.side = THREE.DoubleSide;
          if (lower.includes('lintasan_lari') || (mat.name || '').toLowerCase().includes('lintasan_lari')) {
            mat.polygonOffset = true;
            mat.polygonOffsetFactor = -2;
            mat.polygonOffsetUnits = -2;
          }
          mat.needsUpdate = true;
        });
      }

      // Tingkatkan pendaran lampu festival (fairy lights pohon, strip totem, uplights, festoon) & signage malam
      if (lower.includes('plaza_props_emissive') || matName.includes('plaza_props_emissive')) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (mat) {
            mat.emissiveIntensity = 2.2;
            mat.toneMapped = false;
            mat.needsUpdate = true;
          }
        });
      }
      if (lower.includes('plaza_signage_emissive') || matName.includes('plaza_signage_emissive')) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (mat) {
            mat.emissiveIntensity = 1.15;
            mat.toneMapped = false;
            mat.needsUpdate = true;
          }
        });
      }
    });

    if (seatTemplate) seatTemplate.visible = false;
    if (barTemplate) barTemplate.visible = false;

    // Zone culling (interior vs exterior): daftar mesh ringan, dibuat sekali saat GLB dipasang.
    const isUnder = (o, g) => { for (let n = o; n; n = n.parent) if (n === g) return true; return false; };
    const keepVisible = new Set([beacon, targetSeat, seatTemplate, barTemplate]);
    const exteriorOnlyMeshes = [];
    const interiorOnlyMeshes = [];
    root.traverse((o) => {
      if (!o.isMesh || keepVisible.has(o)) return;
      const n = (o.name || '').toLowerCase();
      if (exterior && isUnder(o, exterior)) exteriorOnlyMeshes.push(o);
      else if ((interior && isUnder(o, interior)) || /gbk_bowl_|lintasan_lari|material_3/.test(n)) interiorOnlyMeshes.push(o);
    });

    const router = new WayfindingRouter({ calibratedSouthData });
    const initRoute = router.resolve(rawSeat);
    const fullBowlSeats = this._buildFullBowlPhysicalSeats(interior || root, initRoute.seatPos);

    if (beacon) {
      interior.add(beacon);
      beacon.scale.setScalar(0.58);
      beacon.renderOrder = 4;
      beacon.material = beacon.material.clone();
      beacon.material.color.set(0xffd60a);
      beacon.material.emissive.set(0xffd60a);
      beacon.material.emissiveIntensity = 1.3;
      beacon.material.transparent = true;
      beacon.material.opacity = 1.0;
      beacon.material.depthWrite = false;
      beacon.material.toneMapped = false;
    }
    if (targetSeat) {
      targetSeat.scale.set(0.72, 0.75, 0.72);
      targetSeat.geometry = targetSeat.geometry.clone();
      targetSeat.geometry.computeVertexNormals();
      targetSeat.material = new THREE.MeshStandardMaterial({
        color: 0xffd60a,
        emissive: 0xffd60a,
        emissiveIntensity: 1.15,
        roughness: 0.35,
        metalness: 0.1,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    }

    const skyMesh = this._buildWaySky();
    const xylo = null; // Partikel Xylobands dinonaktifkan total pada mode wayfinding
    const searchlights = this._buildWaySearchlights();
    const stageLights = interior ? this._buildWayPreviewStageFX(interior) : null;
    this.minimap = this.minimap || new MinimapRadar('spatialMinimap');
    if (exterior) exterior.add(searchlights.mesh);
    else this.wayGroup.add(searchlights.mesh);
    this.wayGroup.add(root, skyMesh, ...this._wayLights());
    if (fullBowlSeats) interiorOnlyMeshes.push(fullBowlSeats.mesh);
    const zoneSpec = getGbkGeometrySpec();
    this._way = {
      router,
      route: null,
      cullZone: null,
      cullRx: zoneSpec?.rxRef || GBK_RX,
      cullRz: zoneSpec?.rzRef || GBK_RZ,
      exteriorOnlyMeshes,
      interiorOnlyMeshes,
      root,
      walkableMeshes,
      exterior,
      interior,
      beacon,
      targetSeat,
      fullBowlSeats,
      physicalSeatsRenderedCount: fullBowlSeats ? fullBowlSeats.mesh.count : 0,
      skyMesh,
      xylo,
      searchlights,
      stageLights,
      ledAnim,
      ledScreens,
      beaconY: beacon ? beacon.position.y : 0,
      pinOpacity: 1,
      ribbon: null,
      seatPointer: null,
      progress: 0,
      lastStepEmitted: -1,
      lastArrivedEmitted: null,
    };
    this._applyWayRoute(rawSeat);
    // Pre-warm shader: kompilasi semua program sekali (semua mesh/zona dipaksa terlihat sementara) agar tidak stutter
    // saat pertama masuk stadion. Dijalankan sebelum _updateWayZoneCull menyembunyikan mesh apa pun.
    const warm = [this.wayGroup, exterior, interior].filter(Boolean);
    const warmPrev = warm.map((o) => o.visible);
    warm.forEach((o) => { o.visible = true; });
    this.renderer.compile(this.scene, this.camera);
    warm.forEach((o, i) => { o.visible = warmPrev[i]; });
    // Bayangan statis: render peta bayangan sekali setelah model & kursi terpasang (no-op bila shadowMap mati).
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }

  /**
   * Zone culling berbasis jarak elips ternormalisasi kamera dari pusat stadion.
   * u < 0.88 di dalam mangkuk, u > 1.12 di luar, di antaranya zona transisi (keduanya tampil, tanpa pop-in).
   * `.visible` hanya diubah saat zona berganti, bukan setiap frame.
   */
  _updateWayZoneCull(pos) {
    const way = this._way;
    const u = Math.hypot(pos.x / way.cullRx, pos.z / way.cullRz);
    // Interior hanya di dalam mangkuk; exterior mati begitu masuk concourse, kecuali di Outer Spiral Ramp (u > 0.95, y > 6).
    // shortcut: pita 0.94..0.98 sengaja tanpa keduanya (tertutup dinding concourse); lebarkan bila terlihat pop-in.
    const showInterior = u < 0.94;
    const showExterior = u > 0.98 || (u > 0.95 && pos.y > 6.0);
    const key = (showInterior ? 1 : 0) | (showExterior ? 2 : 0);
    if (key === way.cullZone) return;
    way.cullZone = key;
    for (const m of way.exteriorOnlyMeshes) m.visible = showExterior;
    for (const m of way.interiorOnlyMeshes) m.visible = showInterior;
  }

  _createStadiumSeatGeometry() {
    const cushion = boxPart(0.46, 0.09, 0.42, 0.0, 0.40, 0.04);
    const backrest = boxPart(0.46, 0.46, 0.08, 0.0, 0.62, -0.18, -0.16);
    const legL = boxPart(0.05, 0.42, 0.34, -0.22, 0.21, -0.02);
    const legR = boxPart(0.05, 0.42, 0.34, 0.22, 0.21, -0.02);
    const baseFoot = boxPart(0.48, 0.04, 0.38, 0.0, 0.02, -0.02);
    return mergeGeometries([cushion, backrest, legL, legR, baseFoot]);
  }

  _buildFullBowlPhysicalSeats(parent, targetSeatWorldPos) {
    if (!parent) return null;
    const spec = getGbkGeometrySpec();
    const validVomAngles = spec.validVomitoryAnglesDeg || Array.from({ length: 24 }, (_, k) => k * 15).filter((a) => a !== 180);
    const tiers = [spec.tier1, spec.tier2];
    const seatSpacing = 0.60;
    const coords = [];

    for (const tSpec of tiers) {
      const aisleHalf = 0.5 * (tSpec.aisleWidth || 2.2) + 0.15;
      const vomHalf = 0.5 * (tSpec.vomWidth || 2.4) + 0.25;
      const vomCtr = tSpec.vomLatOffset ?? -2.8;
      for (let r = 0; r < tSpec.rows; r += 1) {
        const rx = tSpec.rx0 + (r + 0.5) * tSpec.treadX;
        const rz = tSpec.rz0 + (r + 0.5) * tSpec.treadZ;
        const y = tSpec.baseY + r * tSpec.riser;
        const perim = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz)));
        const dDeg = (360.0 * seatSpacing) / Math.max(10.0, perim);

        for (let deg = 30.0; deg <= 330.0; deg += dDeg) {
          const rad = THREE.MathUtils.degToRad(deg);
          let blocked = false;
          for (let k = 0; k < validVomAngles.length; k += 1) {
            const va = validVomAngles[k];
            const signed = ((deg - va + 540) % 360) - 180;
            if (Math.abs(signed) > 12.0) continue;
            const vaRad = THREE.MathUtils.degToRad(va);
            const spd = Math.hypot(rx * Math.cos(vaRad), rz * Math.sin(vaRad)) || 100;
            const lat = THREE.MathUtils.degToRad(signed) * spd;
            if (Math.abs(lat) <= aisleHalf || (r < tSpec.vomOpenRows && Math.abs(lat - vomCtr) <= vomHalf + 0.25)) {
              blocked = true;
              break;
            }
          }
          if (blocked) continue;

          const x = rx * Math.sin(rad);
          const z = -rz * Math.cos(rad);
          const yaw = Math.atan2(-x, -z);
          const sectorIdx = Math.floor(deg / 15) % 2;
          const colorHex = sectorIdx === 0 ? 0x5c1a26 : 0x232d3f;
          coords.push(x, y, z, yaw, colorHex);
        }
      }
    }

    const total = Math.floor(coords.length / 5);
    if (!total) return null;

    const geom = this._createStadiumSeatGeometry();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.52,
      metalness: 0.14,
    });
    const mesh = new THREE.InstancedMesh(geom, mat, total);
    mesh.name = 'All_Stadium_Physical_Seats';
    mesh.frustumCulled = false;

    const seatPositions = new Float32Array(total * 3);
    const seatBaseColors = new Float32Array(total * 3);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();

    for (let i = 0; i < total; i += 1) {
      const off = i * 5;
      const x = coords[off];
      const y = coords[off + 1];
      const z = coords[off + 2];
      const yaw = coords[off + 3];
      const hex = coords[off + 4];
      pos.set(x, y, z);
      quat.setFromAxisAngle(up, yaw);
      m.compose(pos, quat, scl);
      mesh.setMatrixAt(i, m);
      col.setHex(hex);
      mesh.setColorAt(i, col);
      seatPositions[i * 3] = x;
      seatPositions[i * 3 + 1] = y;
      seatPositions[i * 3 + 2] = z;
      seatBaseColors[i * 3] = col.r;
      seatBaseColors[i * 3 + 1] = col.g;
      seatBaseColors[i * 3 + 2] = col.b;
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parent.add(mesh);

    const store = { mesh, seatPositions, seatBaseColors, highlightedIdx: -1, highlightGlow: null };
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0xffd60a,
      emissive: 0xffd60a,
      emissiveIntensity: 1.45,
      roughness: 0.25,
      metalness: 0.15,
      toneMapped: false,
    });
    const highlightGlow = new THREE.Mesh(geom.clone(), glowMat);
    highlightGlow.scale.setScalar(1.06);
    highlightGlow.visible = false;
    parent.add(highlightGlow);
    store.highlightGlow = highlightGlow;
    if (targetSeatWorldPos) {
      this._highlightFullBowlSeat(store, targetSeatWorldPos, false);
    }
    return store;
  }

  _highlightFullBowlSeat(store, seatPos, isStanding) {
    if (!store?.mesh?.instanceColor) return;
    const { mesh, seatPositions, seatBaseColors, highlightedIdx, highlightGlow } = store;
    const tmp = new THREE.Color();
    if (highlightedIdx >= 0) {
      tmp.setRGB(
        seatBaseColors[highlightedIdx * 3],
        seatBaseColors[highlightedIdx * 3 + 1],
        seatBaseColors[highlightedIdx * 3 + 2],
      );
      mesh.setColorAt(highlightedIdx, tmp);
      store.highlightedIdx = -1;
    }
    if (highlightGlow) highlightGlow.visible = false;
    if (!isStanding && seatPos) {
      const total = mesh.count;
      let bestIdx = -1;
      let bestDistSq = Infinity;
      for (let i = 0; i < total; i += 1) {
        const dx = seatPositions[i * 3] - seatPos.x;
        const dy = seatPositions[i * 3 + 1] - seatPos.y;
        const dz = seatPositions[i * 3 + 2] - seatPos.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        tmp.setHex(0xffd60a);
        mesh.setColorAt(bestIdx, tmp);
        store.highlightedIdx = bestIdx;
        if (highlightGlow) {
          const sx = seatPositions[bestIdx * 3];
          const sy = seatPositions[bestIdx * 3 + 1];
          const sz = seatPositions[bestIdx * 3 + 2];
          highlightGlow.position.set(sx, sy, sz);
          highlightGlow.rotation.set(0, Math.atan2(-sx, -sz), 0);
          highlightGlow.visible = true;
        }
      }
    }
    mesh.instanceColor.needsUpdate = true;
  }

  _groundWayCurve(route, root, walkableMeshes) {
    if (!route?.curve || !root || !walkableMeshes?.length) return;
    root.updateMatrixWorld(true);
    const pathLen = Math.max(20, route.pathLength || route.curve.getLength() || 250);
    const n = Math.max(220, Math.min(540, Math.round(pathLen / 0.75)));
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3();
    const worldNormal = new THREE.Vector3();
    const groundedPts = [];
    const baseYs = [];

    for (let i = 0; i <= n; i += 1) {
      const p = route.curve.getPointAt(i / n).clone();
      baseYs.push(p.y);
      origin.set(p.x, p.y + 0.85, p.z);
      rc.near = 0.05;
      rc.far = 2.4;
      rc.set(origin, down);
      const hits = rc.intersectObjects(walkableMeshes, false);
      let bestFloorY = -Infinity;
      for (const hit of hits) {
        const hy = hit.point.y;
        if (hy > p.y + 0.45 || hy < p.y - 1.2) continue;
        if (hit.face) {
          normalMatrix.getNormalMatrix(hit.object.matrixWorld);
          worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
          if (worldNormal.y <= 0.55) continue;
        }
        if (hy > bestFloorY) bestFloorY = hy;
      }
      if (bestFloorY > -Infinity) {
        p.y = bestFloorY + 0.14;
      }
      groundedPts.push(p);
    }

    const residuals = groundedPts.map((p, idx) => p.y - baseYs[idx]);
    for (let i = 1; i < groundedPts.length; i += 1) {
      const horizDist = Math.hypot(
        groundedPts[i].x - groundedPts[i - 1].x,
        groundedPts[i].z - groundedPts[i - 1].z,
      );
      const maxResStep = Math.min(0.32, Math.max(0.16, horizDist * 0.45));
      const dRes = residuals[i] - residuals[i - 1];
      if (Math.abs(dRes) > maxResStep) {
        residuals[i] = residuals[i - 1] + Math.sign(dRes) * maxResStep;
        groundedPts[i].y = baseYs[i] + residuals[i];
      }
    }

    let maxSpike = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      maxSpike = 0;
      for (let i = 1; i < groundedPts.length - 1; i += 1) {
        const a = groundedPts[i - 1];
        const b = groundedPts[i];
        const c = groundedPts[i + 1];
        const d1 = Math.hypot(b.x - a.x, b.z - a.z);
        const d2 = Math.hypot(c.x - b.x, c.z - b.z);
        if (d1 + d2 < 1e-4) continue;
        const expectedY = a.y + (c.y - a.y) * (d1 / (d1 + d2));
        const diff = b.y - expectedY;
        if (Math.abs(diff) > 0.22) {
          b.y = expectedY + Math.sign(diff) * 0.22;
        }
        maxSpike = Math.max(maxSpike, Math.abs(b.y - expectedY));
      }
    }

    let curCurve = new THREE.CatmullRomCurve3(groundedPts, false, 'centripetal', 0.4);
    curCurve.arcLengthDivisions = 1200;
    let finalPts = [];
    maxSpike = 0;
    for (let iter = 0; iter < 4; iter += 1) {
      finalPts = [];
      for (let i = 0; i <= 480; i += 1) {
        finalPts.push(curCurve.getPointAt(i / 480));
      }
      maxSpike = 0;
      for (let i = 1; i < finalPts.length - 1; i += 1) {
        const a = finalPts[i - 1];
        const b = finalPts[i];
        const c = finalPts[i + 1];
        const d1 = Math.hypot(b.x - a.x, b.z - a.z);
        const d2 = Math.hypot(c.x - b.x, c.z - b.z);
        if (d1 + d2 < 1e-4) continue;
        const expectedY = a.y + (c.y - a.y) * (d1 / (d1 + d2));
        const diff = b.y - expectedY;
        if (Math.abs(diff) > 0.22) {
          b.y = expectedY + Math.sign(diff) * 0.22;
        }
        maxSpike = Math.max(maxSpike, Math.abs(b.y - expectedY));
      }
      for (let pass = 0; pass < 64; pass += 1) {
        for (let i = 1; i < finalPts.length; i += 1) {
          const a = finalPts[i - 1];
          const b = finalPts[i];
          const horiz = Math.hypot(b.x - a.x, b.z - a.z);
          const maxStepY = Math.min(0.36, horiz * 0.60);
          const dy = b.y - a.y;
          if (Math.abs(dy) > maxStepY && horiz > 1e-4) {
            b.y = a.y + Math.sign(dy) * maxStepY;
          }
        }
        for (let i = finalPts.length - 2; i >= 0; i -= 1) {
          const a = finalPts[i + 1];
          const b = finalPts[i];
          const horiz = Math.hypot(b.x - a.x, b.z - a.z);
          const maxStepY = Math.min(0.36, horiz * 0.60);
          const dy = b.y - a.y;
          if (Math.abs(dy) > maxStepY && horiz > 1e-4) {
            b.y = a.y + Math.sign(dy) * maxStepY;
          }
        }
      }
      curCurve = new THREE.CatmullRomCurve3(finalPts, false, 'centripetal', 0.4);
      curCurve.arcLengthDivisions = 1200;
    }

    route.maxVerticalSpikeM = Math.round(maxSpike * 1000) / 1000;
    route.curve = curCurve;
    route.camCurve = new THREE.CatmullRomCurve3(buildSmoothCameraYProfile(finalPts, 6), false, 'centripetal', 0.4);
    route.camCurve.arcLengthDivisions = 1200;
    let maxSlopeDeg = 0;
    let prevPt = route.curve.getPointAt(0);
    for (let i = 1; i <= 480; i += 1) {
      const curPt = route.curve.getPointAt(i / 480);
      const dh = Math.hypot(curPt.x - prevPt.x, curPt.z - prevPt.z);
      if (dh > 0.05) {
        const deg = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(curPt.y - prevPt.y), dh));
        if (deg > maxSlopeDeg) maxSlopeDeg = deg;
      }
      prevPt = curPt;
    }
    route.maxSlopeDeg = Math.round(maxSlopeDeg * 100) / 100;
    route.pathLength = Math.round(route.curve.getLength() * 100) / 100;
  }

  _applyWayRoute(rawSeat) {
    const way = this._way;
    if (!way) return null;
    const route = way.router.resolve(rawSeat);
    this._groundWayCurve(route, way.root, way.walkableMeshes);
    way.route = route;
    this._wayCamCurve = route.camCurve || route.curve;
    this._waySnapCamY = true;
    this._waySnapYaw = true;
    this._latchedForwardSign = null;

    if (way.ribbon) {
      this.wayGroup.remove(way.ribbon.mesh);
      way.ribbon.mesh.geometry.dispose();
      way.ribbon.mesh.material.dispose();
      way.ribbon = null;
    }
    if (way.seatPointer) {
      this.wayGroup.remove(way.seatPointer.group);
      way.seatPointer.group.traverse((ch) => {
        if (ch.geometry) ch.geometry.dispose();
      });
      way.seatPointer.material.dispose();
      way.seatPointer = null;
    }

    const ribbon = this._wayRibbon(route.curve, route.pathLength);
    way.ribbon = ribbon;
    this.wayGroup.add(ribbon.mesh);

    if (!route.parsed.isStanding && route.aisleToSeatArc?.length >= 2) {
      way.seatPointer = this._buildSeatPointer(route.aisleToSeatArc);
      if (way.seatPointer) this.wayGroup.add(way.seatPointer.group);
    }

    if (way.beacon) {
      way.beacon.position.copy(route.beaconPos);
      way.beaconY = route.beaconPos.y;
    }
    if (way.fullBowlSeats) {
      this._highlightFullBowlSeat(way.fullBowlSeats, route.seatPos, route.parsed.isStanding);
    }
    if (way.targetSeat) {
      way.targetSeat.visible = !route.parsed.isStanding && !way.fullBowlSeats;
      way.targetSeat.position.copy(route.seatPos);
      way.targetSeat.rotation.set(0, Math.atan2(-route.seatPos.x, -route.seatPos.z), 0);
    }
    this._animateWay(0, 0.016);
    return route;
  }

  /** Empat sorot lampu langit konser (Sky-Trackers) di perimeter taman luar terpadu dalam spektrum konser tunggal. */
  _buildWaySearchlights() {
    const geometry = new THREE.CylinderGeometry(11.0, 1.1, 210.0, 14, 1, true);
    geometry.translate(0, 105.0, 0);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const specs = [
      { pos: new THREE.Vector3(-112, 0.2, -168), color: WAY_CONCERT_PALETTE[0], phase: 0.0, tiltZ: 0.12, tiltX: -0.10 },
      { pos: new THREE.Vector3(-46,  0.2, -192), color: WAY_CONCERT_PALETTE[1], phase: 1.5, tiltZ: 0.05, tiltX: -0.12 },
      { pos: new THREE.Vector3(46,   0.2, -192), color: WAY_CONCERT_PALETTE[2], phase: 3.1, tiltZ: -0.05, tiltX: -0.12 },
      { pos: new THREE.Vector3(112,  0.2, -168), color: WAY_CONCERT_PALETTE[0], phase: 4.6, tiltZ: -0.12, tiltX: -0.10 },
    ];
    const count = specs.length;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      dummy.position.copy(specs[i].pos);
      dummy.rotation.set(specs[i].tiltX, 0, specs[i].tiltZ);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, col.setHex(specs[i].color));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return { mesh, specs, dummy, count };
  }

  /** Manggung konser penuh dalam spektrum warna konser seragam luar-dalam: 20 spotlight cones, 18 laser, & StageLight. */
  _buildWayPreviewStageFX(parent) {
    const beamGeometry = new THREE.CylinderGeometry(0.25, 3.4, 72.0, 14, 1, true);
    beamGeometry.translate(0, -36.0, 0);
    const beamAlpha = makeBeamAlphaTexture();
    this.sharedTextures.push(beamAlpha);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.17,
      alphaMap: beamAlpha,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const topSources = Array.from({ length: 12 }, (_, i) => [-27.5 + i * 5.0, 23.6, -55.8]);
    const wingSources = [-39.5, 39.5].flatMap((x) => [12.0, 15.0, 18.0, 21.0].map((y) => [x, y, -55.8]));
    const beamSources = [...topSources, ...wingSources];
    const specs = beamSources.map(([x, y, z], idx) => ({
      pos: new THREE.Vector3(x, y, z),
      phase: idx * 0.65,
      isWing: idx >= 12,
    }));
    const count = specs.length;
    const mesh = new THREE.InstancedMesh(beamGeometry, material, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;

    const paletteColors = WAY_CONCERT_PALETTE.map((hex) => new THREE.Color(hex));
    const laserBaseColor = new THREE.Color(0x7dd3fc);
    const dummy = new THREE.Object3D();
    const down = new THREE.Vector3(0, -1, 0);
    const dir = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      const sp = specs[i];
      dummy.position.copy(sp.pos);
      dir.set(-sp.pos.x * 0.012, -0.35, 1.0).normalize();
      dummy.quaternion.setFromUnitVectors(down, dir);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, paletteColors[i % paletteColors.length]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    parent.add(mesh);

    const laserCount = 18;
    const laserPositions = new Float32Array(laserCount * 6);
    const laserGeometry = new THREE.BufferGeometry();
    laserGeometry.setAttribute('position', new THREE.BufferAttribute(laserPositions, 3));
    const laserMaterial = new THREE.LineBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      fog: false,
    });
    const lasers = new THREE.LineSegments(laserGeometry, laserMaterial);
    lasers.renderOrder = 2;
    lasers.frustumCulled = false;
    parent.add(lasers);

    const stageLight = new THREE.PointLight(0x818cf8, 56, 130, 1.35);
    stageLight.position.set(0, 16, -42);
    const washL = new THREE.PointLight(0xa5f3fc, 40, 95, 1.4);
    washL.position.set(-14, 14, -46);
    const washR = new THREE.PointLight(0xfde68a, 40, 95, 1.4);
    washR.position.set(14, 14, -46);
    parent.add(stageLight, washL, washR);
    return {
      mesh,
      specs,
      dummy,
      down,
      count,
      paletteColors,
      laserBaseColor,
      tmpTint: new THREE.Color(),
      tmpDir: new THREE.Vector3(),
      lasers,
      laserGeometry,
      laserPositions,
      laserMaterial,
      laserCount,
      stageLight,
      washL,
      washR,
    };
  }

  /** Validasi 0 berkas sorot & laser yang berpotongan dengan layar LED videotron panggung. */
  _countLightLedIntersections(way) {
    if (!way?.stageLights || !way?.ledScreens?.length) return 0;
    way.root?.updateMatrixWorld(true);
    const boxes = way.ledScreens.map((entry) => new THREE.Box3().setFromObject(entry.mesh).expandByScalar(0.02));
    const fx = way.stageLights;
    const ray = new THREE.Ray();
    const hitPt = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const segStart = new THREE.Vector3();
    const segEnd = new THREE.Vector3();
    const m = new THREE.Matrix4();
    let intersections = 0;

    for (let i = 0; i < fx.count; i += 1) {
      fx.mesh.getMatrixAt(i, m);
      segStart.setFromMatrixPosition(m);
      dir.set(0, -1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
      ray.set(segStart, dir);
      for (const box of boxes) {
        if (ray.intersectBox(box, hitPt) && hitPt.distanceTo(segStart) <= 72.0) {
          intersections += 1;
          break;
        }
      }
    }

    const lPos = fx.laserPositions;
    for (let i = 0; i < fx.laserCount; i += 1) {
      segStart.set(lPos[i * 6 + 0], lPos[i * 6 + 1], lPos[i * 6 + 2]);
      segEnd.set(lPos[i * 6 + 3], lPos[i * 6 + 4], lPos[i * 6 + 5]);
      const segLen = segStart.distanceTo(segEnd);
      if (segLen < 1e-4) continue;
      dir.subVectors(segEnd, segStart).normalize();
      ray.set(segStart, dir);
      for (const box of boxes) {
        if (ray.intersectBox(box, hitPt) && hitPt.distanceTo(segStart) <= segLen) {
          intersections += 1;
          break;
        }
      }
    }
    return intersections;
  }

  /** Penunjuk sekunder tipis dari lorong menuju kursi target yang pudar otomatis saat kamera dekat (< 2.5 m). */
  _buildSeatPointer(arcPts) {
    if (!arcPts || arcPts.length < 2) return null;
    const group = new THREE.Group();
    const ptrCurve = new THREE.CatmullRomCurve3(arcPts, false, 'centripetal', 0.25);
    const tubeGeo = new THREE.TubeGeometry(ptrCurve, 28, 0.036, 8, false);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd60a,
      emissive: 0xfacc15,
      emissiveIntensity: 1.35,
      roughness: 0.25,
      metalness: 0.05,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
    const tube = new THREE.Mesh(tubeGeo, mat);
    tube.renderOrder = 3;
    const last = ptrCurve.getPointAt(1);
    const prev = ptrCurve.getPointAt(0.88);
    const dir = new THREE.Vector3().subVectors(last, prev).normalize();
    const headGeo = new THREE.ConeGeometry(0.11, 0.28, 10);
    headGeo.translate(0, 0.14, 0);
    const head = new THREE.Mesh(headGeo, mat);
    head.position.copy(prev.clone().lerp(last, 0.65));
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    head.renderOrder = 3;
    group.add(tube, head);
    return { group, material: mat, baseOpacity: 0.88 };
  }

  /** Pita rute 3D TubeGeometry bercahaya (`#FFD60A` / emissive `#FACC15`) + polygonOffset anti Z-fighting. */
  _wayRibbon(curve, length) {
    const geometry = new THREE.TubeGeometry(curve, 420, 0.085, 8, false);
    const uniforms = {
      uTime: { value: 0 },
      uHead: { value: 0 },
      uLength: { value: Math.max(1, length) },
      uColorBase: { value: new THREE.Color(0xffd60a) },
      uColorPeak: { value: new THREE.Color(0xfacc15) },
      uColorTail: { value: new THREE.Color(0xf59e0b) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uTime;
        uniform float uHead;
        uniform float uLength;
        uniform vec3 uColorBase;
        uniform vec3 uColorPeak;
        uniform vec3 uColorTail;
        varying vec2 vUv;
        void main() {
          float pulse = 0.5 + 0.5 * sin((vUv.x * uLength - uTime * 6.0) * 1.15);
          float ahead = smoothstep(uHead - 0.015, uHead + 0.015, vUv.x);
          vec3 aheadCol = mix(uColorBase, uColorPeak, pow(pulse, 1.5) * 0.72);
          vec3 col = mix(uColorTail * 0.9, aheadCol, ahead);
          float alpha = (0.86 + 0.14 * pulse) * mix(0.68, 1.0, ahead);
          gl_FragColor = vec4(col * (1.02 + 0.34 * pulse), alpha);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { mesh, uniforms };
  }

  /** Pose kamera dari posisi + titik bidik (`yaw` & `pitch` mengikuti konvensi Three.js). */
  _lookPose(pos, look, fov) {
    const dx = look[0] - pos[0];
    const dy = look[1] - pos[1];
    const dz = look[2] - pos[2];
    return { pos: vec(pos), yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.max(0.001, Math.hypot(dx, dz))), fov };
  }

  /** Pose kamera rel terpadu: elevasi mata halus via `_wayCamCurve` + +1,65 m; tiba di Pos 5 memperlihatkan kursi target + panggung. */
  _wayRailPose(u) {
    const way = this._way;
    const route = way?.route;
    if (!route?.curve) return null;
    const curve = route.curve;
    const camCurve = this._wayCamCurve || route.camCurve || curve;
    const t = clamp(u, 0, 1);
    const p = curve.getPointAt(t);
    const pCam = camCurve.getPointAt(t);
    const eyePos = [p.x, pCam.y + WAY_EYE, p.z];
    const dirForward = t < 0.985 ? 1 : -1;
    const tLook = clamp(t + dirForward * 0.018, 0, 1);
    const q = curve.getPointAt(tLook);
    const qCam = camCurve.getPointAt(tLook);
    const aheadYaw = getSmoothLookAheadYaw(curve, t);
    const lookYScale = t < 0.03 ? 1.12 : 0.92;
    const aheadLook = dirForward > 0
      ? [q.x, qCam.y + WAY_EYE * lookYScale, q.z]
      : [2 * p.x - q.x, pCam.y + WAY_EYE * lookYScale, 2 * p.z - q.z];
    const pitchPose = this._lookPose(eyePos, aheadLook, WAY_FOV);
    const tanPose = { pos: pitchPose.pos, yaw: aheadYaw, pitch: pitchPose.pitch, fov: WAY_FOV };

    const smooth = (x) => {
      const k = clamp(x, 0, 1);
      return k * k * (3 - 2 * k);
    };
    const seatLook = [route.seatPos.x, route.seatPos.y + 0.5, route.seatPos.z];
    const stageLook = [route.seatLookAt.x, route.seatLookAt.y, route.seatLookAt.z];
    const seatPose = this._lookPose(eyePos, seatLook, WAY_FOV);
    const stagePose = this._lookPose(eyePos, stageLook, WAY_FOV);
    const seatMix = route.parsed?.isStanding ? 0.0 : 0.35;
    const endPose = {
      pos: tanPose.pos,
      yaw: stagePose.yaw + shortestAngle(stagePose.yaw, seatPose.yaw) * seatMix,
      pitch: stagePose.pitch + (seatPose.pitch - stagePose.pitch) * seatMix,
      fov: WAY_FOV,
    };

    const pos4U = clamp(route.anchors?.pos4 ?? 0.92, 0.85, 0.97);
    const turnStart = route.ingressKind === 'upper' ? Math.max(0.84, pos4U - 0.025) : Math.max(0.92, pos4U);
    if (t < turnStart) {
      return tanPose;
    }

    const k = clamp((t - turnStart) / Math.max(0.005, 1 - turnStart), 0, 1);
    if (k < 0.55) {
      const w = smooth(k / 0.55);
      const midTarget = route.parsed?.isStanding ? stagePose : seatPose;
      return {
        pos: tanPose.pos,
        yaw: tanPose.yaw + shortestAngle(tanPose.yaw, midTarget.yaw) * w,
        pitch: tanPose.pitch + (midTarget.pitch - tanPose.pitch) * w,
        fov: WAY_FOV,
      };
    }
    const w = smooth((k - 0.55) / 0.45);
    const midTarget = route.parsed?.isStanding ? stagePose : seatPose;
    return {
      pos: tanPose.pos,
      yaw: midTarget.yaw + shortestAngle(midTarget.yaw, endPose.yaw) * w,
      pitch: midTarget.pitch + (endPose.pitch - midTarget.pitch) * w,
      fov: WAY_FOV,
    };
  }

  _stepForU(u) {
    const wps = this._way?.route?.waypoints;
    if (!wps || wps.length < 5) return 0;
    if (u >= 0.99) return 4;
    for (let i = 3; i >= 1; i -= 1) {
      const mid = (wps[i - 1].u + wps[i].u) * 0.5;
      if (u >= mid) return i;
    }
    return 0;
  }

  _emitWayProgress(force = false) {
    const way = this._way;
    const wf = this.wayfinding;
    if (!way || !wf) return;
    const u = wf.u;
    const step = wf.tween ? wf.step : this._stepForU(u);
    wf.step = step;
    const arrived = u >= 0.99;
    if (force || way.lastStepEmitted !== step || way.lastArrivedEmitted !== arrived) {
      way.lastStepEmitted = step;
      way.lastArrivedEmitted = arrived;
      if (typeof this.onWayfindingProgress === 'function') {
        this.onWayfindingProgress({ t: u, progress: way.progress ?? 0, step, arrived });
      }
    }
  }

  _applyWayRailU(u, forceNotify = false, opts = {}) {
    const wf = this.wayfinding;
    const pose = this._wayRailPose(u);
    if (!wf || !pose) return;
    const { dt = 0, deltaU = 0, isTween = false } = opts;
    wf.u = clamp(u, 0, 1);
    this.view.pos.copy(pose.pos);

    // Yaw damping anti-stutter: snap saat inisialisasi/jump, jeda saat free-look drag atau mundur manual (S / [‹])
    if (this._waySnapYaw || dt <= 0) {
      this.view.yaw = pose.yaw;
      this.view.pitch = pose.pitch;
      this._waySnapYaw = false;
    } else if (!this._isDragging) {
      if (isTween || deltaU > 0) {
        const yawAlpha = 1 - Math.exp(-3.8 * Math.min(dt, 0.05));
        this.view.yaw += shortestAngle(this.view.yaw, pose.yaw) * yawAlpha;
        this.view.pitch += (pose.pitch - this.view.pitch) * yawAlpha;
      }
      // Saat deltaU < 0 (gerak mundur manual), pertahankan view.yaw & pitch tenang agar tidak tersentak 180 deg di U-turn
    }
    this.view.fov = pose.fov;
    this._setWayZones(wf.u);
    this._emitWayProgress(forceNotify);
  }

  _nudgeWayRail(deltaU, dt = 0.016) {
    if (!this.wayfinding || !this._way?.route) return;
    this.wayfinding.tween = null;
    this._applyWayRailU(clamp(this.wayfinding.u + deltaU, 0, 1), false, { dt, deltaU });
  }

  /**
   * Active Zone-Based Culling berdasarkan progres rute `p` (0..1):
   *   p < 0.35          : Zone_Exterior ON,  Zone_Interior OFF
   *   0.35 <= p < 0.70  : Zone_Exterior ON,  Zone_Interior ON
   *   p >= 0.70         : Zone_Exterior OFF, Zone_Interior ON
   */
  _setWayZones(uOrProgress, isProgress = false) {
    const way = this._way;
    if (!way || !way.route) return;
    const p = isProgress
      ? clamp(uOrProgress, 0, 1)
      : way.router.progressFromU(uOrProgress, way.route.anchors);
    const state = way.router.zoneStateForProgress(p);
    if (way.exterior) way.exterior.visible = state.exteriorVisible;
    if (way.interior) way.interior.visible = state.interiorVisible;
    if (!isProgress && way.ribbon) way.ribbon.uniforms.uHead.value = uOrProgress;
    way.progress = p;
  }

  setWayfindingProgress(progress) {
    if (!this._way) return null;
    this._setWayZones(progress, true);
    return this.getWayfindingStats();
  }

  _bindWayKeys() {
    const isEditable = (target) => {
      if (!target) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };
    window.addEventListener('keydown', (event) => {
      if (!this.wayGroup.visible || isEditable(event.target)) return;
      if (['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
        if (this._latchedForwardSign === null) {
          this._latchedForwardSign = this._wayForwardSign();
        }
        this._wayKeys.add(event.code);
        this._wayManualDir = 0;
        if (this.wayfinding) this.wayfinding.tween = null;
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => {
      this._wayKeys.delete(event.code);
      if (!['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].some((k) => this._wayKeys.has(k)) && this._wayManualDir === 0) {
        this._latchedForwardSign = null;
      }
    });
    window.addEventListener('blur', () => {
      this._wayKeys.clear();
      this._wayManualDir = 0;
      this._latchedForwardSign = null;
    });
  }

  /** Tanda orientasi kamera saat ini terhadap tangen kurva (+1 searah kurva, -1 berlawanan / menoleh ke belakang). */
  _wayForwardSign() {
    const curve = this._way?.route?.curve;
    if (!curve || !this.wayfinding) return 1;
    const tan = curve.getTangentAt(clamp(this.wayfinding.u, 0, 1));
    const tLen = Math.hypot(tan.x, tan.z);
    if (tLen < 1e-5) return 1;
    const totalYaw = this.view.yaw + (this.look?.yaw ?? 0);
    const fx = -Math.sin(totalYaw);
    const fz = -Math.cos(totalYaw);
    const dot = (fx * tan.x + fz * tan.z) / tLen;
    return dot >= -0.05 ? 1 : -1;
  }

  /** Tekan-tahan tombol panah tunggal [‹] / [›]: jalankan rel secara manual & kunci arah agar bebas jitter di U-turn. */
  setWayManualDir(dir) {
    this._wayManualDir = dir > 0 ? 1 : (dir < 0 ? -1 : 0);
    if (this._wayManualDir !== 0) {
      if (this._latchedForwardSign === null) {
        this._latchedForwardSign = this._wayForwardSign();
      }
      if (this.wayfinding) this.wayfinding.tween = null;
    } else if (this._wayKeys.size === 0) {
      this._latchedForwardSign = null;
    }
  }

  /** Lompat otomatis ke Pos sebelumnya (-1) atau berikutnya (+1) dalam rute 5-Pos. */
  goToRelativeWaypoint(delta) {
    if (!this.wayfinding || !this._way?.route?.waypoints) return false;
    const wps = this._way.route.waypoints;
    if (this.wayfinding.tween) {
      const target = clamp((this.wayfinding.step ?? 0) + (delta > 0 ? 1 : -1), 0, 4);
      return this.goToWaypoint(target);
    }
    const u = this.wayfinding.u;
    if (delta > 0) {
      const idx = wps.findIndex((wp) => wp.u > u + 0.008);
      return this.goToWaypoint(idx >= 0 ? idx : 4);
    }
    for (let i = wps.length - 1; i >= 0; i -= 1) {
      if (wps[i].u < u - 0.008) return this.goToWaypoint(i);
    }
    return this.goToWaypoint(0);
  }

  /**
   * Pindah ke langkah tur 0..4 dengan easeInOutCubic halus 2,2 detik di atas rel kurva rute.
   */
  goToWaypoint(index, { instant = false } = {}) {
    if (!this.layout || this.layout.kind === 'cinema') return false;
    const step = clamp(Math.round(index), 0, 4);
    const way = this._way;
    this.camera.near = 0.4;
    this.camera.far = 1600.0;
    this.camera.updateProjectionMatrix();
    this._wayKeys.clear();
    this._wayManualDir = 0;
    this._latchedForwardSign = null;
    this.resetLook();
    const u0 = this.wayfinding && way ? this.wayfinding.u : (way?.route?.anchors?.step0 ?? 0);
    const stepU = way?.route?.waypoints?.[step]?.u ?? [0.0, 0.25, 0.45, 0.85, 1.0][step];
    const snap = instant || this.reducedMotion;
    if (snap) {
      this._waySnapCamY = true;
      this._waySnapYaw = true;
    }
    this.wayfinding = {
      step,
      u: snap ? stepU : u0,
      tween: snap ? null : { u0, u1: stepU, start: performance.now(), duration: WAY_TWEEN_DURATION },
    };
    if (way) {
      this._applyWayRailU(this.wayfinding.u, true);
    }
    return true;
  }

  _tickWayfinding(dt = 0.016) {
    const wf = this.wayfinding;
    const tween = wf?.tween;
    if (!tween) return;
    const prevU = wf.u;
    const t = clamp((performance.now() - tween.start) / 1000 / tween.duration, 0, 1);
    const s = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    const u = tween.u0 + (tween.u1 - tween.u0) * s;
    this._applyWayRailU(u, false, { dt, deltaU: u - prevU, isTween: true });
    if (t >= 1) {
      wf.tween = null;
      this._applyWayRailU(tween.u1, true, { dt, deltaU: 0, isTween: true });
    }
  }

  /** Animasi ringan tiap frame: pin kursi pudar < 2.5 m, pita rute kuning, panggung konser setara preview, & videotron. */
  _animateWay(time, dt = 0.016) {
    const way = this._way;
    if (!way) return;
    if (way.beacon) {
      const uNow = this.wayfinding ? this.wayfinding.u : 0;
      const dist = Math.hypot(
        this.view.pos.x - way.beacon.position.x,
        this.view.pos.y - way.beacon.position.y,
        this.view.pos.z - way.beacon.position.z,
      );
      const distFade = clamp((dist - 1.5) / 1.0, 0, 1);
      const arriveFade = clamp((0.992 - uNow) / 0.015, 0, 1);
      const pinOpacity = Math.min(distFade, arriveFade);
      way.pinOpacity = pinOpacity;
      way.beacon.visible = pinOpacity > 0.02;
      way.beacon.material.opacity = pinOpacity;
      way.beacon.scale.setScalar(0.58 * (0.35 + 0.65 * pinOpacity));
      way.beacon.position.y = way.beaconY + Math.sin(time * 3) * 0.06;
      way.beacon.rotation.y = time * 1.2;
      if (way.seatPointer) {
        way.seatPointer.group.visible = pinOpacity > 0.02;
        way.seatPointer.material.opacity = way.seatPointer.baseOpacity * pinOpacity;
      }
    } else if (way.seatPointer) {
      way.seatPointer.group.visible = false;
    }
    if (way.ribbon) {
      way.ribbon.uniforms.uTime.value = time;
    }
    if (way.searchlights) {
      const { mesh, specs, dummy } = way.searchlights;
      for (let i = 0; i < specs.length; i += 1) {
        const sp = specs[i];
        dummy.position.copy(sp.pos);
        dummy.rotation.set(
          sp.tiltX + Math.sin(time * 0.45 + sp.phase) * 0.08,
          0,
          sp.tiltZ + Math.cos(time * 0.45 + sp.phase) * 0.08,
        );
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (way.stageLights) {
      const fx = way.stageLights;
      const motion = this.reducedMotion ? 0 : time;
      const mediaLuma = this.media?.color?.luma ?? 0.35;
      const mediaEnergy = this.media?.energy ?? 0.4;
      const pal = fx.paletteColors;
      const tint = fx.tmpTint;
      const beamDir = fx.tmpDir;
      for (let i = 0; i < fx.specs.length; i += 1) {
        const sp = fx.specs[i];
        const yawSweep = Math.sin(motion * 0.32 + sp.phase) * 0.65;
        const tiltSweep = 0.45 + Math.sin(motion * 0.23 + i * 1.7) * 0.25;
        beamDir.set(
          Math.sin(yawSweep) * Math.cos(tiltSweep),
          Math.sin(tiltSweep) * 0.42 - 0.22,
          Math.cos(yawSweep) * Math.cos(tiltSweep),
        ).normalize();
        fx.dummy.position.copy(sp.pos);
        fx.dummy.quaternion.setFromUnitVectors(fx.down, beamDir);
        fx.dummy.updateMatrix();
        fx.mesh.setMatrixAt(i, fx.dummy.matrix);
        const pPos = (((i % pal.length) + motion * 0.14) % pal.length + pal.length) % pal.length;
        const idxA = Math.floor(pPos) % pal.length;
        const idxB = (idxA + 1) % pal.length;
        tint.copy(pal[idxA]).lerp(pal[idxB], pPos - Math.floor(pPos));
        fx.mesh.setColorAt(i, tint);
      }
      fx.mesh.instanceMatrix.needsUpdate = true;
      if (fx.mesh.instanceColor) fx.mesh.instanceColor.needsUpdate = true;
      fx.mesh.material.opacity = 0.15 + 0.05 * mediaLuma;

      const lightMix = 0.5 + 0.5 * Math.sin(motion * 0.25);
      if (fx.stageLight) {
        fx.stageLight.color.copy(pal[1]).lerp(pal[0], lightMix * 0.45);
        fx.stageLight.intensity = 42 + 40 * mediaLuma;
      }
      if (fx.washL && fx.washR) {
        fx.washL.color.copy(pal[0]).lerp(pal[1], lightMix * 0.35);
        fx.washR.color.copy(pal[2]).lerp(pal[0], (1 - lightMix) * 0.25);
      }

      const lPos = fx.laserPositions;
      const half = fx.laserCount / 2;
      for (let i = 0; i < fx.laserCount; i += 1) {
        const originX = i < half ? -12 : 12;
        const fan = ((i % half) / Math.max(1, half - 1) - 0.5) * 0.68 + Math.sin(motion * 0.5 + i * 0.15) * 0.16;
        const lift = 0.34 + 0.12 * Math.sin(motion * 0.9 + i);
        const len = 145;
        lPos[i * 6 + 0] = originX;
        lPos[i * 6 + 1] = 23.6;
        lPos[i * 6 + 2] = -55.8;
        lPos[i * 6 + 3] = originX + Math.sin(fan) * len;
        lPos[i * 6 + 4] = 23.6 + lift * len;
        lPos[i * 6 + 5] = -55.8 + Math.cos(fan) * len;
      }
      fx.laserGeometry.attributes.position.needsUpdate = true;
      fx.laserMaterial.opacity = 0.22 + 0.20 * mediaEnergy;
      fx.laserMaterial.color.copy(fx.laserBaseColor).lerp(pal[1], 0.30 * lightMix);
    }
    if (way.ledScreens && way.ledScreens.length) {
      const hasLiveVideo = Boolean(this.media && !this.media.usingFallback && this.media.video && this.media.video.readyState >= 2);
      if (hasLiveVideo) {
        way.ledScreens.forEach((entry) => {
          if (!entry.boundVideo) {
            entry.material.map = this.media.videoTexture;
            entry.material.emissiveMap = this.media.videoTexture;
            entry.material.emissive.set(0xffffff);
            entry.material.emissiveIntensity = 1.25;
            entry.material.needsUpdate = true;
            entry.boundVideo = true;
          }
        });
      } else if (way.ledAnim && (way.ledAnim.lastDraw < 0 || time - way.ledAnim.lastDraw >= 0.05)) {
        this._updateWayLedTexture(way.ledAnim, time, this.media?.energy || 0.35);
      }
    }
  }

  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;
    this.media.tick(time);
    this.sampleTimer += dt;
    if (this.sampleTimer > 0.14) {
      this.sampleTimer = 0;
      this.media.sample();
    }

    // Haluskan perpindahan menuju nilai dari Python, atau ikuti rel wayfinding terpadu jika aktif.
    const view = this.view;
    if (this.spatialTour) {
      this._tickSpatialRoute(dt);
    } else if (this.wayfinding) {
      const keyDir = ((this._wayKeys.has('KeyW') || this._wayKeys.has('ArrowUp')) ? 1 : 0)
        - ((this._wayKeys.has('KeyS') || this._wayKeys.has('ArrowDown')) ? 1 : 0);
      const inputDir = keyDir !== 0 ? keyDir : this._wayManualDir;
      if (inputDir !== 0) {
        this.wayfinding.tween = null;
        const speed = keyDir !== 0 ? WAY_RAIL_SPEED : WAY_HOLD_SPEED;
        const dirSign = this._latchedForwardSign ?? this._wayForwardSign();
        this._nudgeWayRail(inputDir * dirSign * speed * dt, dt);
      } else if (this.wayfinding.tween) {
        this._tickWayfinding(dt);
      }
    } else {
      const k = 1 - Math.exp(-this.damping * dt);
      const goal = this.goal;
      view.pos.lerp(goal.pos, k);
      view.yaw += shortestAngle(view.yaw, goal.yaw) * k;
      view.pitch += (goal.pitch - view.pitch) * k;
      view.fov += (goal.fov - view.fov) * k;
    }
    const lookRate = this._autoResetting ? 4.5 : 14;
    const kLook = 1 - Math.exp(-lookRate * dt);
    this.look.yawNow += (this.look.yaw - this.look.yawNow) * kLook;
    this.look.pitchNow += (this.look.pitch - this.look.pitchNow) * kLook;
    if (this._autoResetting && Math.abs(this.look.yawNow) < 0.001 && Math.abs(this.look.pitchNow) < 0.001) {
      this._autoResetting = false;
      this.look.yawNow = 0;
      this.look.pitchNow = 0;
    }

    for (const update of this.updaters) update(dt, time);
    if (this._way && this.wayGroup.visible) this._animateWay(time, dt);

    const camera = this.camera;
    const prevCamY = camera.position.y;
    camera.position.copy(view.pos);
    if (this.wayfinding) {
      camera.position.y = this._waySnapCamY
        ? view.pos.y
        : THREE.MathUtils.damp(prevCamY, view.pos.y, 7.5, dt);
      this._waySnapCamY = false;
    }
    let roll = 0;
    let pitchExtra = 0;
    const fx = this.fourDX;
    if (fx.pivot && fx.level > 0.004) {
      // Kamera ikut berputar terhadap pivot blok kursi (pendekatan sudut kecil).
      const rx = view.pos.x - fx.pivot.x;
      const ry = view.pos.y - fx.pivot.y;
      const rz = view.pos.z - fx.pivot.z;
      camera.position.x -= ry * fx.roll;
      camera.position.y += rx * fx.roll - rz * fx.pitch + fx.heave;
      camera.position.z += ry * fx.pitch;
      roll = fx.roll;
      pitchExtra = fx.pitch;
    }
    camera.rotation.set(
      clamp(view.pitch + this.look.pitchNow + pitchExtra, -1.5, 1.5),
      view.yaw + this.look.yawNow,
      roll,
    );
    if (Math.abs(camera.fov - view.fov) > 0.01) {
      camera.fov = view.fov;
      camera.updateProjectionMatrix();
    }
    this.media.updateListener(camera);
    if (this._way && this.wayGroup.visible) this._updateWayZoneCull(camera.position);
    if (this._way && this.wayGroup.visible && this.minimap && this._way.route) {
      this.minimap.update(
        camera.position,
        camera.rotation.y,
        this._way.route.curve,
        this._way.route.seatPos,
        this._way.route.plazaKey,
      );
    }
    this.renderer.render(this.scene, camera);
  }
}
