/**
 * minimap_controller.js — 2D Interactive Spatial Minimap Radar HUD untuk mode wayfinding GBK.
 * Merender vektor top-down (Ring Road luar, oval mangkuk GBK, label 4 plaza, kurva rute aktif #00F5D4,
 * penanda kursi target berdenyut, dan blip kamera dengan kerucut FOV berputar sinkron YXZ yaw).
 */

export const MAP_SIZE = 180;
export const MAP_CENTER = MAP_SIZE / 2;
export const MAP_SCALE = MAP_SIZE / 440;

const WORLD_TO_CANVAS_X = (wx) => MAP_CENTER + wx * MAP_SCALE;
const WORLD_TO_CANVAS_Y = (wz) => MAP_CENTER + wz * MAP_SCALE;

export class MinimapRadar {
  constructor(canvasOrId = 'spatialMinimap') {
    this.canvas = typeof canvasOrId === 'string'
      ? document.getElementById(canvasOrId)
      : canvasOrId;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.zoomLocked = true;
    this._cachedCurve = null;
    this._cachedPts = null;
    this._dpr = 1;
    if (this.canvas && this.ctx) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._dpr = dpr;
      this.canvas.width = MAP_SIZE * dpr;
      this.canvas.height = MAP_SIZE * dpr;
      for (const target of [this.canvas, this.canvas.parentElement].filter(Boolean)) {
        for (const evt of ['wheel', 'gesturestart', 'gesturechange', 'dblclick']) {
          target.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
        }
      }
    }
  }

  _sampleCurve(curve) {
    if (!curve || typeof curve.getPointAt !== 'function') return null;
    if (this._cachedCurve === curve && this._cachedPts) return this._cachedPts;
    const pts = [];
    const steps = 64;
    for (let i = 0; i <= steps; i += 1) {
      const p = curve.getPointAt(i / steps);
      pts.push([WORLD_TO_CANVAS_X(p.x), WORLD_TO_CANVAS_Y(p.z)]);
    }
    this._cachedCurve = curve;
    this._cachedPts = pts;
    return pts;
  }

  /**
   * Memperbarui kanvas radar setiap frame render Three.js.
   * @param {{x:number, y:number, z:number}} cameraPos
   * @param {number} cameraYaw
   * @param {import('three').Curve<import('three').Vector3>|null} routeCurve
   * @param {{x:number, y:number, z:number}|null} targetSeatCoords
   */
  update(cameraPos, cameraYaw, routeCurve, targetSeatCoords, activePlazaKey = 'selatan') {
    const ctx = this.ctx;
    if (!ctx || !cameraPos) return;

    const dpr = this._dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    // 1. Latar radar radial gelap + kisi jarak
    const bgGrad = ctx.createRadialGradient(MAP_CENTER, MAP_CENTER, 8, MAP_CENTER, MAP_CENTER, MAP_CENTER);
    bgGrad.addColorStop(0, 'rgba(15, 23, 42, 0.92)');
    bgGrad.addColorStop(1, 'rgba(6, 10, 20, 0.98)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    for (const rWorld of [110, 185]) {
      ctx.beginPath();
      ctx.arc(MAP_CENTER, MAP_CENTER, rWorld * MAP_SCALE, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 2. Lingkaran Ring Road luar (GBK Park)
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.34)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(MAP_CENTER, MAP_CENTER, 162 * MAP_SCALE, 192 * MAP_SCALE, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 3. Siluet oval mangkuk GBK, lintasan lari terakota tipis & panggung konser
    ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(MAP_CENTER, MAP_CENTER, 118 * MAP_SCALE, 160 * MAP_SCALE, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cincin lintasan lari interior
    ctx.strokeStyle = 'rgba(185, 56, 38, 0.72)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(MAP_CENTER, MAP_CENTER, 66 * MAP_SCALE, 90 * MAP_SCALE, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Lapangan Terraplas & panggung utara
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(
      WORLD_TO_CANVAS_X(-35),
      WORLD_TO_CANVAS_Y(-52),
      70 * MAP_SCALE,
      102 * MAP_SCALE,
    );
    ctx.fillStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.fillRect(
      WORLD_TO_CANVAS_X(-24),
      WORLD_TO_CANVAS_Y(-52),
      48 * MAP_SCALE,
      14 * MAP_SCALE,
    );

    // 4. Marker & Label 4 Plaza Utama GBK (Utara, Timur, Selatan/Tenggara, Barat)
    const plazas = [
      { key: 'utara',   label: 'Utara',    x: 0,    z: -198 },
      { key: 'timur',   label: 'Timur',    x: 168,  z: 0    },
      { key: 'selatan', label: 'Selatan',  x: 125,  z: 178  },
      { key: 'barat',   label: 'Barat',    x: -168, z: 0    },
    ];
    ctx.font = '600 8px "SF Pro Display", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pl of plazas) {
      const mx = WORLD_TO_CANVAS_X(pl.x);
      const my = WORLD_TO_CANVAS_Y(pl.z);
      const isAct = pl.key === activePlazaKey;
      ctx.beginPath();
      ctx.arc(mx, my - 9, isAct ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = isAct ? '#FFD60A' : 'rgba(148, 163, 184, 0.55)';
      ctx.fill();
      ctx.fillStyle = isAct ? '#FFD60A' : 'rgba(203, 213, 225, 0.72)';
      ctx.fillText(pl.label, mx, my);
    }

    // 5. Kurva rute navigasi aktif (Glowing Yellow #FFD60A)
    const pts = this._sampleCurve(routeCurve);
    if (pts && pts.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255, 214, 10, 0.34)';
      ctx.lineWidth = 4.8;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();

      ctx.strokeStyle = '#FFD60A';
      ctx.lineWidth = 2.0;
      ctx.stroke();
      ctx.restore();
    }

    // 6. Penanda target kursi (titik kuning emas berdenyut)
    if (targetSeatCoords) {
      const tx = WORLD_TO_CANVAS_X(targetSeatCoords.x);
      const ty = WORLD_TO_CANVAS_Y(targetSeatCoords.z);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
      const ringR = 4.2 + pulse * 4.5;

      ctx.beginPath();
      ctx.arc(tx, ty, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 214, 10, ${(0.85 - pulse * 0.5).toFixed(2)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFD60A';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#111827';
      ctx.stroke();
    }

    // 7. User Blip (titik putih + segitiga cone sudut pandang kamera kuning berputar sesuai yaw)
    const ux = WORLD_TO_CANVAS_X(cameraPos.x);
    const uy = WORLD_TO_CANVAS_Y(cameraPos.z);
    // Konvensi Three.js camera YXZ: vektor pandang horizontal = (-sin(yaw), -cos(yaw)) di bidang (X, Z)
    const heading = Math.atan2(-Math.cos(cameraYaw), -Math.sin(cameraYaw));
    const fovHalf = 0.46;
    const coneLen = 20;

    ctx.save();
    ctx.translate(ux, uy);
    ctx.rotate(heading);
    const coneGrad = ctx.createRadialGradient(0, 0, 1, 0, 0, coneLen);
    coneGrad.addColorStop(0, 'rgba(255, 214, 10, 0.55)');
    coneGrad.addColorStop(1, 'rgba(255, 214, 10, 0.02)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(-fovHalf) * coneLen, Math.sin(-fovHalf) * coneLen);
    ctx.arc(0, 0, coneLen, -fovHalf, fovHalf);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(ux, uy, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#0F172A';
    ctx.stroke();

    ctx.restore();
  }
}
