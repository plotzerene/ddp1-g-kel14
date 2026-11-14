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

const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const vec = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

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

function boxPart(w, h, d, x, y, z, rotX = 0) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  if (rotX) geometry.rotateX(rotX);
  geometry.translate(x, y, z);
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

    video.addEventListener('loadeddata', () => this._useVideo());
    video.addEventListener('loadedmetadata', () => this.onAspect(this.aspect));
    video.addEventListener('error', () => {
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
    if (!url) {
      this.currentUrl = null;
      this.video.removeAttribute('src');
      this.video.load();
      this._useFallback('File video belum ada di reference_assets/videos — memakai animasi pengganti.');
      return;
    }
    if (this.currentUrl !== url) {
      this.currentUrl = url;
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

  /* ----------------------------- Web Audio -------------------------------- */
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 1500);
    this.camera.rotation.order = 'YXZ';
    this.world = new THREE.Group();      // geometri venue
    this.local = new THREE.Group();      // detail di sekitar kursi terpilih
    this.scene.add(this.world, this.local);

    this.layout = null;
    this.pov = null;
    this.updaters = [];
    this.screenMeshes = [];
    this.sharedMaterials = [];
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

    this._bindPointer();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(host);
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  /* ----------------------------- Utilitas -------------------------------- */
  _std(color, extra = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra });
  }

  _basic(color, extra = {}) {
    return new THREE.MeshBasicMaterial({ color, ...extra });
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

  _resize() {
    const width = Math.max(1, Math.floor(this.host.clientWidth));
    const height = Math.max(1, Math.floor(this.host.clientHeight));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.onAspect) this.onAspect(width / height);
  }

  get aspect() {
    return this.camera.aspect;
  }

  /* ----------------------------- Kontrol kamera --------------------------- */
  _bindPointer() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const limitPitch = () => {
      const base = this.goal.pitch;
      this.look.pitch = clamp(this.look.pitch, -1.45 - base, 1.45 - base);
    };

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
      if (this.onInteract) this.onInteract();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const radPerPixel = THREE.MathUtils.degToRad(this.camera.fov) / Math.max(1, canvas.clientHeight);
      this.look.yaw += (event.clientX - lastX) * radPerPixel;
      this.look.pitch += (event.clientY - lastY) * radPerPixel;
      limitPitch();
      lastX = event.clientX;
      lastY = event.clientY;
    });
    const stop = () => {
      dragging = false;
      canvas.classList.remove('is-dragging');
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('dblclick', () => this.resetLook());
    canvas.addEventListener('keydown', (event) => {
      const step = THREE.MathUtils.degToRad(6);
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[event.key]) {
        event.preventDefault();
        this.look.yaw += moves[event.key][0];
        this.look.pitch += moves[event.key][1];
        limitPitch();
        if (this.onInteract) this.onInteract();
      } else if (event.key === 'Home' || event.key === '0') {
        this.resetLook();
      }
    });
  }

  /** Kembali ke arah pandang yang dihitung Python. */
  resetLook() {
    this.look.yaw = 0;
    this.look.pitch = 0;
  }

  /* ----------------------------- Memuat venue ----------------------------- */
  loadVenue(layout) {
    this._clearGroup(this.world);
    this._clearGroup(this.local);
    for (const material of this.sharedMaterials) material.dispose();
    this.sharedMaterials = [];
    this.media.materials.clear();
    this.updaters = [];
    this.screenMeshes = [];
    this.layout = layout;
    this.pov = null;
    this.spectators = null;
    this.seatSets = null;
    this.farCrowd = null;
    this.xylo = null;
    this.frontGroup = null;
    this.fourDX = { on: false, level: 0, config: null, pivot: null };
    this.scene.fog = null;
    if (layout.kind === 'cinema') this._buildCinema(layout);
    else this._buildStadium(layout);
    this.media.setSource(layout.media.video, layout.media.video_label);
  }

  /* ----------------------------- Layar / LED ------------------------------ */
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
    const material = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.media.bind(material);
    const mesh = new THREE.Mesh(geometry, material);
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

    // Ruangan: kotak dilihat dari dalam + lantai, plafon, dinding depan hitam.
    const shell = new THREE.Mesh(new THREE.BoxGeometry(W, H, length), this._std(theme.wall, { side: THREE.BackSide }));
    shell.position.set(0, H / 2, zMid);
    this.world.add(shell);
    const carpet = this._std(theme.carpet, { roughness: 1 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, length), carpet);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.003, zMid);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, length), this._std(theme.ceiling, { roughness: 1 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, H - 0.003, zMid);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this._basic(0x020202));
    front.position.set(0, H / 2, z0 + 0.01);
    this.world.add(floor, ceiling, front);

    // Undakan tiap baris.
    const treadStart = (row) => row.z - spec.row_depth / 2 - 0.1;
    const nosing = this._basic(0x2a2426);
    L.rows.forEach((row, i) => {
      if (row.y <= 0) return;
      const start = treadStart(row);
      const end = i === L.rows.length - 1 ? D : treadStart(L.rows[i + 1]);
      this._box(W, row.y, end - start, carpet, 0, row.y / 2, (start + end) / 2);
      this._box(W, 0.02, 0.05, nosing, 0, row.y + 0.011, start + 0.03);
    });
    const floorAt = (z) => {
      let y = 0;
      for (const row of L.rows) if (treadStart(row) <= z) y = row.y;
      return y;
    };

    // Lampu langkah di lorong.
    const aisles = [-(W / 2 - 0.55), W / 2 - 0.55];
    for (let i = 0; i < L.columns.length - 1; i += 1) {
      if (L.columns[i + 1] - L.columns[i] > spec.seat_pitch + 0.35) aisles.push((L.columns[i] + L.columns[i + 1]) / 2);
    }
    const stepLights = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.5, 0.025, 0.05), this._basic(theme.step_light, { toneMapped: false }),
      aisles.length * L.rows.length);
    const matrix = new THREE.Matrix4();
    let count = 0;
    for (const row of L.rows) {
      for (const x of aisles) {
        matrix.makeTranslation(x, row.y + 0.014, treadStart(row) + 0.06);
        stepLights.setMatrixAt(count, matrix);
        count += 1;
      }
    }
    this.world.add(stepLights);

    // Pilaster dinding + lampu dinding.
    const pilaster = this._std(theme.wall_accent);
    const sconce = this._basic(theme.sconce, { toneMapped: false });
    const wash = this._shared(this._glowMaterial(theme.sconce, 0.2));
    for (let z = 2.6; z < D - 0.6; z += 2.6) {
      for (const side of [-1, 1]) {
        const y = floorAt(z) + 2.3;
        this._box(0.1, H, 0.55, pilaster, side * (W / 2 - 0.05), H / 2, z);
        this._box(0.07, 0.4, 0.2, sconce, side * (W / 2 - 0.13), y, z);
        const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.8), wash);
        glow.position.set(side * (W / 2 - 0.11), y, z);
        glow.rotation.y = -side * Math.PI / 2;
        this.world.add(glow);
      }
    }
    const exit = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.2), this._basic(0x1fbf62, { toneMapped: false }));
    exit.position.set(-W / 2 + 0.02, 2.5, 3.2);
    exit.rotation.y = Math.PI / 2;
    this.world.add(exit);

    // Layar + cahaya layar yang mengikuti warna video.
    this._buildSurface(screen);
    const ambient = new THREE.AmbientLight(0xffffff, 0.09);
    const hemi = new THREE.HemisphereLight(new THREE.Color(theme.sconce), new THREE.Color(0x000000), 0.16);
    const screenLight = new THREE.PointLight(0xffffff, 10, 0, 1.1);
    screenLight.position.set(0, screen.center[1], 2.2);
    this.world.add(ambient, hemi, screenLight);
    const reach = Math.sqrt(screen.width * screen.height);
    this.updaters.push(() => {
      const c = this.media.color;
      screenLight.color.setRGB(0.35 + c.r * 0.65, 0.35 + c.g * 0.65, 0.35 + c.b * 0.65);
      screenLight.intensity = reach * (0.5 + 4.2 * c.luma);
      ambient.intensity = 0.09 + this.fourDX.level * this.media.energy * 0.6;   // kilat 4DX
    });

    // Berkas proyektor.
    const apex = new THREE.Vector3(0, Math.min(H - 0.5, room.back_floor_y + 2.45), D - 0.25);
    const arc = screen.arc;
    const left = arc ? arc[0] : [-screen.width / 2, 0, 0];
    const right = arc ? arc[arc.length - 1] : [screen.width / 2, 0, 0];
    const top = screen.center[1] + screen.height / 2;
    const bottom = screen.center[1] - screen.height / 2;
    const beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      apex.x, apex.y, apex.z,
      left[0], bottom, left[2], right[0], bottom, right[2], right[0], top, right[2], left[0], top, left[2],
    ], 3));
    beamGeometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0x9fb8ff, transparent: true, opacity: 0.035, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.world.add(new THREE.Mesh(beamGeometry, beamMaterial));
    const lens = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture, color: 0xa9c4ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    lens.position.copy(apex);
    lens.scale.setScalar(1.3);
    this.world.add(lens);
    this.updaters.push(() => {
      const c = this.media.color;
      beamMaterial.color.setRGB(0.4 + c.r * 0.6, 0.4 + c.g * 0.6, 0.45 + c.b * 0.55);
      beamMaterial.opacity = 0.018 + 0.05 * c.luma;
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
        { geometry: boxPart(0.5, 0.03, 0.03, 0, h + 0.74, 0.31), material: this._basic(theme.seat_piping) },
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
  }

  /** Penonton di kursi terjual (siluet kepala + badan). */
  _buildSpectators(L) {
    const sold = L.seats.filter((seat) => seat.status === 'sold');
    if (!sold.length) return;
    const recliner = L.seat_type === 'recliner';
    const material = this._std(0x0c0c12, { roughness: 1 });
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.105, 12, 10), material, sold.length);
    const torso = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.17, 0.3, 3, 8), material, sold.length);
    head.frustumCulled = false;
    torso.frustumCulled = false;
    const base = { head: [], torso: [] };
    const scale = new THREE.Vector3(1.2, 1, 1);
    const none = new THREE.Quaternion();
    sold.forEach((seat, i) => {
      const sit = 0.8 + ((hashString(seat.id) % 100) / 100) * 0.1;      // variasi tinggi duduk
      const lean = recliner ? 0.26 : 0.06;
      const drop = recliner ? 0.07 : 0;
      const headMatrix = new THREE.Matrix4().makeTranslation(seat.x, seat.y + L.seat_height + sit - 0.105 - drop, seat.z + lean);
      const torsoMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(seat.x, seat.y + L.seat_height + 0.3 - drop, seat.z + lean * 0.6), none, scale);
      head.setMatrixAt(i, headMatrix);
      torso.setMatrixAt(i, torsoMatrix);
      base.head.push(headMatrix);
      base.torso.push(torsoMatrix);
    });
    this.world.add(head, torso);
    this.spectators = { head, torso, base, seats: sold, index: new Map(sold.map((seat, i) => [seat.id, i])), hidden: [] };
  }

  /** Sembunyikan siluet generik di kursi sendiri dan kursi tepat di depan (diganti versi Python). */
  _hideSpectators(seatIds) {
    const set = this.spectators;
    if (!set) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const i of set.hidden) {
      set.head.setMatrixAt(i, set.base.head[i]);
      set.torso.setMatrixAt(i, set.base.torso[i]);
    }
    set.hidden = seatIds.map((id) => set.index.get(id)).filter((i) => i !== undefined);
    for (const i of set.hidden) {
      set.head.setMatrixAt(i, zero);
      set.torso.setMatrixAt(i, zero);
    }
    set.head.instanceMatrix.needsUpdate = true;
    set.torso.instanceMatrix.needsUpdate = true;
  }

  _buildFurniture(L) {
    if (!L.furniture.length) return;
    const wood = this._std(L.theme.table, { roughness: 0.5 });
    const lamp = this._basic(L.theme.lamp, { toneMapped: false });
    const halo = this._shared(new THREE.SpriteMaterial({
      map: this.glowTexture, color: L.theme.lamp, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    for (const item of L.furniture) {
      const topMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 20), wood);
      topMesh.position.set(item.x, item.y + 0.62, item.z - 0.05);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 10), wood);
      stem.position.set(item.x, item.y + 0.3, item.z - 0.05);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), lamp);
      bulb.position.set(item.x, item.y + 0.8, item.z - 0.05);
      const glow = new THREE.Sprite(halo);
      glow.position.copy(bulb.position);
      glow.scale.setScalar(0.9);
      this.world.add(topMesh, stem, bulb, glow);
    }
  }

  /* ----------------------------- Efek 4DX --------------------------------- */
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
          spectators.head.setMatrixAt(k, scratch.multiplyMatrices(sway, spectators.base.head[k]));
          spectators.torso.setMatrixAt(k, scratch.multiplyMatrices(sway, spectators.base.torso[k]));
        }
      });
      for (const mesh of this.seatSets.meshes) mesh.instanceMatrix.needsUpdate = true;
      if (spectators) {
        spectators.head.instanceMatrix.needsUpdate = true;
        spectators.torso.instanceMatrix.needsUpdate = true;
      }
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
  _ringStrip(inner, outer, material, { vRepeat = 1, drop = 0 } = {}) {
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
    this.world.add(mesh);
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
    this.world.add(new THREE.Mesh(skyGeometry, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    const starPositions = [];
    for (let i = 0; i < 700; i += 1) {
      const theta = rand() * TAU;
      const phi = Math.acos(rand() * 0.92);
      starPositions.push(1150 * Math.sin(phi) * Math.cos(theta), 1150 * Math.cos(phi) + 30, 1150 * Math.sin(phi) * Math.sin(theta));
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    this.world.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({
      color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false, depthWrite: false })));

    // Cahaya: malam biru + cahaya panggung yang mengikuti video.
    const stageLight = new THREE.PointLight(0xffffff, 60, 0, 1.0);
    stageLight.position.set(0, 18, stage.deck.z1 + 5);
    this.world.add(new THREE.AmbientLight(0x8fa2ff, 0.3), new THREE.HemisphereLight(0x2b3a7a, 0x05060a, 0.5), stageLight);

    // Warna aksen bersama (pita LED, tepi runway, sorot) mengikuti warna dominan video.
    const accent = this._basic(0xffffff, { toneMapped: false });
    const accentDim = this._basic(0xffffff, { toneMapped: false });
    const white = new THREE.Color(0xffffff);
    const hsl = { h: 0, s: 0, l: 0 };
    this.updaters.push(() => {
      const c = this.media.color;
      this.vivid.setRGB(c.r, c.g, c.b).getHSL(hsl);
      this.vivid.setHSL(hsl.h, Math.max(0.7, hsl.s), 0.56);
      stageLight.color.copy(this.vivid).lerp(white, 0.35);
      stageLight.intensity = 30 + 120 * c.luma;
      accent.color.copy(this.vivid);
      accentDim.color.copy(this.vivid).multiplyScalar(0.3);
    });

    // Lapangan.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), this._std(0x0a0c15, { roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.world.add(ground);
    const pitchShape = new THREE.Shape(L.field.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    const pitch = new THREE.Mesh(new THREE.ShapeGeometry(pitchShape), this._std(0x11131f, { roughness: 1 }));
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.y = 0.01;
    this.world.add(pitch);

    // Mangkuk tribun dari cincin titik yang dihitung Python.
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
    this._buildFarCrowd(rand);
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
        // Platform FOH: dek berpagar barikade + kanopi lengkung perak + meja konsol suara/lampu.
        const foh = new THREE.Group();
        foh.position.set(center[0], 0, center[2]);
        this.world.add(foh);

        const deckH = 1.6;
        this._buildCompoundDeck(foh, 6.4, 4.8, deckH, dark, railMat);
        for (const sx of [-2.4, 2.4]) {
          for (const sz of [-1.9, 1.9]) {
            this._box(0.16, 2.0, 0.16, steel, sx, deckH + 1.0, sz, foh);
          }
        }
        this._buildCanopyRoof(foh, 0, 2.85, 0, 5.2, 4.2, 2.5, canopyMat);
        // Meja konsol audio & pencahayaan di bawah tenda FOH.
        this._box(3.8, 0.95, 1.05, housingMat, 0, deckH + 0.48, -0.35, foh);
        const consoleGlow = this._basic(0x38bdf8, { toneMapped: false });
        this._box(3.4, 0.08, 0.55, consoleGlow, 0, deckH + 0.98, -0.32, foh);
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

    // Sorot lampu & laser.
    const beamGeometry = new THREE.CylinderGeometry(0.25, 3.4, 80, 14, 1, true);
    beamGeometry.translate(0, -40, 0);
    const beams = [];
    const down = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < 12; i += 1) {
      const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      }));
      beam.position.set(-27.5 + i * 5, 15, deck.z0 + 1);
      this.world.add(beam);
      beams.push(beam);
    }
    const laserCount = 18;
    const laserPositions = new Float32Array(laserCount * 6);
    const laserGeometry = new THREE.BufferGeometry();
    laserGeometry.setAttribute('position', new THREE.BufferAttribute(laserPositions, 3));
    const laserMaterial = new THREE.LineBasicMaterial({
      color: 0x39ff9a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const lasers = new THREE.LineSegments(laserGeometry, laserMaterial);
    lasers.frustumCulled = false;
    this.world.add(lasers);
    const direction = new THREE.Vector3();
    const tint = new THREE.Color();
    this.updaters.push((dt, time) => {
      const motion = this.reducedMotion ? 0 : time;
      beams.forEach((beam, i) => {
        const yaw = Math.sin(motion * 0.3 + i * 0.9) * 0.7;
        const tilt = 0.5 + Math.sin(motion * 0.23 + i * 1.7) * 0.32;
        direction.set(Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt) * 0.55 - 0.1, Math.cos(yaw) * Math.cos(tilt)).normalize();
        beam.quaternion.setFromUnitVectors(down, direction);
        tint.copy(this.vivid).offsetHSL(i * 0.07, 0, 0);
        beam.material.color.copy(tint);
        beam.material.opacity = 0.03 + 0.05 * this.media.color.luma;
      });
      for (let i = 0; i < laserCount; i += 1) {
        const originX = i < laserCount / 2 ? -12 : 12;
        const fan = ((i % (laserCount / 2)) / (laserCount / 2 - 1) - 0.5) * 1.3 + Math.sin(motion * 0.5) * 0.3;
        const lift = 0.1 + 0.1 * Math.sin(motion + i);
        laserPositions.set([
          originX, 14.5, deck.z0 + 0.5,
          originX + Math.sin(fan) * 260, 14.5 + lift * 260, deck.z0 + 0.5 + Math.cos(fan) * 260,
        ], i * 6);
      }
      laserGeometry.attributes.position.needsUpdate = true;
      laserMaterial.opacity = 0.18 + 0.4 * this.media.energy;
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
    this.clearOfStage = (x, z) => {
      if (x > runway.x0 - 1.4 && x < runway.x1 + 1.4 && z < runway.z1 + 1.4) return false;
      if (Math.hypot(x - bStage.center[0], z - bStage.center[2]) < bStage.radius + 1.5) return false;
      return Math.hypot(x - cStage.center[0], z - cStage.center[2]) >= cStage.radius + 1.5;
    };
    for (let placed = 0, tries = 0; placed < 5200 && tries < 30000; tries += 1) {
      const x = (rand() - 0.5) * 78;
      const z = -53 + rand() * 132;
      if (!this.insideField(x, z) || !this.clearOfStage(x, z)) continue;
      positions.push(x, 1.3 + rand() * 0.7, z);
      seeds.push(rand());
      placed += 1;
    }

    const uniforms = {
      uTime: { value: 0 }, uBeat: { value: 0.3 }, uProj: { value: 600 }, uWave: { value: 0.5 },
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
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float alpha = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vColor * alpha, alpha);
          #include <colorspace_fragment>
        }`,
    }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    this.world.add(points);
    this.xylo = { material, uniforms };

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
      const x = (rand() - 0.5) * 76;
      const z = -53 + Math.pow(rand(), 1.35) * 131;      // lebih padat di dekat panggung
      if (!this.insideField(x, z) || !this.clearOfStage(x, z)) continue;
      people.push({ x, z, h: 1.5 + rand() * 0.32 });
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
    const crowd = this.farCrowd;
    if (!crowd) return;
    const matrix = new THREE.Matrix4();
    const none = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    crowd.people.forEach((person, i) => {
      const hidden = center && Math.hypot(person.x - center.x, person.z - center.z) < radius;
      const s = hidden ? 0 : 1;
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
    if (pov.viewer.posture !== 'standing') this._buildBodyRig(rig, frame);
    this._buildFrontSpectator(pov);
  }

  /** Kaki sendiri di bagian bawah pandangan (footrest terangkat di The Premiere). */
  _buildBodyRig(rig, frame) {
    const h = this.layout.seat_height || 0.42;       // tinggi alas duduk dari layout Python
    const trousers = this._std(0x1a2238, { roughness: 1 });
    const shoes = this._std(0x0a0a0c, { roughness: 0.6 });
    const limb = (radius, length, x, y, z, rotX, material = trousers) => {
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 3, 8), material);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rotX;
      rig.add(mesh);
    };
    for (const side of [-1, 1]) {
      const x = side * 0.1;
      limb(0.075, 0.34, x, h + 0.09, -0.26, Math.PI / 2);
      if (frame.footrest && frame.footrest.raised) {
        limb(0.062, 0.36, x, frame.footrest.top_y + 0.11, -0.74, Math.PI / 2);
        limb(0.05, 0.14, x, frame.footrest.top_y + 0.2, -1.02, 0.35, shoes);
      } else {
        limb(0.06, Math.max(0.1, h - 0.16), x, h / 2 + 0.02, -0.5, 0);
        limb(0.05, 0.14, x, 0.05, -0.6, Math.PI / 2, shoes);
      }
    }
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
    const standing = spectator.posture === 'standing';
    const yaw = standing ? pov.camera.yaw_rad : Math.atan2(-pov.seat_frame.facing[0], -pov.seat_frame.facing[2]);
    const group = new THREE.Group();
    group.position.set(spectator.floor[0], 0, spectator.floor[2]);
    group.rotation.y = yaw;
    const skin = this._std(0x12121c, { roughness: 1, emissive: 0x0b0a24 });
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
      people.forEach((person, i) => {
        matrix.makeTranslation(person.x, person.y + 0.42 + person.sit - 0.105, person.z);
        heads.setMatrixAt(i, matrix);
        matrix.compose(position.set(person.x, person.y + 0.72, person.z), none, wide);
        torsos.setMatrixAt(i, matrix);
        bands.push(person.x + 0.2, person.y + (person.raised ? 1.45 + person.seed * 0.2 : 0.78), person.z - (person.raised ? 0.1 : 0.25));
        seeds.push(person.seed);
      });
      for (const mesh of [heads, torsos]) mesh.frustumCulled = false;
      rig.add(heads, torsos);
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
    const phones = new THREE.InstancedMesh(new THREE.BoxGeometry(0.075, 0.15, 0.012),
      this._basic(0xcfe0ff, { toneMapped: false }), raisedCount);
    const matrix = new THREE.Matrix4();
    const none = new THREE.Quaternion();
    const facing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const mesh of [bodies, heads, arms, phones]) {
      mesh.setMatrixAt(0, zero);
      mesh.frustumCulled = false;
    }
    const bands = [];
    const seeds = [];
    let armIndex = 0;
    people.forEach((person, i) => {
      const shoulder = person.h * 0.818;
      matrix.compose(position.set(person.x, shoulder / 2, person.z), facing, scale.set(1.25, shoulder / 1.06, 1));
      bodies.setMatrixAt(i, matrix);
      matrix.compose(position.set(person.x, person.h - 0.105, person.z), none, scale.set(1, 1, 1));
      heads.setMatrixAt(i, matrix);
      const side = person.seed < 0.5 ? -0.22 : 0.22;
      const handX = person.x + right.x * side;
      const handZ = person.z + right.z * side;
      if (person.raised) {
        matrix.compose(position.set(handX, shoulder + 0.24, handZ), none, scale.set(1, 1, 1));
        arms.setMatrixAt(armIndex, matrix);
        matrix.compose(position.set(handX, shoulder + 0.56, handZ), facing, scale.setScalar(person.phone ? 1 : 0));
        phones.setMatrixAt(armIndex, matrix);
        armIndex += 1;
        bands.push(handX, shoulder + 0.42, handZ);
      } else {
        bands.push(handX, person.h * 0.5, handZ);
      }
      seeds.push(person.seed);
    });
    this.local.add(bodies, heads, arms, phones);
    this._addBandPoints(this.local, bands, seeds);
  }

  /* ======================================================================= */
  /* MENERAPKAN HASIL PYTHON                                                 */
  /* ======================================================================= */
  /**
   * @param {object} pov   respons `/api/pov`
   * @param {'jump'|'glide'|'quick'} mode  jump = langsung, glide = meluncur antar kursi,
   *                                        quick = mengikuti slider
   */
  applyPov(pov, mode = 'glide') {
    const previous = this.pov;
    const seatChanged = !previous || previous.seat.seat_id !== pov.seat.seat_id || previous.venue_id !== pov.venue_id;
    const targetChanged = !previous || previous.active_target !== pov.active_target;
    this.pov = pov;

    const camera = pov.camera;
    this.goal.pos.set(...camera.position);
    this.goal.yaw = camera.yaw_rad;
    this.goal.pitch = camera.pitch_rad;
    this.goal.fov = camera.fov_deg;
    if (this.camera.near !== camera.near || this.camera.far !== camera.far) {
      this.camera.near = camera.near;
      this.camera.far = camera.far;
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

  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;
    this.media.tick(time);
    this.sampleTimer += dt;
    if (this.sampleTimer > 0.14) {
      this.sampleTimer = 0;
      this.media.sample();
    }

    // Haluskan perpindahan menuju nilai dari Python.
    const k = 1 - Math.exp(-this.damping * dt);
    const view = this.view;
    const goal = this.goal;
    view.pos.lerp(goal.pos, k);
    view.yaw += shortestAngle(view.yaw, goal.yaw) * k;
    view.pitch += (goal.pitch - view.pitch) * k;
    view.fov += (goal.fov - view.fov) * k;
    const kLook = 1 - Math.exp(-14 * dt);
    this.look.yawNow += (this.look.yaw - this.look.yawNow) * kLook;
    this.look.pitchNow += (this.look.pitch - this.look.pitchNow) * kLook;

    for (const update of this.updaters) update(dt, time);

    const camera = this.camera;
    camera.position.copy(view.pos);
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
    this.renderer.render(this.scene, camera);
  }
}
