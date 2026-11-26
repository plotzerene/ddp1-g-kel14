/**
 * model_assets.js — pemuat model 3D (glTF/GLB) dari app/static/models/ untuk pov_3d_three.js.
 *
 *   cinemamovie_theater_interior/seat.glb       satu kursi bioskop utuh yang diekstrak dari cinema.glb
 *   cinema_theater_lounge_sofa/sofa_lod.glb     sofa lounge 2 kursi, disederhanakan dari 437 rb → ±30 rb segitiga
 *
 * seat.glb dan sofa_lod.glb dibuat oleh tools/build_model_assets.mjs (model aslinya terlalu berat untuk
 * diduplikasi ratusan kali). Keduanya berukuran meter, lantai di y=0, pusat X/Z di (0,0), depan menghadap −z.
 *
 * Semua pemuatan di-cache; bila gagal (404, jaringan) promise ditolak dan pemanggil jatuh kembali ke
 * geometri prosedural yang sudah tergambar lebih dulu — halaman tidak pernah kosong.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BASE = new URL('../models/', import.meta.url);

export const MODEL_FILES = {
  hallSeat: 'cinemamovie_theater_interior/seat.glb',
  loungeSofa: 'cinema_theater_lounge_sofa/sofa_lod.glb',
  // Eksterior GBK + panggung konser (Blender, 22,7 rb segitiga). Koordinat file = koordinat app; dipakai mode wayfinding.
  // Versi produksi: Draco + WebP (~3 MB). File asli 24 MB tetap ada sebagai cadangan bila decoder/WebP gagal.
  gbkExterior: 'gbk_exterior_prod.glb',
};

const MODEL_FALLBACKS = {
  gbkExterior: 'gbk_exterior_optimized.glb',
};

/**
 * Ukuran asli model (meter, sebelum diskalakan) yang dipakai untuk menskalakan ke layout Python dan untuk
 * mendudukkan manekin penonton tepat di bantalan + menyandar ke sandaran. Diukur dari vertex GLB:
 *   width        lebar total (dengan sandaran tangan)          seatTop      tinggi acuan dudukan (skala Y)
 *   armrest      lebar satu sandaran tangan (kursi hall)       cushionTop   puncak bantalan duduk
 *   cushionFront tepi depan bantalan (z, depan = −z)            cushionX     pusat bantalan dari pusat sofa (x)
 *   backFront    profil muka depan sandaran: [y, z] dari bawah ke atas      reclineDeg  kemiringan rata-rata sandaran
 */
export const MODEL_SPECS = {
  hallSeat: {
    width: 0.5, seatTop: 0.36, armrest: 0.06, cushionTop: 0.359, cushionFront: -0.263, reclineDeg: 11,
    backFront: [[0.36, 0.08], [0.4, 0.084], [0.5, 0.103], [0.6, 0.138], [0.65, 0.151], [0.7, 0.16], [0.75, 0.166], [0.83, 0.17]],
  },
  loungeSofa: {
    width: 2.0, seatTop: 0.55, cushionTop: 0.477, cushionFront: -0.483, cushionX: 0.42, reclineDeg: 22,
    backFront: [[0.48, 0.128], [0.6, 0.132], [0.65, 0.15], [0.7, 0.181], [0.75, 0.222], [0.8, 0.243], [0.9, 0.241], [1.04, 0.3]],
  },
};

const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(new URL('./vendor/three-addons/libs/draco/gltf/', import.meta.url).href);
loader.setDRACOLoader(dracoLoader);
const cache = new Map();

export function modelUrl(key) {
  return new URL(MODEL_FILES[key], BASE).href;
}

/** Muat model (sekali saja). @returns {Promise<THREE.Group>} scene glTF yang di-cache — jangan dimodifikasi. */
export function loadModel(key) {
  if (!MODEL_FILES[key]) return Promise.reject(new Error(`Model tidak dikenal: ${key}`));
  if (!cache.has(key)) {
    let promise = loader.loadAsync(modelUrl(key)).then((gltf) => gltf.scene);
    if (MODEL_FALLBACKS[key]) {
      promise = promise.catch((err) => {
        console.warn(`Model ${key} gagal dimuat, memakai cadangan`, err);
        return loader.loadAsync(new URL(MODEL_FALLBACKS[key], BASE).href).then((gltf) => gltf.scene);
      });
    }
    promise.catch(() => cache.delete(key));        // izinkan coba lagi bila gagal
    cache.set(key, promise);
  }
  return cache.get(key);
}

/**
 * Ratakan hierarki model menjadi daftar { geometry, material } — satu entri per material, transformasi
 * dunia sudah di-"bake" ke vertex. Cocok untuk InstancedMesh (satu draw call per material).
 * Material dikloning supaya aman diubah (mis. warna jok) dan dibuang tanpa menyentuh cache.
 *
 * @param {THREE.Object3D} root
 * @param {{ scale?: [number, number, number], override?: THREE.Material }} [options]
 *   scale: skala per sumbu yang di-bake ke geometri; override: satu material untuk SEMUA mesh (tekstur & UV asli dibuang)
 */
export function bakeParts(root, { scale = [1, 1, 1], override = null } = {}) {
  root.updateWorldMatrix(true, true);
  const groups = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geometry.deleteAttribute(name);
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    if (override) geometry.deleteAttribute('uv');     // material pengganti tanpa tekstur → UV (seam) dibuang
    const material = override || object.material;
    if (!groups.has(material)) groups.set(material, []);
    groups.get(material).push(geometry);
  });
  const parts = [];
  for (const [material, geometries] of groups) {
    // Gabungkan hanya bila semuanya punya atribut yang sama (mis. sebagian tanpa UV).
    const withUv = geometries.filter((g) => g.attributes.uv);
    const list = withUv.length === geometries.length ? geometries : geometries.map((g) => {
      g.deleteAttribute('uv');
      return g;
    });
    // mergeGeometries menuntut semuanya berindeks atau semuanya tidak.
    const indexed = list.every((g) => g.index);
    const merged = list.length === 1 ? list[0] : mergeGeometries(indexed ? list : list.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    merged.scale(scale[0], scale[1], scale[2]);
    merged.computeBoundingBox();
    const clone = material.clone();
    parts.push({ geometry: merged, material: clone });
  }
  return parts;
}

/** Bounding box gabungan semua bagian (dalam meter). */
export function partsBounds(parts) {
  const box = new THREE.Box3();
  for (const { geometry } of parts) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  return box;
}
