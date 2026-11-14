/* ================= KARTS + particles ================= */
(function () {
  const G = window.__G, THREE = G.THREE;
  const { clamp, lerp, R, RI } = G.util;
  const M = G.M, TEX = G.TEX;

  // ------------------------------------------------------------------ shared wheel geometry
  const wheelCache = {};
  const sidewallCanvas = document.createElement('canvas'); sidewallCanvas.width = 256; sidewallCanvas.height = 256;
  {
    const x = sidewallCanvas.getContext('2d');
    x.fillStyle = '#161616'; x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      x.strokeStyle = `rgba(78,78,78,${0.05 + i * 0.02})`; x.lineWidth = 2 + i;
      x.beginPath(); x.arc(128, 128, 40 + i * 11, 0, Math.PI * 2); x.stroke();
    }
    x.fillStyle = 'rgba(235,230,216,.62)'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '700 17px monospace';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      x.save(); x.translate(128 + Math.cos(a) * 92, 128 + Math.sin(a) * 92); x.rotate(a + Math.PI / 2);
      x.fillText(i % 3 === 0 ? 'SUNSET' : 'KART', 0, 0); x.restore();
    }
    x.strokeStyle = 'rgba(220,214,198,.22)'; x.lineWidth = 3;
    x.beginPath(); x.arc(128, 128, 74, 0, Math.PI * 2); x.stroke();
  }
  const sidewallTex = new THREE.CanvasTexture(sidewallCanvas);
  sidewallTex.colorSpace = THREE.SRGBColorSpace; sidewallTex.anisotropy = 4;
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x9d9a95, map: sidewallTex, roughness: 0.88, metalness: 0.02 });
  tireMat.name = 'kart-tyre';
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc2bfb6, roughness: 0.26, metalness: 0.85, envMapIntensity: 1.5 });
  rimMat.name = 'kart-rim';
  const rimDarkMat = new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.4, metalness: 0.8 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x8e8f90, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.3 });
  const rimAccentMat = new THREE.MeshStandardMaterial({ color: 0xd7a13c, roughness: 0.32, metalness: 0.9 });
  const rimWhiteMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.55, metalness: 0.1 });

  const contactCanvas = document.createElement('canvas'); contactCanvas.width = 128; contactCanvas.height = 128;
  {
    const cx = contactCanvas.getContext('2d');
    const gr = cx.createRadialGradient(64, 64, 8, 64, 64, 62);
    gr.addColorStop(0, 'rgba(0,0,0,.78)'); gr.addColorStop(0.55, 'rgba(0,0,0,.38)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 128, 128);
  }
  const contactTex = new THREE.CanvasTexture(contactCanvas);
  const contactMat = new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false, opacity: 0.7 });

  function makeWheelGeo(r, w) {
    const key = r + ':' + w;
    if (wheelCache[key]) return wheelCache[key];
    const tireBag = [], rimBag = [], metalBag = [], accentBag = [], whiteBag = [];
    const tire = new THREE.CylinderGeometry(r, r, w, 36, 1, true);
    tire.rotateZ(Math.PI / 2);
    tireBag.push({ geometry: tire });
    for (const sx of [-1, 1]) {
      const wall = new THREE.TorusGeometry(r * 0.78, r * 0.225, 8, 36);
      wall.rotateY(Math.PI / 2);
      wall.translate(sx * w * 0.40, 0, 0);
      tireBag.push({ geometry: wall });
    }
    // rim ring on both faces
    for (const sx of [-1, 1]) {
      const ring = new THREE.TorusGeometry(r * 0.6, r * 0.045, 6, 28);
      ring.rotateY(Math.PI / 2);
      ring.translate(sx * w * 0.40, 0, 0);
      rimBag.push({ geometry: ring });
      const spokes = [];
      for (let i = 0; i < 5; i++) {
        const spoke = new THREE.BoxGeometry(0.035, r * 0.065, r * 0.42);
        const m = new THREE.Matrix4().makeRotationX(i / 5 * Math.PI * 2).multiply(new THREE.Matrix4().makeTranslation(0, 0, r * 0.30));
        spokes.push({ geometry: spoke, matrix: m });
      }
      const disc = new THREE.CylinderGeometry(r * 0.55, r * 0.55, 0.03, 24);
      disc.rotateZ(Math.PI / 2); disc.translate(sx * w * 0.25, 0, 0);
      rimBag.push({ geometry: disc });
      const inner = new THREE.CylinderGeometry(r * 0.47, r * 0.47, w * 0.34, 24);
      inner.rotateZ(Math.PI / 2); inner.translate(sx * w * 0.08, 0, 0);
      metalBag.push({ geometry: inner });
      for (const sp of spokes) rimBag.push({ geometry: sp.geometry, matrix: new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeTranslation(sx * w * 0.42, 0, 0), sp.matrix) });
      // lug nuts
      for (let i = 0; i < 5; i++) {
        const nut = new THREE.CylinderGeometry(r * 0.045, r * 0.045, 0.035, 6);
        nut.rotateZ(Math.PI / 2);
        nut.translate(sx * w * 0.46, Math.cos(i / 5 * Math.PI * 2) * r * 0.18, Math.sin(i / 5 * Math.PI * 2) * r * 0.18);
        metalBag.push({ geometry: nut });
      }
      const cap = new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.03, 18);
      cap.rotateZ(Math.PI / 2); cap.translate(sx * w * 0.47, 0, 0);
      accentBag.push({ geometry: cap });
      const whiteRing = new THREE.TorusGeometry(r * 0.74, r * 0.012, 5, 32);
      whiteRing.rotateY(Math.PI / 2); whiteRing.translate(sx * w * 0.505, 0, 0);
      whiteBag.push({ geometry: whiteRing });
    }
    // brake disc visible through the spokes
    const disc2 = new THREE.CylinderGeometry(r * 0.53, r * 0.53, 0.02, 24);
    disc2.rotateZ(Math.PI / 2); disc2.translate(0, 0, 0);
    metalBag.push({ geometry: disc2 });
    wheelCache[key] = {
      tire: G.mergeGeoms(tireBag), rim: G.mergeGeoms(rimBag), metal: G.mergeGeoms(metalBag), accent: G.mergeGeoms(accentBag), white: G.mergeGeoms(whiteBag),
    };
    return wheelCache[key];
  }

  // ------------------------------------------------------------------ kart
  function tube(bag, from, to, radius, mat) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(radius, radius, len, 10);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    bag.push({ geometry: g, matrix: m });
  }
  function spherePart(bag, x, y, z, sx, sy, sz, seg = 20) {
    const g = new THREE.SphereGeometry(1, seg, Math.max(10, seg * 0.6));
    bag.push({ geometry: g, matrix: G.M4(x, y, z, 0, 0, 0, sx, sy, sz) });
  }

  function makeLivery(num, accentHex) {
    const S = 512, c = document.createElement('canvas'); c.width = S; c.height = S;
    const x = c.getContext('2d');
    x.clearRect(0, 0, S, S);
    // number roundel
    x.fillStyle = 'rgba(12,12,14,.92)';
    x.beginPath(); x.arc(S / 2, S / 2 - 20, 150, 0, Math.PI * 2); x.fill();
    x.strokeStyle = accentHex; x.lineWidth = 12; x.stroke();
    x.fillStyle = '#f7f1e4'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = '800 215px Helvetica, Arial, sans-serif';
    x.fillText(String(num), S / 2, S / 2 - 10);
    // sponsor strip
    x.fillStyle = 'rgba(247,241,228,.92)';
    x.font = '700 27px monospace'; x.fillText('SUNSET / DISTRICT', S / 2, S / 2 + 112);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  const kartGeoCache = {};
  function createKart(opts = {}) {
    const num = opts.number ?? 7;
    const base = opts.base ?? 0xf0a12c;
    const accent = opts.accent ?? 0x1e2228;
    const accentCss = '#' + new THREE.Color(accent).getHexString();
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: base, roughness: 0.28, metalness: 0.45, clearcoat: 0.9, clearcoatRoughness: 0.18,
      envMapIntensity: 1.2,
    });
    paintMat.name = 'kart-paint';
    paintMat.userData.surfaceProcedural = true;
    const accentMat = new THREE.MeshPhysicalMaterial({
      color: accent, roughness: 0.38, metalness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.24,
      envMapIntensity: 1.1,
    });
    accentMat.name = 'kart-accent';
    accentMat.userData.surfaceProcedural = true;
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.18, metalness: 1.0, envMapIntensity: 1.4 });
    chromeMat.name = 'kart-chrome';
    const carbonMat = new THREE.MeshStandardMaterial({ color: 0x25272a, roughness: 0.42, metalness: 0.55, envMapIntensity: 0.9 });
    carbonMat.name = 'kart-carbon';
    const redLightMat = new THREE.MeshBasicMaterial({ color: 0xff2d1a });
    const flameMat = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.72 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0xd6cfbf, roughness: 0.72 });
    const suitAccent = new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: 0.6, metalness: 0.1 });
    const helmetMat = new THREE.MeshPhysicalMaterial({ color: base, roughness: 0.22, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.3 });
    const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x0c1116, roughness: 0.06, metalness: 0.8, envMapIntensity: 1.6 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55 });

    const group = new THREE.Group();
    group.name = 'kart-' + num;
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 3.2), contactMat);
    contact.rotation.x = -Math.PI / 2;
    contact.position.set(0, 0.035, 0);
    contact.renderOrder = 2;
    contact.userData.passable = true;
    group.add(contact);
    const body = new THREE.Group();
    body.name = 'kart-body-' + num;
    group.add(body);
    const bags = { paint: [], accent: [], chrome: [], carbon: [], seat: [], suit: [], suitAccent: [], helmet: [], visor: [], glove: [], red: [], flame: [], metal: [] };

    // chassis floor + rails
    bags.paint.push({ geometry: G.boxGeo(1.08, 0.07, 1.95, 1, 1), matrix: G.M4(0, 0.17, 0.02) });
    bags.carbon.push({ geometry: G.boxGeo(1.16, 0.035, 2.02, 1, 1), matrix: G.M4(0, 0.135, 0.02) });
    for (const sx of [-1, 1]) {
      tube(bags.carbon, [sx * 0.3, 0.19, -1.0], [sx * 0.3, 0.19, 1.0], 0.028);
      tube(bags.chrome, [sx * 0.65, 0.2, -0.9], [sx * 0.65, 0.2, 0.95], 0.026);
      tube(bags.carbon, [sx * 0.3, 0.19, -0.55], [sx * 0.65, 0.2, -0.9], 0.024);
      tube(bags.carbon, [sx * 0.3, 0.19, 0.55], [sx * 0.65, 0.2, 0.95], 0.024);
    }
    // side pods
    for (const sx of [-1, 1]) {
      const pod = new THREE.CapsuleGeometry(0.16, 0.56, 6, 16);
      pod.rotateX(Math.PI / 2);
      bags.paint.push({ geometry: pod, matrix: G.M4(sx * 0.53, 0.31, 0.02, 0, 0, sx * 0.04, 1.0, 0.82, 1.0) });
      // flat top plate and a dark leading edge
      bags.accent.push({ geometry: G.boxGeo(0.30, 0.035, 0.78, 1, 1), matrix: G.M4(sx * 0.54, 0.445, 0.01) });
      bags.carbon.push({ geometry: G.boxGeo(0.33, 0.16, 0.06, 1, 1), matrix: G.M4(sx * 0.54, 0.33, 0.47) });
      bags.carbon.push({ geometry: G.boxGeo(0.33, 0.16, 0.06, 1, 1), matrix: G.M4(sx * 0.54, 0.33, -0.42) });
    }
    // nose: low wedge fairing, not a blob
    bags.paint.push({ geometry: G.boxGeo(1.02, 0.13, 0.70, 1, 1), matrix: G.M4(0, 0.205, 1.00, 0, -0.045) });
    bags.paint.push({ geometry: G.boxGeo(0.84, 0.10, 0.62, 1, 1), matrix: G.M4(0, 0.295, 0.93, 0, -0.10) });
    bags.paint.push({ geometry: G.boxGeo(1.08, 0.12, 0.16, 1, 1), matrix: G.M4(0, 0.225, 1.34) });
    // front wing plate and endplates
    bags.accent.push({ geometry: G.boxGeo(1.28, 0.035, 0.30, 1, 1), matrix: G.M4(0, 0.165, 1.30, 0, -0.02) });
    bags.accent.push({ geometry: G.boxGeo(0.035, 0.18, 0.34, 1, 1), matrix: G.M4(-0.63, 0.20, 1.29) });
    bags.accent.push({ geometry: G.boxGeo(0.035, 0.18, 0.34, 1, 1), matrix: G.M4(0.63, 0.20, 1.29) });
    // black grille and number background
    bags.carbon.push({ geometry: G.boxGeo(0.44, 0.09, 0.03, 1, 1), matrix: G.M4(0, 0.22, 1.425) });
    bags.carbon.push({ geometry: G.boxGeo(0.56, 0.02, 0.70, 1, 1), matrix: G.M4(0, 0.342, 0.95, 0, -0.10) });
    bags.accent.push({ geometry: G.boxGeo(0.14, 0.04, 0.72, 1, 1), matrix: G.M4(0, 0.355, 0.95, 0, -0.10) });
    // front hoop
    tube(bags.chrome, [-0.55, 0.18, 1.34], [-0.55, 0.42, 1.34], 0.028);
    tube(bags.chrome, [0.55, 0.18, 1.34], [0.55, 0.42, 1.34], 0.028);
    tube(bags.chrome, [-0.55, 0.42, 1.34], [0.55, 0.42, 1.34], 0.028);
    tube(bags.chrome, [-0.55, 0.18, 1.34], [0.55, 0.18, 1.34], 0.028);
    // rear bumper + light
    tube(bags.chrome, [-0.62, 0.24, -1.16], [-0.62, 0.42, -1.16], 0.028);
    tube(bags.chrome, [0.62, 0.24, -1.16], [0.62, 0.42, -1.16], 0.028);
    tube(bags.chrome, [-0.62, 0.32, -1.16], [0.62, 0.32, -1.16], 0.026);
    bags.red.push({ geometry: G.boxGeo(0.34, 0.08, 0.05, 1, 1), matrix: G.M4(0, 0.44, -1.18) });
    // rear wing over the protection hoop
    bags.paint.push({ geometry: G.boxGeo(1.16, 0.05, 0.28, 1, 1), matrix: G.M4(0, 0.92, -0.99, 0, 0.08) });
    bags.accent.push({ geometry: G.boxGeo(1.12, 0.014, 0.24, 1, 1), matrix: G.M4(0, 0.952, -0.99, 0, 0.08) });
    bags.paint.push({ geometry: G.boxGeo(0.05, 0.22, 0.30, 1, 1), matrix: G.M4(-0.59, 0.99, -0.99, 0, 0.08) });
    bags.paint.push({ geometry: G.boxGeo(0.05, 0.22, 0.30, 1, 1), matrix: G.M4(0.59, 0.99, -0.99, 0, 0.08) });
    bags.chrome.push({ geometry: G.boxGeo(0.035, 0.20, 0.035, 1, 1), matrix: G.M4(-0.34, 0.82, -0.97) });
    bags.chrome.push({ geometry: G.boxGeo(0.035, 0.20, 0.035, 1, 1), matrix: G.M4(0.34, 0.82, -0.97) });
    bags.paint.push({ geometry: G.boxGeo(0.70, 0.32, 0.05, 1, 1), matrix: G.M4(0, 0.53, -1.20) });
    bags.accent.push({ geometry: G.boxGeo(0.72, 0.06, 0.052, 1, 1), matrix: G.M4(0, 0.40, -1.20) });
    // radiator and rear axle
    bags.metal.push({ geometry: G.boxGeo(0.34, 0.26, 0.06, 1, 1), matrix: G.M4(0.40, 0.47, 0.30, 0, -0.15) });
    for (let i = 0; i < 5; i++) bags.metal.push({ geometry: G.boxGeo(0.30, 0.012, 0.01, 1, 1), matrix: G.M4(0.40, 0.40 + i * 0.035, 0.335, 0, -0.15) });
    const axle = new THREE.CylinderGeometry(0.035, 0.035, 1.22, 10); axle.rotateZ(Math.PI / 2);
    bags.chrome.push({ geometry: axle, matrix: G.M4(0, 0.3, -0.81) });
    bags.carbon.push({ geometry: G.boxGeo(0.08, 0.30, 0.38, 1, 1), matrix: G.M4(-0.5, 0.4, -0.62) });
    // seat
    bags.seat.push({ geometry: G.boxGeo(0.46, 0.09, 0.46, 1, 1), matrix: G.M4(0, 0.39, -0.33, 0, 0.03) });
    const back = new THREE.CapsuleGeometry(0.24, 0.36, 6, 16);
    back.rotateX(Math.PI / 2);
    bags.seat.push({ geometry: back, matrix: G.M4(0, 0.62, -0.63, 0, 0.06, 0, 1.0, 1.15, 0.45) });
    // engine + fins + exhaust
    bags.carbon.push({ geometry: G.boxGeo(0.34, 0.26, 0.5, 1, 1), matrix: G.M4(-0.32, 0.45, -0.58) });
    for (let i = 0; i < 7; i++) {
      bags.metal.push({ geometry: G.boxGeo(0.36, 0.014, 0.08, 1, 1), matrix: G.M4(-0.32, 0.56 + i * 0.03, -0.42) });
    }
    const air = new THREE.CylinderGeometry(0.12, 0.12, 0.16, 20);
    air.rotateZ(Math.PI / 2);
    bags.chrome.push({ geometry: air, matrix: G.M4(-0.2, 0.62, -0.55) });
    tube(bags.chrome, [-0.36, 0.44, -0.8], [-0.3, 0.4, -1.03], 0.055);
    tube(bags.chrome, [-0.3, 0.4, -1.03], [-0.5, 0.34, -1.03], 0.065);
    // exhaust tip + flame cone
    tube(bags.carbon, [-0.53, 0.34, -1.04], [-0.62, 0.34, -1.04], 0.075);
    const flame = new THREE.ConeGeometry(0.075, 0.5, 12, 1, true);
    flame.rotateZ(Math.PI / 2);
    bags.flame.push({ geometry: flame, matrix: G.M4(-0.86, 0.34, -1.04) });
    // fuel tank behind seat
    const ft = new THREE.CylinderGeometry(0.1, 0.1, 0.32, 16);
    bags.chrome.push({ geometry: ft, matrix: G.M4(0.42, 0.5, -0.72, 0, 0, 0.1) });
    // steering column and wheel
    tube(bags.chrome, [0, 0.25, 0.58], [0, 0.72, 0.26], 0.022);
    const sw = new THREE.TorusGeometry(0.15, 0.024, 8, 24);
    bags.carbon.push({ geometry: sw, matrix: G.M4(0, 0.77, 0.24, 0, -0.72) });
    tube(bags.chrome, [-0.14, 0.77, 0.24], [0.14, 0.77, 0.24], 0.014);
    // driver
    bags.suitAccent.push({ geometry: new THREE.CapsuleGeometry(0.17, 0.22, 6, 16), matrix: G.M4(0, 0.75, -0.35, 0, 0.06) });
    spherePart(bags.suit, 0, 0.92, -0.42, 0.22, 0.14, 0.16);
    // harness straps
    bags.carbon.push({ geometry: G.boxGeo(0.075, 0.28, 0.035, 1, 1), matrix: G.M4(-0.11, 0.88, -0.19, 0, -0.18) });
    bags.carbon.push({ geometry: G.boxGeo(0.075, 0.28, 0.035, 1, 1), matrix: G.M4(0.11, 0.88, -0.19, 0, 0.18) });
    // arms
    for (const sx of [-1, 1]) {
      tube(bags.suit, [sx * 0.2, 0.94, -0.38], [sx * 0.18, 0.83, 0.03], 0.052);
      tube(bags.suitAccent, [sx * 0.18, 0.83, 0.03], [sx * 0.14, 0.79, 0.18], 0.048);
      spherePart(bags.glove, sx * 0.14, 0.79, 0.2, 0.065, 0.05, 0.075, 12);
    }
    // helmet
    spherePart(bags.helmet, 0, 1.14, -0.33, 0.185, 0.195, 0.19, 24);
    // visor cap
    {
      const vg = new THREE.SphereGeometry(0.195, 20, 12, -0.85, 1.7, 1.18, 0.75);
      bags.visor.push({ geometry: vg, matrix: G.M4(0, 1.14, -0.33) });
    }
    bags.accent.push({ geometry: new THREE.TorusGeometry(0.19, 0.024, 6, 24), matrix: G.M4(0, 1.145, -0.33, Math.PI / 2, 0, 0) });
    // rear protection hoop
    tube(bags.chrome, [-0.3, 0.62, -0.96], [-0.3, 1.02, -0.96], 0.022);
    tube(bags.chrome, [0.3, 0.62, -0.96], [0.3, 1.02, -0.96], 0.022);
    tube(bags.chrome, [-0.3, 1.02, -0.96], [0.3, 1.02, -0.96], 0.022);
    // headrest
    bags.carbon.push({ geometry: G.boxGeo(0.4, 0.24, 0.1, 1, 1), matrix: G.M4(0, 1.1, -0.58, 0, -0.12) });
    // side number plates
    const decalMat = new THREE.MeshStandardMaterial({ map: makeLivery(num, accentCss), transparent: true, roughness: 0.4, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
    decalMat.name = 'kart-livery';
    decalMat.userData.surfaceProcedural = true;
    const decalGeo = new THREE.PlaneGeometry(0.50, 0.34);
    for (const sx of [-1, 1]) {
      const d = new THREE.Mesh(decalGeo, decalMat);
      d.position.set(sx * 0.706, 0.345, 0.02);
      d.rotation.y = sx * Math.PI / 2;
      body.add(d);
    }
    // front number, facing up/forward
    const frontDecal = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.34), decalMat);
    frontDecal.position.set(0, 0.405, 0.96);
    frontDecal.rotation.x = -Math.PI / 2 + 0.13;
    const rearDecal = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.30), decalMat);
    rearDecal.position.set(0, 0.52, -1.225);
    rearDecal.rotation.y = Math.PI;
    body.add(rearDecal);
    body.add(frontDecal);

    // merge bags
    const matMap = {
      paint: paintMat, accent: accentMat, chrome: chromeMat, carbon: carbonMat, seat: seatMat,
      suit: suitMat, suitAccent: suitAccent, helmet: helmetMat, visor: visorMat, glove: gloveMat,
      red: redLightMat, flame: flameMat, metal: M.metal,
    };
    const flameMesh = [];
    for (const [key, list] of Object.entries(bags)) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(G.mergeGeoms(list), matMap[key]);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'kart-part-' + key;
      mesh.userData.passable = true;
      mesh.userData.identity = [{ name: key === 'paint' ? 'shell' : key, extents: [1.4, 0.8, 2.4] }];
      mesh.userData.parts = [key === 'paint' ? 'shell' : key];
      if (key === 'paint' || key === 'accent' || key === 'chrome' || key === 'carbon' || key === 'helmet' || key === 'suit') mesh.userData.surfaceProcedural = true;
      body.add(mesh);
      if (key === 'flame') { mesh.visible = false; flameMesh.push(mesh); }
      if (key === 'red') mesh.name = 'kart-brake-light';
    }

    // wheels
    const wheels = [];
    const fr = 0.26, rr = 0.30;
    const specs = [
      { x: -0.64, z: 0.81, r: fr, front: true },
      { x: 0.64, z: 0.81, r: fr, front: true },
      { x: -0.68, z: -0.81, r: rr, front: false },
      { x: 0.68, z: -0.81, r: rr, front: false },
    ];
    for (const sp of specs) {
      const pivot = new THREE.Group();
      pivot.position.set(sp.x, sp.r, sp.z);
      const spin = new THREE.Group();
      pivot.add(spin);
      const geo = makeWheelGeo(sp.r, sp.r > 0.28 ? 0.32 : 0.27);
      const tyre = new THREE.Mesh(geo.tire, tireMat);
      const rim = new THREE.Mesh(geo.rim, rimMat);
      const disc = new THREE.Mesh(geo.metal, discMat);
      const acc = new THREE.Mesh(geo.accent, rimAccentMat);
      const white = new THREE.Mesh(geo.white, rimWhiteMat);
      for (const m of [tyre, rim, disc, acc, white]) { m.castShadow = true; m.receiveShadow = true; m.userData.passable = true; m.userData.identity = [{ name: 'wheel', extents: [0.4, 0.6, 0.6] }]; m.userData.parts = ['wheel']; spin.add(m); }
      group.add(pivot);
      wheels.push({ pivot, spin, front: sp.front, r: sp.r, side: sp.x > 0 ? 'left' : 'right' });
    }
    // suspension arms
    const arms = [];
    for (const sp of specs) {
      const inner = [Math.sign(sp.x) * 0.32, 0.2, sp.z];
      tube(arms, inner, [sp.x, sp.r, sp.z], 0.022);
      tube(arms, [inner[0], 0.28, sp.z], [sp.x, sp.r + 0.05, sp.z], 0.02);
    }
    const armMesh = new THREE.Mesh(G.mergeGeoms(arms), M.darkMetal);
    armMesh.castShadow = true; armMesh.name = 'kart-suspension'; armMesh.userData.passable = true; armMesh.userData.identity = [{ name: 'suspension', extents: [1.3, 0.5, 1.6] }]; armMesh.userData.parts = ['suspension'];
    body.add(armMesh);

    group.userData.wheelSpin = 0;
    group.userData.parts = { body, wheels, flameMeshes: flameMesh, brakeLight: body.getObjectByName('kart-brake-light'), num };
    return group;
  }
  G.createKart = createKart;

  // ------------------------------------------------------------------ particles
  const smokeTex = TEX.smoke;
  class ParticleField {
    constructor(max, opts = {}) {
      this.max = max;
      this.opts = opts;
      this.pos = new Float32Array(max * 3);
      this.vel = new Float32Array(max * 3);
      this.life = new Float32Array(max);
      this.maxLife = new Float32Array(max);
      this.size = new Float32Array(max);
      this.seed = new Float32Array(max);
      this.alpha = new Float32Array(max);
      this.geo = new THREE.BufferGeometry();
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
      this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
      this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: opts.texture || smokeTex },
          uColor: { value: new THREE.Color(opts.color ?? 0xd8d2c8) },
          uAdd: { value: opts.additive ? 1 : 0 },
        },
        vertexShader: `attribute float aSize; attribute float aAlpha; attribute float aSeed;
          varying float vAlpha; varying float vSeed;
          void main(){
            vAlpha = aAlpha; vSeed = aSeed;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `uniform sampler2D uTex; uniform vec3 uColor; uniform float uAdd;
          varying float vAlpha; varying float vSeed;
          void main(){
            vec4 t = texture2D(uTex, gl_PointCoord);
            float a = t.a * vAlpha;
            if (a < 0.006) discard;
            vec3 c = uColor * (0.82 + 0.36 * vSeed);
            if (uAdd > 0.5) gl_FragColor = vec4(c * a * 1.8, a);
            else gl_FragColor = vec4(c, a);
          }`,
        transparent: true, depthWrite: false,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.points = new THREE.Points(this.geo, this.material);
      this.points.frustumCulled = false;
      this.points.userData.passable = true;
      this.cursor = 0;
      this.active = 0;
    }
    spawn(x, y, z, vx, vy, vz, life, size) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      const i3 = i * 3;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.life[i] = life; this.maxLife[i] = life; this.size[i] = size; this.seed[i] = Math.random();
      this.alpha[i] = 1;
    }
    update(dt) {
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
        this.life[i] -= dt;
        const i3 = i * 3;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        this.vel[i3] *= (1 - dt * 0.35);
        this.vel[i3 + 2] *= (1 - dt * 0.35);
        this.vel[i3 + 1] += this.opts.buoyancy * dt;
        const f = Math.max(0, this.life[i] / this.maxLife[i]);
        this.alpha[i] = f * f * (this.opts.fade ?? 0.7);
        this.size[i] += this.opts.grow * dt;
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aSeed.needsUpdate = true;
    }
  }
  G.ParticleField = ParticleField;

  // skid marks: one dynamic ribbon pool, laid as short quads under the rear tyres
  class SkidMarks {
    constructor(max = 700) {
      this.max = max;
      this.geo = new THREE.BufferGeometry();
      this.pos = new Float32Array(max * 4 * 3);
      this.alpha = new Float32Array(max * 4);
      this.idx = [];
      for (let i = 0; i < max; i++) {
        const a = i * 4;
        this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
      this.geo.setIndex(this.idx);
      this.mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x0c0c0c) } },
        vertexShader: `attribute float aAlpha; varying float vA;
          void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; varying float vA;
          void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA*0.55); }`,
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      this.mesh = new THREE.Mesh(this.geo, this.mat);
      this.mesh.frustumCulled = false;
      this.mesh.userData.passable = true;
      this.cursor = 0;
    }
    add(x, z, ang, width = 0.22, strength = 1) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      const i4 = i * 4, p = this.pos;
      const dx = Math.cos(ang) * 0.28, dz = Math.sin(ang) * 0.28;
      const nx = -Math.sin(ang) * width, nz = Math.cos(ang) * width;
      const y = 0.048;
      p[i4 * 3] = x - dx - nx; p[i4 * 3 + 1] = y; p[i4 * 3 + 2] = z - dz - nz;
      p[(i4 + 1) * 3] = x + dx - nx; p[(i4 + 1) * 3 + 1] = y; p[(i4 + 1) * 3 + 2] = z + dz - nz;
      p[(i4 + 2) * 3] = x - dx + nx; p[(i4 + 2) * 3 + 1] = y; p[(i4 + 2) * 3 + 2] = z - dz + nz;
      p[(i4 + 3) * 3] = x + dx + nx; p[(i4 + 3) * 3 + 1] = y; p[(i4 + 3) * 3 + 2] = z + dz + nz;
      for (let k = 0; k < 4; k++) this.alpha[i4 + k] = strength;
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }
    clear() { this.alpha.fill(0); this.geo.attributes.aAlpha.needsUpdate = true; this.cursor = 0; }
  }
  G.SkidMarks = SkidMarks;
})();
