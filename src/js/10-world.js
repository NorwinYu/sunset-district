/* ================= WORLD: the city of Aranya, the circuit, the dressing ================= */
(function () {
  const G = window.__G, THREE = G.THREE;
  const { clamp, lerp, smoothstep, damp, R, RI, pick, fmtTime } = G.util;
  const M = G.M, TEX = G.TEX;

  // ---------------------------------------------------------------- circuit
  // A clockwise downtown loop: a long start straight, a fast northern sweep,
  // a tight eastern hairpin and a technical final sector. Dimensions in metres.
  const TRACK_PTS = [
    [0, 20], [0, -12], [1, -40], [7, -62], [22, -80], [46, -92], [76, -98],
    [104, -94], [124, -80], [134, -58], [136, -34], [132, -12], [120, 6],
    [100, 18], [76, 24], [54, 28], [31, 38], [16, 50], [7, 62], [0, 55],
  ];
  const HW = 5.2;          // road half width
  const CURB_W = 0.55;
  const WALL_OFF = 6.28;   // barrier centre
  const SIDEWALK0 = 6.65;
  const SIDEWALK1 = 11.15;

  const curvePts = TRACK_PTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(curvePts, true, 'catmullrom', 0.5);
  const N = 1600;
  const raw = curve.getSpacedPoints(N);
  const samples = [];
  let total = 0;
  for (let i = 0; i < N; i++) {
    const p = raw[i];
    const pn = raw[(i + 1) % N], pp = raw[(i - 1 + N) % N];
    const t = new THREE.Vector3(pn.x - pp.x, 0, pn.z - pp.z).normalize();
    const n = new THREE.Vector3(t.z, 0, -t.x); // left of travel
    if (i > 0) total += Math.hypot(p.x - raw[i - 1].x, p.z - raw[i - 1].z);
    samples.push({ p, t, n, s: total });
  }
  const LAP = total + samples[0].p.distanceTo(samples[N - 1].p);
  for (const s of samples) s.u = s.s / LAP;

  function atDistance(d) {
    let u = ((d % LAP) + LAP) % LAP;
    const f = u / LAP * N;
    const i = Math.floor(f) % N, j = (i + 1) % N, t = f - Math.floor(f);
    const a = samples[i], b = samples[j];
    const p = new THREE.Vector3(lerp(a.p.x, b.p.x, t), 0, lerp(a.p.z, b.p.z, t));
    const tan = new THREE.Vector3(lerp(a.t.x, b.t.x, t), 0, lerp(a.t.z, b.t.z, t)).normalize();
    const n = new THREE.Vector3(tan.z, 0, -tan.x);
    return { p, t: tan, n, i, s: u };
  }
  // nearest sample to a world point; hint makes the common case cheap
  function nearest(x, z, hint = -1) {
    let best = 1e18, bi = 0;
    if (hint >= 0) {
      for (let k = -80; k <= 80; k++) {
        const i = (hint + k + N) % N, p = samples[i].p;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
    } else {
      for (let i = 0; i < N; i += 4) {
        const p = samples[i].p, d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
      for (let k = -5; k <= 5; k++) {
        const i = (bi + k + N) % N, p = samples[i].p;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
    }
    const s = samples[bi];
    const dx = x - s.p.x, dz = z - s.p.z;
    const lateral = dx * s.n.x + dz * s.n.z;
    const along = dx * s.t.x + dz * s.t.z;
    return { i: bi, dist: Math.sqrt(best), lateral, along, s: s.s, p: s.p, n: s.n, t: s.t };
  }
  const distToTrack = (x, z) => Math.sqrt(nearest(x, z).dist ** 2);
  const track = { samples, N, LAP, atDistance, nearest, distToTrack, HW, WALL_OFF, SIDEWALK0, SIDEWALK1, TRACK_PTS };
  G.track = track;

  // road centre used by cameras / minimap
  const bounds = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
  for (const s of samples) { bounds.x0 = Math.min(bounds.x0, s.p.x); bounds.x1 = Math.max(bounds.x1, s.p.x); bounds.z0 = Math.min(bounds.z0, s.p.z); bounds.z1 = Math.max(bounds.z1, s.p.z); }
  G.track.bounds = bounds;
  G.track.center = new THREE.Vector3((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2);
  G.track.radius = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0) / 2;

  // ---------------------------------------------------------------- shared builders
  const root = new THREE.Group(); root.name = 'city';
  G.scene.add(root);
  const world = G.world = { root, props: [], boostPads: [], hazards: [], markerSprites: [], noReflect: [] };
  const shadowCasters = [];

  function ribbon(offA, offB, yA, yB, vScale = 10, uScale = 1, closed = true, colorFn = null) {
    const pos = [], nor = [], uv = [], idx = [], col = [];
    const n = N;
    for (let i = 0; i <= n; i++) {
      const s = samples[i % n];
      const pa = new THREE.Vector3(s.p.x + s.n.x * offA, yA, s.p.z + s.n.z * offA);
      const pb = new THREE.Vector3(s.p.x + s.n.x * offB, yB, s.p.z + s.n.z * offB);
      pos.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      nor.push(0, 1, 0, 0, 1, 0);
      const v = (i === n ? LAP : s.s) / vScale;
      uv.push(0, v, uScale, v);
      const c = colorFn ? colorFn(i) : null;
      if (c) { const cc = new THREE.Color(c); col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b); }
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (colorFn) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeBoundingSphere();
    return g;
  }

  // solid strip with vertical outer face (curbs/sidewalk)
  function ledge(offIn, offOut, top, thick, vScale = 8) {
    const pos = [], nor = [], uv = [], idx = [];
    const n = N;
    for (let i = 0; i <= n; i++) {
      const s = samples[i % n];
      const v = (i === n ? LAP : s.s) / vScale;
      const pts = [
        [offIn, top], [offOut, top], [offOut, top - thick],
      ];
      for (const [o, y] of pts) {
        pos.push(s.p.x + s.n.x * o, y, s.p.z + s.n.z * o);
        const isTop = y === top;
        nor.push(isTop ? 0 : s.n.x * Math.sign(offOut), isTop ? 1 : 0, isTop ? 0 : s.n.z * Math.sign(offOut));
        uv.push(o / vScale, v);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = i * 3;
      // top
      idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4);
      // outer face
      idx.push(a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeBoundingSphere();
    return g;
  }

  // ---------------------------------------------------------------- ground + road
  const groundMat = M.concrete.clone();
  groundMat.map = TEX.paving.alb.clone(); groundMat.map.repeat.set(40, 40); groundMat.map.needsUpdate = true;
  groundMat.color = new THREE.Color(0x6d6a63); groundMat.roughness = 0.95;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.set(60, -0.09, -20);
  ground.receiveShadow = true; ground.name = 'city-ground'; ground.userData.passable = true;
  ground.userData.surfaceProcedural = true;
  root.add(ground); world.noReflect.push(ground);

  const road = new THREE.Mesh(ribbon(-HW, HW, 0.025, 0.025, 15, 1), M.asphalt);
  road.receiveShadow = true; road.name = 'circuit-asphalt'; road.userData.passable = true;
  road.userData.surfaceProcedural = true;
  road.userData.identity = [{ name: 'surface', extents: [12, LAP, 1] }]; road.userData.parts = ['surface'];
  root.add(road); world.noReflect.push(road);

  // curbs: alternating weathered red / cream every few metres
  const curbColor = (i) => {
    const band = Math.floor(i / 26) % 2;
    return band ? 0xc9bfae : 0xb74936;
  };
  for (const side of [-1, 1]) {
    const a = side * HW, b = side * (HW + CURB_W);
    const g = ribbon(Math.min(a, b), Math.max(a, b), 0.085, 0.085, 9, 1, true, curbColor);
    const mesh = new THREE.Mesh(g, M.curb.clone());
    mesh.material.vertexColors = true; mesh.material.color.set(0xffffff);
    mesh.material.needsUpdate = true; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.name = 'curb-' + (side < 0 ? 'left' : 'right'); mesh.userData.passable = true;
    root.add(mesh); world.noReflect.push(mesh);
  }
  // sidewalk top + outer face
  for (const side of [-1, 1]) {
    const o1 = side * SIDEWALK0, o2 = side * SIDEWALK1;
    const g = ledge(Math.min(o1, o2), Math.max(o1, o2), 0.15, 0.16, 5.5);
    const mesh = new THREE.Mesh(g, M.sidewalk);
    mesh.receiveShadow = true; mesh.name = 'sidewalk-' + (side < 0 ? 'left' : 'right'); mesh.userData.passable = true;
    mesh.userData.surfaceProcedural = true;
    root.add(mesh); world.noReflect.push(mesh);
  }

  // paint: edge lines, dashed pit exit, start/finish checker, grid slots
  const paintBags = { white: [], red: [], yellow: [] };
  for (const side of [-1, 1]) {
    const o = side * (HW - 0.42);
    const g = ribbon(o - 0.07, o + 0.07, 0.038, 0.038, 12, 1);
    paintBags.white.push({ geometry: g });
  }
  // start/finish checker: 16 x 2 cells across the road
  {
    const s0 = 0;
    const at = atDistance(s0);
    const cellW = (HW * 2) / 16, cellD = 1.05;
    const base = new THREE.Matrix4().makeRotationY(Math.atan2(at.t.x, at.t.z));
    for (let r = 0; r < 2; r++) for (let c = 0; c < 16; c++) {
      if ((r + c) % 2) continue;
      const off = -HW + (c + 0.5) * cellW;
      const p = new THREE.Vector3(at.p.x + at.n.x * off + at.t.x * (r * cellD - cellD * 0.5), 0.041, at.p.z + at.n.z * off + at.t.z * (r * cellD - cellD * 0.5));
      const q = new THREE.Matrix4().makeRotationY(Math.atan2(at.t.x, at.t.z) + Math.PI / 2);
      const g = new THREE.BoxGeometry(cellW * 0.94, 0.012, cellD * 0.9);
      paintBags.white.push({ geometry: g, matrix: new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(p.x, p.y, p.z), q) });
    }
    // grid slot brackets
    for (let k = 0; k < 6; k++) {
      const d = LAP - 8 - Math.floor(k / 2) * 5.4;
      const lat = (k % 2 ? 1 : -1) * 2.5;
      const gAt = atDistance(d);
      const q = new THREE.Matrix4().makeRotationY(Math.atan2(gAt.t.x, gAt.t.z) + Math.PI / 2);
      const pos = new THREE.Vector3(gAt.p.x + gAt.n.x * lat, 0.043, gAt.p.z + gAt.n.z * lat);
      for (const xx of [-1.2, 1.2]) {
        const b = new THREE.BoxGeometry(0.16, 0.012, 1.6);
        paintBags.white.push({ geometry: b, matrix: new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z).multiply(q).multiply(new THREE.Matrix4().makeTranslation(xx, 0, 0)), new THREE.Matrix4()) });
      }
      // slot number bar
      const bar = new THREE.BoxGeometry(2.3, 0.012, 0.09);
      paintBags.white.push({ geometry: bar, matrix: new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z), q) });
    }
  }
  // corner warning arrows / "SLOW" bars: red chevrons painted before the 3 tightest corners
  const sharpIdx = [];
  for (let i = 0; i < N; i++) {
    const a = samples[(i - 14 + N) % N], b = samples[i], c = samples[(i + 14) % N];
    const ang = Math.abs(G.util.wrapAngle(Math.atan2(c.t.x, c.t.z) - Math.atan2(a.t.x, a.t.z)));
    if (ang > 1.15) sharpIdx.push(i);
  }
  const sharpCenters = [];
  for (const i of sharpIdx) {
    if (!sharpCenters.length || Math.min(...sharpCenters.map((j) => Math.abs(j - i))) > 40) sharpCenters.push(i);
  }
  for (const i of sharpCenters.slice(0, 8)) {
    const s = samples[(i - 50 + N) % N];
    const q = new THREE.Matrix4().makeRotationY(Math.atan2(s.t.x, s.t.z) + Math.PI / 2);
    for (let k = 0; k < 4; k++) {
      const lat = -3.6 + k * 2.4;
      const g = new THREE.BoxGeometry(0.9, 0.012, 2.6);
      const m = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(s.p.x + s.n.x * lat, 0.043, s.p.z + s.n.z * lat), q);
      paintBags.red.push({ geometry: g, matrix: m });
    }
  }
  for (const [key, list] of Object.entries(paintBags)) {
    if (!list.length) continue;
    const mat = key === 'white' ? M.paint : key === 'red' ? M.paintRed : M.paint;
    const mesh = new THREE.Mesh(G.mergeGeoms(list), mat);
    mesh.receiveShadow = true; mesh.userData.passable = true; mesh.name = 'road-paint-' + key;
    mesh.material.polygonOffset = true; mesh.material.polygonOffsetFactor = -2; mesh.material.polygonOffsetUnits = -2;
    mesh.userData.surfaceProcedural = true;
    root.add(mesh); world.noReflect.push(mesh);
  }

  // wet puddles: shallow, mirror-smooth patches towards the gutters
  {
    const puddleMat = new THREE.MeshPhysicalMaterial({
      color: 0x242627, roughness: 0.025, metalness: 0.15, envMapIntensity: 3.2,
      normalMap: G.DETAILS.water.nrm, normalScale: new THREE.Vector2(0.035, 0.035),
      transparent: true, opacity: 0.92, depthWrite: false,
    });
    puddleMat.userData.surfaceProcedural = true;
    const list = [];
    for (let i = 0; i < 34; i++) {
      const d = R(6, LAP - 6);
      const at = atDistance(d);
      const side = R() > 0.5 ? 1 : -1;
      const off = side * R(2.5, 4.9);
      const rx = R(0.9, 2.9), rz = R(0.45, 1.35);
      const g = new THREE.CircleGeometry(1, 18);
      g.scale(rx, rz, 1);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Matrix4();
      m.makeRotationY(Math.atan2(at.t.x, at.t.z) + R(-0.4, 0.4));
      m.setPosition(at.p.x + at.n.x * off, 0.046, at.p.z + at.n.z * off);
      list.push({ geometry: g, matrix: m });
    }
    const puddles = new THREE.Mesh(G.mergeGeoms(list), puddleMat);
    puddles.receiveShadow = false; puddles.userData.passable = true; puddles.name = 'puddles'; puddles.userData.surfaceProcedural = true;
    root.add(puddles); world.noReflect.push(puddles);
  }

  // manholes and drains
  {
    const bag = [];
    for (let i = 0; i < 30; i++) {
      const at = atDistance(R(0, LAP));
      const off = (R() > 0.5 ? 1 : -1) * R(1.2, 4.8);
      const g = new THREE.CylinderGeometry(0.34, 0.34, 0.03, 20);
      g.rotateY(R(0, 6.28));
      bag.push({ geometry: g, matrix: G.M4(at.p.x + at.n.x * off, 0.047, at.p.z + at.n.z * off) });
    }
    const mesh = new THREE.Mesh(G.mergeGeoms(bag), M.darkMetal);
    mesh.receiveShadow = true; mesh.userData.passable = true; mesh.name = 'manholes';
    root.add(mesh); world.noReflect.push(mesh);
  }

  // ---------------------------------------------------------------- barriers
  {
    const concreteBag = [], railBag = [], panelBag = [], tyreBag = [];
    const step = 2.4;
    for (const side of [-1, 1]) {
      for (let d = 0; d < LAP; d += step) {
        const at = atDistance(d);
        const off = side * WALL_OFF;
        const ry = Math.atan2(at.t.x, at.t.z);
        const b = new THREE.Matrix4().multiplyMatrices(
          G.M4(at.p.x + at.n.x * off, 0.47, at.p.z + at.n.z * off, ry),
          G.M4(0, 0, 0)
        );
        const base = new THREE.BoxGeometry(0.32, 0.55, step * 0.98);
        concreteBag.push({ geometry: base, matrix: b });
        // rail
        const rail = new THREE.BoxGeometry(0.09, 0.12, step * 1.01);
        const rm = new THREE.Matrix4().multiplyMatrices(b, G.M4(0, 0.56, 0));
        railBag.push({ geometry: rail, matrix: rm });
        // sponsor panels every 5th segment
        if (Math.floor(d / step) % 5 === 2) {
          const panel = new THREE.BoxGeometry(0.36, 0.28, step * 0.86);
          const pm = new THREE.Matrix4().multiplyMatrices(b, G.M4(0, 0.06, 0));
          panelBag.push({ geometry: panel, matrix: pm, color: pick([0x1c3c44, 0x5b2620, 0x4a3a22, 0x223348]) });
        }
      }
      // tyre stacks at the sharp corners
      for (const i of sharpCenters) {
        const at = samples[i];
        for (let k = 0; k < 4; k++) {
          const off = side * (HW + CURB_W - 0.25) + side * 0.2;
          const g = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 18);
          const m = G.M4(at.p.x + at.n.x * off, 0.1 + k * 0.19, at.p.z + at.n.z * off, 0);
          tyreBag.push({ geometry: g, matrix: m, color: k % 2 ? 0x1b1b1b : 0x242424 });
        }
      }
    }
    const concrete = new THREE.Mesh(G.mergeGeoms(concreteBag), M.concrete);
    concrete.castShadow = true; concrete.receiveShadow = true; concrete.name = 'barrier-concrete';
    concrete.userData.passable = true; concrete.userData.surfaceProcedural = true;
    root.add(concrete);
    const rail = new THREE.Mesh(G.mergeGeoms(railBag), M.metal);
    rail.castShadow = true; rail.receiveShadow = true; rail.name = 'barrier-rail';
    rail.userData.passable = true;
    root.add(rail);
    const panels = new THREE.Mesh(G.mergeGeoms(panelBag, { vertexColors: true }), M.curb.clone());
    panels.material.vertexColors = true; panels.material.color.set(0xffffff); panels.material.roughness = 0.55;
    panels.castShadow = false; panels.receiveShadow = true; panels.name = 'barrier-sponsors';
    panels.userData.passable = true;
    root.add(panels);
    const tyres = new THREE.Mesh(G.mergeGeoms(tyreBag, { vertexColors: true }), M.rubber.clone());
    tyres.material.vertexColors = true; tyres.material.color.set(0xffffff);
    tyres.castShadow = true; tyres.receiveShadow = true; tyres.name = 'tyre-stacks';
    tyres.userData.passable = true;
    root.add(tyres);
  }

  // ---------------------------------------------------------------- facades / city blocks
  const FAC_W = 10.4, FAC_H = 13.6;
  const facadeMats = TEX.facades.map((f, i) => {
    const m = new THREE.MeshStandardMaterial({
      map: f.map, roughnessMap: f.rgh, emissiveMap: f.emi, emissive: 0xffcf9a, emissiveIntensity: 0.55,
      roughness: 1.0, metalness: i === 3 ? 0.35 : 0.04, vertexColors: true, envMapIntensity: 0.95,
    });
    m.name = 'facade-' + i; m.userData.surfaceProcedural = true;
    return m;
  });
  // canvas textures above were created with a random awning colour; build a proper set
  function makeAwningMat(colour) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = colour; x.fillRect(0, 0, 256, 128);
    x.fillStyle = 'rgba(244,232,210,.82)';
    for (let i = -8; i < 18; i++) { x.save(); x.translate(i * 24, 0); x.rotate(-0.22); x.fillRect(0, 0, 10, 220); x.restore(); }
    x.fillStyle = 'rgba(25,18,12,.18)'; x.fillRect(0, 102, 256, 26);
    const t = G.TEX.awningTex = G.TEX.awningTex || null;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, side: THREE.DoubleSide });
    m.name = 'awning'; m.userData.surfaceProcedural = true;
    return m;
  }
  const awningMats = [makeAwningMat('#9a3d2e'), makeAwningMat('#2c5a54'), makeAwningMat('#b08a45'), makeAwningMat('#3b4260')];
  const plainFacade = facadeMats.map((m) => { const c = m.clone(); c.vertexColors = false; c.needsUpdate = true; return c; });

  const bags = {
    wall: [[], [], [], []],
    store: [], roof: [], concrete: [], metal: [], darkMetal: [], signs: [], awning: awningMats.map(() => []),
    ac: [], glass: [], wood: [], orange: [], rubber: [], white: [], leafA: [], leafB: [],
  };
  const buildingList = [];
  const buildingCircles = [];

  function buildingMatrix(x, z, ry) {
    return G.M4(x, 0, z, ry);
  }
  function facadeDir(side, at) {
    // unit direction from the building toward the track
    return new THREE.Vector3(-side * at.n.x, 0, -side * at.n.z);
  }
  function addLot(side, d, opt = {}) {
    const at = atDistance(d);
    const w = opt.w ?? R(15, 29);
    const depth = opt.depth ?? R(13, 24);
    const style = opt.style ?? RI(0, 2);
    const h = opt.h ?? (style === 3 ? R(28, 62) : R(9, 28));
    const offset = opt.offset ?? (HW + 7.4 + R(0, 1.6));
    const dirX = -side * at.n.x, dirZ = -side * at.n.z;
    const cx = at.p.x + side * at.n.x * (offset + depth / 2);
    const cz = at.p.z + side * at.n.z * (offset + depth / 2);
    // keep the footprint clear of every part of the circuit
    let minD = 1e9;
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      const px = cx + Math.cos(ang) * w * 0.52, pz = cz + Math.sin(ang) * depth * 0.52;
      minD = Math.min(minD, distToTrack(px, pz));
    }
    if (minD < HW + 5.2) return false;
    for (const b of buildingCircles) {
      if (Math.hypot(cx - b.x, cz - b.z) < (b.r + Math.max(w, depth) * 0.5) * 0.93) return false;
    }
    const ry = Math.atan2(dirX, dirZ); // local +z faces the track
    const bm = buildingMatrix(cx, cz, ry);
    const tint = new THREE.Color().setHSL(R() > 0.52 ? 0.58 + R(-0.03, 0.04) : 0.065 + R(-0.025, 0.05), R(0.02, 0.14), R(0.66, 0.96));
    // wall
    const wallG = G.boxGeo(w, h, depth, FAC_W, FAC_H);
    bags.wall[style].push({ geometry: wallG, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h / 2, 0)), color: tint });
    // ground-floor shop band
    const storeG = G.boxGeo(w + 0.06, 4.1, depth + 0.08, 8.6, 4.1);
    bags.store.push({ geometry: storeG, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, 2.05, 0)) });
    // trim / cornices
    bags.concrete.push({ geometry: G.boxGeo(w + 0.34, 0.34, depth + 0.34, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, 4.2, 0)) });
    bags.concrete.push({ geometry: G.boxGeo(w + 0.4, 0.36, depth + 0.4, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h - 0.2, 0)) });
    // roof + parapet
    bags.roof.push({ geometry: G.boxGeo(w - 0.24, 0.18, depth - 0.24, 3, 3), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + 0.02, 0)) });
    const ph = 0.62;
    bags.concrete.push({ geometry: G.boxGeo(w, ph, 0.24, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + ph / 2, depth / 2 - 0.12)) });
    bags.concrete.push({ geometry: G.boxGeo(w, ph, 0.24, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + ph / 2, -depth / 2 + 0.12)) });
    bags.concrete.push({ geometry: G.boxGeo(0.24, ph, depth, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(w / 2 - 0.12, h + ph / 2, 0)) });
    bags.concrete.push({ geometry: G.boxGeo(0.24, ph, depth, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(-w / 2 + 0.12, h + ph / 2, 0)) });
    // rooftop machinery
    const units = RI(1, 4);
    for (let u = 0; u < units; u++) {
      const uw = R(1.2, 2.6), uh = R(0.7, 1.5), ud = R(1, 2);
      bags.metal.push({ geometry: G.boxGeo(uw, uh, ud, 1, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.3, w * 0.3), h + 0.2 + uh / 2, R(-depth * 0.28, depth * 0.28), R(0, 3))) });
    }
    if (h > 22) {
      // stair house + water tank
      bags.concrete.push({ geometry: G.boxGeo(3.2, 3.0, 3.8, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.2, w * 0.2), h + 1.5, -depth * 0.25)) });
      if (R() > 0.45) {
        const tank = new THREE.CylinderGeometry(1.35, 1.35, 2.4, 18);
        bags.metal.push({ geometry: tank, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.3, w * 0.3), h + 1.4, R(-depth * 0.3, depth * 0.3))) });
        for (let l = 0; l < 4; l++) {
          const leg = new THREE.CylinderGeometry(0.07, 0.07, 1.3, 8);
          bags.darkMetal.push({ geometry: leg, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.25, w * 0.25) + Math.cos(l * Math.PI / 2) * 0.9, h + 0.65, R(-depth * 0.2, depth * 0.2) + Math.sin(l * Math.PI / 2) * 0.9)) });
        }
      }
      // antenna
      if (R() > 0.6) {
        const mast = new THREE.CylinderGeometry(0.05, 0.09, R(3, 9), 8);
        const mh = R(3, 9);
        bags.darkMetal.push({ geometry: mast, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.3, w * 0.3), h + mh / 2, R(-depth * 0.3, depth * 0.3))) });
      }
    }
    // AC boxes on the facade
    const acCount = RI(2, 6);
    for (let a = 0; a < acCount; a++) {
      const ay = R(6, Math.max(8, h - 2));
      const axx = R(-w / 2 + 1.2, w / 2 - 1.2);
      bags.ac.push({ geometry: G.boxGeo(0.9, 0.55, 0.5, 1, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(axx, ay, depth / 2 + 0.26)) });
    }
    // awnings over the shops
    const awCount = RI(1, 3);
    for (let a = 0; a < awCount; a++) {
      const aw = Math.min(R(3.5, 6.5), w - 2);
      const axx = R(-w / 2 + aw / 2 + 0.6, w / 2 - aw / 2 - 0.6);
      const matIdx = RI(0, awningMats.length - 1);
      const awG = G.boxGeo(aw, 0.09, 1.55, 2, 1);
      const m = new THREE.Matrix4().multiplyMatrices(bm, new THREE.Matrix4().multiplyMatrices(G.M4(axx, 3.55, depth / 2 + 0.72), G.M4(0, 0, 0, 0, -0.18)));
      bags.awning[matIdx].push({ geometry: awG, matrix: m });
      // valance + rods
      bags.awning[matIdx].push({ geometry: G.boxGeo(aw, 0.26, 0.04, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(axx, 3.35, depth / 2 + 1.5)) });
      for (const sign of [-1, 1]) {
        const rod = new THREE.CylinderGeometry(0.025, 0.025, 1.45, 6);
        bags.darkMetal.push({ geometry: rod, matrix: new THREE.Matrix4().multiplyMatrices(bm, new THREE.Matrix4().multiplyMatrices(G.M4(axx + sign * (aw / 2 - 0.25), 3.1, depth / 2 + 1.44), G.M4(0, 0, 0, 0, 0.85))) });
      }
    }
    // signage: shop sign above the awning, sometimes a vertical blade or roof board
    const cell = Math.floor(R(0, 15));
    const su = (cell % 4) * 0.25, sv = 1 - (Math.floor(cell / 4) + 1) * 0.25;
    const signW = Math.min(w * 0.74, R(5, 8.5)), signH = signW * 0.26;
    const signG = new THREE.PlaneGeometry(signW, signH);
    const uvA = signG.attributes.uv;
    for (let q = 0; q < uvA.count; q++) uvA.setXY(q, su + uvA.getX(q) * 0.25, sv + uvA.getY(q) * 0.25);
    bags.signs.push({ geometry: signG, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w / 4, w / 4), R(4.65, 5.5), depth / 2 + 0.08)) });
    // second, smaller shop blade sign
    if (R() > 0.35) {
      const cell3 = Math.floor(R(0, 15));
      const su3 = (cell3 % 4) * 0.25, sv3 = 1 - (Math.floor(cell3 / 4) + 1) * 0.25;
      const bsg = new THREE.PlaneGeometry(1.2, 2.6);
      const uv3 = bsg.attributes.uv;
      for (let q = 0; q < uv3.count; q++) uv3.setXY(q, su3 + uv3.getX(q) * 0.25, sv3 + uv3.getY(q) * 0.25);
      bags.signs.push({ geometry: bsg, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(-w / 2 - 0.08, R(3.6, 6.0), depth / 2 - 1.0, Math.PI / 2)) });
      bags.darkMetal.push({ geometry: G.boxGeo(0.08, 2.8, 1.35, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(-w / 2 - 0.02, R(3.6, 6.0), depth / 2 - 1.0, Math.PI / 2)) });
    }
    bags.darkMetal.push({ geometry: G.boxGeo(signW + 0.16, signH + 0.16, 0.1, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, 5.1, depth / 2 + 0.03)) });
    if (R() > 0.45 && h > 14) {
      // rooftop billboard
      const bw = Math.min(w * 0.8, R(6, 10)), bh = bw * 0.36;
      const cell2 = Math.floor(R(0, 15));
      const su2 = (cell2 % 4) * 0.25, sv2 = 1 - (Math.floor(cell2 / 4) + 1) * 0.25;
      const bg = new THREE.PlaneGeometry(bw, bh);
      const uv2 = bg.attributes.uv;
      for (let q = 0; q < uv2.count; q++) uv2.setXY(q, su2 + uv2.getX(q) * 0.25, sv2 + uv2.getY(q) * 0.25);
      bags.signs.push({ geometry: bg, matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + 2.2 + bh / 2, depth * 0.1)) });
      bags.darkMetal.push({ geometry: G.boxGeo(bw + 0.24, bh + 0.24, 0.2, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + 2.2 + bh / 2, depth * 0.1 - 0.12)) });
      for (const sx of [-bw * 0.36, bw * 0.36]) {
        bags.darkMetal.push({ geometry: new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(sx, h + 1.3, depth * 0.1)) });
      }
    }
    // balconies
    if (style !== 3 && h > 14) {
      for (let b = 0; b < 2; b++) {
        const by = R(8, h - 3);
        const bx = R(-w / 3, w / 3);
        bags.concrete.push({ geometry: G.boxGeo(2.6, 0.14, 0.95, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(bx, by, depth / 2 + 0.48)) });
        for (let r = 0; r < 6; r++) {
          bags.metal.push({ geometry: new THREE.CylinderGeometry(0.02, 0.02, 0.85, 5), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(bx - 1.2 + r * 0.48, by + 0.5, depth / 2 + 0.9)) });
        }
        bags.metal.push({ geometry: G.boxGeo(2.64, 0.04, 0.04, 1, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(bx, by + 0.9, depth / 2 + 0.9)) });
      }
    }
    buildingCircles.push({ x: cx, z: cz, r: Math.max(w, depth) * 0.5 });
    buildingList.push({ x: cx, z: cz, w, d: depth, h, style, side, s: d });
    return true;
  }

  // key gaps: start viewing corridor on the inside is a park, outside is a grandstand
  function inPark(d, side) {
    if (side !== -1) return false;
    const u = ((d % LAP) + LAP) % LAP;
    return u < 122; // the infield of the start straight is the city park
  }
  // leave room for the grandstand on the outside of the start straight
  function inGrandstandGap(d, side) {
    if (side !== 1) return false;
    const u = ((d % LAP) + LAP) % LAP;
    return u < 74 || u > LAP - 56;
  }
  for (const side of [1, -1]) {
    let d = 18;
    let guard = 0;
    while (d < LAP - 20 && guard++ < 260) {
      const step = R(19, 34);
      if (!inPark(d, side) && !inGrandstandGap(d, side)) {
        const w = R(15, 30);
        const h = R(10, 34);
        const style = h > 30 && R() > 0.5 ? 3 : RI(0, 2);
        addLot(side, d, { w, h, depth: R(13, 22), style });
      }
      d += step;
    }
  }
  // second row: taller, simpler blocks that fill the skyline behind the first row
  for (let i = 0; i < 42; i++) {
    const d = R(0, LAP), side = R() > 0.5 ? 1 : -1;
    if (inPark(d, side) || inGrandstandGap(d, side)) continue;
    const at = atDistance(d);
    const off = R(44, 78);
    const cx = at.p.x + side * at.n.x * off, cz = at.p.z + side * at.n.z * off;
    if (distToTrack(cx, cz) < 42) continue;
    if (buildingCircles.some((b) => Math.hypot(cx - b.x, cz - b.z) < b.r + 9)) continue;
    const w = R(20, 38), depth = R(18, 32), h = R(30, 76);
    const ry = Math.atan2(-side * at.n.x, -side * at.n.z);
    const bm = buildingMatrix(cx, cz, ry);
    const style = R() > 0.4 ? 3 : RI(0, 2);
    const tint = new THREE.Color().setHSL(R() > 0.5 ? 0.58 : 0.07, R(0.02, 0.10), R(0.58, 0.88));
    bags.wall[style].push({ geometry: G.boxGeo(w, h, depth, FAC_W, FAC_H), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h / 2, 0)), color: tint });
    bags.roof.push({ geometry: G.boxGeo(w - 0.2, 0.15, depth - 0.2, 3, 3), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + 0.02, 0)) });
    bags.concrete.push({ geometry: G.boxGeo(w + 0.3, 0.3, depth + 0.3, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h - 0.18, 0)) });
    buildingCircles.push({ x: cx, z: cz, r: Math.max(w, depth) * 0.5 });
    buildingList.push({ x: cx, z: cz, w, d: depth, h, style, side, s: d });
  }

  // ---------------------------------------------------------------- city fabric
  // A dense background grid of blocks so the circuit sits inside a real downtown,
  // not a ring of facades with empty ground behind them.
  {
    let added = 0;
    const cx0 = G.track.center.x, cz0 = G.track.center.z;
    for (let gx = -5; gx <= 5; gx++) {
      for (let gz = -5; gz <= 5; gz++) {
        const x = cx0 + gx * 42 + R(-5, 5);
        const z = cz0 + gz * 42 + R(-5, 5);
        // keep the park and the circuit clear
        if (Math.hypot(x - 44, z - 6) < 46) continue;
        if (distToTrack(x, z) < 31) continue;
        if (buildingCircles.some((b) => Math.hypot(x - b.x, z - b.z) < b.r + 15)) continue;
        const w = R(18, 30), d = R(16, 27);
        // all four corners must stay clear of the racing corridor
        let clear = true;
        for (let a = 0; a < 4; a++) {
          const px = x + (a < 2 ? -1 : 1) * w * 0.5, pz = z + (a % 2 ? -1 : 1) * d * 0.5;
          if (distToTrack(px, pz) < 25) { clear = false; break; }
        }
        if (!clear) continue;
        const h = R(9, 34) + (Math.abs(gx) < 2 && Math.abs(gz) < 2 ? R(0, 18) : 0);
        const style = h > 30 && R() > 0.45 ? 3 : RI(0, 2);
        const tint = new THREE.Color().setHSL(R() > 0.5 ? 0.58 : 0.07, R(0.02, 0.10), R(0.6, 0.9));
        const bm = G.M4(x, 0, z, Math.round(R(0, 3)) * Math.PI / 2);
        bags.wall[style].push({ geometry: G.boxGeo(w, h, d, FAC_W, FAC_H), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h / 2, 0)), color: tint });
        bags.roof.push({ geometry: G.boxGeo(w - 0.3, 0.16, d - 0.3, 3, 3), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + 0.02, 0)) });
        bags.concrete.push({ geometry: G.boxGeo(w + 0.3, 0.28, d + 0.3, 2, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h - 0.16, 0)) });
        // a simple setback crown on the taller blocks
        if (h > 26 && R() > 0.35) {
          const hh = R(5, 12);
          bags.wall[style].push({ geometry: G.boxGeo(w * 0.66, hh, d * 0.66, FAC_W, FAC_H), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + hh / 2, 0)), color: tint });
          bags.roof.push({ geometry: G.boxGeo(w * 0.62, 0.14, d * 0.62, 3, 3), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(0, h + hh + 0.02, 0)) });
        }
        for (let u = 0; u < 2; u++) {
          bags.metal.push({ geometry: G.boxGeo(R(1.2, 2.2), R(0.7, 1.4), R(1.2, 2.0), 1, 1), matrix: new THREE.Matrix4().multiplyMatrices(bm, G.M4(R(-w * 0.28, w * 0.28), h + 0.8, R(-d * 0.28, d * 0.28))) });
        }
        buildingCircles.push({ x, z, r: Math.max(w, d) * 0.5 });
        buildingList.push({ x, z, w, d, h, style, side: 0, s: 0 });
        added++;
      }
    }
    G.world.fabricCount = added;
  }

  // ---------------------------------------------------------------- skyline ring + landmark
  {
    const center = G.track.center;
    const bag = [[], [], [], []];
    const rr = G.rng;
    for (let i = 0; i < 56; i++) {
      const ang = R(0, Math.PI * 2);
      const rad = R(230, 520);
      const x = center.x + Math.cos(ang) * rad, z = center.z + Math.sin(ang) * rad * 0.85;
      const w = R(16, 42), d = R(16, 38), h = R(28, 105);
      const style = R() > 0.5 ? 3 : RI(0, 2);
      const ry = R(0, Math.PI);
      const tint = new THREE.Color().setHSL(0.07, R(0.01, 0.07), R(0.5, 0.75));
      bag[style].push({ geometry: G.boxGeo(w, h, d, FAC_W, FAC_H), matrix: G.M4(x, h / 2, z, ry), color: tint });
      // crown / setback
      if (h > 60) {
        bag[style].push({ geometry: G.boxGeo(w * 0.65, h * 0.25, d * 0.65, FAC_W, FAC_H), matrix: G.M4(x, h + h * 0.125, z, ry), color: tint });
        bag[style].push({ geometry: G.boxGeo(w * 0.32, h * 0.1, d * 0.32, FAC_W, FAC_H), matrix: G.M4(x, h + h * 0.25 + h * 0.05, z, ry), color: tint });
      }
    }
    for (let s = 0; s < 4; s++) {
      if (!bag[s].length) continue;
      const mesh = new THREE.Mesh(G.mergeGeoms(bag[s], { vertexColors: true }), facadeMats[s]);
      mesh.name = 'skyline-' + s; mesh.userData.passable = true; mesh.userData.surfaceProcedural = true;
      root.add(mesh);
    }
    // landmarks: two modern towers frame the northern sightline
    function modernTower(x, z, w, h, sign, crownCol) {
      const g = new THREE.Group();
      const podium = new THREE.Mesh(G.boxGeo(w * 1.5, 22, w * 1.5, FAC_W, FAC_H), plainFacade[3]);
      podium.position.set(x, 11, z); podium.userData.passable = true; podium.userData.surfaceProcedural = true;
      g.add(podium);
      const shaft = new THREE.Mesh(G.boxGeo(w, h * 0.66, w, FAC_W, FAC_H), plainFacade[3]);
      shaft.position.set(x, 22 + h * 0.33, z); shaft.userData.passable = true; shaft.userData.surfaceProcedural = true;
      g.add(shaft);
      const upper = new THREE.Mesh(G.boxGeo(w * 0.78, h * 0.26, w * 0.78, FAC_W, FAC_H), plainFacade[3]);
      upper.position.set(x, 22 + h * 0.66 + h * 0.13, z); upper.userData.passable = true; upper.userData.surfaceProcedural = true;
      g.add(upper);
      const crown = new THREE.Mesh(G.boxGeo(w * 0.5, h * 0.1, w * 0.5, FAC_W, FAC_H), plainFacade[3]);
      crown.position.set(x, 22 + h * 0.92, z); crown.userData.passable = true; crown.userData.surfaceProcedural = true;
      g.add(crown);
      const bandMat = new THREE.MeshBasicMaterial({ color: crownCol });
      const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.53, 1.8, w * 0.53), bandMat);
      band.position.set(x, 22 + h * 0.86, z);
      band.userData.surfaceProcedural = true;
      g.add(band);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.2, 46, 24), M.darkMetal);
      ant.position.set(x, 22 + h * 0.97 + 23, z);
      ant.userData.passable = true;
      g.add(ant);
      // vertical fins on the shaft for silhouette break-up
      const finBag = [];
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2;
        finBag.push({ geometry: new THREE.BoxGeometry(0.7, h * 0.62, 0.7), matrix: G.M4(x + Math.cos(a) * (w * 0.5 + 0.2), 22 + h * 0.31, z + Math.sin(a) * (w * 0.5 + 0.2)) });
      }
      const fins = new THREE.Mesh(G.mergeGeoms(finBag), M.darkMetal);
      fins.userData.passable = true; g.add(fins);
      g.name = 'landmark-tower';
      return g;
    }
    root.add(modernTower(-146, -330, 30, 160, -1, 0xffb057));
    root.add(modernTower(178, -372, 24, 118, 1, 0xff6f4a));
    // a couple of mid-ground stepped blocks so the horizon isn't a row of equal boxes
    for (let i = 0; i < 5; i++) {
      const x = -160 + i * 72, z = -250 - (i % 2) * 45;
      const h = 55 + (i * 13) % 55;
      const b = new THREE.Mesh(G.boxGeo(24, h, 22, FAC_W, FAC_H), plainFacade[i % 2 ? 3 : 1]);
      b.position.set(x, h / 2, z); b.userData.passable = true; b.userData.surfaceProcedural = true;
      root.add(b);
    }
  }

  // commit building bags
  for (let s = 0; s < 4; s++) {
    if (!bags.wall[s].length) continue;
    const mesh = new THREE.Mesh(G.mergeGeoms(bags.wall[s], { vertexColors: true }), facadeMats[s]);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'facade-block-' + s;
    mesh.userData.passable = true; mesh.userData.surfaceProcedural = true;
    mesh.userData.identity = [{ name: 'facade', extents: [30, 30, 30] }]; mesh.userData.parts = ['facade'];
    root.add(mesh);
    shadowCasters.push(mesh);
  }
  function commitBag(list, material, name, cast = true, opts = {}) {
    if (!list.length) return null;
    const mesh = new THREE.Mesh(G.mergeGeoms(list, opts), material);
    mesh.castShadow = cast; mesh.receiveShadow = true; mesh.name = name;
    mesh.userData.passable = true;
    if (opts.surfaceProcedural) mesh.userData.surfaceProcedural = true;
    root.add(mesh);
    if (cast) shadowCasters.push(mesh);
    return mesh;
  }
  commitBag(bags.store, M.storefront, 'shopfronts', true, { surfaceProcedural: true });
  commitBag(bags.roof, M.roof, 'roofs', true, { surfaceProcedural: true });
  commitBag(bags.concrete, M.concrete, 'building-trim', true, { surfaceProcedural: true });
  commitBag(bags.metal, M.metal, 'building-metal', true);
  commitBag(bags.darkMetal, M.darkMetal, 'building-dark-metal', true);
  commitBag(bags.ac, M.metal, 'ac-units', true);
  const signMesh = commitBag(bags.signs, M.sign, 'shop-signs', false);
  if (signMesh) signMesh.userData.surfaceProcedural = true;
  awningMats.forEach((mat, i) => commitBag(bags.awning[i], mat, 'awnings-' + i, true, { surfaceProcedural: true }));

  // ---------------------------------------------------------------- green: trees, planters, park
  const treePlacements = [];
  function treeGeo(type, scale = 1) {
    // crossed leaf cards arranged in three tiers around a trunk
    const mats = type === 0 ? M.foliageA : M.foliageB;
    const cards = [];
    const tiers = [
      { y: 3.6, s: 1.95, n: 3, tilt: 0.15 },
      { y: 4.8, s: 2.1, n: 3, tilt: -0.1 },
      { y: 6.0, s: 1.6, n: 2, tilt: 0.1 },
    ];
    for (const t of tiers) {
      for (let i = 0; i < t.n; i++) {
        const g = new THREE.PlaneGeometry(t.s * 2, t.s * 2);
        const ry = (i / t.n) * Math.PI + R(-0.3, 0.3);
        cards.push({ geometry: g, matrix: G.M4(0, t.y, 0, ry, R(-0.1, 0.1), t.tilt) });
      }
    }
    const trunk = [];
    const tG = new THREE.CylinderGeometry(0.1 * scale, 0.18 * scale, 4.2 * scale, 9);
    trunk.push({ geometry: tG, matrix: G.M4(0, 2.1 * scale, 0) });
    // a few branches
    for (let b = 0; b < 3; b++) {
      const br = new THREE.CylinderGeometry(0.04, 0.09, 1.6, 6);
      trunk.push({ geometry: br, matrix: G.M4(R(-0.4, 0.4), 3.4 + b * 0.5, R(-0.4, 0.4), R(0, 6.28), R(-0.7, 0.7), 0) });
    }
    return { cards: G.mergeGeoms(cards), trunk: G.mergeGeoms(trunk), mat: mats };
  }
  const treeTypes = [treeGeo(0), treeGeo(1)];
  G.TEX.tree = treeTypes;
  {
    // instanced trees: park + street rows
    const placements = [];
    // street trees, behind the barriers, clear of the start park (also in it)
    for (const side of [1, -1]) {
      for (let d = R(6, 24); d < LAP; d += R(21, 30)) {
        const at = atDistance(d);
        const off = side * R(9.4, 11.2);
        if (distToTrack(at.p.x + at.n.x * off, at.p.z + at.n.z * off) < HW + 3.1) continue;
        // avoid start line / gantry
        const sNorm = ((d % LAP) + LAP) % LAP;
        if (sNorm < 14 || sNorm > LAP - 8) continue;
        placements.push({ x: at.p.x + at.n.x * off, z: at.p.z + at.n.z * off, s: R(0.82, 1.25), ry: R(0, 6.28), type: R() > 0.5 ? 0 : 1 });
      }
    }
    // park planting on the inside of the start corridor
    for (let i = 0; i < 34; i++) {
      const d = R(-30, 65) + LAP;
      const at = atDistance(d);
      const off = -R(13, 30);
      const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
      if (distToTrack(x, z) < HW + 6) continue;
      placements.push({ x, z, s: R(0.9, 1.5), ry: R(0, 6.28), type: R() > 0.5 ? 0 : 1 });
    }
    // palms at the plaza
    for (let i = 0; i < 8; i++) {
      const ang = i / 8 * Math.PI * 2;
      const x = 44 + Math.cos(ang) * R(12, 18), z = 6 + Math.sin(ang) * R(9, 14);
      placements.push({ x, z, s: R(1.1, 1.45), ry: R(0, 6.28), type: 0 });
    }
    for (const type of [0, 1]) {
      const subset = placements.filter((p) => p.type === type);
      if (!subset.length) continue;
      const cardMesh = new THREE.InstancedMesh(treeTypes[type].cards, treeTypes[type].mat, subset.length);
      const trunkMesh = new THREE.InstancedMesh(treeTypes[type].trunk, M.wood, subset.length);
      cardMesh.castShadow = true; cardMesh.receiveShadow = true; cardMesh.name = 'tree-foliage-' + type;
      trunkMesh.castShadow = true; trunkMesh.receiveShadow = true; trunkMesh.name = 'tree-trunk-' + type;
      cardMesh.userData.passable = true; trunkMesh.userData.passable = true;
      cardMesh.userData.surfaceProcedural = true;
      const dummy = new THREE.Object3D();
      subset.forEach((p, i) => {
        dummy.position.set(p.x, 0.15, p.z); dummy.rotation.y = p.ry; dummy.scale.setScalar(p.s);
        dummy.updateMatrix();
        cardMesh.setMatrixAt(i, dummy.matrix); trunkMesh.setMatrixAt(i, dummy.matrix);
      });
      cardMesh.instanceMatrix.needsUpdate = true; trunkMesh.instanceMatrix.needsUpdate = true;
      root.add(cardMesh); root.add(trunkMesh);
    }
  }
  // park lawn + paths + fountain
  {
    const lawnMat = new THREE.MeshStandardMaterial({ color: 0x5d6b3e, roughness: 0.95 });
    lawnMat.userData.surfaceProcedural = true;
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(24, 42), lawnMat);
    lawn.rotation.x = -Math.PI / 2; lawn.position.set(44, 0.135, 6);
    lawn.receiveShadow = true; lawn.name = 'start-park-lawn'; lawn.userData.passable = true;
    lawn.userData.surfaceProcedural = true;
    root.add(lawn); world.noReflect.push(lawn);
    const pathMat = new THREE.MeshStandardMaterial({ color: 0xb8b0a2, map: TEX.paving.alb, roughnessMap: TEX.paving.rgh, roughness: 0.8 });
    pathMat.userData.surfaceProcedural = true;
    for (let i = 0; i < 3; i++) {
      const g = new THREE.RingGeometry(6 + i * 6, 7.4 + i * 6, 40, 1, 0, Math.PI * 2);
      g.rotateX(-Math.PI / 2);
      const p = new THREE.Mesh(g, pathMat);
      p.position.set(44, 0.145 + i * 0.002, 6); p.receiveShadow = true; p.userData.passable = true;
      root.add(p);
    }
    const fountain = new THREE.Group();
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.8, 0.5, 36), M.concrete);
    basin.position.y = 0.25;
    fountain.add(basin);
    const waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x4d6d75, roughness: 0.05, metalness: 0.2, envMapIntensity: 2.2,
      normalMap: G.DETAILS.water.nrm, normalScale: new THREE.Vector2(0.05, 0.05),
    });
    waterMat.userData.surfaceProcedural = true;
    const water = new THREE.Mesh(new THREE.CircleGeometry(3.25, 36), waterMat);
    water.userData.surfaceProcedural = true;
    water.rotation.x = -Math.PI / 2; water.position.y = 0.47; fountain.add(water);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 2.4, 32), M.concrete);
    stem.position.y = 1.3; fountain.add(stem);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 0.5, 0.5, 28), M.concrete);
    bowl.position.y = 2.5; fountain.add(bowl);
    fountain.position.set(44, 0.14, 6);
    fountain.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.userData.passable = true; } });
    root.add(fountain);
    G.world.fountain = fountain;
  }

  // ---------------------------------------------------------------- hero billboard
  {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 384;
    const x = c.getContext('2d');
    // warm printed poster with a hard sun graphic
    const g = x.createLinearGradient(0, 0, 1024, 384);
    g.addColorStop(0, '#161b21'); g.addColorStop(0.55, '#1d2329'); g.addColorStop(1, '#101317');
    x.fillStyle = g; x.fillRect(0, 0, 1024, 384);
    // sun disc / bands
    const sg = x.createRadialGradient(760, 150, 10, 760, 150, 190);
    sg.addColorStop(0, '#ffd18d'); sg.addColorStop(0.55, '#e97a35'); sg.addColorStop(1, 'rgba(120,40,18,0)');
    x.fillStyle = sg; x.beginPath(); x.arc(760, 150, 190, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(20,24,28,.85)';
    for (let i = 0; i < 5; i++) x.fillRect(0, 210 + i * 22, 1024, 8 + i * 2);
    x.fillStyle = '#ffb454'; x.font = '800 78px Helvetica, Arial, sans-serif'; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText('SUNSET', 52, 112);
    x.fillStyle = '#f4ead8'; x.font = '800 96px Helvetica, Arial, sans-serif';
    x.fillText('DISTRICT', 50, 200);
    x.fillStyle = 'rgba(244,234,216,.66)'; x.font = '600 25px monospace';
    x.fillText('CITY KART GRAND PRIX · ARANYA · 17:42', 54, 286);
    x.fillStyle = '#ffb454'; x.fillRect(54, 318, 240, 6);
    x.fillStyle = 'rgba(255,244,228,.45)'; x.font = '600 17px monospace';
    x.fillText('ROUND 04 / THE RIVER CIRCUIT', 54, 348);
    x.strokeStyle = 'rgba(255,210,150,.55)'; x.lineWidth = 4; x.strokeRect(12, 12, 1000, 360);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const bm = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.55, metalness: 0.1 });
    bm.userData.surfaceProcedural = true;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(13, 4.9), bm);
    const bx = 27, bz = 8, by = 8.2, bry = Math.atan2(-bx - 8, 40 - bz);
    sign.position.set(bx, by, bz); sign.rotation.y = bry;
    sign.castShadow = true; sign.userData.passable = true;
    root.add(sign);
    // frame, supports and LED strip
    const frame = new THREE.Mesh(new THREE.BoxGeometry(13.4, 5.3, 0.28), M.darkMetal);
    frame.position.set(bx - Math.sin(bry) * 0.16, by, bz - Math.cos(bry) * 0.16); frame.rotation.y = bry;
    frame.castShadow = true; frame.receiveShadow = true; frame.userData.passable = true; frame.userData.surfaceProcedural = true;
    root.add(frame);
    for (const off of [-5.1, 5.1]) {
      const px = bx + Math.cos(bry) * off, pz = bz - Math.sin(bry) * off;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 6.3, 32), M.metal);
      post.position.set(px, 3.15, pz); post.castShadow = true; post.receiveShadow = true; post.userData.passable = true;
      root.add(post);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 32), M.darkMetal);
      strut.position.set(px - Math.sin(bry) * 0.8, 5.4, pz - Math.cos(bry) * 0.8);
      strut.rotation.x = bry + 0.5;
      strut.castShadow = true; strut.userData.passable = true;
      root.add(strut);
    }
    const led = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: 0xffb454 }));
    led.position.set(bx, by + 2.55, bz); led.rotation.y = bry; led.userData.passable = true; led.userData.surfaceProcedural = true;
    root.add(led);
    G.world.billboard = sign;
  }

  // ---------------------------------------------------------------- street furniture
  function lampGeo() {
    const parts = [];
    parts.push({ geometry: new THREE.CylinderGeometry(0.1, 0.16, 7.6, 10), matrix: G.M4(0, 3.8, 0) });
    // curved arm as three segments
    for (let i = 0; i < 3; i++) {
      const g = new THREE.CylinderGeometry(0.07, 0.08, 1.0, 8);
      parts.push({ geometry: g, matrix: M4rot(0.42 + i * 0.3, 7.55 + i * 0.28, 0, -0.9 + i * 0.2) });
    }
    parts.push({ geometry: new THREE.BoxGeometry(0.26, 0.13, 1.1), matrix: G.M4(1.9, 7.6, 0) });
    return G.mergeGeoms(parts);
  }
  function M4rot(x, y, z, rx) { const m = new THREE.Matrix4(); m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(1, 1, 1)); return m; }
  {
    const bag = [], heads = [];
    for (const side of [1, -1]) {
      for (let d = 8; d < LAP; d += 29) {
        if (d < 20) continue; // keep the hero view of the start gantry clean
        const at = atDistance(d);
        const off = side * R(9.1, 10.1);
        const ry = Math.atan2(-side * at.n.x, -side * at.n.z);
        const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
        if (distToTrack(x, z) < HW + 3) continue;
        bag.push({ geometry: lampGeo(), matrix: G.M4(x, 0.12, z, ry) });
        heads.push({ geometry: new THREE.BoxGeometry(0.22, 0.05, 0.9), matrix: G.M4(x + Math.sin(ry + Math.PI / 2) * 1.9, 7.66, z + Math.cos(ry + Math.PI / 2) * 1.9, ry) });
      }
    }
    const lamps = new THREE.Mesh(G.mergeGeoms(bag), M.darkMetal);
    lamps.castShadow = true; lamps.receiveShadow = true; lamps.name = 'street-lamps'; lamps.userData.passable = true;
    root.add(lamps);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffe0b0, emissive: 0xffc77a, emissiveIntensity: 0.55, roughness: 0.3 });
    headMat.userData.surfaceProcedural = true;
    const headPercent = 0;
    const headMesh = new THREE.Mesh(G.mergeGeoms(heads), headMat);
    headMesh.name = 'street-lamp-lens'; headMesh.userData.passable = true; headMesh.userData.surfaceProcedural = true;
    root.add(headMesh);
  }
  // bollards, bins, benches, planters, hydrants
  {
    const metal = [], concrete = [], wood = [], orange = [], rubber = [], hedges = [];
    const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x4d6138, roughness: 0.94, vertexColors: true });
    hedgeMat.userData.surfaceProcedural = true;
    for (const side of [1, -1]) {
      for (let d = 30; d < LAP; d += 41) {
        const at = atDistance(d);
        const off = side * R(8.3, 8.8);
        const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
        if (distToTrack(x, z) < HW + 2.2) continue;
        const ry = Math.atan2(-side * at.n.x, -side * at.n.z);
        for (let k = 0; k < 3; k++) {
          const g = new THREE.CylinderGeometry(0.09, 0.11, 0.9, 12);
          metal.push({ geometry: g, matrix: G.M4(x + Math.cos(ry) * k * 0.8, 0.55, z + Math.sin(ry) * k * 0.8) });
          metal.push({ geometry: new THREE.SphereGeometry(0.1, 12, 8), matrix: G.M4(x + Math.cos(ry) * k * 0.8, 1.0, z + Math.sin(ry) * k * 0.8) });
        }
      }
      for (let d = 60; d < LAP; d += 63) {
        const at = atDistance(d);
        const off = side * R(8.8, 9.8);
        const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
        if (distToTrack(x, z) < HW + 2.8) continue;
        const ry = Math.atan2(-side * at.n.x, -side * at.n.z) + R(-0.5, 0.5);
        // low planter with a clipped hedge: green mass, not a concrete block
        concrete.push({ geometry: G.boxGeo(1.7, 0.42, 0.8, 1, 1), matrix: G.M4(x, 0.36, z, ry) });
        for (let k = 0; k < 3; k++) {
          const bush = new THREE.IcosahedronGeometry(0.34 + R(0, 0.12), 1);
          hedges.push({ geometry: bush, matrix: G.M4(x + Math.cos(ry) * (k - 1) * 0.5, 0.66, z + Math.sin(ry) * (k - 1) * 0.5, R(0, 3), 0, 0, 1.15, 0.8, 1) });
        }
        // bench, small and only sometimes
        if (R() > 0.55) {
          for (let b = 0; b < 3; b++) wood.push({ geometry: G.boxGeo(1.7, 0.055, 0.12, 1, 1), matrix: G.M4(x + 2.2 * Math.cos(ry), 0.58, z + 2.2 * Math.sin(ry), ry) });
          for (const sx of [-0.65, 0.65]) metal.push({ geometry: G.boxGeo(0.05, 0.38, 0.42, 1, 1), matrix: G.M4(x + 2.2 * Math.cos(ry) + sx * Math.cos(ry), 0.38, z + 2.2 * Math.sin(ry) + sx * Math.sin(ry), ry) });
        }
        // bin and hydrant stay small
        rubber.push({ geometry: new THREE.CylinderGeometry(0.28, 0.24, 0.8, 16), matrix: G.M4(x - 2.2 * Math.cos(ry), 0.55, z - 2.2 * Math.sin(ry)) });
        orange.push({ geometry: new THREE.CylinderGeometry(0.11, 0.15, 0.56, 12), matrix: G.M4(x + 1.6, 0.43, z - 1.4) });
        orange.push({ geometry: new THREE.SphereGeometry(0.13, 12, 8), matrix: G.M4(x + 1.6, 0.71, z - 1.4) });
      }
    }
    const m1 = new THREE.Mesh(G.mergeGeoms(metal), M.metal); m1.castShadow = true; m1.receiveShadow = true; m1.name = 'street-metal'; m1.userData.passable = true; root.add(m1);
    const m2 = new THREE.Mesh(G.mergeGeoms(concrete), M.concrete); m2.castShadow = true; m2.receiveShadow = true; m2.name = 'planters'; m2.userData.passable = true; m2.userData.surfaceProcedural = true; root.add(m2);
    const m3 = new THREE.Mesh(G.mergeGeoms(wood), M.wood); m3.castShadow = true; m3.receiveShadow = true; m3.name = 'benches'; m3.userData.passable = true; root.add(m3);
    const m4 = new THREE.Mesh(G.mergeGeoms(orange), M.orange); m4.castShadow = true; m4.receiveShadow = true; m4.name = 'hydrants'; m4.userData.passable = true; root.add(m4);
    const m5 = new THREE.Mesh(G.mergeGeoms(rubber), M.rubber); m5.castShadow = true; m5.receiveShadow = true; m5.name = 'bins'; m5.userData.passable = true; root.add(m5);
    const m6 = new THREE.Mesh(G.mergeGeoms(hedges, { vertexColors: true }), hedgeMat); m6.castShadow = true; m6.receiveShadow = true; m6.name = 'hedges'; m6.userData.passable = true; m6.userData.surfaceProcedural = true; root.add(m6);
  }


  // ---------------------------------------------------------------- spectators
  {
    // compact, readable people at 8-40 m: two instanced draws for a whole street
    const bodies = [];
    const legs = [];
    for (const sx of [-1, 1]) {
      legs.push({ geometry: new THREE.BoxGeometry(0.12, 0.72, 0.15), matrix: G.M4(sx * 0.095, 0.36, 0) });
    }
    const torso = new THREE.CapsuleGeometry(0.16, 0.30, 4, 8);
    bodies.push({ geometry: torso, matrix: G.M4(0, 1.02, 0) });
    for (const sx of [-1, 1]) {
      const arm = new THREE.CylinderGeometry(0.045, 0.05, 0.58, 6);
      bodies.push({ geometry: arm, matrix: G.M4(sx * 0.25, 1.06, 0, 0, 0, sx * 0.15) });
    }
    bodies.push({ geometry: new THREE.BoxGeometry(0.44, 0.22, 0.2), matrix: G.M4(0, 0.85, 0) });
    const bodyGeo = G.mergeGeoms([...legs, ...bodies]);
    const headGeo = new THREE.SphereGeometry(0.115, 10, 8);
    headGeo.translate(0, 1.56, 0);
    const placements = [];
    const pushPerson = (d, side) => {
      const at = atDistance(d);
      const off = side * (WALL_OFF + R(0.55, 2.6));
      const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
      if (distToTrack(x, z) < WALL_OFF) return;
      // don't put people inside the grandstand or the kiosk
      if (Math.hypot(x - 18.5, z - 8) < 7) return;
      placements.push({
        x, z, ry: Math.atan2(-side * at.n.x, -side * at.n.z) + R(-0.6, 0.6),
        s: R(0.88, 1.08),
      });
    };
    // dense on the start straight, sparse elsewhere
    for (let i = 0; i < 76; i++) {
      const d = (i < 44) ? LAP - 62 + R(0, 130) : R(120, LAP - 30);
      pushPerson(((d % LAP) + LAP) % LAP, R() > 0.5 ? 1 : -1);
    }
    // closer clusters behind the grid
    for (let i = 0; i < 26; i++) pushPerson((LAP - 46 + R(0, 56)) % LAP, R() > 0.5 ? 1 : -1);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
    bodyMat.userData.surfaceProcedural = true;
    const headMat = new THREE.MeshStandardMaterial({ roughness: 0.72 });
    const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, placements.length);
    const headMesh = new THREE.InstancedMesh(headGeo, headMat, placements.length);
    bodyMesh.name = 'spectators'; headMesh.name = 'spectator-heads';
    const dummy = new THREE.Object3D();
    const jacket = [0x2d3a44, 0x6f3a31, 0xc0b49c, 0x3c5144, 0x766a58, 0x2c2a30, 0x8e6c43, 0x495a6b];
    const skins = [0xd9b087, 0xa8754f, 0x6f4c36, 0xe6c39b, 0x8c6046];
    placements.forEach((p, i) => {
      dummy.position.set(p.x, 0.15, p.z); dummy.rotation.y = p.ry; dummy.scale.setScalar(p.s);
      dummy.updateMatrix(); bodyMesh.setMatrixAt(i, dummy.matrix); headMesh.setMatrixAt(i, dummy.matrix);
      bodyMesh.setColorAt(i, new THREE.Color(jacket[i % jacket.length]));
      headMesh.setColorAt(i, new THREE.Color(skins[i % skins.length]));
    });
    bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
    headMesh.castShadow = true; headMesh.receiveShadow = true;
    bodyMesh.instanceMatrix.needsUpdate = true; headMesh.instanceMatrix.needsUpdate = true;
    bodyMesh.userData.passable = true; headMesh.userData.passable = true;
    bodyMesh.userData.surfaceProcedural = true; headMesh.userData.surfaceProcedural = true;
    root.add(bodyMesh); root.add(headMesh);
    G.world.spectators = { bodyMesh, headMesh, count: placements.length };
  }

  // ---------------------------------------------------------------- start gantry + grandstand
  const startGroup = new THREE.Group(); startGroup.name = 'start-area'; root.add(startGroup);
  {
    const at = atDistance(0);
    const ry = Math.atan2(at.t.x, at.t.z);
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x3b3f45, roughness: 0.42, metalness: 0.8 });
    trussMat.userData.surfaceProcedural = true;
    const bag = [];
    for (const side of [-1, 1]) {
      const x = at.p.x + at.n.x * side * 8.0, z = at.p.z + at.n.z * side * 8.0;
      for (let i = 0; i < 4; i++) {
        const dx = [-0.35, 0.35, -0.35, 0.35][i], dz = [0.35, 0.35, -0.35, -0.35][i];
        bag.push({ geometry: new THREE.BoxGeometry(0.2, 7.2, 0.2), matrix: G.M4(x + dx * 0.4, 3.6, z + dz * 0.4, ry) });
      }
      for (let y = 0.6; y < 7; y += 1.2) {
        bag.push({ geometry: new THREE.BoxGeometry(0.14, 0.14, 0.95), matrix: G.M4(x, y, z, ry) });
      }
    }
    // overhead truss
    for (const side of [-1, 1]) {
      bag.push({ geometry: new THREE.BoxGeometry(0.26, 0.26, 16.4), matrix: G.M4(at.p.x + at.n.x * side * 0.0, 7.2 + side * 0.0, at.p.z, ry) });
    }
    const cross = at.p.x, crossZ = at.p.z;
    // two beams across the track at y 7.1 and 7.7
    for (const y of [7.15, 7.75]) {
      bag.push({ geometry: new THREE.BoxGeometry(16.4, 0.2, 0.2), matrix: G.M4(cross, y, crossZ, ry) });
      for (let i = 0; i < 12; i++) {
        const t = -8 + i * 16 / 11;
        bag.push({ geometry: new THREE.BoxGeometry(0.07, 0.6, 0.07), matrix: G.M4(cross + at.n.x * t, (y + 7.45) / 2, crossZ + at.n.z * t, ry) });
      }
    }
    const truss = new THREE.Mesh(G.mergeGeoms(bag), trussMat);
    truss.castShadow = true; truss.receiveShadow = true; truss.name = 'start-gantry';
    truss.userData.passable = true; truss.userData.surfaceProcedural = true;
    truss.userData.identity = [{ name: 'truss', extents: [16, 8, 1] }, { name: 'pillars', extents: [1, 7.2, 1] }];
    truss.userData.parts = ['truss', 'pillars'];
    startGroup.add(truss);
    // banner across the gantry
    const bannerCanvas = document.createElement('canvas'); bannerCanvas.width = 1024; bannerCanvas.height = 160;
    const bctx = bannerCanvas.getContext('2d');
    bctx.fillStyle = '#181b20'; bctx.fillRect(0, 0, 1024, 160);
    bctx.strokeStyle = 'rgba(255,180,84,.75)'; bctx.lineWidth = 4; bctx.strokeRect(6, 6, 1012, 148);
    bctx.fillStyle = '#ffb454'; bctx.font = '800 78px Helvetica, Arial, sans-serif'; bctx.textAlign = 'center'; bctx.textBaseline = 'middle';
    bctx.fillText('SUNSET DISTRICT', 512, 70);
    bctx.fillStyle = 'rgba(255,245,230,.75)'; bctx.font = '600 26px monospace';
    bctx.fillText('CITY KART GRAND PRIX · ARANYA', 512, 126);
    const btex = new THREE.CanvasTexture(bannerCanvas); btex.colorSpace = THREE.SRGBColorSpace;
    const bannerMat = new THREE.MeshStandardMaterial({ map: btex, roughness: 0.55, metalness: 0.05, emissive: 0xffcf94, emissiveIntensity: 0.28, side: THREE.DoubleSide });
    bannerMat.userData.surfaceProcedural = true;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(16.0, 2.5), bannerMat);
    banner.position.set(cross, 6.3, crossZ);
    banner.rotation.y = Math.atan2(-at.t.x, -at.t.z);
    banner.castShadow = true;
    startGroup.add(banner);
    // timing lights
    const lightGroup = new THREE.Group();
    const lightMatOff = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.3, metalness: 0.4 });
    const lightMatRed = new THREE.MeshBasicMaterial({ color: 0xff3b23 });
    for (let i = 0; i < 5; i++) {
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.14, 32), lightMatOff);
      housing.rotation.x = Math.PI / 2;
      housing.position.set(-2.8 + i * 1.4, 6.95, 0.2);
      lightGroup.add(housing);
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.15, 16), lightMatRed);
      lamp.position.set(-2.8 + i * 1.4, 6.95, 0.28);
      lightGroup.add(lamp);
    }
    lightGroup.position.copy(at.p);
    lightGroup.rotation.y = Math.atan2(-at.t.x, -at.t.z);
    startGroup.add(lightGroup);
    G.world.startLights = lightGroup;
    // flags
    const flagCols = [0xdd5a3a, 0xf2d8a4, 0x3d6a76, 0xe1a94a];
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 4.4, 24), M.metal);
        pole.position.set(at.p.x + at.n.x * side * (8.7 + k * 1.6) + 0.0, 2.2, at.p.z + at.n.z * side * (8.7 + k * 1.6));
        startGroup.add(pole);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.95), new THREE.MeshStandardMaterial({ color: flagCols[(k + (side > 0 ? 0 : 2)) % 4], side: THREE.DoubleSide, roughness: 0.8 }));
        flag.position.set(pole.position.x + 0.75 * Math.cos(ry), 3.9, pole.position.z - 0.75 * Math.sin(ry));
        flag.rotation.y = ry + Math.PI / 2;
        startGroup.add(flag);
      }
    }
  }

  // grandstand on the outside of the start straight, behind the barrier
  {
    const at = atDistance(36);
    const side = 1;
    const ry = Math.atan2(-side * at.n.x, -side * at.n.z);
    const cx = at.p.x + at.n.x * side * 18.5, cz = at.p.z + at.n.z * side * 18.5;
    const gs = new THREE.Group();
    gs.position.set(cx, 0, cz);
    gs.rotation.y = ry;
    const frame = [], seats = [], crowd = [];
    // stepped terraces facing the track (local +z faces track)
    for (let i = 0; i < 7; i++) {
      const stepDepth = 1.15, stepH = 0.55;
      seats.push({ geometry: G.boxGeo(20, stepH, stepDepth, 2, 1), matrix: G.M4(0, 0.4 + i * stepH, 2.4 - i * stepDepth) });
      frame.push({ geometry: G.boxGeo(0.18, 1.8 + i * 0.2, 0.18, 1, 1), matrix: G.M4(-9.6, 1.0 + i * stepH, 1.6 - i * stepDepth) });
    }
    // roof
    frame.push({ geometry: G.boxGeo(21, 0.25, 11, 2, 1), matrix: G.M4(0, 8.2, 4.5, 0, 0.045) });
    for (const sx of [-9.8, 9.8]) for (const sz of [-0.4, 8.8]) frame.push({ geometry: G.boxGeo(0.26, 8.2, 0.26, 1, 1), matrix: G.M4(sx, 4.1, sz) });
    for (let i = 0; i < 10; i++) frame.push({ geometry: G.boxGeo(0.12, 0.12, 9.2, 1, 1), matrix: G.M4(-9.5 + i * 2.1, 8.0, 4.6) });
    // crowd cards
    for (let row = 0; row < 7; row++) {
      for (let c = 0; c < 12; c++) {
        const x = -8.8 + c * 1.6 + (row % 2) * 0.4, z = 2.6 - row * 1.15;
        crowd.push({ geometry: new THREE.PlaneGeometry(2.0, 1.05), matrix: G.M4(x, 1.25 + row * 0.55, z, 0) });
      }
    }
    const gm1 = new THREE.Mesh(G.mergeGeoms(frame), M.darkMetal); gm1.castShadow = true; gm1.receiveShadow = true; gm1.userData.passable = true;
    const gm2 = new THREE.Mesh(G.mergeGeoms(seats), M.concrete.clone()); gm2.material.color.set(0x8c8579); gm2.castShadow = true; gm2.receiveShadow = true; gm2.userData.passable = true;
    const crowdMat = new THREE.MeshStandardMaterial({ map: TEX.crowd, roughness: 0.92, side: THREE.DoubleSide });
    crowdMat.userData.surfaceProcedural = true;
    const gm3 = new THREE.Mesh(G.mergeGeoms(crowd), crowdMat); gm3.castShadow = false; gm3.receiveShadow = true; gm3.userData.passable = true;
    gs.add(gm1, gm2, gm3);
    gs.name = 'grandstand';
    root.add(gs);
    G.world.grandstand = gs;
  }

  // ---------------------------------------------------------------- boost pads + hazards
  {
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x1a2426, roughness: 0.35, metalness: 0.2, emissive: 0x1e5c5e, emissiveIntensity: 0.5,
      roughnessMap: G.DETAILS.metal.rgh, normalMap: G.DETAILS.metal.nrm, normalScale: new THREE.Vector2(0.16, 0.16),
    });
    padMat.userData.surfaceProcedural = true;
    const chevMat = new THREE.MeshBasicMaterial({ color: 0x78e8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    padMat.userData.surfaceProcedural = true;
    const padSites = [0.10, 0.27, 0.42, 0.60, 0.74, 0.89].map((f) => f * LAP);
    for (const d of padSites) {
      const at = atDistance(d);
      const off = R(-2.4, 2.4);
      const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
      const ry = Math.atan2(at.t.x, at.t.z);
      const pad = new THREE.Group();
      pad.position.set(x, 0.055, z); pad.rotation.y = ry;
      const base = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 5.2), padMat);
      base.rotation.x = -Math.PI / 2; base.receiveShadow = true;
      pad.add(base);
      const chev = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const shape = new THREE.Shape();
        shape.moveTo(-0.8, 0); shape.lineTo(0, 0.7); shape.lineTo(0.8, 0); shape.lineTo(0.5, 0); shape.lineTo(0, 0.4); shape.lineTo(-0.5, 0); shape.closePath();
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, chevMat);
        m.position.y = 0.02; m.position.z = -1.4 + i * 1.25;
        chev.add(m);
      }
      pad.add(chev);
      pad.name = 'boost-pad';
      root.add(pad);
      world.boostPads.push({ x, z, ry, group: pad, chev, radius: 2.4, cooldown: 0, d });
    }
    // hazard: cone clusters on the racing surface, telegraphed by a warning board
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xe35f22, roughness: 0.5, emissive: 0x7a2c0a, emissiveIntensity: 0.4 });
    coneMat.userData.surfaceProcedural = true;
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf3e9d4, roughness: 0.55 });
    const sites = [0.36, 0.55, 0.83];
    for (const f of sites) {
      const at = atDistance(f * LAP);
      const off = R(-1.8, 1.8);
      const zone = new THREE.Group();
      zone.position.set(at.p.x + at.n.x * off, 0, at.p.z + at.n.z * off);
      zone.rotation.y = Math.atan2(at.t.x, at.t.z);
      const cones = [];
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Group();
        const body = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.62, 32), coneMat);
        body.position.y = 0.33; body.castShadow = true; body.receiveShadow = true;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.16, 0.1, 32), whiteMat);
        band.position.y = 0.42;
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.44), M.darkMetal);
        foot.position.y = 0.03;
        c.add(body, band, foot);
        c.position.set((i % 2 ? 1 : -1) * 0.8, 0, -1.5 + Math.floor(i / 2) * 2.2);
        zone.add(c); cones.push(c);
      }
      zone.name = 'hazard-cones';
      root.add(zone);
      world.hazards.push({ x: zone.position.x, z: zone.position.z, radius: 2.1, group: zone, cones, hit: false, d: f * LAP });
    }
  }

  // ---------------------------------------------------------------- overhead wires and banners
  {
    const wireBag = [], bannerBag = [];
    for (let d = 20; d < LAP; d += 95) {
      const at = atDistance(d);
      for (const side of [-1, 1]) {
        const x = at.p.x + at.n.x * side * 12.4, z = at.p.z + at.n.z * side * 12.4;
        wireBag.push({ geometry: new THREE.CylinderGeometry(0.03, 0.03, 9.4, 6), matrix: G.M4(x, 9.0, z, Math.atan2(-side * at.n.x, -side * at.n.z)) });
      }
      const g = new THREE.CylinderGeometry(0.022, 0.022, 24.8, 5);
      g.rotateZ(Math.PI / 2);
      wireBag.push({ geometry: g, matrix: G.M4(at.p.x, 8.75, at.p.z, Math.atan2(at.t.x, at.t.z) + Math.PI / 2) });
      // small string flags along the wire
      for (let i = 0; i < 7; i++) {
        const off = -10.2 + i * 3.4;
        bannerBag.push({ geometry: new THREE.PlaneGeometry(1.3, 0.75), matrix: G.M4(at.p.x + at.n.x * off, 8.25, at.p.z + at.n.z * off, Math.atan2(at.t.x, at.t.z) + Math.PI / 2) });
      }
    }
    const wires = new THREE.Mesh(G.mergeGeoms(wireBag), M.darkMetal);
    wires.name = 'overhead-wires'; wires.userData.passable = true;
    root.add(wires);
    const bmat = new THREE.MeshStandardMaterial({ color: 0xe4d6b8, roughness: 0.82, side: THREE.DoubleSide });
    bmat.userData.surfaceProcedural = true;
    const bm = new THREE.Mesh(G.mergeGeoms(bannerBag), bmat);
    bm.name = 'bunting'; bm.userData.passable = true; bm.userData.surfaceProcedural = true;
    bmat.map = G.DETAILS.cloth.alb; bmat.normalMap = G.DETAILS.cloth.nrm; bmat.needsUpdate = true;
    root.add(bm);
  }

  // ---------------------------------------------------------------- street level extras: parked cars, kiosks
  {
    function carGeometry(bodyColor) {
      const body = [], glass = [], rubber = [], lights = [];
      body.push({ geometry: G.boxGeo(1.85, 0.6, 4.3, 1, 1), matrix: G.M4(0, 0.62, 0) });
      body.push({ geometry: G.boxGeo(1.65, 0.48, 2.3, 1, 1), matrix: G.M4(0, 1.08, -0.15) });
      glass.push({ geometry: G.boxGeo(1.55, 0.4, 1.3, 1, 1), matrix: G.M4(0, 1.18, 0.42) });
      for (const sx of [-0.85, 0.85]) for (const sz of [-1.35, 1.35]) {
        rubber.push({ geometry: new THREE.CylinderGeometry(0.33, 0.33, 0.24, 18), matrix: G.M4(sx, 0.35, sz, 0, 0, Math.PI / 2) });
      }
      lights.push({ geometry: G.boxGeo(0.45, 0.14, 0.06, 1, 1), matrix: G.M4(-0.55, 0.72, 2.16) });
      lights.push({ geometry: G.boxGeo(0.45, 0.14, 0.06, 1, 1), matrix: G.M4(0.55, 0.72, 2.16) });
      return { body: G.mergeGeoms(body), glass: G.mergeGeoms(glass), rubber: G.mergeGeoms(rubber), lights: G.mergeGeoms(lights), color: bodyColor };
    }
    const cars = [];
    const carColors = [0x8a2f2a, 0x2f4d6b, 0xb8b3a8, 0x2b2f31, 0x6a6d4a];
    const spots = [
      [-2, 34], [-1, 76], [-2, 118], [1, 156], [1, 52], [-1, 90],
    ];
    for (let i = 0; i < spots.length; i++) {
      const [side, d] = spots[i];
      const at = atDistance(d);
      const off = side * 15.5;
      const x = at.p.x + at.n.x * off, z = at.p.z + at.n.z * off;
      if (distToTrack(x, z) < 12.5) continue;
      const cg = carGeometry(carColors[i % carColors.length]);
      const g = new THREE.Group();
      const bm = new THREE.MeshStandardMaterial({ color: cg.color, roughness: 0.34, metalness: 0.6, envMapIntensity: 1.1 });
      bm.userData.surfaceProcedural = true;
      bm.roughnessMap = G.DETAILS.paint.rgh; bm.normalMap = G.DETAILS.paint.nrm; bm.normalScale = new THREE.Vector2(0.15, 0.15);
      const mB = new THREE.Mesh(cg.body, bm), mG = new THREE.Mesh(cg.glass, M.glass), mR = new THREE.Mesh(cg.rubber, M.rubber), mL = new THREE.Mesh(cg.lights, new THREE.MeshBasicMaterial({ color: 0xffd7a0 }));
      for (const m of [mB, mG, mR]) { m.castShadow = true; m.receiveShadow = true; m.userData.passable = true; m.userData.surfaceProcedural = true; }
      g.add(mB, mG, mR, mL);
      g.position.set(x, 0.13, z);
      g.rotation.y = Math.atan2(at.t.x, at.t.z) + (side > 0 ? 0 : Math.PI);
      g.name = 'parked-car';
      root.add(g);
      cars.push(g);
    }
    // kiosk / newsstand near the grandstand
    const kiosk = new THREE.Group();
    const kb = new THREE.Mesh(G.boxGeo(3.2, 2.5, 2.2, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3f5e50, roughness: 0.65, map: G.DETAILS.paint.alb, roughnessMap: G.DETAILS.paint.rgh }));
    kb.position.y = 1.25; kb.castShadow = true; kb.receiveShadow = true; kb.userData.passable = true; kiosk.add(kb);
    const kr = new THREE.Mesh(G.boxGeo(3.7, 0.15, 2.7, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd9cfba, roughness: 0.7, map: G.DETAILS.cloth.alb, roughnessMap: G.DETAILS.cloth.rgh }));
    kr.position.y = 2.6; kr.castShadow = true; kr.userData.passable = true; kiosk.add(kr);
    const kp = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), new THREE.MeshStandardMaterial({ map: TEX.signs, roughness: 0.5 }));
    kp.position.set(0, 2.1, 1.12); kiosk.add(kp);
    kiosk.position.set(-24, 0.14, 24); kiosk.rotation.y = 0.9;
    kiosk.name = 'kiosk'; root.add(kiosk);
  }

  // ---------------------------------------------------------------- city aggregate bookkeeping
  const colliderData = [];
  // Barrier colliders: one AABB per 4.8 m of barrier, warped to the local tangent.
  for (const side of [-1, 1]) {
    for (let d = 0; d < LAP; d += 4.8) {
      const a = atDistance(d), b = atDistance(d + 4.8);
      const ax = a.p.x + a.n.x * side * WALL_OFF, az = a.p.z + a.n.z * side * WALL_OFF;
      const bx = b.p.x + b.n.x * side * WALL_OFF, bz = b.p.z + b.n.z * side * WALL_OFF;
      colliderData.push({
        x0: Math.min(ax, bx) - 0.35, x1: Math.max(ax, bx) + 0.35,
        z0: Math.min(az, bz) - 0.35, z1: Math.max(az, bz) + 0.35,
        y0: 0, y1: 1.0,
      });
    }
  }
  G.world.colliders = colliderData;
  G.world.buildingList = buildingList;
  G.world.shadowCasters = shadowCasters;
  G.world.road = road;
  G.world.startLine = atDistance(0);

  // mark merged world meshes as procedural and grounded so the census can see intent
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.passable) o.userData.passable = false;
    if (o.material && (o.material.map || o.material.vertexColors)) o.userData.surfaceProcedural = true;
  });

  G.world.buildStats = {
    buildings: buildingList.length,
    trees: G.scene.getObjectByName('tree-foliage-0')?.count || 0,
    katLights: 3,
  };
})();
