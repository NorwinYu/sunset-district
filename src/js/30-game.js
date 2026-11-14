/* ================= GAME: race director, physics, AI, camera, shell ================= */
(function () {
  const G = window.__G, THREE = G.THREE;
  const { clamp, lerp, smoothstep, damp, approach, wrapAngle, fmtTime, R } = G.util;
  const track = G.track, world = G.world, M = G.M, TEX = G.TEX;
  const LAP = track.LAP, N = track.N;
  const $ = (id) => document.getElementById(id);
  const el = {
    hud: $('hud'), start: $('start'), pause: $('pause'), settings: $('settings'), end: $('end'),
    touch: $('touch'), loading: $('loading'), loadFill: $('load-fill'), loadText: $('load-text'),
    objective: $('objective'), lap: $('lap'), beatDots: $('beat-dots'), pos: $('pos'), posOf: $('pos-of'),
    raceTime: $('race-time'), lastLap: $('last-lap'), bestLap: $('best-lap'), speed: $('speed'),
    gear: $('gear'), rpmFill: $('rpm-fill'), nitroFill: $('nitro-fill'), nitroNum: $('nitro-num'),
    damageFill: $('damage-fill'), damageNum: $('damage-num'), subtitle: $('subtitle'),
    subtitleText: $('subtitle-text'), subtitleKicker: $('subtitle-kicker'), prompt: $('prompt'),
    raceMsg: $('race-msg'), lapBanner: $('lap-banner'), minimap: $('minimap'),
    compassArrow: $('compass-arrow'), compassText: $('compass-text'),
    titleBest: $('title-best'), titlePodium: $('title-podium'), gridList: $('grid-list'),
    pPos: $('p-pos'), pLap: $('p-lap'), pTime: $('p-time'), pDmg: $('p-dmg'),
    endKicker: $('end-kicker'), endTitle: $('end-title'), endCause: $('end-cause'),
    ePos: $('e-pos'), eTime: $('e-time'), eBest: $('e-best'), eTop: $('e-top'), endFlag: $('end-flag'),
    titleMute: $('title-mute'),
  };

  // ------------------------------------------------------------------ persistence
  const KEY_BEST = 'sunsetdistrict.best';
  const KEY_SET = 'sunsetdistrict.settings';
  function readJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; }
    catch (e) { return fallback; }
  }
  const best = Object.assign({ bestLap: null, bestPosition: null, wins: 0, last: '—' }, readJSON(KEY_BEST, {}));
  const settings = Object.assign({
    sensitivity: 1.0, volume: 0.7, fov: 64, invertY: false, quality: 'high', mute: false,
  }, readJSON(KEY_SET, {}));
  function saveBest() {
    try { localStorage.setItem(KEY_BEST, JSON.stringify(best)); } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem(KEY_SET, JSON.stringify(settings)); } catch (e) {}
  }
  function saveAll() { saveBest(); saveSettings(); }
  function applyQuality(name) {
    if (!G.QUALITY[name]) return;
    settings.quality = name;
    G.setQuality(name);
    const s = G.QS();
    G.scene.environmentIntensity = s.env;
    saveSettings();
  }
  G.setQuality = G.setQuality || function () {};

  // ------------------------------------------------------------------ audio
  class AudioRig {
    constructor() {
      this.ctx = null; this.master = null; this.engineGain = null; this.engineFilter = null;
      this.engineA = null; this.engineB = null; this.screechGain = null; this.windGain = null;
      this.volume = settings.volume; this.muted = settings.mute;
      this.active = false; this.ready = false;
    }
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        const ctx = new AC();
        this.ctx = ctx;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 14; comp.ratio.value = 5;
        comp.attack.value = 0.004; comp.release.value = 0.22;
        this.master = ctx.createGain();
        this.master.gain.value = 0;
        comp.connect(this.master).connect(ctx.destination);
        this.bus = ctx.createGain(); this.bus.connect(comp);
        // shared noise
        const len = ctx.sampleRate * 2;
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = buf;
        // engine
        this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
        this.engineFilter = ctx.createBiquadFilter(); this.engineFilter.type = 'lowpass';
        this.engineFilter.frequency.value = 480; this.engineFilter.Q.value = 1.3;
        this.engineA = ctx.createOscillator(); this.engineA.type = 'sawtooth'; this.engineA.frequency.value = 62;
        this.engineB = ctx.createOscillator(); this.engineB.type = 'square'; this.engineB.frequency.value = 31;
        const gA = ctx.createGain(); gA.gain.value = 0.5;
        const gB = ctx.createGain(); gB.gain.value = 0.22;
        this.engineA.connect(gA).connect(this.engineFilter);
        this.engineB.connect(gB).connect(this.engineFilter);
        this.engineFilter.connect(this.engineGain).connect(this.bus);
        this.engineA.start(); this.engineB.start();
        // wind
        const wind = ctx.createBufferSource(); wind.buffer = buf; wind.loop = true;
        const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 520; wf.Q.value = 0.5;
        this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
        wind.connect(wf).connect(this.windGain).connect(this.bus); wind.start();
        // tyre screech
        const scr = ctx.createBufferSource(); scr.buffer = buf; scr.loop = true;
        const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 2100; sf.Q.value = 5.5;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
        this.screechGain = ctx.createGain(); this.screechGain.gain.value = 0;
        scr.connect(sf).connect(hp).connect(this.screechGain).connect(this.bus); scr.start();
        // crowd murmur
        const crowd = ctx.createBufferSource(); crowd.buffer = buf; crowd.loop = true;
        const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 360; cf.Q.value = 0.8;
        this.crowdGain = ctx.createGain(); this.crowdGain.gain.value = 0;
        crowd.connect(cf).connect(this.crowdGain).connect(this.bus); crowd.start();
        this.ready = true;
        this.applyMaster();
      } catch (e) { this.ready = false; }
    }
    applyMaster() {
      if (!this.ctx) return;
      const g = this.muted ? 0 : this.volume;
      this.master.gain.setTargetAtTime(g * 0.9, this.ctx.currentTime, 0.08);
    }
    setVolume(v) { this.volume = v; if (this.ready) this.applyMaster(); }
    setMuted(m) { this.muted = m; if (this.ready) this.applyMaster(); }
    setRaceActive(on) {
      this.active = on;
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      this.engineGain.gain.setTargetAtTime(on ? 0.055 : 0, t, 0.25);
      this.crowdGain.gain.setTargetAtTime(on ? 0.012 : 0.004, t, 0.6);
    }
    updateEngine(speed, throttle, drifting, slip, boosting) {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      const s = Math.min(46, Math.abs(speed));
      const f = 48 + s * 4.6 + Math.max(0, throttle) * 16 + (boosting ? 32 : 0);
      this.engineA.frequency.setTargetAtTime(f, t, 0.05);
      this.engineB.frequency.setTargetAtTime(f * 0.5, t, 0.06);
      this.engineFilter.frequency.setTargetAtTime(420 + s * 42 + (boosting ? 900 : 0), t, 0.1);
      this.engineGain.gain.setTargetAtTime(this.active ? 0.045 + throttle * 0.028 : 0, t, 0.12);
      this.screechGain.gain.setTargetAtTime(this.active ? clamp((drifting ? 0.075 : 0) + Math.abs(slip) * 0.006, 0, 0.12) : 0, t, 0.08);
      this.windGain.gain.setTargetAtTime(this.active ? clamp(s / 42, 0, 1) * 0.036 : 0, t, 0.2);
    }
    tone(freq, dur, type = 'sine', gain = 0.15, when = 0, glide = 0) {
      if (!this.ready) return;
      const ctx = this.ctx, t0 = ctx.currentTime + when;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t0);
      if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(this.bus); o.start(t0); o.stop(t0 + dur + 0.03);
    }
    noiseBurst(dur = 0.2, freq = 900, gain = 0.16, q = 1, type = 'bandpass') {
      if (!this.ready) return;
      const ctx = this.ctx, t0 = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f).connect(g).connect(this.bus); src.start(t0); src.stop(t0 + dur + 0.02);
    }
    click() { this.tone(520, 0.06, 'triangle', 0.05); }
    count(n) { this.tone(n === 0 ? 880 : 440, n === 0 ? 0.7 : 0.16, 'square', n === 0 ? 0.14 : 0.09); if (n === 0) this.tone(1320, 0.5, 'sine', 0.08, 0.02); }
    lap() { this.tone(660, 0.12, 'triangle', 0.1); this.tone(990, 0.2, 'sine', 0.08, 0.11); }
    boost() { this.noiseBurst(0.5, 1400, 0.16, 0.7); this.tone(180, 0.4, 'sawtooth', 0.05, 0, 2.4); }
    pad() { this.tone(1180, 0.14, 'sine', 0.09, 0, 1.6); this.tone(1560, 0.18, 'triangle', 0.05, 0.06); }
    impact(strength = 1) { this.noiseBurst(0.22, 220, clamp(strength * 0.3, 0.04, 0.2), 1.2, 'lowpass'); this.tone(70, 0.24, 'sine', clamp(strength * 0.05, 0.02, 0.16), 0, 0.7); }
    warn() { this.tone(240, 0.18, 'square', 0.07); }
    win() { [523, 659, 784, 1047].forEach((n, i) => this.tone(n, 0.45, 'triangle', 0.11, i * 0.13)); }
    lose() { [330, 294, 247, 196].forEach((n, i) => this.tone(n, 0.5, 'sawtooth', 0.06, i * 0.16)); }
  }
  const audio = new AudioRig();
  audio.setMuted(settings.mute); audio.setVolume(settings.volume);

  // ------------------------------------------------------------------ race state
  const state = {
    phase: 'menu', prevPhase: 'menu', countdown: 0, raceTime: 0, limit: 240,
    laps: 4, lapsDone: 0, lapStart: 0, started: false, position: 6,
    health: 100, nitro: 100, speed: 0, failed: false, won: false, cause: '',
    lastLap: null, bestLap: best.bestLap || null, topSpeed: 0, result: '—',
    beatsDone: 0, finalShown: false, warningDone: false, contactDone: false,
    cameraMode: 'title', time: 0, startedLights: 0,
  };
  G.state = state;
  const player = {
    name: 'YOU', number: 7, isPlayer: true, gridOrder: 6, raceDistance: -18.8, heading: 0,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), steer: 0, nitro: 100, health: 100,
    driftTime: 0, drifting: false, wasDrifting: false, turbo: 0, invuln: 0, shake: 0,
    idx: 0, latSlip: 0, wheelSpin: 0, throttleVis: 0, boosting: false, energized: false,
    lapStartTime: 0, lastLap: null,
  };
  const AI_DEFS = [
    { name: 'MIRA VOSS', num: 3, base: 0x2b8f9d, accent: 0x0e1d22, skill: 0.99, back: 8, lat: 2.4 },
    { name: 'DIEGO REN', num: 12, base: 0xc8402f, accent: 0x1c1210, skill: 1.015, back: 8, lat: -2.4 },
    { name: 'KAORU ITO', num: 21, base: 0x2c4f8f, accent: 0x101724, skill: 0.985, back: 13.4, lat: 2.4 },
    { name: 'SAL MAKRI', num: 44, base: 0x3f7d45, accent: 0x111c12, skill: 1.0, back: 13.4, lat: -2.4 },
    { name: 'NINA HALE', num: 88, base: 0x9b3c7a, accent: 0x1d101a, skill: 0.995, back: 18.8, lat: -2.4 },
  ];
  const ais = AI_DEFS.map((d, i) => ({
    name: d.name, number: d.num, isPlayer: false, skill: d.skill, gridOrder: i + 1, s: 0, offset: d.lat,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), heading: 0, speed: 0,
    raceDistance: -d.back, idx: 0, wheelSpin: 0, targetOffset: d.lat,
    group: null, lap: 0,
  }));
  const karts = [player, ...ais];

  // karts in the scene
  player.group = G.createKart({ number: 7, base: 0xf0a32b, accent: 0x171a1e });
  G.scene.add(player.group);
  ais.forEach((a, i) => {
    a.group = G.createKart({ number: a.number, base: AI_DEFS[i].base, accent: AI_DEFS[i].accent });
    G.scene.add(a.group);
  });

  // effects
  const smoke = new G.ParticleField(300, { texture: TEX.smoke, color: 0xd8d2c7, buoyancy: 0.55, grow: 1.6, fade: 0.5 });
  smoke.points.name = 'tyre-smoke'; G.scene.add(smoke.points);
  const dust = new G.ParticleField(180, { texture: TEX.smoke, color: 0xc6b49b, buoyancy: 0.3, grow: 1.2, fade: 0.35 });
  dust.points.name = 'haze'; G.scene.add(dust.points);
  const sparks = new G.ParticleField(240, { texture: TEX.smoke, color: 0xffb15c, buoyancy: -7, grow: -0.2, fade: 0.9, additive: true });
  sparks.points.name = 'sparks'; G.scene.add(sparks.points);
  const skid = new G.SkidMarks(900);
  skid.mesh.name = 'skid-marks'; G.scene.add(skid.mesh);
  const fx = { smoke, dust, sparks, skid, emitAcc: 0, sparkAcc: 0 };

  // ------------------------------------------------------------------ grid
  const gridDefs = [
    { back: 8, lat: 2.4, kart: ais[0] }, { back: 8, lat: -2.4, kart: ais[1] },
    { back: 13.4, lat: 2.4, kart: ais[2] }, { back: 13.4, lat: -2.4, kart: ais[3] },
    { back: 18.8, lat: 2.4, kart: ais[4] }, { back: 18.8, lat: -2.4, kart: player },
  ];
  function kartPoseFromDistance(d, lat, out) {
    const at = track.atDistance(d);
    out.pos.set(at.p.x + at.n.x * lat, 0.015, at.p.z + at.n.z * lat);
    out.heading = Math.atan2(at.t.x, at.t.z);
    return at;
  }
  function placeKartsOnGrid() {
    for (const g of gridDefs) {
      const k = g.kart;
      const at = kartPoseFromDistance(LAP - g.back, g.lat, k);
      k.raceDistance = -g.back;
      k.idx = at.i;
      if (k === player) {
        player.vel.set(0, 0, 0); player.steer = 0; player.nitro = 100; player.health = 100;
        player.driftTime = 0; player.turbo = 0; player.invuln = 0; player.boosting = false;
        player.energy = 100;
      } else {
        k.s = (LAP - g.back + LAP) % LAP;
        k.offset = g.lat; k.targetOffset = g.lat;
        k.speed = 0; k.lap = 0;
      }
      syncKartTransform(k);
    }
  }
  function syncKartTransform(k) {
    if (!k.group) return;
    k.group.position.copy(k.pos);
    k.group.rotation.y = k.heading;
    const body = k.group.userData.parts.body;
    if (body) { body.rotation.set(0, 0, 0); body.position.y = 0; }
    const w = k.group.userData.parts.wheels;
    for (const wh of w) { wh.spin.rotation.x = 0; wh.pivot.rotation.y = 0; }
    if (k.group.userData.parts.flameMeshes) for (const f of k.group.userData.parts.flameMeshes) f.visible = false;
  }

  // ------------------------------------------------------------------ markers in the world
  function markerTexture(main, sub, color) {
    const w = 512, h = 220;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.clearRect(0, 0, w, h);
    x.fillStyle = 'rgba(8,10,13,.72)';
    const r = 28;
    x.beginPath();
    x.moveTo(r, 24); x.lineTo(w - r, 24); x.quadraticCurveTo(w - 12, 24, w - 12, 24 + r);
    x.lineTo(w - 12, h - 55); x.lineTo(12, h - 55); x.lineTo(12, 24 + r); x.quadraticCurveTo(12, 24, r, 24);
    x.closePath(); x.fill();
    x.strokeStyle = color; x.lineWidth = 4; x.stroke();
    x.fillStyle = color; x.fillRect(12, h - 55, w - 24, 5);
    x.fillStyle = '#fff7ea'; x.textAlign = 'center'; x.font = '800 78px Helvetica, Arial, sans-serif'; x.textBaseline = 'middle';
    x.fillText(main, w / 2, 105);
    x.fillStyle = color; x.font = '700 30px monospace';
    x.fillText(sub, w / 2, h - 25);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  const markerSprites = [];
  function addMarker(x, y, z, texture, scale = 1.5) {
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.9, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z); sp.scale.set(scale * 2.2, scale * 1.1, 1);
    sp.userData.baseY = y; sp.userData.scale = scale;
    G.scene.add(sp); markerSprites.push(sp);
    return sp;
  }
  world.boostPads.forEach((p, i) => { p.marker = addMarker(p.x, 2.6, p.z, markerTexture('BOOST', 'SHIFT · NITRO', '#7fe6ff'), 1.15); });
  world.hazards.forEach((h, i) => { h.marker = addMarker(h.x, 2.2, h.z, markerTexture('CAUTION', 'CONES ON TRACK', '#ffb454'), 1.0); });

  // ------------------------------------------------------------------ controls
  const ctl = { throttle: 0, brake: 0, steer: 0, drift: false, boost: false };
  const keys = Object.create(null);
  const touchState = { left: false, right: false, gas: false, brake: false, drift: false, boost: false };
  let isTouchDevice = false;
  try { isTouchDevice = matchMedia('(pointer:coarse)').matches || (navigator.maxTouchPoints || 0) > 0; } catch (e) {}
  const touchAvailable = () => innerWidth < 900 || isTouchDevice;
  function readInput() {
    if (state.captureControls) {
      const c = state.captureControls;
      ctl.throttle = c.throttle || 0; ctl.brake = c.brake || 0; ctl.steer = c.steer || 0;
      ctl.drift = !!c.drift; ctl.boost = !!c.boost;
      return;
    }
    const left = !!(keys['KeyA'] || keys['ArrowLeft']) || touchState.left;
    const right = !!(keys['KeyD'] || keys['ArrowRight']) || touchState.right;
    const gas = !!(keys['KeyW'] || keys['ArrowUp']) || touchState.gas;
    const brake = !!(keys['KeyS'] || keys['ArrowDown']) || touchState.brake;
    const drift = !!keys['Space'] || touchState.drift;
    const boost = !!(keys['ShiftLeft'] || keys['ShiftRight']) || touchState.boost;
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    ctl.steer = damp(ctl.steer, target, 9.5, 1 / 60);
    ctl.throttle = gas ? 1 : 0;
    ctl.brake = brake ? 1 : 0;
    ctl.drift = drift;
    ctl.boost = boost;
  }
  function resetControls() {
    for (const k in keys) keys[k] = false;
    touchState.left = touchState.right = touchState.gas = touchState.brake = touchState.drift = touchState.boost = false;
    ctl.throttle = 0; ctl.brake = 0; ctl.steer = 0; ctl.drift = false; ctl.boost = false;
  }

  // ------------------------------------------------------------------ cameras
  const camera = G.camera;
  const look = { yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0, idle: 0 };
  const titleCam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 54 };
  const closeCam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 48 };
  const camTarget = new THREE.Vector3();
  let cameraReady = false;
  let shake = 0;
  function computeCameras() {
    const h = player.heading;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    const p = player.pos;
    titleCam.pos.set(p.x - fwd.x * 7.4 - right.x * 2.7, 2.62, p.z - fwd.z * 7.4 - right.z * 2.7);
    titleCam.look.set(p.x + fwd.x * 17 + right.x * 0.4, 1.18, p.z + fwd.z * 17 + right.z * 0.4);
    titleCam.fov = 57;
    closeCam.pos.set(p.x + fwd.x * 2.15 + right.x * 1.55, 1.10, p.z + fwd.z * 2.15 + right.z * 1.55);
    closeCam.look.set(p.x + fwd.x * 0.15 + right.x * 0.12, 0.52, p.z + fwd.z * 0.15 + right.z * 0.12);
    closeCam.fov = 48;
    G.productCameras = [
      { name: 'hero', cam: [...titleCam.pos.toArray(), ...titleCam.look.toArray()] },
      { name: 'close', cam: [...closeCam.pos.toArray(), ...closeCam.look.toArray()] },
    ];
  }
  const CAMQ = (() => {
    const q = new URLSearchParams(location.search).get('cam');
    return q ? q.split(',').map(Number) : null;
  })();
  const SHOT = document.body.classList.contains('shot');
  const FREEZE = SHOT || new URLSearchParams(location.search).get('freeze') === '1';
  const HOLD_UI = new URLSearchParams(location.search).get('hold') === '1';
  function setTitleCamera(time) {
    const drift = FREEZE ? 0 : Math.sin(time * 0.18) * 0.35;
    const h = player.heading;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    camera.position.set(
      titleCam.pos.x + right.x * drift,
      titleCam.pos.y + (FREEZE ? 0 : Math.sin(time * 0.3) * 0.05),
      titleCam.pos.z + right.z * drift
    );
    camTarget.set(titleCam.look.x, titleCam.look.y, titleCam.look.z);
    camera.fov = titleCam.fov; camera.updateProjectionMatrix();
    camera.lookAt(camTarget);
  }
  function chaseCamera(dt, time) {
    const h = player.heading;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    const speed = player.vel.length();
    const speedRatio = clamp(speed / 38, 0, 1);
    if (look.idle > 0) look.idle -= dt;
    else { look.yaw = damp(look.yaw, 0, 1.6, dt); look.pitch = damp(look.pitch, 0, 1.6, dt); }
    const yaw = look.yaw;
    const back = new THREE.Vector3(-fwd.x, 0, -fwd.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const dist = 5.7 + speedRatio * 1.8;
    const height = 2.05 + speedRatio * 0.55 + Math.max(0, look.pitch) * 1.6;
    const desired = new THREE.Vector3(
      player.pos.x + back.x * dist,
      height,
      player.pos.z + back.z * dist
    );
    const lookAhead = new THREE.Vector3(
      player.pos.x + fwd.x * (7.2 + speedRatio * 6) + right.x * Math.sin(yaw) * 2.0,
      1.05 + Math.max(0, look.pitch) * 1.2,
      player.pos.z + fwd.z * (7.2 + speedRatio * 6) + right.z * Math.sin(yaw) * 2.0
    );
    if (!cameraReady || dt === 0) {
      // snap on the first racing frame and in frozen capture mode
      camera.position.copy(desired);
      camTarget.copy(lookAhead);
      cameraReady = true;
    } else {
      const smooth = 1 - Math.exp(-dt * (6.5 - speedRatio * 1.6));
      camera.position.x = lerp(camera.position.x, desired.x, smooth);
      camera.position.y = lerp(camera.position.y, desired.y, smooth * 0.9);
      camera.position.z = lerp(camera.position.z, desired.z, smooth);
      camTarget.lerp(lookAhead, 1 - Math.exp(-dt * 7));
    }
    // impact shake
    shake = Math.max(0, shake - dt * 2.4);
    const jitter = shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * jitter;
    camera.position.y += (Math.random() - 0.5) * jitter;
    camera.position.z += (Math.random() - 0.5) * jitter;
    camera.lookAt(camTarget);
    const fovTarget = settings.fov + speedRatio * 6.5 + (player.boosting ? 3.5 : 0);
    camera.fov = dt === 0 ? fovTarget : damp(camera.fov, fovTarget, 3.0, dt);
    camera.updateProjectionMatrix();
  }
  function endCamera(dt, time) {
    const ang = time * 0.22 + 0.8;
    const desired = new THREE.Vector3(player.pos.x + Math.sin(ang) * 4.6, 1.7, player.pos.z + Math.cos(ang) * 4.6);
    camera.position.lerp(desired, 1 - Math.exp(-dt * 1.2));
    camTarget.lerp(new THREE.Vector3(player.pos.x, 0.6, player.pos.z), 1 - Math.exp(-dt * 2));
    camera.lookAt(camTarget);
    camera.fov = damp(camera.fov, 46, 2, dt);
    camera.updateProjectionMatrix();
  }
  function updateCamera(dt, time) {
    if (state.captureCam) {
      const c = state.captureCam;
      camera.position.set(c.x, c.y, c.z);
      camera.fov = c.fov || 55; camera.updateProjectionMatrix();
      camera.lookAt(new THREE.Vector3(c.tx, c.ty, c.tz));
      return;
    }
    if (CAMQ) {
      camera.position.set(CAMQ[0], CAMQ[1], CAMQ[2]);
      camera.fov = 58; camera.updateProjectionMatrix();
      camera.lookAt(new THREE.Vector3(CAMQ[3], CAMQ[4], CAMQ[5]));
      return;
    }
    if (state.phase === 'menu') { setTitleCamera(time); return; }
    if (state.phase === 'won' || state.phase === 'lost') { endCamera(dt, time); return; }
    if (!cameraReady) cameraReady = false;
    chaseCamera(dt, time);
  }

  // ------------------------------------------------------------------ input binding
  const canvas = G.renderer.domElement;
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    keys[e.code] = true;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.code === 'Enter') {
      if (state.phase === 'menu') startRace();
      else if (state.phase === 'won' || state.phase === 'lost') startRace();
    }
    if (e.code === 'Escape') {
      if (state.phase === 'settings') closeSettings();
      else if (state.phase === 'paused') resumeGame();
      else if (state.phase === 'racing' || state.phase === 'countdown') pauseGame();
      else if (state.phase === 'won' || state.phase === 'lost') showMenu();
    }
    if (e.code === 'KeyR' && (state.phase === 'racing' || state.phase === 'paused')) startRace();
    if (e.code === 'KeyM') toggleMute();
  }, { passive: false });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  canvas.addEventListener('pointerdown', (e) => {
    if (state.phase !== 'racing' && state.phase !== 'countdown') return;
    look.dragging = true; look.lastX = e.clientX; look.lastY = e.clientY;
    canvas.classList.add('dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!look.dragging) return;
    const dx = e.clientX - look.lastX, dy = e.clientY - look.lastY;
    look.lastX = e.clientX; look.lastY = e.clientY;
    const sens = 0.0026 * settings.sensitivity;
    look.yaw = clamp(look.yaw - dx * sens, -1.15, 1.15);
    look.pitch = clamp(look.pitch + dy * sens * (settings.invertY ? -1 : 1), -0.35, 0.55);
    look.idle = 1.8;
  });
  const endLook = (e) => {
    if (!look.dragging) return;
    look.dragging = false; look.idle = 1.3;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // touch buttons
  function bindHold(id, name) {
    const node = $(id); if (!node) return;
    const on = (e) => { e.preventDefault(); touchState[name] = true; node.classList.add('active'); try { node.setPointerCapture(e.pointerId); } catch (err) {} };
    const off = (e) => { e.preventDefault(); touchState[name] = false; node.classList.remove('active'); };
    node.addEventListener('pointerdown', on);
    node.addEventListener('pointerup', off);
    node.addEventListener('pointercancel', off);
    node.addEventListener('pointerleave', off);
  }
  bindHold('t-left', 'left'); bindHold('t-right', 'right'); bindHold('t-gas', 'gas');
  bindHold('t-brake', 'brake'); bindHold('t-drift', 'drift'); bindHold('t-boost', 'boost');
  $('t-pause')?.addEventListener('click', () => { if (state.phase === 'racing' || state.phase === 'countdown') pauseGame(); });

  // ------------------------------------------------------------------ physics helpers
  const tmpV = new THREE.Vector3();
  function rearWheelPoints(k, out) {
    const h = k.heading, ch = Math.cos(h), sh = Math.sin(h);
    // local rear axle z=-0.81, x=+/-
    out[0].set(k.pos.x + (-0.68) * ch - (-0.81) * sh, 0.09, k.pos.z - (-0.68) * sh - (-0.81) * ch);
    out[1].set(k.pos.x + (0.68) * ch - (-0.81) * sh, 0.09, k.pos.z - (0.68) * sh - (-0.81) * ch);
  }
  const rw = [new THREE.Vector3(), new THREE.Vector3()];

  function sparkBurst(x, y, z, n, power = 1) {
    for (let i = 0; i < n; i++) {
      sparks.spawn(x, y, z,
        (Math.random() - 0.5) * 7 * power,
        Math.random() * 4.5 * power,
        (Math.random() - 0.5) * 7 * power,
        0.35 + Math.random() * 0.4, 0.7 + Math.random());
    }
  }
  function damagePlayer(amount, cause) {
    if (player.invuln > 0 || state.phase !== 'racing') return;
    player.invuln = 0.45;
    player.health = Math.max(0, player.health - amount);
    state.health = player.health;
    shake = Math.min(0.9, shake + 0.16);
    audio.impact(clamp(amount / 8, 0.4, 1.6));
    if (player.health <= 0 && !state.finalShown) {
      endRace(false, 'KART WRECKED — ' + (cause || 'TOO MANY IMPACTS'));
    } else if (player.health < 30 && !state.warningDone) {
      state.warningDone = true;
      showSubtitle('CHASSIS CRITICAL. One more wall and the run is over.', 'RADIO');
      audio.warn();
    }
  }
  function resolveWall() {
    const near = track.nearest(player.pos.x, player.pos.z, player.idx);
    player.idx = near.i;
    const lat = near.lateral;
    const LIM = track.WALL_OFF - 0.94;
    let impact = 0;
    if (Math.abs(lat) > LIM) {
      const over = Math.abs(lat) - LIM;
      player.pos.x -= near.n.x * Math.sign(lat) * over;
      player.pos.z -= near.n.z * Math.sign(lat) * over;
      const outN = new THREE.Vector3(near.n.x * Math.sign(lat), 0, near.n.z * Math.sign(lat));
      const vn = player.vel.dot(outN);
      if (vn > 0) { player.vel.addScaledVector(outN, -vn * 1.28); impact = vn; }
      player.vel.multiplyScalar(0.992);
      if (impact > 4.2) {
        rearWheelPoints(player, rw);
        sparkBurst(player.pos.x, 0.45, player.pos.z, 10, clamp(impact / 10, 0.4, 1.6));
        if (player.invuln <= 0) damagePlayer(clamp(impact * 0.55, 2, 9), 'BARRIER STRIKE');
      }
    }
    return near;
  }

  function stepPlayer(h) {
    if (state.phase !== 'racing' || player.health <= 0) return;
    const p = player;
    const h0 = p.heading;
    let fwd = new THREE.Vector3(Math.sin(h0), 0, Math.cos(h0));
    let right = new THREE.Vector3(-Math.cos(h0), 0, Math.sin(h0));
    let speed = p.vel.length();
    const steer = ctl.steer;
    const drifting = ctl.drift && speed > 8.0;
    if (drifting && !p.drifting) {
      // kick-off
      p.driftTime = 0;
    }
    p.drifting = drifting;
    if (drifting) {
      p.driftTime += h;
      p.nitro = Math.min(100, p.nitro + (9 + Math.abs(steer) * 11) * h);
      p.turbo = Math.max(p.turbo, 0.02);
    } else if (p.wasDrifting) {
      if (p.driftTime > 0.55) {
        const boost = clamp(0.55 + p.driftTime * 0.35, 0.55, 1.5);
        p.turbo = Math.max(p.turbo, boost);
        audio.boost();
        showSubtitle('Mini-turbo — hold the drift longer for more.', 'COACH');
      }
      p.driftTime = 0;
    }
    p.wasDrifting = drifting;
    // steering
    const speedF = clamp(speed / 6, 0, 1);
    const turnRate = (2.25 + (drifting ? 0.95 : 0)) * speedF * (1 - clamp(speed / 58, 0, 0.55));
    p.heading -= steer * turnRate * h;
    fwd.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    right.set(-Math.cos(p.heading), 0, Math.sin(p.heading));
    let vF = p.vel.dot(fwd), vR = p.vel.dot(right);
    // boost
    p.boosting = false;
    if (p.turbo > 0) p.turbo = Math.max(0, p.turbo - h);
    const turboOn = p.turbo > 0.01;
    if (ctl.boost && p.nitro > 0.4 && !drifting) {
      p.nitro = Math.max(0, p.nitro - 29 * h);
      p.boosting = true;
      if (!p.boostSound) { audio.boost(); p.boostSound = true; }
    } else p.boostSound = false;
    const boosting = p.boosting || turboOn;
    const maxF = turboOn ? 39 : (p.boosting ? 37 : 29.2);
    const throttle = state.phase === 'racing' ? ctl.throttle : 0;
    if (throttle > 0 && vF < maxF) {
      const accel = turboOn ? 17 : (p.boosting ? 15 : 11.8);
      vF += accel * h * (1 - clamp(vF / maxF, 0, 0.82) * 0.55);
    }
    if (ctl.brake) {
      if (vF > 0.4) vF -= 22 * h;
      else vF = Math.max(vF - 6.5 * h, -8);
    }
    if (!throttle && !ctl.brake) vF -= Math.sign(vF) * 0.6 * h;
    if (vF > maxF) vF = damp(vF, maxF, 2.2, h);
    vF -= vF * Math.abs(vF) * 0.0026 * h;
    // lateral grip / drift
    const grip = drifting ? 1.55 : 7.6;
    vR *= Math.exp(-grip * h);
    if (drifting) vR -= steer * 3.4 * h;
    // suspension / slip bookkeeping
    p.latSlip = vR;
    p.vel.set(fwd.x * vF + right.x * vR, 0, fwd.z * vF + right.z * vR);
    p.pos.addScaledVector(p.vel, h);
    speed = p.vel.length();
    p.speed = speed;
    state.speed = speed;
    state.topSpeed = Math.max(state.topSpeed, speed * 3.6);
    // wall + progress
    const near = resolveWall();
    const along = p.vel.dot(near.t);
    p.raceDistance += along * h;
    if (!state.started && p.raceDistance >= 0) {
      state.started = true; state.lapStart = state.raceTime;
    }
    if (p.nitro > 0) p.nitro = Math.min(100, p.nitro);
    state.nitro = p.nitro;
    player.invuln = Math.max(0, player.invuln - h);
    // particles / skid
    if (state.effectsEnabled) {
      if (drifting && speed > 8) {
        rearWheelPoints(p, rw);
        fx.emitAcc += h;
        if (fx.emitAcc > 0.024) {
          fx.emitAcc = 0;
          for (const w of rw) {
            smoke.spawn(w.x + (Math.random() - 0.5) * 0.2, 0.12, w.z + (Math.random() - 0.5) * 0.2,
              (Math.random() - 0.5) * 1.1, 0.35 + Math.random() * 0.5, (Math.random() - 0.5) * 1.1,
              0.9 + Math.random() * 0.7, 0.72 + Math.random() * 0.6);
          }
        }
        fx.skidAcc = (fx.skidAcc || 0) + h;
        if (fx.skidAcc > 0.045) {
          fx.skidAcc = 0;
          for (const w of rw) skid.add(w.x, w.z, Math.atan2(p.vel.x, p.vel.z) + Math.PI / 2, 0.12, 0.85);
        }
      }
      if ((boosting || speed > 25) && player.health > 0) {
        fx.sparkAcc = (fx.sparkAcc || 0) + h;
        if (fx.sparkAcc > (boosting ? 0.035 : 0.15)) {
          fx.sparkAcc = 0;
          const back = new THREE.Vector3(-Math.sin(p.heading), 0, -Math.cos(p.heading));
          sparks.spawn(p.pos.x + back.x * 1.1 + (Math.random() - 0.5) * 0.2, 0.28, p.pos.z + back.z * 1.1 + (Math.random() - 0.5) * 0.2,
            back.x * 3, 0.4, back.z * 3, 0.18 + Math.random() * 0.2, 0.45);
        }
      }
      if (player.health < 25 && player.health > 0) {
        fx.emitAcc = fx.emitAcc;
        if (Math.random() < h * 14) {
          smoke.spawn(p.pos.x - Math.sin(p.heading) * 0.6, 0.6, p.pos.z - Math.cos(p.heading) * 0.6,
            (Math.random() - 0.5) * 0.4, 0.6, (Math.random() - 0.5) * 0.4, 1.2, 0.7);
        }
      }
    }
  }

  function stepAI(ai, h) {
    if (state.phase !== 'racing') return;
    const t1 = track.atDistance(ai.s + 5), t2 = track.atDistance(ai.s + 19);
    const a1 = Math.atan2(t1.t.x, t1.t.z), a2 = Math.atan2(t2.t.x, t2.t.z);
    const turn = Math.abs(wrapAngle(a2 - a1));
    const cross = t1.t.x * t2.t.z - t1.t.z * t2.t.x;
    let target = clamp(26.2 - turn * 19, 11.5, 26.0) * ai.skill;
    const gap = player.raceDistance - ai.raceDistance;
    // the player gets a real catch-up window, and leads are not given away for free
    const rubber = gap < -45 ? 0.91 : gap < 0 ? 0.955 : gap > 45 ? 1.02 : 1.0;
    target *= rubber;
    if (state.raceTime < 2.2) target *= 0.5 + state.raceTime * 0.22;
    const accel = ai.speed < target ? 7.4 : 12;
    ai.speed = approach(ai.speed, target, accel * h);
    const inside = -Math.sign(cross) * 1.9;
    ai.targetOffset = clamp(inside + Math.sin(ai.s * 0.026 + ai.number) * 0.75, -3.2, 3.2);
    ai.offset = damp(ai.offset, ai.targetOffset, 0.9, h);
    // avoid the player's line if close ahead
    const dxp = player.pos.x - ai.pos.x, dzp = player.pos.z - ai.pos.z;
    const ddp = Math.hypot(dxp, dzp);
    if (ddp < 4.2) {
      const side = (dxp * Math.cos(ai.heading) - dzp * Math.sin(ai.heading)) >= 0 ? -1 : 1;
      ai.offset += side * h * 1.5;
      ai.offset = clamp(ai.offset, -3.4, 3.4);
    }
    ai.s += ai.speed * h;
    ai.raceDistance += ai.speed * h;
    const at = track.atDistance(ai.s);
    ai.pos.set(at.p.x + at.n.x * ai.offset, 0.015, at.p.z + at.n.z * ai.offset);
    ai.heading = Math.atan2(at.t.x, at.t.z);
    // collision with player
    const dx = player.pos.x - ai.pos.x, dz = player.pos.z - ai.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.001 && d < 1.55) {
      const nx = dx / d, nz = dz / d, over = 1.55 - d;
      player.pos.x += nx * over * 0.72; player.pos.z += nz * over * 0.72;
      ai.offset -= (nx * at.n.x + nz * at.n.z) * over * 0.5;
      player.vel.x += nx * 1.6; player.vel.z += nz * 1.6;
      ai.speed *= 0.94;
      if (player.invuln <= 0) { damagePlayer(2.6, 'RIVAL CONTACT'); sparkBurst(player.pos.x, 0.5, player.pos.z, 8, 0.8); }
    }
    ai.lap = Math.floor(Math.max(0, ai.raceDistance) / LAP);
  }

  function updateProgress() {
    const standings = computeStandings();
    state.position = standings.indexOf(player) + 1;
    if (state.started) {
      while (state.lapsDone < state.laps && player.raceDistance >= (state.lapsDone + 1) * LAP) {
        state.lapsDone++;
        const lapTime = state.raceTime - state.lapStart;
        state.lapStart = state.raceTime;
        state.lastLap = lapTime;
        player.lastLap = lapTime;
        if (!state.bestLap || lapTime < state.bestLap) {
          state.bestLap = lapTime;
          best.bestLap = lapTime;
          saveBest();
          showSubtitle('New personal best lap — ' + fmtTime(lapTime) + '.', 'RACE CONTROL');
        }
        audio.lap();
        if (state.lapsDone < state.laps) {
          player.health = Math.min(100, player.health + 14);
          state.health = player.health;
          showLapBanner(`LAP ${state.lapsDone + 1} / ${state.laps}`);
          if (state.lapsDone === 1) showSubtitle('Lap two. The river straight is where the race is won.', 'RACE CONTROL');
          else showSubtitle('Last lap. Everything you have left — now.', 'RACE CONTROL');
          if (state.lapsDone === state.laps - 1) audio.count(0);
        }
        if (state.lapsDone >= state.laps) {
          const pos = computeStandings().indexOf(player) + 1;
          endRace(pos <= 3, pos <= 3 ? (pos === 1 ? 'CITY CHAMPION — YOU OWN THIS STREET.' : `PODIUM SECURED — FINISHED P${pos}.`) : `FINISHED P${pos} — THE PODIUM GOT AWAY.`);
          break;
        }
      }
    }
    // podium / lead radio beats
    if (state.position <= 3 && !state.contactDone && state.raceTime > 8) {
      state.contactDone = true;
      showSubtitle(`You're P${state.position}. The city is watching — keep it clean.`, 'RACE CONTROL');
    }
  }
  function computeStandings() {
    return karts.slice().sort((a, b) => (b.raceDistance - a.raceDistance) || (a.gridOrder - b.gridOrder));
  }

  function checkPadsAndHazards() {
    // boost pads
    for (const pad of world.boostPads) {
      pad.cooldown = Math.max(0, (pad.cooldown || 0) - 1 / 60);
      const dx = player.pos.x - pad.x, dz = player.pos.z - pad.z;
      if (pad.cooldown <= 0 && dx * dx + dz * dz < 2.35 * 2.35) {
        pad.cooldown = 4.0;
        player.nitro = Math.min(100, player.nitro + 38);
        player.turbo = Math.max(player.turbo, 0.85);
        state.nitro = player.nitro;
        audio.pad();
        showSubtitle('Boost pad — nitro topped up. Spend it on the straight.', 'COACH');
        for (let i = 0; i < 12; i++) sparks.spawn(pad.x, 0.2, pad.z, (Math.random() - 0.5) * 3, Math.random() * 2.4, (Math.random() - 0.5) * 3, 0.4, 0.8);
      }
    }
    // cones
    for (const hz of world.hazards) {
      if (hz.hit) continue;
      const dx = player.pos.x - hz.x, dz = player.pos.z - hz.z;
      if (dx * dx + dz * dz < 2.15 * 2.15) {
        hz.hit = true;
        hz.group.visible = false;
        if (hz.marker) hz.marker.visible = false;
        player.turbo = 0;
        player.vel.multiplyScalar(0.72);
        rearWheelPoints(player, rw);
        for (const w of rw) sparkBurst(w.x, 0.3, w.z, 10, 1.2);
        damagePlayer(8, 'CONE STRIKE');
        showSubtitle('Cones — that cost you time. Watch the orange boards.', 'RACE CONTROL');
      }
    }
  }

  function stepWorld(dt, withEffects) {
    state.raceTime += dt;
    if (state.raceTime >= state.limit) {
      endRace(false, 'RACE CLOCK EXPIRED — THE CITY CUP SLIPPED AWAY.');
      return;
    }
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 120))));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      if (state.phase !== 'racing') break;
      stepPlayer(h);
      for (const ai of ais) stepAI(ai, h);
      // player vs AI collisions can push into a wall; resolve again
      resolveWall();
    }
    checkPadsAndHazards();
    updateProgress();
    if (state.health !== player.health) state.health = player.health;
    state.nitro = player.nitro;
    state.speed = player.vel.length();
  }

  // ------------------------------------------------------------------ visuals each frame
  function updateKartVisuals(dt, time) {
    for (const k of karts) {
      if (!k.group) continue;
      const parts = k.group.userData.parts;
      k.group.position.copy(k.pos);
      k.group.rotation.y = k.heading;
      const speed = k.isPlayer ? player.vel.length() : k.speed;
      k.wheelSpin += speed / 0.3 * dt;
      const steer = k.isPlayer ? player.steer : clamp((k.targetOffset || 0) * 0.08, -0.4, 0.4);
      for (const wh of parts.wheels) {
        wh.spin.rotation.x = -k.wheelSpin;
        wh.pivot.rotation.y = wh.front ? -steer * 0.42 : 0;
      }
      const body = parts.body;
      if (body) {
        let roll = 0, pitch = 0;
        if (k.isPlayer) {
          roll = clamp(player.latSlip * 0.006 + player.steer * 0.028, -0.07, 0.07);
          pitch = clamp((ctl.throttle ? -0.012 : 0) + (ctl.brake ? 0.02 : 0), -0.03, 0.03);
        } else {
          roll = Math.sin(k.s * 0.1 + k.number) * 0.01;
        }
        body.rotation.z = damp(body.rotation.z, roll, 7, dt);
        body.rotation.x = damp(body.rotation.x, pitch, 7, dt);
        body.position.y = Math.sin(time * 18 + k.number) * 0.002 * (k.isPlayer ? 1 : 0.5);
      }
      const boosting = k.isPlayer ? (player.boosting || player.turbo > 0) : (k.speed > 22 && Math.random() < 0.02);
      const flames = parts.flameMeshes || [];
      for (const f of flames) {
        f.visible = boosting;
        if (boosting) f.material.opacity = 0.55 + Math.random() * 0.4;
      }
      if (parts.brakeLight) parts.brakeLight.visible = k.isPlayer ? !!ctl.brake : false;
    }
  }
  function updateEffects(dt) {
    smoke.update(dt); dust.update(dt); sparks.update(dt);
    if (!state.effectsEnabled) return;
  }

  // ------------------------------------------------------------------ HUD
  let hudTick = 0;
  let lastShownLap = -1;
  function updateHUD(time) {
    if (!el.hud || el.hud.classList.contains('hidden')) return;
    const speedKmh = Math.round(player.vel.length() * 3.6);
    state.speed = player.vel.length();
    const lapNum = clamp(Math.floor(Math.max(0, player.raceDistance) / LAP) + 1, 1, state.laps);
    const dots = Array.from({ length: state.laps }, (_, i) => (i < state.lapsDone ? '●' : '○')).join(' ');
    el.lap.textContent = `LAP ${lapNum} / ${state.laps}`;
    el.beatDots.textContent = dots;
    el.objective.textContent = lapNum === 1 ? 'WIN THE CITY CUP' : lapNum === 2 ? 'HOLD THE PODIUM' : 'BRING IT HOME';
    el.pos.textContent = 'P' + state.position;
    el.posOf.textContent = '/ ' + karts.length;
    const remain = Math.max(0, state.limit - state.raceTime);
    el.raceTime.textContent = fmtTime(remain);
    el.raceTime.style.color = remain < 30 ? '#ff8a76' : '';
    el.lastLap.textContent = 'LAST ' + (state.lastLap ? fmtTime(state.lastLap) : '—');
    el.bestLap.textContent = 'BEST ' + (state.bestLap ? fmtTime(state.bestLap) : '—');
    el.speed.textContent = String(speedKmh);
    el.gear.textContent = speedKmh < 2 ? 'N' : String(clamp(1 + Math.floor(speedKmh / 24), 1, 6));
    const rpm = clamp(player.vel.length() / 38, 0, 1) * 0.84 + (ctl.throttle ? 0.1 : 0) + (player.drifting ? 0.06 : 0);
    el.rpmFill.style.strokeDashoffset = String(315 - 315 * clamp(rpm, 0, 1));
    el.nitroFill.style.transform = 'scaleX(' + clamp(player.nitro / 100, 0, 1) + ')';
    el.nitroNum.textContent = String(Math.round(player.nitro));
    const hp = clamp(player.health, 0, 100);
    el.damageFill.style.transform = 'scaleX(' + hp / 100 + ')';
    el.damageNum.textContent = String(Math.round(hp));
    el.damageFill.style.background = hp < 30 ? 'linear-gradient(90deg,#ff2f1f,#ff7a42)' : 'linear-gradient(90deg,#ff4c39,#ff9a4f)';
    // compass / next marker
    let bestD = 1e9, bestPad = null;
    const near = track.nearest(player.pos.x, player.pos.z, player.idx);
    for (const pad of world.boostPads) {
      const dd = ((pad.d - near.s) % LAP + LAP) % LAP;
      if (dd < bestD) { bestD = dd; bestPad = pad; }
    }
    if (bestPad && bestD < 160) {
      const ang = Math.atan2(bestPad.x - player.pos.x, bestPad.z - player.pos.z);
      const rel = wrapAngle(ang - player.heading);
      el.compassArrow.style.transform = `rotate(${-rel * 180 / Math.PI}deg)`;
      el.compassText.textContent = `BOOST PAD · ${Math.round(bestD)} m`;
    } else {
      el.compassArrow.style.transform = 'rotate(0deg)';
      el.compassText.textContent = `FINISH · ${Math.round(LAP - near.s)} m`;
    }
    // prompt
    let prompt = '<b>SPACE</b> DRIFT · <b>SHIFT</b> NITRO';
    if (player.health < 30) prompt = '<b>CHASSIS CRITICAL</b> · AVOID CONTACT';
    else if (player.drifting) prompt = '<b>DRIFT</b> · RELEASE FOR MINI-TURBO';
    else if (player.boosting) prompt = '<b>NITRO</b> ENGAGED';
    if (el.prompt.innerHTML !== prompt) el.prompt.innerHTML = prompt;
    el.prompt.classList.remove('hidden');
    // minimap
    hudTick++;
    if (hudTick % 2 === 0) drawMinimap(near);
  }
  function drawMinimap(near) {
    const canvas = el.minimap; if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const pad = 20, b = track.bounds;
    const sx = (W - pad * 2) / (b.x1 - b.x0), sz = (H - pad * 2) / (b.z1 - b.z0);
    const s = Math.min(sx, sz);
    const ox = (W - (b.x1 - b.x0) * s) / 2, oz = (H - (b.z1 - b.z0) * s) / 2;
    const map = (x, z) => [ox + (x - b.x0) * s, oz + (z - b.z0) * s];
    ctx.clearRect(0, 0, W, H);
    // dial
    const cg = ctx.createRadialGradient(W / 2, H / 2, 8, W / 2, H / 2, W / 2);
    cg.addColorStop(0, 'rgba(10,13,17,.74)'); cg.addColorStop(1, 'rgba(8,10,13,.4)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,180,84,.28)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, W / 2 - 3, 0, Math.PI * 2); ctx.stroke();
    // track path: dark underlay then a bright ribbon
    ctx.beginPath();
    for (let i = 0; i <= N; i += 8) {
      const p = track.samples[i % N].p;
      const [x, y] = map(p.x, p.z);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6,8,11,.8)'; ctx.lineWidth = 10; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,236,214,.62)'; ctx.lineWidth = 5.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,180,84,.9)'; ctx.lineWidth = 1.6; ctx.stroke();
    // start line
    const sp = track.samples[0].p, [sx2, sy2] = map(sp.x, sp.z);
    ctx.fillStyle = '#ffb454'; ctx.fillRect(sx2 - 4, sy2 - 4, 8, 8);
    ctx.fillStyle = 'rgba(8,10,13,.9)'; ctx.fillRect(sx2 - 4, sy2 - 4, 4, 4); ctx.fillRect(sx2, sy2, 4, 4);
    // karts
    for (const k of karts) {
      const [x, y] = map(k.pos.x, k.pos.z);
      if (k.isPlayer) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(-k.heading + Math.PI);
        ctx.shadowColor = 'rgba(255,180,84,.9)'; ctx.shadowBlur = 8;
        ctx.fillStyle = '#ffd08a';
        ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(238,236,226,.82)';
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(8,10,13,.75)'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
  }
  // ------------------------------------------------------------------ shell: screens
  function hideAllScreens() {
    for (const node of [el.start, el.pause, el.settings, el.end]) {
      if (!node) continue;
      node.classList.add('hidden');
      if (node === el.end) node.hidden = true;
    }
  }
  function showScreen(node) {
    hideAllScreens();
    if (!node) return;
    node.classList.remove('hidden');
    if (node === el.end) node.hidden = false;
  }
  function showHUD(show) {
    el.hud.classList.toggle('hidden', !show);
  }
  function showTouch(show) {
    el.touch.classList.toggle('hidden', !(show && touchAvailable()));
  }
  function updateTitleMeta() {
    el.titleBest.textContent = best.bestLap ? fmtTime(best.bestLap) : '—';
    el.titlePodium.textContent = best.bestPosition ? `P${best.bestPosition}` : '—';
    el.titleMute.textContent = settings.mute ? 'MUTED' : 'UNMUTED';
    if (el.gridList) {
      el.gridList.innerHTML = '';
      const rows = [
        ...gridDefs.map((g, i) => ({ i: i + 1, k: g.kart })),
      ];
      for (const r of rows) {
        const li = document.createElement('li');
        if (r.k.isPlayer) li.className = 'you';
        li.innerHTML = `<i>${String(r.i).padStart(2, '0')}</i><b>${r.k.isPlayer ? 'YOU · #7' : '#' + r.k.number + ' ' + r.k.name}</b><span>${r.k.isPlayer ? 'GRID' : 'RIVAL'}</span>`;
        el.gridList.appendChild(li);
      }
    }
  }
  function showSubtitle(text, kicker = 'RADIO') {
    if (!el.subtitle) return;
    el.subtitleKicker.textContent = kicker;
    el.subtitleText.textContent = text;
    el.subtitle.classList.remove('hidden', 'fade');
    clearTimeout(showSubtitle._t1); clearTimeout(showSubtitle._t2);
    if (HOLD_UI) return;
    showSubtitle._t1 = setTimeout(() => {
      el.subtitle.classList.add('fade');
      showSubtitle._t2 = setTimeout(() => el.subtitle.classList.add('hidden'), 400);
    }, 5200);
  }
  function hideSubtitle() {
    if (!el.subtitle) return;
    clearTimeout(showSubtitle._t1); clearTimeout(showSubtitle._t2);
    el.subtitle.classList.add('hidden');
  }
  function raceMessage(html, cls = 'show') {
    if (!el.raceMsg) return;
    el.raceMsg.innerHTML = html;
    el.raceMsg.classList.add(cls);
  }
  function hideRaceMessage() { el.raceMsg?.classList.remove('show'); }
  function showLapBanner(text) {
    if (!el.lapBanner) return;
    el.lapBanner.textContent = text;
    el.lapBanner.classList.remove('hidden');
    clearTimeout(showLapBanner._t);
    showLapBanner._t = setTimeout(() => el.lapBanner.classList.add('hidden'), 1900);
  }
  // start lights
  const startLamps = [];
  if (world.startLights) world.startLights.traverse((o) => {
    if (o.isMesh && o.geometry && o.geometry.type === 'CircleGeometry') { o.visible = false; startLamps.push(o); }
  });
  function setStartLights(n) {
    startLamps.forEach((l, i) => { l.visible = i < n; });
  }

  // ------------------------------------------------------------------ race flow
  function resetRaceState() {
    state.countdown = 0; state.raceTime = 0; state.lapsDone = 0; state.lapStart = 0;
    state.started = false; state.health = 100; state.nitro = 100; state.speed = 0;
    state.failed = false; state.won = false; state.cause = ''; state.lastLap = null;
    state.bestLap = best.bestLap || null; state.topSpeed = 0;
    state.finalShown = false; state.warningDone = false; state.contactDone = false;
    state.ended = false; state.boosting = false; state._lastCount = -1;
    state.effectsEnabled = true;
    player.health = 100; player.nitro = 100; player.vel.set(0, 0, 0); player.turbo = 0;
    player.driftTime = 0; player.drifting = false; player.wasDrifting = false;
    player.invuln = 0; player.raceDistance = -18.8; player.steer = 0; player.latSlip = 0;
    player.boosting = false; player.boostSound = false;
    for (const ai of ais) { ai.speed = 0; }
    // reset AI race distances from grid
    for (const g of gridDefs) {
      if (g.kart.isPlayer) { player.raceDistance = -g.back; }
      else { const ai = g.kart; ai.raceDistance = -g.back; ai.s = (LAP - g.back + LAP) % LAP; ai.offset = g.lat; ai.targetOffset = g.lat; ai.speed = 0; }
    }
    for (const pad of world.boostPads) pad.cooldown = 0;
    for (const hz of world.hazards) { hz.hit = false; hz.group.visible = true; if (hz.marker) hz.marker.visible = true; }
    setStartLights(0);
    hideRaceMessage(); hideSubtitle();
    if (el.lapBanner) el.lapBanner.classList.add('hidden');
    resetControls();
    smoke.clear?.(); // not implemented; no-op guard
    for (let i = 0; i < smoke.max; i++) { smoke.life[i] = 0; smoke.alpha[i] = 0; }
    for (let i = 0; i < dust.max; i++) { dust.life[i] = 0; dust.alpha[i] = 0; }
    for (let i = 0; i < sparks.max; i++) { sparks.life[i] = 0; sparks.alpha[i] = 0; }
    smoke.geo.attributes.aAlpha.needsUpdate = true;
    dust.geo.attributes.aAlpha.needsUpdate = true;
    sparks.geo.attributes.aAlpha.needsUpdate = true;
    skid.clear();
    placeKartsOnGrid();
    state.position = 6;
    updateHUD(0);
  }
  function showMenu() {
    state.phase = 'menu'; state.prevPhase = 'menu';
    resetRaceState();
    computeCameras();
    cameraReady = false;
    showScreen(el.start);
    showHUD(false);
    showTouch(false);
    hideSubtitle();
    updateTitleMeta();
    audio.setRaceActive(false);
    el.end.classList.add('hidden'); el.end.hidden = true;
    document.body.classList.remove('racing');
    requestAnimationFrame(() => setTitleCamera(state.time));
  }
  function startRace() {
    audio.init();
    audio.click();
    resetRaceState();
    computeCameras();
    state.phase = 'countdown';
    state.prevPhase = 'countdown';
    state.countdown = 3.0;
    setStartLights(5);
    showScreen(null);
    showHUD(true);
    showTouch(true);
    document.body.classList.add('racing');
    cameraReady = false;
    audio.setRaceActive(true);
    raceMessage('3', 'show');
    showSubtitle('Six karts, three laps. The city is yours if you take it.', 'RACE CONTROL');
    updateHUD(0);
  }
  function beginRacing() {
    state.phase = 'racing';
    state.countdown = 0;
    state.started = false;
    state.lapStart = 0;
    state.raceTime = 0;
    setStartLights(0);
    raceMessage('GO<small>LIGHTS OUT</small>', 'show');
    clearTimeout(beginRacing._t);
    beginRacing._t = setTimeout(() => hideRaceMessage(), 900);
    audio.count(0);
    showSubtitle('Lights out. Drift early, nitro late — and mind the walls.', 'RACE CONTROL');
  }
  function pauseGame() {
    if (state.phase !== 'racing' && state.phase !== 'countdown') return;
    state.prevPhase = state.phase;
    state.phase = 'paused';
    showScreen(el.pause);
    updatePauseStats();
    audio.setRaceActive(false);
    showTouch(false);
    el.pause.classList.remove('hidden');
  }
  function resumeGame() {
    if (state.phase !== 'paused') return;
    state.phase = state.prevPhase === 'countdown' ? 'countdown' : 'racing';
    hideAllScreens();
    showHUD(true);
    showTouch(true);
    audio.setRaceActive(true);
    cameraReady = false;
    resetControls();
  }
  function updatePauseStats() {
    if (!el.pPos) return;
    el.pPos.textContent = 'P' + state.position;
    el.pLap.textContent = `${clamp(state.lapsDone + 1, 1, state.laps)} / ${state.laps}`;
    el.pTime.textContent = fmtTime(state.raceTime);
    el.pDmg.textContent = Math.round(player.health) + '%';
  }
  function endRace(won, cause) {
    if (state.finalShown) return;
    state.finalShown = true;
    const standings = computeStandings();
    const pos = standings.indexOf(player) + 1;
    state.position = pos;
    state.phase = won ? 'won' : 'lost';
    state.failed = !won; state.won = won; state.cause = cause || '';
    state.result = won ? `P${pos}` : '—';
    if (best.bestPosition === null || pos < best.bestPosition) best.bestPosition = pos;
    if (won) best.wins = (best.wins || 0) + 1;
    best.last = state.result;
    saveBest();
    showEndScreen(pos, cause);
    audio.setRaceActive(false);
    if (won) audio.win(); else audio.lose();
    showTouch(false);
    hideRaceMessage();
    showHUD(false);
  }
  function showEndScreen(pos, cause) {
    const won = state.won;
    el.end.classList.remove('hidden'); el.end.hidden = false;
    el.end.dataset.result = won ? 'won' : 'lost';
    el.endKicker.textContent = won ? 'CHEQUERED FLAG' : 'RACE OVER';
    el.endTitle.textContent = won ? (pos === 1 ? 'P1' : 'P' + pos) : (state.health <= 0 ? 'WRECKED' : (state.raceTime >= state.limit ? 'TIME UP' : 'P' + pos));
    el.endCause.textContent = cause || (won ? 'YOU WON THE SUNSET DISTRICT GP' : 'THE CITY CUP WAS LOST');
    el.ePos.textContent = `P${pos} / ${karts.length}`;
    el.eTime.textContent = fmtTime(state.raceTime);
    el.eBest.textContent = state.bestLap ? fmtTime(state.bestLap) : '—';
    el.eTop.textContent = Math.round(state.topSpeed) + ' KM/H';
    const flagText = best.bestLap && state.lastLap && state.lastLap <= best.bestLap ? 'NEW PERSONAL BEST' : (won ? 'CITY CUP SECURED' : 'RUN RECORDED');
    el.endFlag.textContent = flagText;
    el.endFlag.classList.remove('off');
    showScreen(el.end);
    updateTitleMeta();
  }

  // ------------------------------------------------------------------ settings + UI wiring
  function openSettings() {
    if (state.phase === 'settings') return;
    state.settingsReturn = state.phase;
    state.phase = 'settings';
    el.settings.classList.remove('hidden');
    el.pause.classList.add('hidden');
    el.start.classList.add('hidden');
    el.end.classList.add('hidden');
    showTouch(false);
    syncSettingsUI();
    audio.click();
  }
  function closeSettings() {
    if (state.phase !== 'settings') return;
    el.settings.classList.add('hidden');
    const back = state.settingsReturn || 'menu';
    let next = back;
    if (back === 'paused') { next = 'paused'; el.pause.classList.remove('hidden'); }
    else if (back === 'menu') { next = 'menu'; el.start.classList.remove('hidden'); }
    else if (back === 'won' || back === 'lost') { next = back; el.end.classList.remove('hidden'); el.end.hidden = false; }
    else { next = back === 'countdown' ? 'countdown' : 'racing'; }
    state.phase = next;
    if (next === 'paused' || next === 'racing' || next === 'countdown') showHUD(true);
    else showHUD(next !== 'menu');
    if (next === 'racing' || next === 'countdown') { showTouch(true); audio.setRaceActive(true); cameraReady = false; }
    audio.click();
  }
  function toggleMute() {
    settings.mute = !settings.mute;
    audio.setMuted(settings.mute);
    saveSettings();
    syncSettingsUI();
    updateTitleMeta();
  }
  function syncSettingsUI() {
    if (!el.settings) return;
    $('set-sensitivity').value = String(Math.round(settings.sensitivity * 100));
    $('set-volume').value = String(Math.round(settings.volume * 100));
    $('set-fov').value = String(settings.fov);
    $('set-invert').checked = !!settings.invertY;
    $('set-quality').value = settings.quality;
    $('set-mute').checked = !!settings.mute;
    $('val-sensitivity').textContent = settings.sensitivity.toFixed(2) + '×';
    $('val-volume').textContent = Math.round(settings.volume * 100) + '%';
    $('val-fov').textContent = settings.fov + '°';
    $('val-invert').textContent = settings.invertY ? 'ON' : 'OFF';
    $('val-quality').textContent = settings.quality.toUpperCase();
    $('val-mute').textContent = settings.mute ? 'ON' : 'OFF';
  }
  // buttons
  $('btn-start')?.addEventListener('click', () => { startRace(); });
  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-resume')?.addEventListener('click', resumeGame);
  $('btn-restart')?.addEventListener('click', startRace);
  $('btn-pause-settings')?.addEventListener('click', openSettings);
  $('btn-quit')?.addEventListener('click', showMenu);
  $('btn-close-settings')?.addEventListener('click', closeSettings);
  $('btn-settings-done')?.addEventListener('click', closeSettings);
  $('btn-again')?.addEventListener('click', startRace);
  $('btn-end-menu')?.addEventListener('click', showMenu);
  $('btn-reset-save')?.addEventListener('click', () => {
    best.bestLap = null; best.bestPosition = null; best.wins = 0; best.last = '—';
    saveBest(); updateTitleMeta(); syncSettingsUI();
  });
  const bindSetting = (id, event, fn) => { const n = $(id); if (n) n.addEventListener(event, fn); };
  bindSetting('set-sensitivity', 'input', (e) => { settings.sensitivity = e.target.value / 100; $('val-sensitivity').textContent = settings.sensitivity.toFixed(2) + '×'; saveSettings(); });
  bindSetting('set-volume', 'input', (e) => { settings.volume = e.target.value / 100; audio.setVolume(settings.volume); $('val-volume').textContent = Math.round(settings.volume * 100) + '%'; saveSettings(); });
  bindSetting('set-fov', 'input', (e) => { settings.fov = +e.target.value; $('val-fov').textContent = settings.fov + '°'; saveSettings(); });
  bindSetting('set-invert', 'change', (e) => { settings.invertY = e.target.checked; $('val-invert').textContent = settings.invertY ? 'ON' : 'OFF'; saveSettings(); });
  bindSetting('set-quality', 'change', (e) => { applyQuality(e.target.value); $('val-quality').textContent = settings.quality.toUpperCase(); });
  bindSetting('set-mute', 'change', (e) => { settings.mute = e.target.checked; audio.setMuted(settings.mute); $('val-mute').textContent = settings.mute ? 'ON' : 'OFF'; saveSettings(); updateTitleMeta(); });
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => audio.click()));
  window.addEventListener('resize', () => { G.resize(); camera.aspect = innerWidth / Math.max(1, innerHeight); camera.updateProjectionMatrix(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && (state.phase === 'racing' || state.phase === 'countdown')) pauseGame(); });

  // ------------------------------------------------------------------ markers update
  function updateMarkers(time) {
    const show = state.phase === 'racing' || state.phase === 'countdown';
    for (const sp of markerSprites) {
      if (!show) { sp.visible = false; continue; }
      const dx = sp.position.x - camera.position.x, dz = sp.position.z - camera.position.z;
      const d = Math.hypot(dx, dz);
      sp.visible = d < 140 && d > 5;
      sp.material.opacity = clamp(1 - d / 150, 0.08, 0.92) * smoothstep(4, 14, d);
      sp.position.y = sp.userData.baseY + Math.sin(time * 1.7 + sp.position.x * 0.4) * 0.07;
      const sc = sp.userData.scale;
      sp.scale.set(sc * 2.2, sc * 1.1, 1);
    }
    world.hazards.forEach((h) => { if (h.hit && h.marker) h.marker.visible = false; });
  }

  // ------------------------------------------------------------------ ambient life
  const birds = new THREE.Group();
  {
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2c2a28, side: THREE.DoubleSide });
    for (let i = 0; i < 8; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -0.45, 0.1, -0.08, 0, 0.02, 0.08], 3));
      const m = new THREE.Mesh(g, birdMat);
      m.userData = { r: 28 + R(0, 16), a: R(0, 6.28), h: 26 + R(0, 18), sp: R(0.08, 0.18) };
      birds.add(m);
    }
    birds.name = 'birds'; G.scene.add(birds);
  }
  function updateAmbient(dt, time) {
    birds.children.forEach((b) => {
      b.userData.a += b.userData.sp * dt;
      b.position.set(40 + Math.cos(b.userData.a) * b.userData.r, b.userData.h + Math.sin(time * 0.6 + b.userData.a) * 2, -30 + Math.sin(b.userData.a) * b.userData.r * 0.7);
      b.rotation.y = -b.userData.a;
      b.rotation.z = Math.sin(time * 6 + b.userData.a) * 0.35;
    });
    dust.points.visible = false;
  }

  // ------------------------------------------------------------------ main loop
  const clock = { last: performance.now(), fps: 60, acc: 0 };
  let time = FREEZE ? 12.4 : 0;
  let frames = 0;
  let readyShown = false;
  function frame(now) {
    const raw = Math.min(0.05, Math.max(0.0001, (now - clock.last) / 1000));
    clock.last = now;
    if (!FREEZE) {
      time += raw;
      state.time = time;
      clock.fps = lerp(clock.fps, 1 / raw, 0.06);
      G.skyUniforms.uTime.value = time * 0.45;
      // countdown
      if (state.phase === 'countdown') {
        state.countdown -= raw;
        const n = Math.ceil(state.countdown);
        if (n >= 1) {
          if (n !== state._lastCount) { state._lastCount = n; raceMessage(String(n), 'show'); audio.count(n); }
        }
        if (state.countdown <= 0) beginRacing();
        readInput();
        updateKartVisuals(raw, time);
        updateAmbient(raw, time);
      } else if (state.phase === 'racing') {
        if (state.captureHold) {
          // posed still: keep the world exactly as staged while the capture runs
          updateKartVisuals(0, time);
          updateEffects(0);
          updateAmbient(0, time);
        } else {
          readInput();
          state.effectsEnabled = true;
          stepWorld(raw, true);
          updateKartVisuals(raw, time);
          updateEffects(raw);
          updateAmbient(raw, time);
        }
      } else if (state.phase === 'menu') {
        updateKartVisuals(raw, time);
        updateAmbient(raw, time);
        updateEffects(raw);
      } else if (state.phase === 'won' || state.phase === 'lost') {
        updateKartVisuals(raw, time);
        updateEffects(raw);
        updateAmbient(raw, time);
      }
      if (state.phase !== 'paused' && state.phase !== 'settings') updateMarkers(time);
      // camera
      updateCamera(raw, time);
      // sun follows the action so the shadow map stays useful
      const px = Math.round(player.pos.x / 3) * 3, pz = Math.round(player.pos.z / 3) * 3;
      G.sun.target.position.set(px, 0, pz);
      G.sun.position.copy(G.sun.target.position).addScaledVector(G.SUN_DIR, 170);
      // HUD
      if (state.phase === 'racing' || state.phase === 'countdown' || state.phase === 'paused' || state.phase === 'settings') updateHUD(time);
      if (state.phase === 'paused' || state.phase === 'settings') updatePauseStats();
      audio.updateEngine(player.vel.length(), ctl.throttle, player.drifting, player.latSlip, player.boosting || player.turbo > 0);
    } else {
      // still update the simulation of nothing; a frozen frame stays reproducible
      G.skyUniforms.uTime.value = 6.0;
      state.effectsEnabled = false;
      readInput();
      updateKartVisuals(0, time);
      updateMarkers(time);
      updateCamera(0, time);
    }
    G.setTime(time);
    const stats = G.renderPost(raw);
    window.__CAM_POS = { x: camera.position.x, z: camera.position.z };
    frames++;
    if (!readyShown && frames > 8) {
      readyShown = true;
      window.__READY = true;
      setTimeout(() => { el.loading.classList.add('fade-out'); setTimeout(() => el.loading.classList.add('hidden'), 650); }, 220);
    }
    window.__STATS = { calls: stats.calls, triangles: stats.tris, fps: Math.round(clock.fps), phase: state.phase };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ boot
  // start state
  state.phase = 'menu';
  resetRaceState();
  computeCameras();
  updateTitleMeta();
  syncSettingsUI();
  const tl = document.getElementById('title-laps'); if (tl) tl.textContent = state.laps + ' LAPS';
  const tc = document.getElementById('title-circuit'); if (tc) tc.textContent = (LAP / 1000).toFixed(2) + ' KM · ' + state.laps + ' LAPS';
  showScreen(el.start);
  showHUD(false);
  showTouch(false);
  el.end.hidden = true;
  const storedOpts = readJSON(KEY_SET, {});
  if (!storedOpts.quality && (touchAvailable() || innerWidth < 900)) settings.quality = 'medium';
  if (settings.quality && settings.quality !== 'high') applyQuality(settings.quality);
  camera.position.copy(titleCam.pos);
  camera.lookAt(titleCam.look);
  updateHUD(0);
  window.__STATS = { calls: 0, triangles: 0, fps: 0, phase: 'menu' };

  // ------------------------------------------------------------------ contracts
  window.__SCENE = G.scene;
  window.__AUDIT = [
    { name: 'kart-player', size: 2.6, segments: 32, parts: 12, texelDensity: 160, bevel: true, ao: true },
    { name: 'start-gantry', size: 16, segments: 10, parts: 9, texelDensity: 64, bevel: true, ao: false },
    { name: 'facades', size: 30, segments: 8, parts: 6, texelDensity: 90, bevel: true, ao: false },
    { name: 'street-lamps', size: 8, segments: 10, parts: 4, texelDensity: 48, bevel: false, ao: true },
  ];
  window.__COLLIDERS = world.colliders;
  const B = track.bounds;
  window.__BOUNDS = {
    x0: B.x0 - 12, x1: B.x1 + 12, z0: B.z0 - 12, z1: B.z1 + 12, playerRadius: 0.8,
  };
  window.__TESTMOVE = (x, z, dx, dz) => {
    const nx = clamp(x + dx, window.__BOUNDS.x0, window.__BOUNDS.x1);
    const nz = clamp(z + dz, window.__BOUNDS.z0, window.__BOUNDS.z1);
    const near = track.nearest(nx, nz, -1);
    if (Math.abs(near.lateral) > track.WALL_OFF - 0.94) return [x, z];
    for (const c of world.colliders) {
      if (nx > c.x0 - 0.8 && nx < c.x1 + 0.8 && nz > c.z0 - 0.8 && nz < c.z1 + 0.8) {
        if (c.y0 < 1.9 && c.y1 > 0.05) return [x, z];
      }
    }
    return [nx, nz];
  };
  G.game = {
    state, player, ais, karts, startRace, pauseGame, resumeGame, openSettings, closeSettings,
    showMenu, saveAll, endRace, syncSettingsUI,
  };
  window.__GAME = { state, actions: { startRace, pauseGame, resumeGame, openSettings, closeSettings, showMenu, saveAll }, reset: showMenu };

  function snapshot() {
    const near = track.nearest(player.pos.x, player.pos.z, player.idx);
    return {
      phase: state.phase, lap: state.lapsDone, laps: state.laps, position: state.position,
      health: Math.round(player.health), nitro: Math.round(player.nitro),
      speed: +(player.vel.length() * 3.6).toFixed(1), raceTime: +state.raceTime.toFixed(2),
      countdown: +state.countdown.toFixed(2), raceDistance: +player.raceDistance.toFixed(1),
      trackS: +(near.s).toFixed(1), lateral: +near.lateral.toFixed(2),
      bestLap: state.bestLap, lastLap: state.lastLap, failed: state.failed, won: state.won,
      cause: state.cause, started: state.started, finalShown: state.finalShown,
      drifting: !!player.drifting, driftTime: +player.driftTime.toFixed(2), turbo: +player.turbo.toFixed(2),
      standings: computeStandings().map((k) => ({ name: k.name, number: k.number, d: +k.raceDistance.toFixed(1) })),
    };
  }
  let autopilotOn = false;
  function autoControls() {
    const near = track.nearest(player.pos.x, player.pos.z, player.idx);
    const ahead = track.atDistance(near.s + 16);
    const lookAt = ahead.p.clone().addScaledVector(ahead.n, clamp(-near.lateral * 0.4, -2, 2));
    const desired = Math.atan2(lookAt.x - player.pos.x, lookAt.z - player.pos.z);
    const diff = wrapAngle(desired - player.heading);
    ctl.steer = clamp(-diff * 2.4, -1, 1);
    const t1 = track.atDistance(near.s + 12), t2 = track.atDistance(near.s + 34);
    const turn = Math.abs(wrapAngle(Math.atan2(t2.t.x, t2.t.z) - Math.atan2(t1.t.x, t1.t.z)));
    const maxSpeed = clamp(31 - turn * 25, 9.5, 30);
    const speed = player.vel.length();
    ctl.throttle = speed < maxSpeed ? 1 : 0;
    ctl.brake = speed > maxSpeed + 3 ? 1 : 0;
    ctl.drift = false;
    ctl.boost = player.nitro > 30 && turn < 0.22 && speed > 12;
  }
  function autopilot(seconds) {
    if (state.phase === 'menu') startRace();
    if (state.phase === 'countdown') { state.countdown = 0; beginRacing(); }
    if (state.phase !== 'racing') return snapshot();
    autopilotOn = true;
    state.effectsEnabled = false;
    const steps = Math.floor(Math.max(0, seconds) / (1 / 60));
    for (let i = 0; i < steps && state.phase === 'racing'; i++) {
      autoControls();
      state.raceTime += 1 / 60;
      if (state.raceTime >= state.limit) { endRace(false, 'RACE CLOCK EXPIRED — THE CITY CUP SLIPPED AWAY.'); break; }
      const h = 1 / 60;
      stepPlayer(h);
      for (const ai of ais) stepAI(ai, h);
      resolveWall();
      checkPadsAndHazards();
      updateProgress();
    }
    autopilotOn = false;
    state.effectsEnabled = true;
    updateHUD(state.time);
    return snapshot();
  }
  window.__TEST = (action, arg) => {
    switch (action) {
      case 'start': startRace(); break;
      case 'pause': pauseGame(); break;
      case 'resume': resumeGame(); break;
      case 'openSettings': openSettings(); break;
      case 'closeSettings': closeSettings(); break;
      case 'save': saveAll(); break;
      case 'state': break;
      case 'reset': showMenu(); break;
      case 'race': if (state.phase === 'menu' || state.phase === 'countdown') { if (state.phase === 'menu') startRace(); state.countdown = 0; beginRacing(); } break;
      case 'tick': {
        if (state.phase === 'racing') {
          state.raceTime += Math.max(0, +arg || 0);
          if (state.raceTime >= state.limit) endRace(false, 'RACE CLOCK EXPIRED — THE CITY CUP SLIPPED AWAY.');
        }
        break;
      }
      case 'hurt': if (state.phase === 'racing') damagePlayer(+arg || 30, 'TEST IMPACT'); break;
      case 'autopilot': return autopilot(+arg || 30);
      case 'finish': { const pos = karts.length; endRace(+arg === 1 || arg === true, +arg === 1 ? 'TEST WIN' : 'TEST FINISH'); break; }
      case 'drive': {
        if (state.phase === 'menu') { startRace(); state.countdown = 0; beginRacing(); }
        if (state.phase !== 'racing') return snapshot();
        const o = Object.assign({ secs: 2, throttle: 1, brake: 0, steer: 0, drift: false, boost: false }, arg || {});
        ctl.throttle = o.throttle; ctl.brake = o.brake; ctl.steer = clamp(o.steer, -1, 1); ctl.drift = !!o.drift; ctl.boost = !!o.boost;
        state.effectsEnabled = false;
        const n = Math.min(600, Math.floor((+o.secs || 2) * 60));
        for (let i = 0; i < n && state.phase === 'racing'; i++) {
          state.raceTime += 1 / 60;
          if (state.raceTime >= state.limit) { endRace(false, 'RACE CLOCK EXPIRED — THE CITY CUP SLIPPED AWAY.'); break; }
          stepPlayer(1 / 60);
          for (const ai of ais) stepAI(ai, 1 / 60);
          resolveWall();
          checkPadsAndHazards();
          updateProgress();
        }
        resetControls();
        updateHUD(state.time);
        return snapshot();
      }
      case 'plan': return {
        objectives: [{ id: 'city-cup', title: 'Win the Sunset District Grand Prix', steps: 4 }],
        roles: ['rival-kart', 'boost-pad', 'hazard-cone'],
        tools: ['drift', 'nitro'],
        beats: ['lights-out', 'lap-one', 'mid-race', 'final-lap', 'chequered-flag'],
        markerRange: 140, laps: state.laps, circuit: LAP,
      };
      case 'menu': showMenu(); break;
      default: break;
    }
    return snapshot();
  };
  window.__HURT = (n) => { damagePlayer(+n || 10, 'TEST IMPACT'); return snapshot(); };
  // ---------------------------------------------------------------- capture-only staging
  // These helpers are used by the screenshot tool to pose feature stills. Normal
  // play never calls them and they do not change any of the racing rules.
  function showcaseReset() {
    state.captureHold = false;
    state.captureHideMarkers = false;
    state.captureControls = null;
    state.captureCam = null;
    startRace();
    state.countdown = 0;
    beginRacing();
    state.effectsEnabled = true;
    state.lastLap = 22.4;
    state.bestLap = 21.6;
    state.topSpeed = 104;
  }
  function showcasePlace(d, lat, speed, lapBase, raceTime) {
    const at = track.atDistance(((d % LAP) + LAP) % LAP);
    const p = player;
    p.pos.set(at.p.x + at.n.x * lat, 0.015, at.p.z + at.n.z * lat);
    p.heading = Math.atan2(at.t.x, at.t.z);
    p.vel.set(Math.sin(p.heading) * speed, 0, Math.cos(p.heading) * speed);
    p.idx = at.i;
    p.raceDistance = lapBase * LAP + d;
    p.invuln = 0;
    cameraReady = false;
    state.raceTime = raceTime;
    state.lapsDone = lapBase;
    state.started = true;
    state.lapStart = Math.max(0, raceTime - 22);
    state.raceDistance = p.raceDistance;
  }
  function showcaseAI(baseD, lapBase, offsets, speed = 18) {
    ais.forEach((ai, i) => {
      const raw = baseD + (offsets[i] ?? (10 + i * 4));
      const at = track.atDistance(((raw % LAP) + LAP) % LAP);
      ai.s = ((raw % LAP) + LAP) % LAP;
      ai.offset = ((i % 3) - 1) * 1.55;
      ai.speed = speed;
      ai.pos.set(at.p.x + at.n.x * ai.offset, 0.015, at.p.z + at.n.z * ai.offset);
      ai.heading = Math.atan2(at.t.x, at.t.z);
      ai.raceDistance = lapBase * LAP + raw;
      syncKartTransform(ai);
    });
    state.position = computeStandings().indexOf(player) + 1;
  }
  function showcaseSmokeBurst(count = 12) {
    rearWheelPoints(player, rw);
    const h = player.heading;
    const side = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    for (const w of rw) {
      const outward = (w === rw[0] ? 1 : -1);
      for (let i = 0; i < count; i++) {
        smoke.spawn(w.x + side.x * outward * (0.22 + Math.random() * 0.6) + (Math.random() - 0.5) * 0.35,
          0.24 + Math.random() * 0.85,
          w.z + side.z * outward * (0.22 + Math.random() * 0.6) + (Math.random() - 0.5) * 0.35,
          (Math.random() - 0.5) * 1.8, 0.4 + Math.random() * 1.0, (Math.random() - 0.5) * 1.8,
          1.2 + Math.random() * 1.0, 1.0 + Math.random() * 1.0);
      }
      skid.add(w.x, w.z, Math.atan2(player.vel.x, player.vel.z) + Math.PI / 2, 0.16, 0.95);
    }
    smoke.update(0.016);
  }
  function showcaseSparkBurst(n = 18) {
    const back = new THREE.Vector3(-Math.sin(player.heading), 0, -Math.cos(player.heading));
    for (let i = 0; i < n; i++) {
      sparks.spawn(player.pos.x + back.x * 1.1 + (Math.random() - 0.5) * 0.35, 0.28,
        player.pos.z + back.z * 1.1 + (Math.random() - 0.5) * 0.35,
        back.x * (2 + Math.random() * 4), 0.4 + Math.random() * 2.6, back.z * (2 + Math.random() * 4),
        0.30 + Math.random() * 0.35, 0.45 + Math.random() * 0.55);
    }
    sparks.update(0.016);
  }
  function showcaseChaseCam(back, side, height, ahead, lookY, fov) {
    const h = player.heading;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const right = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    state.captureCam = {
      x: player.pos.x - fwd.x * back - right.x * side,
      y: height,
      z: player.pos.z - fwd.z * back - right.z * side,
      tx: player.pos.x + fwd.x * ahead,
      ty: lookY,
      tz: player.pos.z + fwd.z * ahead,
      fov,
    };
    cameraReady = true;
  }
  function showcaseSetHud(lap, pos, health, nitro) {
    if (lap !== undefined) state.lapsDone = lap;
    if (pos !== undefined) state.position = pos;
    if (health !== undefined) { player.health = health; state.health = health; }
    if (nitro !== undefined) { player.nitro = nitro; state.nitro = nitro; }
    updateHUD(0);
  }
  function showcaseFindCorner(start) {
    let best = start, bestTurn = 0;
    for (let d = start; d < LAP - 50; d += 3) {
      const a = track.atDistance(d), b = track.atDistance(d + 20);
      const turn = Math.abs(wrapAngle(Math.atan2(b.t.x, b.t.z) - Math.atan2(a.t.x, a.t.z)));
      if (turn > bestTurn) { bestTurn = turn; best = d; }
    }
    return best;
  }
  G.showcase = {
    title() {
      state.captureControls = null; state.captureCam = null;
      showMenu();
    },
    hero() {
      state.captureControls = null; state.captureCam = null;
      showMenu();
      hideAllScreens(); showHUD(false); showTouch(false); hideSubtitle();
    },
    kart() {
      state.captureControls = null;
      showMenu(); hideAllScreens(); showHUD(false); showTouch(false); hideSubtitle();
      const h = player.heading;
      const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
      const right = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
      state.captureCam = {
        x: player.pos.x + fwd.x * 2.15 + right.x * 1.55, y: 1.10,
        z: player.pos.z + fwd.z * 2.15 + right.z * 1.55,
        tx: player.pos.x + fwd.x * 0.15 + right.x * 0.12, ty: 0.52,
        tz: player.pos.z + fwd.z * 0.15 + right.z * 0.12, fov: 48,
      };
      cameraReady = true;
      updateKartVisuals(0.016, state.time);
    },
    race() {
      showcaseReset();
      showcasePlace(30, 0.9, 21, 0, 46);
      showcaseAI(30, 0, [10, 14, 19, 24, 29], 18);
      showcaseSetHud(0, 6, 92, 74);
      player.turbo = 0;
      state.captureControls = { throttle: 1, steer: 0, drift: false, boost: false };
      updateKartVisuals(0.016, state.time);
      showSubtitle('Four laps. Five rivals. The city is watching.', 'RACE CONTROL');
      updateHUD(0);
    },
    drift() {
      showcaseReset();
      const corner = showcaseFindCorner(78);
      showcasePlace(corner - 6, 0.35, 20, 1, 63);
      const near = track.nearest(player.pos.x, player.pos.z, -1);
      // slide: the nose points into the corner while the velocity follows the road
      player.heading = Math.atan2(near.t.x, near.t.z) + 0.34;
      player.vel.set(near.t.x * 20, 0, near.t.z * 20);
      showcaseAI(corner - 6, 1, [-30, -23, 15, 22, 29], 19);
      showcaseSetHud(1, 3, 86, 46);
      player.drifting = true; player.driftTime = 1.7; player.latSlip = 8.5; player.steer = 0.55;
      state.captureHideMarkers = true;
      showcaseSmokeBurst(22);
      state.captureControls = { throttle: 0.5, steer: 0.55, drift: true, boost: false };
      state.captureCam = {
        x: player.pos.x - near.t.x * 4.2 + near.n.x * 2.7, y: 1.72,
        z: player.pos.z - near.t.z * 4.2 + near.n.z * 2.7,
        tx: player.pos.x + near.t.x * 2.2, ty: 0.56,
        tz: player.pos.z + near.t.z * 2.2, fov: 50,
      };
      cameraReady = true;
      updateKartVisuals(0.016, state.time);
      showSubtitle('Drift — charge nitro, release for a mini-turbo.', 'COACH');
      updateHUD(0);
    },
    boost() {
      showcaseReset();
      const pad = world.boostPads[0];
      const padLat = track.nearest(pad.x, pad.z).lateral;
      showcasePlace(pad.d - 7.5, padLat, 24, 0, 31);
      showcaseAI(pad.d - 7.5, 0, [-9, -14, -21, -28, -35], 20);
      showcaseSetHud(0, 2, 88, 94);
      player.turbo = 1.2; player.boosting = true; player.nitro = 94;
      state.captureControls = { throttle: 1, steer: 0, drift: false, boost: true };
      showcaseSparkBurst(22);
      showcaseChaseCam(4.7, 1.2, 1.65, 6.4, 0.62, 54);
      updateKartVisuals(0.016, state.time);
      showSubtitle('Boost pad — nitro topped up. Spend it on the straight.', 'COACH');
      updateHUD(0);
    },
    hazard() {
      showcaseReset();
      const hz = world.hazards[0];
      const hzLat = track.nearest(hz.x, hz.z).lateral;
      showcasePlace(hz.d - 7.5, hzLat + 0.7, 15, 1, 72);
      showcaseAI(hz.d - 7.5, 1, [12, 17, 23, 29, 35], 17);
      showcaseSetHud(1, 4, 84, 71);
      state.captureControls = { throttle: 1, steer: 0, drift: false, boost: false };
      showcaseChaseCam(4.4, 1.5, 1.75, 6.2, 0.5, 54);
      updateKartVisuals(0.016, state.time);
      showSubtitle('Cones on the racing line — watch the orange boards.', 'RACE CONTROL');
      updateHUD(0);
    },
    lap() {
      showcaseReset();
      showcasePlace(55, 0.2, 18, 1, 66);
      showcaseAI(55, 1, [-12, -7, 7, 13, 19], 18);
      showcaseSetHud(1, 2, 91, 63);
      state.captureControls = { throttle: 1, steer: 0, drift: false, boost: false };
      updateKartVisuals(0.016, state.time);
      showLapBanner('LAP 2 / 4');
      clearTimeout(showLapBanner._t);
      showSubtitle('Lap two. The river straight is where the race is won.', 'RACE CONTROL');
      updateHUD(0);
    },
    pause() {
      showcaseReset();
      state.captureControls = null;
      pauseGame();
    },
    settings() {
      showMenu();
      openSettings();
    },
    lose() {
      showcaseReset();
      state.captureControls = null;
      state.raceTime = state.limit;
      endRace(false, 'RACE CLOCK EXPIRED — THE CITY CUP SLIPPED AWAY.');
    },
    win() {
      showcaseReset();
      state.captureControls = null;
      __TEST('autopilot', 160);
    },
    mobile() {
      showcaseReset();
      showcasePlace(30, 0.9, 18, 0, 44);
      showcaseAI(30, 0, [9, 13, 18, 23, 28], 18);
      showcaseSetHud(0, 6, 93, 78);
      state.captureControls = { throttle: 1, steer: 0, drift: false, boost: false };
      updateKartVisuals(0.016, state.time);
      showSubtitle('Touch controls: left/right, GAS, BRK, DRIFT, NITRO.', 'COACH');
      updateHUD(0);
      showTouch(true);
    },
    settle() {
      // freeze simulation, sync the visuals and render one deterministic frame
      state.captureHold = true;
      updateKartVisuals(0, state.time);
      updateEffects(0);
      updateAmbient(0, state.time);
      updateHUD(state.time);
      updateMarkers(state.time);
      if (state.captureHideMarkers) for (const sp of markerSprites) sp.visible = false;
      updateCamera(0, state.time);
      G.renderPost(0);
      window.__CAM_POS = { x: camera.position.x, z: camera.position.z };
    },
  };

  window.__PRODUCT = {
    title: { name: 'SUNSET DISTRICT — City Kart Grand Prix', start: '#start', hud: '#hud', hudHiddenOnTitle: true },
    screens: ['menu', 'playing', 'paused', 'settings', 'lost', 'won'],
    ui: { start: '#start', hud: '#hud', pause: '#pause', settings: '#settings', end: '#end', touch: '#touch' },
    settings: ['sensitivity', 'volume', 'fov', 'invertY', 'quality'],
    persistence: [KEY_BEST, KEY_SET],
    input: { keyboard: true, mouse: true, touch: true },
    content: {
      objectives: [{ id: 'city-cup', title: 'Win the Sunset District Grand Prix', steps: 4 }],
      roles: ['rival-kart', 'boost-pad', 'hazard-cone'],
      tools: ['drift', 'nitro'],
      beats: ['lights-out', 'lap-one', 'mid-race', 'final-lap', 'chequered-flag'],
    },
    hud: ['objective', 'health', 'compass', 'prompt', 'subtitles', 'speed'],
    audio: { events: 10, mute: true },
    perf: { maxCalls: 700, maxTris: 1600000, maxLights: 8 },
    cameras: G.productCameras || [],
    test: { start: 'start', pause: 'pause', resume: 'resume', settings: 'openSettings', save: 'save' },
  };
  // initial product cameras
  window.__PRODUCT.cameras = G.productCameras || [];

  // deterministic capture hooks: ?race=1 starts a race, ?q=low|medium|high|ultra forces a preset
  const QQ = new URLSearchParams(location.search);
  const qOverride = QQ.get('q');
  if (qOverride && G.QUALITY[qOverride]) { settings.quality = qOverride; G.setQuality(qOverride); }
  if (QQ.get('race') === '1') {
    startRace();
    state.countdown = 0;
    beginRacing();
    state.effectsEnabled = false;
    if (QQ.get('demo') === '1') __TEST('autopilot', 5.5);
    if (HOLD_UI) showSubtitle('Lights out. Drift early, nitro late — and mind the walls.', 'RACE CONTROL');
    updateHUD(0);
    state.effectsEnabled = true;
  }
  const screenQ = QQ.get('screen');
  if (screenQ === 'settings') openSettings();
  else if (screenQ === 'pause') { if (state.phase === 'menu') startRace(); state.countdown = 0; beginRacing(); pauseGame(); }
  else if (screenQ === 'end') { if (state.phase === 'menu') startRace(); state.countdown = 0; beginRacing(); __TEST('tick', 240); }
  else if (screenQ === 'won') { if (state.phase === 'menu') startRace(); state.countdown = 0; beginRacing(); __TEST('autopilot', 160); }
  // start the visual loop
  requestAnimationFrame((t) => { clock.last = t; frame(t); });
})();
