/* SUNSET DISTRICT — city kart grand prix
   Everything below is authored for this build: no external assets, no network. */
'use strict';
(function () {
  const THREE = window.THREE;
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get('shot') === '1';
  const FREEZE = Q.get('freeze') === '1' || SHOT;
  const CAMQ = Q.get('cam') ? Q.get('cam').split(',').map(Number) : null;
  const SEED = parseInt(Q.get('seed') || '20261114', 10) || 20261114;
  if (SHOT) document.body.classList.add('shot');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const G = (window.__G = { THREE, state: {}, flags: {} });
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
  const smoothstep = (a, b, x) => { const t = invLerp(a, b, x); return t * t * (3 - 2 * t); };
  const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
  const approach = (a, b, step) => (a < b ? Math.min(a + step, b) : Math.max(a - step, b));
  const wrapAngle = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
  const fmtTime = (s, ms = true) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60), d = Math.floor((s % 1) * 10);
    return `${m}:${String(sec).padStart(2, '0')}${ms ? '.' + d : ''}`;
  };

  // Deterministic RNG (mulberry32) so every fixed camera / seed reproduces.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(SEED);
  G.rng = rng;
  const R = (a = 0, b = 1) => a + (b - a) * rng();
  const RI = (a, b) => Math.floor(R(a, b + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  // ---------------------------------------------------------------- renderer
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, stencil: false, depth: true,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  renderer.setClearColor(0x0a0c10, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = false;
  if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;
  G.renderer = renderer;
  const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const QUALITY = {
    low:    { dpr: 1.0, shadow: 1024, samples: 0, bloom: false, refl: 0,  env: 0.9,  foliage: 0.7 },
    medium: { dpr: 1.25, shadow: 1536, samples: 2, bloom: true, refl: 0,   env: 1.0, foliage: 0.85 },
    high:   { dpr: Math.min(1.6, devicePixelRatio || 1), shadow: 2048, samples: 4, bloom: true, refl: 0.5, env: 1.0, foliage: 1 },
    ultra:  { dpr: Math.min(2, devicePixelRatio || 1), shadow: 3072, samples: 4, bloom: true, refl: 0.75, env: 1.05, foliage: 1.15 },
  };
  let qualityName = 'high';
  let QS = QUALITY[qualityName];

  // ---------------------------------------------------------------- canvas textures
  const maxAniso = MAX_ANISO;
  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    return c;
  }
  function canvasTexture(c, srgb = true, rx = 1, ry = 1, aniso = 8) {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = Math.min(aniso, maxAniso);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }
  // Tileable value-noise lattice, smoothly interpolated.
  function noiseMaker(period, seed) {
    const r = mulberry32(seed);
    const g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = r();
    const sm = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
      const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
      const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
      const u = sm(xf), v = sm(yf);
      return lerp(lerp(a, b, u), lerp(c, d, u), v);
    };
  }
  function fbmMaker(period, seed, octaves = 4) {
    const layers = [];
    for (let o = 0; o < octaves; o++) layers.push(noiseMaker(period * Math.pow(2, o), seed + o * 131));
    return (x, y) => {
      let s = 0, a = 0.5, f = 1;
      for (let o = 0; o < octaves; o++) { s += a * layers[o](x * f, y * f); f *= 2; a *= 0.5; }
      return s;
    };
  }
  const smoothNoise = fbmMaker(8, 1337, 4);
  const fineNoise = fbmMaker(64, 991, 3);

  function heightToNormal(height, w, h, strength = 2.2) {
    const c = makeCanvas(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xl = (x - 1 + w) % w, xr = (x + 1) % w, yu = (y - 1 + h) % h, yd = (y + 1) % h;
        const dx = (height[yu * w + xr] - height[yu * w + xl]) * strength;
        const dy = (height[yd * w + xl] - height[yu * w + xl]) * strength;
        let nx = -dx, ny = -dy, nz = 1;
        const il = 1 / Math.hypot(nx, ny, nz);
        nx *= il; ny *= il; nz *= il;
        const p = (y * w + x) * 4;
        d[p] = (nx * 0.5 + 0.5) * 255; d[p + 1] = (ny * 0.5 + 0.5) * 255; d[p + 2] = (nz * 0.5 + 0.5) * 255; d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---- asphalt ----
  function makeAsphalt() {
    const S = 1024;
    const alb = makeCanvas(S, S), rgh = makeCanvas(S, S);
    const actx = alb.getContext('2d'), rctx = rgh.getContext('2d');
    const ai = actx.createImageData(S, S), ri = rctx.createImageData(S, S);
    const A = ai.data, Rg = ri.data;
    const n1 = fbmMaker(4, 71, 4), n2 = fbmMaker(16, 991, 4), n3 = noiseMaker(128, 41);
    const height = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        const macro = n1(u * 4, v * 4), mid = n2(u * 15, v * 15), grain = n3(x * 0.9, y * 0.9);
        // tyre-polished ruts and gutters hold the water
        const gutter = Math.exp(-Math.pow((u - 0.035) / 0.085, 2)) + Math.exp(-Math.pow((u - 0.965) / 0.085, 2));
        const rut = Math.exp(-Math.pow((u - 0.31) / 0.075, 2)) + Math.exp(-Math.pow((u - 0.69) / 0.075, 2));
        const sheet = smoothstep(0.50, 0.80, n1(u * 2.0 + 4.1, v * 2.4 + 1.7));
        const wet = clamp(gutter * 0.92 + rut * 0.42 + sheet * 0.62, 0, 1);
        let g = 0.245 + macro * 0.085 + (mid - 0.5) * 0.055 + (grain - 0.5) * 0.038;
        g *= 1 - wet * 0.34;
        // old tar seams / patches
        const seam = Math.abs(Math.sin((u * 6.3 + v * 1.7) * Math.PI));
        if (seam < 0.014) g *= 0.72;
        const p = (y * S + x) * 4;
        A[p] = clamp(g * 255 * 1.02, 0, 255);
        A[p + 1] = clamp(g * 255 * 0.985, 0, 255);
        A[p + 2] = clamp(g * 255 * 0.955, 0, 255);
        A[p + 3] = 255;
        let rrv = 0.68 - wet * 0.50 + (grain - 0.5) * 0.09 + (mid - 0.5) * 0.05;
        rrv = clamp(rrv, 0.045, 1);
        Rg[p] = rrv * 255; Rg[p + 1] = Rg[p]; Rg[p + 2] = Rg[p]; Rg[p + 3] = 255;
        height[y * S + x] = grain * 0.42 + mid * 0.24 + macro * 0.18 + (seam < 0.014 ? 0.18 : 0);
      }
    }
    actx.putImageData(ai, 0, 0); rctx.putImageData(ri, 0, 0);
    const r2 = mulberry32(404);
    actx.lineCap = 'round';
    // aggregate specks catching light
    for (let i = 0; i < 2200; i++) {
      const x = r2() * S, y = r2() * S;
      const b = 30 + r2() * 70;
      actx.fillStyle = `rgba(${b},${b * 0.97},${b * 0.9},${0.15 + r2() * 0.25})`;
      actx.fillRect(x, y, 1 + r2() * 2.2, 1 + r2() * 1.8);
    }
    // cracks
    for (let i = 0; i < 22; i++) {
      let x = r2() * S, y = r2() * S, ang = r2() * TAU;
      actx.strokeStyle = `rgba(${RI(12, 30)},${RI(11, 27)},${RI(10, 24)},${0.25 + r2() * 0.38})`;
      actx.lineWidth = 0.8 + r2() * 1.7;
      actx.beginPath(); actx.moveTo(x, y);
      for (let k = 0; k < 20; k++) {
        ang += (r2() - 0.5) * 0.8; x += Math.cos(ang) * (8 + r2() * 20); y += Math.sin(ang) * (8 + r2() * 20);
        actx.lineTo(x, y);
      }
      actx.stroke();
    }
    // oil sheen and dirty patches
    for (let i = 0; i < 16; i++) {
      const x = r2() * S, y = r2() * S, rad = 18 + r2() * 80;
      const gr = actx.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(8,8,7,${0.08 + r2() * 0.14})`); gr.addColorStop(1, 'rgba(8,8,7,0)');
      actx.fillStyle = gr; actx.beginPath(); actx.arc(x, y, rad, 0, TAU); actx.fill();
    }
    const albTex = canvasTexture(alb, true, 1, 1, 8);
    const rghTex = canvasTexture(rgh, false, 1, 1, 8);
    const nrmTex = canvasTexture(heightToNormal(height, S, S, 1.15), false, 1, 1, 8);
    return { alb: albTex, rgh: rghTex, nrm: nrmTex };
  }

  // ---- paving / concrete ----
  function makePaving(seed = 7) {
    const S = 512, c = makeCanvas(S, S), r = makeCanvas(S, S);
    const ctx = c.getContext('2d'), rctx = r.getContext('2d');
    ctx.fillStyle = '#8a837a'; ctx.fillRect(0, 0, S, S);
    const img = ctx.getImageData(0, 0, S, S), d = img.data;
    const n = fbmMaker(8, seed, 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 4, v = n(x / S * 5, y / S * 5);
      const g = 118 + (v - 0.5) * 34;
      d[p] = g * 1.02; d[p + 1] = g * 0.99; d[p + 2] = g * 0.94;
    }
    ctx.putImageData(img, 0, 0);
    const rows = 8, cols = 4;
    ctx.strokeStyle = 'rgba(45,42,38,.55)'; ctx.lineWidth = 2;
    for (let j = 0; j < rows; j++) {
      const y = j * S / rows;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
      for (let i = 0; i < cols; i++) {
        const x = (i + (j % 2) * 0.5) * S / cols;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + S / rows); ctx.stroke();
      }
    }
    // stains and gum
    const rr = mulberry32(seed + 5);
    for (let i = 0; i < 80; i++) {
      const x = rr() * S, y = rr() * S, rad = 2 + rr() * 12;
      ctx.fillStyle = `rgba(40,36,30,${0.03 + rr() * 0.09})`;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    }
    const img2 = c.getContext('2d').getImageData(0, 0, S, S);
    for (let i = 0; i < img2.data.length; i += 4) {
      const p = i, v = img2.data[p] / 255;
      const rough = 0.68 + (v - 0.5) * 0.2;
      rctx.fillStyle = `rgb(${rough * 255},${rough * 255},${rough * 255})`;
    }
    rctx.fillStyle = 'rgb(168,168,168)'; rctx.fillRect(0, 0, S, S);
    return { alb: canvasTexture(c, true, 1, 1, 8), rgh: canvasTexture(r, false, 1, 1, 8) };
  }

  // ---- facades: 4 x 4 bays, tile size 10.4 m x 13.6 m ----
  const FACADE_W = 10.4, FACADE_H = 13.6;
  function makeFacade(style, seed) {
    const S = 1024, c = makeCanvas(S, S), rc = makeCanvas(S, S), ec = makeCanvas(S, S);
    const ctx = c.getContext('2d'), rctx = rc.getContext('2d'), ectx = ec.getContext('2d');
    const rr = mulberry32(seed);
    const bays = 5, floors = 5, bw = S / bays, fh = S / floors;
    const palettes = [
      { wall: '#b2a48e', wall2: '#948771', frame: '#615849', trim: '#d0c3ac', glass: '#435663', glass2: '#8fa8b8', lit: '#ffd39a' }, // limestone
      { wall: '#98928a', wall2: '#7c7770', frame: '#3f4447', trim: '#aaa399', glass: '#485e69', glass2: '#849dab', lit: '#ffd0a0' }, // concrete office
      { wall: '#89685a', wall2: '#705247', frame: '#55433b', trim: '#b9a48e', glass: '#43545f', glass2: '#7d919c', lit: '#ffc887' }, // brick
      { wall: '#5c6b76', wall2: '#47535d', frame: '#2c353c', trim: '#8d9ba5', glass: '#607c8e', glass2: '#a9c1d0', lit: '#fff0c6' }, // curtain wall
    ];
    const P = palettes[style];
    // --- wall base with subtle vertical gradient and weathering
    const bg = ctx.createLinearGradient(0, 0, 0, S);
    bg.addColorStop(0, P.wall2); bg.addColorStop(0.5, P.wall); bg.addColorStop(1, P.wall2);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, S, S);
    rctx.fillStyle = 'rgb(205,205,205)'; rctx.fillRect(0, 0, S, S);
    ectx.fillStyle = '#000'; ectx.fillRect(0, 0, S, S);
    for (let i = 0; i < 9000; i++) {
      const x = rr() * S, y = rr() * S, a = 0.012 + rr() * 0.035;
      ctx.fillStyle = rr() > 0.48 ? `rgba(255,248,236,${a})` : `rgba(28,23,19,${a})`;
      ctx.fillRect(x, y, 1 + rr() * 3, 1 + rr() * 2);
    }
    // floor bands, panel joints, corner pilasters
    for (let fy = 0; fy <= floors; fy++) {
      const y = fy * fh;
      ctx.fillStyle = 'rgba(255,247,234,.12)'; ctx.fillRect(0, y, S, 3);
      ctx.fillStyle = 'rgba(24,20,17,.22)'; ctx.fillRect(0, y + 3, S, 5);
      const g = ctx.createLinearGradient(0, y + 8, 0, y + 30);
      g.addColorStop(0, 'rgba(20,16,13,.12)'); g.addColorStop(1, 'rgba(20,16,13,0)');
      ctx.fillStyle = g; ctx.fillRect(0, y + 8, S, 24);
    }
    for (let bx = 0; bx <= bays; bx++) {
      ctx.fillStyle = 'rgba(26,22,18,.16)'; ctx.fillRect(bx * bw - 1, 0, 2, S);
    }
    // window fields
    const winW = bw * (style === 3 ? 0.9 : style === 1 ? 0.66 : 0.52);
    const winH = fh * (style === 3 ? 0.82 : style === 1 ? 0.4 : 0.52);
    for (let fy = 0; fy < floors; fy++) {
      for (let bx = 0; bx < bays; bx++) {
        const cx = bx * bw + bw / 2, cy = fy * fh + fh * 0.48;
        const x = cx - winW / 2, y = cy - winH / 2;
        const lit = style !== 3 && rr() < 0.035;
        // recess + shadow reveal
        ctx.fillStyle = 'rgba(20,16,13,.5)'; ctx.fillRect(x - 9, y - 9, winW + 18, winH + 18);
        // frame
        ctx.fillStyle = P.frame; ctx.fillRect(x - 5, y - 5, winW + 10, winH + 10);
        // glass
        const gg = ctx.createLinearGradient(x, y, x + winW * 0.5, y + winH);
        gg.addColorStop(0, lit ? '#f6c78c' : P.glass2);
        gg.addColorStop(0.36, lit ? '#c8844e' : P.glass);
        gg.addColorStop(1, lit ? '#4b2e20' : '#1f2b33');
        ctx.fillStyle = gg; ctx.fillRect(x, y, winW, winH);
        // sky reflection sash
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, winW, winH); ctx.clip();
        ctx.fillStyle = `rgba(220,235,244,${lit ? 0.06 : 0.16 + rr() * 0.16})`;
        ctx.beginPath(); ctx.moveTo(x + winW * 0.05, y); ctx.lineTo(x + winW * 0.42, y); ctx.lineTo(x + winW * 0.08, y + winH); ctx.lineTo(x - winW * 0.2, y + winH); ctx.closePath(); ctx.fill();
        if (!lit && rr() > 0.42) {
          // blinds or curtain
          ctx.fillStyle = `rgba(225,218,205,${0.10 + rr() * 0.25})`;
          ctx.fillRect(x + 3, y + 2, winW - 6, winH * (0.15 + rr() * 0.38));
        }
        if (!lit && rr() > 0.88) {
          // a plant / interior lamp silhouette
          ctx.fillStyle = 'rgba(28,34,32,.6)';
          ctx.beginPath(); ctx.arc(x + winW * 0.7, y + winH * 0.72, winH * 0.16, 0, TAU); ctx.fill();
        }
        // mullions
        ctx.fillStyle = P.frame;
        ctx.fillRect(x + winW / 2 - 2, y, 4, winH);
        if (style !== 3) ctx.fillRect(x, y + winH * 0.55, winW, 3);
        // sill + lintel
        ctx.restore();
        ctx.fillStyle = P.trim; ctx.fillRect(x - 12, y + winH + 8, winW + 24, 8);
        ctx.fillStyle = 'rgba(18,14,11,.28)'; ctx.fillRect(x - 12, y + winH + 16, winW + 24, 4);
        // rough map
        rctx.fillStyle = 'rgb(215,215,215)'; rctx.fillRect(x - 10, y - 10, winW + 20, winH + 20);
        rctx.fillStyle = lit ? 'rgb(110,110,110)' : 'rgb(56,56,56)'; rctx.fillRect(x, y, winW, winH);
        // emissive
        if (lit) {
          const eg = ectx.createLinearGradient(x, y, x, y + winH);
          eg.addColorStop(0, 'rgba(255,211,158,.95)'); eg.addColorStop(1, 'rgba(220,150,90,.6)');
          ectx.fillStyle = eg; ectx.fillRect(x, y, winW, winH);
        }
      }
    }
    // --- vertical rain streaks and base grime
    for (let i = 0; i < 110; i++) {
      const x = rr() * S, w = 1 + rr() * 5, y = rr() * S * 0.5, h = 80 + rr() * 500;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, `rgba(30,25,20,${0.02 + rr() * 0.10})`); g.addColorStop(1, 'rgba(30,25,20,0)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    }
    const gr = ctx.createLinearGradient(0, S, 0, S * 0.72);
    gr.addColorStop(0, 'rgba(18,15,12,.62)'); gr.addColorStop(1, 'rgba(18,15,12,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
    // rough streaks
    for (let i = 0; i < 40; i++) {
      const x = rr() * S, y = rr() * S, w = 30 + rr() * 160, h = 100 + rr() * 400;
      const rg = rctx.createLinearGradient(0, y, 0, y + h);
      rg.addColorStop(0, `rgba(255,255,255,${0.03 + rr() * 0.05})`); rg.addColorStop(1, 'rgba(255,255,255,0)');
      rctx.fillStyle = rg; rctx.fillRect(x, y, w, h);
    }
    // normal map derived from facade relief (glass recessed, frames raised)
    const small = makeCanvas(512, 512);
    const sctx = small.getContext('2d'); sctx.drawImage(c, 0, 0, 512, 512);
    const img = sctx.getImageData(0, 0, 512, 512).data;
    const height = new Float32Array(512 * 512);
    for (let i = 0; i < 512 * 512; i++) {
      const l = (img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11) / 255;
      height[i] = l;
    }
    const nrm = heightToNormal(height, 512, 512, 2.0);
    return {
      map: canvasTexture(c, true, 1, 1, 8), rgh: canvasTexture(rc, false, 1, 1, 8),
      emi: canvasTexture(ec, true, 1, 1, 4), nrm: canvasTexture(nrm, false, 1, 1, 8),
    };
  }

  // ---- storefront strip ----
  function makeStorefront(seed) {
    const S = 1024, c = makeCanvas(S, S);
    const ctx = c.getContext('2d');
    const rr = mulberry32(seed);
    ctx.fillStyle = '#3a332c'; ctx.fillRect(0, 0, S, S);
    const cols = 4, cw = S / cols;
    for (let i = 0; i < cols; i++) {
      const x = i * cw + 10, w = cw - 20;
      // glass
      const g = ctx.createLinearGradient(0, 120, 0, 760);
      g.addColorStop(0, '#2d3a42'); g.addColorStop(0.45, '#5e6a6c'); g.addColorStop(1, '#23282a');
      ctx.fillStyle = g; ctx.fillRect(x, 150, w, 520);
      // door
      ctx.fillStyle = '#1b2226'; ctx.fillRect(x + w * 0.36, 260, w * 0.28, 410);
      ctx.strokeStyle = 'rgba(210,200,180,.25)'; ctx.lineWidth = 3; ctx.strokeRect(x + w * 0.36, 260, w * 0.28, 410);
      // interior warm glow
      ctx.fillStyle = `rgba(255,190,110,${0.06 + rr() * 0.16})`; ctx.fillRect(x + 8, 180, w - 16, 380);
      // frame
      ctx.fillStyle = '#241f1b'; ctx.fillRect(x - 12, 120, w + 24, 70);
      ctx.fillStyle = '#8d7a63'; ctx.fillRect(x - 12, 120, w + 24, 8);
      // signage band
      const sign = ['NOODLE HOUSE', 'SUNSET COFFEE', 'ARCADE', 'OPEN 24H', 'PHARMACY', 'RAMEN', 'TAILOR', 'BOOKS'][Math.floor(rr() * 8)];
      ctx.fillStyle = ['#a33b2c', '#2c5b57', '#b58130', '#3b3f5e'][Math.floor(rr() * 4)];
      ctx.fillRect(x, 28, w, 78);
      ctx.fillStyle = 'rgba(255,240,215,.92)';
      ctx.font = `700 ${34}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(sign, x + w / 2, 68);
      // dirt at base
      const dg = ctx.createLinearGradient(0, S, 0, S * 0.86);
      dg.addColorStop(0, 'rgba(15,12,10,.7)'); dg.addColorStop(1, 'rgba(15,12,10,0)');
      ctx.fillStyle = dg; ctx.fillRect(x, 0, w, S);
    }
    return canvasTexture(c, true, 1, 1, 8);
  }

  // ---- sign atlas: 4 x 4 cells ----
  const SIGN_CELLS = [];
  function makeSignAtlas(seed) {
    const S = 1024, c = makeCanvas(S, S), ctx = c.getContext('2d');
    const rr = mulberry32(seed);
    const names = ['SUNSET MOTEL', 'ARANYA', 'KART', 'NIGHT MARKET', 'SUSHI', 'HOTEL', 'BAR', 'PHARMACY',
      'CINEMA', 'PARKING', 'COFFEE', 'OPEN', 'LAUNDRY', 'TAXI', 'NOODLES', 'RECORDS'];
    const colours = [['#d6412f', '#f4e4c8'], ['#1f4f59', '#e9ddc7'], ['#e0a32b', '#1d1712'], ['#272d45', '#f5d9a0'],
      ['#8e2b3a', '#f5e6cc'], ['#2f664c', '#f1e7d2'], ['#b7b0a1', '#241f1a'], ['#15171b', '#f0b04a']];
    ctx.fillStyle = '#101114'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 16; i++) {
      const cx = i % 4, cy = Math.floor(i / 4), w = S / 4, h = S / 4;
      const x = cx * w, y = cy * h;
      const pal = colours[i % colours.length];
      ctx.fillStyle = pal[0]; ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
      // frame
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 3; ctx.strokeRect(x + 16, y + 16, w - 32, h - 32);
      // letters, stacked sometimes
      ctx.fillStyle = pal[1];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const words = names[i].split(' ');
      if (words.length > 1 && i % 3 === 0) {
        ctx.font = '800 34px Helvetica, Arial, sans-serif';
        words.forEach((wd, k) => ctx.fillText(wd, x + w / 2, y + h * (0.36 + k * 0.23)));
      } else {
        ctx.font = `${names[i].length > 8 ? 700 : 800} ${Math.min(40, 300 / names[i].length + 16)}px Helvetica, Arial, sans-serif`;
        ctx.fillText(names[i], x + w / 2, y + h / 2);
      }
      // neon inner line
      ctx.strokeStyle = `rgba(255,220,170,${0.18 + rr() * 0.2})`; ctx.lineWidth = 2;
      ctx.strokeRect(x + 24, y + 24, w - 48, h - 48);
      // grime
      ctx.fillStyle = `rgba(10,10,10,${0.05 + rr() * 0.12})`; ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
      SIGN_CELLS.push([cx / 4, 1 - (cy + 1) / 4, 1 / 4, 1 / 4]);
    }
    return canvasTexture(c, true, 1, 1, 8);
  }

  // ---- foliage card ----
  function makeLeafTexture(seed, palette) {
    const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    const rr = mulberry32(seed);
    const cols = palette;
    // branches
    ctx.strokeStyle = 'rgba(60,48,34,.85)'; ctx.lineCap = 'round';
    for (let b = 0; b < 9; b++) {
      ctx.lineWidth = 2 + rr() * 4;
      ctx.beginPath();
      const x0 = 150 + rr() * 210, y0 = 470;
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + (rr() - 0.5) * 160, 300, x0 + (rr() - 0.5) * 240, 110 + rr() * 80);
      ctx.stroke();
    }
    for (let i = 0; i < 900; i++) {
      const x = 40 + Math.pow(rr(), 0.72) * (S - 80), y = 20 + Math.pow(rr(), 0.9) * (S - 60);
      const d = Math.hypot((x - S / 2) / (S * 0.48), (y - S * 0.45) / (S * 0.52));
      if (d > 1 && rr() > 0.12) continue;
      const r = 5 + rr() * 13;
      const col = cols[Math.floor(rr() * cols.length)];
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.55 + rr() * 0.45;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.5 + rr() * 0.4), rr() * TAU, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return canvasTexture(c, true, 1, 1, 4);
  }

  function makeSmokeTexture() {
    const S = 128, c = makeCanvas(S, S), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(0.45, 'rgba(230,228,222,.32)');
    g.addColorStop(0.75, 'rgba(210,208,202,.08)'); g.addColorStop(1, 'rgba(200,200,200,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return canvasTexture(c, true, 1, 1, 1);
  }

  function makeCrowdTexture() {
    const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1714'; ctx.fillRect(0, 0, S, S);
    const rr = mulberry32(90);
    const skin = ['#c99570', '#8b5f43', '#e0b18f', '#6b4632'];
    const shirts = ['#c94f3d', '#3d7a8c', '#d6b25c', '#4f5b8c', '#d9d3c6', '#7c4a62', '#4c7a54'];
    for (let row = 0; row < 9; row++) {
      for (let i = 0; i < 34; i++) {
        const x = i * (S / 34) + (row % 2) * 6 + rr() * 5;
        const y = row * (S / 9) + 18 + rr() * 8;
        const w = 7 + rr() * 5, h = w * 1.25;
        ctx.fillStyle = shirts[Math.floor(rr() * shirts.length)];
        ctx.beginPath(); ctx.ellipse(x, y + 4, w * 0.7, h * 0.62, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = skin[Math.floor(rr() * skin.length)];
        ctx.beginPath(); ctx.arc(x, y - h * 0.5, w * 0.34, 0, TAU); ctx.fill();
      }
    }
    // darken rows
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return canvasTexture(c, true, 1, 1, 4);
  }

  function makeKartLivery(num, base, accent) {
    const S = 512, c = makeCanvas(S, S), ctx = c.getContext('2d');
    ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(S, 0); ctx.lineTo(S, 120); ctx.lineTo(0, 300); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(10,10,12,.9)';
    ctx.beginPath(); ctx.moveTo(0, S); ctx.lineTo(S, 250); ctx.lineTo(S, S); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f7f1e2';
    ctx.font = '800 190px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), S / 2, 300);
    ctx.fillStyle = 'rgba(255,255,255,.82)';
    ctx.font = '700 26px Helvetica, Arial, sans-serif';
    ctx.fillText('SUNSET DISTRICT', S / 2, 420);
    // grime
    const rr = mulberry32(num * 17 + 3);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(20,16,12,${0.02 + rr() * 0.08})`;
      ctx.fillRect(rr() * S, rr() * S, 1 + rr() * 8, 1 + rr() * 3);
    }
    return canvasTexture(c, true, 1, 1, 4);
  }

  // ---- shared micro-detail maps: flat material families get real relief ----
  function makeDetail(kind, seed) {
    const S = 256, alb = makeCanvas(S, S), rgh = makeCanvas(S, S);
    const a = alb.getContext('2d'), r = rgh.getContext('2d');
    const rr = mulberry32(seed);
    const h = new Float32Array(S * S);
    const n = fbmMaker(8, seed + 3, 4), n2 = noiseMaker(64, seed + 17);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      let val, rough, hv;
      if (kind === 'metal') {
        const brush = Math.sin(v * 280 + n(u * 3, v * 2) * 4) * 0.035;
        val = 0.52 + (n(u * 2, v * 2) - 0.5) * 0.18 + brush + (n2(u * 40, v * 6) - 0.5) * 0.05;
        rough = 0.38 + (n2(u * 22, v * 4) - 0.5) * 0.16 + (n(u, v) - 0.5) * 0.1;
        hv = val;
      } else if (kind === 'concrete') {
        val = 0.58 + (n(u * 3, v * 3) - 0.5) * 0.18 + (n2(u * 18, v * 18) - 0.5) * 0.06;
        rough = 0.78 + (n2(u * 16, v * 16) - 0.5) * 0.12;
        hv = val + (n2(u * 8, v * 8) - 0.5) * 0.25;
      } else if (kind === 'wood') {
        val = 0.55 + Math.sin(u * 70 + n(u * 2, v * 7) * 9) * 0.08 + (n2(u * 8, v * 28) - 0.5) * 0.10;
        rough = 0.7 + (n2(u * 6, v * 38) - 0.5) * 0.12;
        hv = val;
      } else if (kind === 'roof') {
        val = 0.42 + (n2(u * 26, v * 26) - 0.5) * 0.22;
        rough = 0.9 + (n2(u * 20, v * 20) - 0.5) * 0.08;
        hv = val + (n2(u * 40, v * 40) - 0.5) * 0.4;
      } else if (kind === 'rubber') {
        val = 0.16 + (n2(u * 40, v * 40) - 0.5) * 0.05;
        rough = 0.82 + (n2(u * 30, v * 30) - 0.5) * 0.1;
        hv = n2(u * 50, v * 50);
      } else if (kind === 'cloth') {
        val = 0.82 + Math.sin(u * 90) * Math.sin(v * 90) * 0.035 + (n2(u * 8, v * 8) - 0.5) * 0.04;
        rough = 0.86;
        hv = val + Math.sin(u * 90) * 0.15;
      } else if (kind === 'water') {
        val = 0.5; rough = 0.04;
        hv = Math.sin(u * 18 + v * 9) * 0.25 + Math.sin(v * 31 + u * 6) * 0.15 + n(u * 3, v * 3) * 0.4;
      } else {
        val = 0.55 + (n(u * 4, v * 4) - 0.5) * 0.1; rough = 0.62; hv = val;
      }
      const p = (y * S + x) * 4;
      const g = clamp(val, 0, 1) * 255;
      a.fillStyle = `rgb(${g},${g},${g})`; a.fillRect(x, y, 1, 1);
      const rg = clamp(rough, 0, 1) * 255;
      r.fillStyle = `rgb(${rg},${rg},${rg})`; r.fillRect(x, y, 1, 1);
      h[y * S + x] = hv;
    }
    return {
      alb: canvasTexture(alb, true, 1, 1, 4),
      rgh: canvasTexture(rgh, false, 1, 1, 4),
      nrm: canvasTexture(heightToNormal(h, S, S, 1.8), false, 1, 1, 4),
    };
  }
  const DETAILS = {
    metal: makeDetail('metal', 311), concrete: makeDetail('concrete', 523), wood: makeDetail('wood', 731),
    roof: makeDetail('roof', 941), rubber: makeDetail('rubber', 1151), cloth: makeDetail('cloth', 1361),
    water: makeDetail('water', 1571), paint: makeDetail('paint', 1771),
  };
  G.DETAILS = DETAILS;

  const TEX = G.TEX = {
    asphalt: makeAsphalt(),
    paving: makePaving(7),
    paving2: makePaving(19),
    facades: [0, 1, 2, 3].map((s) => makeFacade(s, 100 + s * 31)),
    storefront: makeStorefront(55),
    signs: makeSignAtlas(77),
    leafA: makeLeafTexture(3, ['#7d8a45', '#95a253', '#b3b96a', '#5e7038', '#c8bd6a']),
    leafB: makeLeafTexture(8, ['#4f6b3b', '#6f8a49', '#8da45d', '#3d5730', '#a8b370']),
    smoke: makeSmokeTexture(),
    crowd: makeCrowdTexture(),
  };

  // ---------------------------------------------------------------- sky
  const SUN_DIR = new THREE.Vector3(-0.105, 0.282, -0.954).normalize();
  G.SUN_DIR = SUN_DIR;
  const skyUniforms = {
    uSun: { value: SUN_DIR },
    uTime: { value: 0 },
    uFog: { value: new THREE.Color(0xc79a72) },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision highp float;
      uniform vec3 uSun; uniform float uTime; uniform vec3 uFog;
      varying vec3 vDir;
      float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      float fbm(vec2 p){
        float s=0.0, a=0.5;
        mat2 rot=mat2(0.8,0.6,-0.6,0.8);
        for(int i=0;i<5;i++){ s+=a*vnoise(p); p=rot*p*2.03; a*=0.5; }
        return s;
      }
      vec3 skyColor(vec3 d){
        float h = d.y;
        vec3 zenith = vec3(0.075,0.175,0.34);
        vec3 upper  = vec3(0.38,0.46,0.55);
        vec3 horizon= vec3(0.94,0.55,0.34);
        float t = pow(clamp(h,0.0,1.0), 0.52);
        vec3 col = mix(horizon, upper, smoothstep(0.0,0.34,t));
        col = mix(col, zenith, smoothstep(0.28,1.0,t));
        // warm horizon haze / pollution band
        col = mix(col, vec3(0.98,0.68,0.46), exp(-max(h,0.0)*11.0)*0.55);
        float mu = max(dot(d, uSun), 0.0);
        // forward scattering glow
        col += vec3(1.0,0.60,0.28) * pow(mu, 22.0) * 0.55;
        col += vec3(1.0,0.78,0.52) * pow(mu, 260.0) * 2.4;
        col += vec3(6.0,4.2,2.4) * smoothstep(0.99955, 0.99992, mu);
        // clouds on a warped directional deck
        if (h > -0.015) {
          vec2 p = d.xz * (2.55/(0.18 + 0.82*max(h,0.0)));
          p = p*1.25 + vec2(uTime*0.004, uTime*0.0016);
          vec2 q = vec2(fbm(p*0.55+3.1), fbm(p*0.55+11.7));
          float n = fbm(p + (q-0.5)*2.2);
          float cover = smoothstep(0.47, 0.62, n) * smoothstep(0.0, 0.09, h) * (1.0 - smoothstep(0.58, 0.94, h));
          float edge = smoothstep(0.46,0.54,n) - smoothstep(0.54,0.64,n);
          vec3 lit = mix(vec3(0.34,0.33,0.37), vec3(2.15,1.20,0.72), pow(mu,2.0));
          lit += vec3(1.4,0.55,0.20) * pow(mu,9.0) * 0.5;
          col = mix(col, lit, cover*0.82);
          col += vec3(1.0,0.55,0.25) * edge * pow(mu,6.0) * 0.35;
        }
        // below-horizon fade into fog so there is no cut-out edge
        col = mix(col, uFog, smoothstep(0.015,-0.09,h)*0.85);
        return col;
      }
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = skyColor(d);
        col = max(col, 0.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 32), skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  skyMesh.name = 'sky-dome';
  skyMesh.userData.passable = true;
  skyMesh.userData.surfaceProcedural = true; // procedural sky shader

  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(skyMesh.geometry, skyMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromScene(envScene, 0.04, 1, 3000);
  const envMap = envRT.texture;

  // ---------------------------------------------------------------- scene
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xb0a495, 0.00102);
  scene.environment = envMap;
  scene.environmentIntensity = 1.02;
  scene.add(skyMesh);
  G.scene = scene;

  const sun = new THREE.DirectionalLight(0xffd0a0, 3.65);
  sun.position.copy(SUN_DIR).multiplyScalar(160);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QS.shadow, QS.shadow);
  sun.shadow.camera.left = -72; sun.shadow.camera.right = 72;
  sun.shadow.camera.top = 72; sun.shadow.camera.bottom = -72;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.035;
  sun.target.position.set(0, 0, 0);
  scene.add(sun); scene.add(sun.target);
  G.sun = sun;

  const hemi = new THREE.HemisphereLight(0x93aac9, 0x45382c, 0.68);
  scene.add(hemi);
  const fill = new THREE.AmbientLight(0x7f8fa6, 0.10);
  scene.add(fill);
  // cool sky bounce from the camera side: reads the kart's back and the shopfronts
  const bounce = new THREE.DirectionalLight(0x9fb8d8, 0.62);
  bounce.position.set(-40, 70, 160);
  bounce.target.position.set(40, 0, -40);
  scene.add(bounce); scene.add(bounce.target);
  G.bounce = bounce;

  // ---------------------------------------------------------------- post chain
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(quadGeo, null);
  postQuad.frustumCulled = false;
  postScene.add(postQuad);
  const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  const brightMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uThreshold: { value: 1.22 } },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uThreshold;
      void main(){
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.2126,0.7152,0.0722));
        float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
        gl_FragColor = vec4(c*k, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) } },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel;
      void main(){
        vec2 o = uDir * uTexel;
        vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
        c += (texture2D(tDiffuse, vUv + o*1.3846).rgb + texture2D(tDiffuse, vUv - o*1.3846).rgb) * 0.3162162;
        c += (texture2D(tDiffuse, vUv + o*3.2308).rgb + texture2D(tDiffuse, vUv - o*3.2308).rgb) * 0.0702703;
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const compMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tBloom: { value: null },
      uExposure: { value: 1.08 }, uBloom: { value: 0.55 }, uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) }, uVignette: { value: 0.38 },
    },
    vertexShader: VERT,
    fragmentShader: `varying vec2 vUv;
      uniform sampler2D tScene; uniform sampler2D tBloom;
      uniform float uExposure; uniform float uBloom; uniform float uTime; uniform float uVignette;
      uniform vec2 uRes;
      vec3 aces(vec3 x){
        x = x * 0.92;
        return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
      }
      float hash(vec2 p){ p=fract(p*vec2(443.897,441.423)); p+=dot(p,p+19.19); return fract(p.x*p.y); }
      float luma3(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
      vec3 fxaaSample(vec2 uv, vec2 rcp){
        vec3 rgbNW = texture2D(tScene, uv + vec2(-1.0,-1.0)*rcp).rgb;
        vec3 rgbNE = texture2D(tScene, uv + vec2( 1.0,-1.0)*rcp).rgb;
        vec3 rgbSW = texture2D(tScene, uv + vec2(-1.0, 1.0)*rcp).rgb;
        vec3 rgbSE = texture2D(tScene, uv + vec2( 1.0, 1.0)*rcp).rgb;
        vec3 rgbM  = texture2D(tScene, uv).rgb;
        float lNW = luma3(rgbNW), lNE = luma3(rgbNE), lSW = luma3(rgbSW), lSE = luma3(rgbSE), lM = luma3(rgbM);
        float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
        float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
        if (lMax - lMin < max(0.035, lMax * 0.145)) return rgbM;
        vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
        float reduce = max((lNW+lNE+lSW+lSE) * 0.03, 1.0/128.0);
        float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
        dir = clamp(dir * rcpMin, vec2(-6.0), vec2(6.0)) * rcp;
        vec3 rgbA = 0.5 * (texture2D(tScene, uv + dir * (1.0/3.0 - 0.5)).rgb + texture2D(tScene, uv + dir * (2.0/3.0 - 0.5)).rgb);
        vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tScene, uv + dir * -0.5).rgb + texture2D(tScene, uv + dir * 0.5).rgb);
        float lB = luma3(rgbB);
        return (lB < lMin || lB > lMax) ? rgbA : rgbB;
      }
      void main(){
        vec2 uv = vUv;
        vec2 d = uv - 0.5;
        float r2 = dot(d,d);
        vec3 col = fxaaSample(uv, 1.0 / uRes);
        // extremely slight chromatic aberration at the far corners
        vec2 ca = d * (0.00045 * r2 * 2.0);
        col.r = mix(col.r, texture2D(tScene, uv + ca).r, 0.55);
        col.b = mix(col.b, texture2D(tScene, uv - ca).b, 0.55);
        vec3 bloom = texture2D(tBloom, uv).rgb;
        col += bloom * uBloom;
        col *= uExposure;
        col = aces(col);
        col = clamp((col - 0.5) * 1.055 + 0.5 + vec3(0.006, 0.002, -0.004), 0.0, 1.0);
        // split tone: cool shadows, warm highlights
        float l = dot(col, vec3(0.299,0.587,0.114));
        col = mix(vec3(l), col, 1.04);
        col *= mix(vec3(0.94,0.985,1.055), vec3(1.045,1.005,0.955), smoothstep(0.10,0.72,l));
        col = mix(vec3(dot(col, vec3(0.299,0.587,0.114))), col, 0.64);
        // never crush the last few code values: keep detail in the shadows
        float lowMask = 1.0 - smoothstep(0.015, 0.16, l);
        col += vec3(0.0036, 0.0034, 0.0032) * lowMask;
        // vignette
        float vig = smoothstep(0.98, 0.28, length(d*vec2(1.05,0.92))*1.22);
        col *= mix(1.0, 0.70, (1.0-vig)*uVignette);
        // film grain + dither
        float g = hash(uv*uRes + fract(uTime)*137.0) - 0.5;
        col += g * 0.008;
        col += (hash(uv*uRes+9.1)-0.5) / 255.0;
        col = max(col, 0.0);
        col = pow(col, vec3(1.0/2.2));
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  postQuad.material = compMat;

  let rtScene = null, rtBright = null, rtBlurA = null, rtBlurB = null;
  let rtRefl = null;
  let VW = 1, VH = 1, PR = 1;
  const reflCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.15, 2600);
  const reflUniforms = {
    tRefl: { value: null }, uOn: { value: 1 }, uScreen: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
  };
  G.reflUniforms = reflUniforms;
  G.reflReady = false;
  function makeTargets() {
    const w = Math.max(2, Math.floor(VW * PR)), h = Math.max(2, Math.floor(VH * PR));
    rtScene?.dispose(); rtBright?.dispose(); rtBlurA?.dispose(); rtBlurB?.dispose();
    rtScene = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      stencilBuffer: false, samples: QS.samples, colorSpace: THREE.LinearSRGBColorSpace,
    });
    rtRefl?.dispose();
    rtRefl = new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w * 0.5)), Math.max(2, Math.floor(h * 0.5)), {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      stencilBuffer: false, samples: 0, colorSpace: THREE.LinearSRGBColorSpace,
    });
    reflUniforms.tRefl.value = rtRefl.texture;
    reflUniforms.uScreen.value.set(w, h);
    G.reflReady = true;
    const bw = Math.max(2, Math.floor(w / 2)), bh = Math.max(2, Math.floor(h / 2));
    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, colorSpace: THREE.LinearSRGBColorSpace };
    rtBright = new THREE.WebGLRenderTarget(bw, bh, opts);
    rtBlurA = new THREE.WebGLRenderTarget(bw, bh, opts);
    rtBlurB = new THREE.WebGLRenderTarget(bw, bh, opts);
    blurMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    compMat.uniforms.uRes.value.set(w, h);
  }
  function resize() {
    VW = Math.max(320, window.innerWidth);
    VH = Math.max(240, window.innerHeight);
    PR = Math.min(QS.dpr, window.devicePixelRatio || 1);
    if (VW * PR > 2600) PR = 2600 / VW;
    renderer.setPixelRatio(1);
    renderer.setSize(VW, VH, false);
    canvas.style.width = VW + 'px'; canvas.style.height = VH + 'px';
    // custom targets are sized in physical pixels; the renderer viewport must match
    renderer.setPixelRatio(PR);
    renderer.setSize(VW, VH, false);
    makeTargets();
    camera.aspect = VW / VH;
    camera.updateProjectionMatrix();
  }
  const camera = new THREE.PerspectiveCamera(64, 16 / 9, 0.15, 2600);
  camera.position.set(0, 3, 44);
  G.camera = camera;
  resize();

  function renderReflection() {
    if (!rtRefl || QS.refl <= 0) { reflUniforms.uOn.value = 0; return; }
    const noRefl = G.world && G.world.noReflect ? G.world.noReflect : [];
    for (const o of noRefl) if (o) o.visible = false;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const pos = camera.position;
    reflCam.fov = camera.fov; reflCam.aspect = camera.aspect;
    reflCam.near = camera.near; reflCam.far = camera.far;
    reflCam.position.set(pos.x, -pos.y, pos.z);
    reflCam.up.set(camera.up.x, -camera.up.y, camera.up.z);
    reflCam.lookAt(pos.x + dir.x, -pos.y + (-dir.y), pos.z + dir.z);
    reflCam.updateProjectionMatrix();
    reflCam.updateMatrixWorld(true);
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(rtRefl);
    renderer.clear();
    renderer.render(scene, reflCam);
    renderer.shadowMap.autoUpdate = true;
    for (const o of noRefl) if (o) o.visible = true;
    reflUniforms.uOn.value = 1;
    reflUniforms.uTime.value = clockTime;
  }
  function renderPost(dt) {
    renderReflection();
    renderer.info.reset();
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(scene, camera);
    const stats = renderer.info.render;
    let calls = stats.calls, tris = stats.triangles;
    if (QS.bloom) {
      // bright pass
      postQuad.material = brightMat;
      brightMat.uniforms.tDiffuse.value = rtScene.texture;
      renderer.setRenderTarget(rtBright);
      renderer.render(postScene, postCamera);
      // blur H
      postQuad.material = blurMat;
      blurMat.uniforms.tDiffuse.value = rtBright.texture;
      blurMat.uniforms.uDir.value.set(1, 0);
      renderer.setRenderTarget(rtBlurA);
      renderer.render(postScene, postCamera);
      // blur V
      blurMat.uniforms.tDiffuse.value = rtBlurA.texture;
      blurMat.uniforms.uDir.value.set(0, 1);
      renderer.setRenderTarget(rtBlurB);
      renderer.render(postScene, postCamera);
      compMat.uniforms.tBloom.value = rtBlurB.texture;
      compMat.uniforms.uBloom.value = 0.40;
    } else {
      compMat.uniforms.tBloom.value = rtBright?.texture || null;
      compMat.uniforms.uBloom.value = 0.0;
    }
    compMat.uniforms.tScene.value = rtScene.texture;
    compMat.uniforms.uTime.value = clockTime;
    postQuad.material = compMat;
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
    return { calls, tris };
  }
  G.renderPost = renderPost;
  G.resize = resize;
  G.setQuality = function (name) {
    if (!QUALITY[name]) return;
    qualityName = name; QS = QUALITY[name];
    sun.shadow.mapSize.set(QS.shadow, QS.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    scene.environmentIntensity = QS.env;
    resize();
  };
  G.post = { compMat, brightMat, blurMat, bright: () => bloomThreshold() };
  function bloomThreshold() { return brightMat.uniforms.uThreshold.value; }

  // clock/time are available to the whole build
  let clockTime = 0;
  G.now = () => clockTime;
  G.setTime = (t) => { clockTime = t; };
  G.skyUniforms = skyUniforms;
  G.envMap = envMap;
  G.QUALITY = QUALITY;
  G.QS = () => QS;

  // ---------------------------------------------------------------- shared materials
  const M = G.M = {};
  M.asphalt = new THREE.MeshPhysicalMaterial({
    map: TEX.asphalt.alb, roughnessMap: TEX.asphalt.rgh, normalMap: TEX.asphalt.nrm,
    normalScale: new THREE.Vector2(0.14, 0.14), roughness: 0.66, metalness: 0.04,
    color: 0x989288, envMapIntensity: 1.55, clearcoat: 0.28, clearcoatRoughness: 0.14,
  });
  M.asphalt.name = 'wet-asphalt';
  M.asphalt.onBeforeCompile = (shader) => {
    shader.uniforms.tRefl = reflUniforms.tRefl;
    shader.uniforms.uReflOn = reflUniforms.uOn;
    shader.uniforms.uReflScreen = reflUniforms.uScreen;
    shader.uniforms.uReflTime = reflUniforms.uTime;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
      '#include <common>\nuniform sampler2D tRefl;\nuniform float uReflOn;\nuniform vec2 uReflScreen;\nuniform float uReflTime;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `
      if (uReflOn > 0.5) {
        vec2 suv = gl_FragCoord.xy / uReflScreen;
        // small ripple, strongest in the running-together wet patches
        vec2 rip = vec2(sin(suv.y*420.0 + uReflTime*1.3), cos(suv.x*380.0 - uReflTime*0.9)) * 0.0011;
        vec3 refl = texture2D(tRefl, suv + rip).rgb;
        float ndv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 2.6);
        float wet = smoothstep(0.44, 0.08, roughnessFactor);
        vec2 bo = vec2(0.0022, 0.0028) * (0.5 + wet);
        vec3 refl2 = texture2D(tRefl, suv + rip + bo).rgb + texture2D(tRefl, suv + rip - bo).rgb;
        refl2 += texture2D(tRefl, suv + rip + vec2(bo.x, -bo.y)).rgb + texture2D(tRefl, suv + rip - vec2(bo.x, -bo.y)).rgb;
        refl = mix(refl, refl2 * 0.25, 0.75);
        float amount = clamp((0.07 + wet * 0.62) * fres * 1.55, 0.0, 0.52);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, refl * 0.98, amount);
      }
      #include <dithering_fragment>`);
  };
  M.asphalt.customProgramCacheKey = () => 'sd-asphalt-refl-1';
  M.asphalt.userData.surfaceProcedural = true;
  M.sidewalk = new THREE.MeshStandardMaterial({
    map: TEX.paving.alb, roughnessMap: TEX.paving.rgh, color: 0xc8c2b6, roughness: 1.0, envMapIntensity: 0.75,
  });
  M.sidewalk.name = 'paving';
  M.sidewalk.userData.surfaceProcedural = true;
  M.curb = new THREE.MeshStandardMaterial({ color: 0xb6aea2, roughness: 0.72, metalness: 0.02, envMapIntensity: 0.7 });
  M.curb.userData.surfaceProcedural = true;
  M.paint = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.45, metalness: 0.0, envMapIntensity: 0.9 });
  M.paintRed = new THREE.MeshStandardMaterial({ color: 0xc94c3a, roughness: 0.5, envMapIntensity: 0.9 });
  M.metal = new THREE.MeshStandardMaterial({ color: 0x62666b, roughness: 0.4, metalness: 0.85, envMapIntensity: 1.1 });
  M.darkMetal = new THREE.MeshStandardMaterial({ color: 0x2b2e32, roughness: 0.48, metalness: 0.7, envMapIntensity: 1.0 });
  M.concrete = new THREE.MeshStandardMaterial({ color: 0x8d877e, roughness: 0.82, metalness: 0.02, envMapIntensity: 0.7 });
  M.concrete.userData.surfaceProcedural = true;
  M.glass = new THREE.MeshStandardMaterial({ color: 0x6f8493, roughness: 0.12, metalness: 0.55, envMapIntensity: 1.4 });
  M.rubber = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.86, metalness: 0.02 });
  M.wood = new THREE.MeshStandardMaterial({ color: 0x6a4f37, roughness: 0.72 });
  M.orange = new THREE.MeshStandardMaterial({ color: 0xd95d22, roughness: 0.5, emissive: 0x984010, emissiveIntensity: 0.5 });
  M.white = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.55 });
  M.foliageA = new THREE.MeshStandardMaterial({
    map: TEX.leafA, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.9,
    color: 0x9aa47c, envMapIntensity: 0.4, transparent: false,
  });
  M.foliageB = new THREE.MeshStandardMaterial({
    map: TEX.leafB, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.92,
    color: 0x8f9a74, envMapIntensity: 0.4,
  });
  M.leafA = M.foliageA; M.leafB = M.foliageB;
  M.sign = new THREE.MeshStandardMaterial({
    map: TEX.signs, emissiveMap: TEX.signs, emissive: 0xffffff, emissiveIntensity: 0.34,
    roughness: 0.52, metalness: 0.05, side: THREE.FrontSide,
  });
  M.storefront = new THREE.MeshStandardMaterial({
    map: TEX.storefront, emissiveMap: TEX.storefront, emissive: 0xffb066, emissiveIntensity: 0.10,
    roughness: 0.42, metalness: 0.12, envMapIntensity: 1.0,
  });
  M.storefront.userData.surfaceProcedural = true;
  M.roof = new THREE.MeshStandardMaterial({ color: 0x6b675f, roughness: 0.94, metalness: 0.02 });
  M.roof.userData.surfaceProcedural = true;

  // give the flat material families measurable albedo / roughness / normal variation
  function detailize(mat, d, opts = {}) {
    if (!mat) return;
    if (opts.alb !== false) { mat.map = d.alb; mat.color.multiplyScalar(opts.tint ?? 1.0); }
    mat.roughnessMap = d.rgh;
    mat.normalMap = d.nrm;
    mat.normalScale = new THREE.Vector2(opts.ns ?? 0.35, opts.ns ?? 0.35);
    mat.needsUpdate = true;
  }
  detailize(M.metal, DETAILS.metal, { tint: 0.85, ns: 0.25 });
  detailize(M.darkMetal, DETAILS.metal, { tint: 0.7, ns: 0.3 });
  detailize(M.concrete, DETAILS.concrete, { tint: 0.95, ns: 0.3 });
  detailize(M.curb, DETAILS.concrete, { tint: 0.95, ns: 0.25 });
  detailize(M.roof, DETAILS.roof, { tint: 0.9, ns: 0.35 });
  detailize(M.wood, DETAILS.wood, { tint: 0.95, ns: 0.25 });
  detailize(M.rubber, DETAILS.rubber, { tint: 0.75, ns: 0.3 });
  detailize(M.orange, DETAILS.paint, { tint: 1.0, ns: 0.2 });
  detailize(M.paint, DETAILS.paint, { tint: 1.0, ns: 0.12 });
  detailize(M.paintRed, DETAILS.paint, { tint: 1.0, ns: 0.12 });

  // ---------------------------------------------------------------- geometry helpers
  function mergeGeoms(list, opts = {}) {
    const pos = [], nor = [], uv = [], col = [];
    const tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const it of list) {
      let g = it.geometry || it.g;
      if (!g) continue;
      if (g.index) g = g.toNonIndexed();
      const m = it.matrix || it.m || new THREE.Matrix4();
      nm.getNormalMatrix(m);
      const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
      const c = it.color ? new THREE.Color(it.color) : null;
      for (let i = 0; i < p.count; i++) {
        tmpV.fromBufferAttribute(p, i).applyMatrix4(m);
        pos.push(tmpV.x, tmpV.y, tmpV.z);
        if (n) { tmpN.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor.push(tmpN.x, tmpN.y, tmpN.z); }
        else nor.push(0, 1, 0);
        if (u) uv.push(u.getX(i), u.getY(i)); else uv.push(0, 0);
        if (c) col.push(c.r, c.g, c.b); else col.push(1, 1, 1);
      }
      if (g !== it.geometry && g !== it.g) g.dispose?.();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (opts.vertexColors || col.some((v) => v !== 1)) out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.computeBoundingSphere(); out.computeBoundingBox();
    return out;
  }
  G.mergeGeoms = mergeGeoms;

  // Custom box with UVs in world-metre units (so facade tiles stay square).
  function boxGeo(w, h, d, uScale = 1, vScale = 1, faceUV = true) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (faceUV) {
      const uv = g.attributes.uv;
      // BoxGeometry face order: +x, -x, +y, -y, +z, -z — 4 verts each
      const scales = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) {
        for (let i = 0; i < 4; i++) {
          const idx = f * 4 + i;
          uv.setXY(idx, uv.getX(idx) * scales[f][0] / uScale, uv.getY(idx) * scales[f][1] / vScale);
        }
      }
      uv.needsUpdate = true;
    }
    return g;
  }
  G.boxGeo = boxGeo;

  function M4(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
    return m;
  }
  G.M4 = M4;

  G.util = { clamp, lerp, smoothstep, damp, approach, wrapAngle, fmtTime, R, RI, pick };
})();
