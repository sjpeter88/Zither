// Real-time 3D concert zither: procedural wood and metal, soft shadows,
// strings that vibrate from the audio engine's own per-string levels.
import * as THREE from '../lib/three.module.min.js';
import { STRINGS, GEOM, FRETS, fretX, N_STRINGS, MELODY_COUNT } from './zither-model.js';

const L = GEOM.bodyLen, D = GEOM.bodyDepth, H = GEOM.bodyHeight;
const X = (x) => x - L / 2;             // model x (mm)        -> scene X
const Z = (d) => D / 2 - d;             // distance from near edge -> scene Z (near edge faces the player)

// ---- small deterministic noise helpers ----------------------------------------
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) { return 0.5 * noise(x, y) + 0.25 * noise(x * 2.1, y * 2.1) + 0.125 * noise(x * 4.3, y * 4.3) + 0.125 * noise(x * 8.7, y * 8.7); }

function canvasTexture(w, h, paint, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Straight-grained wood. Grain runs along the canvas x axis. */
function paintWood(ctx, w, h, o) {
  const img = ctx.createImageData(w, h), px = img.data;
  const [r0, g0, b0] = o.light, [r1, g1, b1] = o.dark;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wob = fbm(x * o.wobble, y * o.wobble * 3) * o.wobbleAmp;
      const ring = 0.5 + 0.5 * Math.sin((y + wob) * o.ring + 3 * fbm(x * 0.002, y * 0.03));
      let t = Math.pow(ring, o.sharp) * o.contrast;
      t += (fbm(x * 0.05, y * 0.9) - 0.5) * o.fiber;            // long fibres
      t += (fbm(x * 0.004, y * 0.012) - 0.5) * o.cloud;         // slow colour drift
      t += (hash(x, y) - 0.5) * 0.03;
      t = Math.min(1, Math.max(0, t));
      const i = (y * w + x) * 4;
      px[i] = r0 + (r1 - r0) * t; px[i + 1] = g0 + (g1 - g0) * t; px[i + 2] = b0 + (b1 - b0) * t; px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---- body outline (model mm: x along strings, d from the near edge) ------------
function outline() {
  const r = 15, dc = 333, apex = D, pts = [];
  const arc = (cx, cy, a0, a1) => { for (let k = 0; k <= 6; k++) { const a = a0 + (a1 - a0) * k / 6; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(r, r, Math.PI, 1.5 * Math.PI);            // near-left
  arc(L - r, r, 1.5 * Math.PI, 2 * Math.PI);    // near-right
  arc(L - r, dc, 0, 0.5 * Math.PI);             // far-right
  for (let k = 1; k < 60; k++) {                // curved far side, belly towards the right
    const t = 1 - k / 60;
    pts.push([r + (L - 2 * r) * t, dc + r + (apex - dc - r) * Math.pow(Math.sin(Math.PI * Math.pow(t, 1.25)), 1.1)]);
  }
  arc(r, dc, 0.5 * Math.PI, Math.PI);           // far-left
  return pts;
}

export class ZitherScene {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0a08);
    scene.fog = new THREE.Fog(0x0d0a08, 1500, 3600);
    this.camera = new THREE.PerspectiveCamera(30, 1, 20, 8000);

    this.inst = new THREE.Group();          // everything that mirrors with the instrument
    scene.add(this.inst);

    this.levels = new Float32Array(N_STRINGS);
    this.strings = [];
    this.insets = { top: 0, bottom: 0 };
    this.view = { az: 0, el: 1.2, zoom: 1 }; this.viewTarget = { az: 0, el: 1.2, zoom: 1 };
    this.viewName = 'play'; this.orbiting = false;
    this.time = 0; this.mirror = false;

    this._environment();
    this._lights();
    this._table();
    this._body();
    this._fretboard();
    this._hardware();
    this._strings();
    this._labels();
    this._markers();
    this.setView('play', true);
    this.resize();
  }

  // ---- lighting -----------------------------------------------------------------
  _environment() {
    // a painted studio: dark warm room with a few softboxes, used only for reflections
    const tex = canvasTexture(1024, 512, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2a2018'); g.addColorStop(0.45, '#15100c'); g.addColorStop(1, '#070504');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      const box = (x, y, bw, bh, col) => {
        const rg = ctx.createRadialGradient(x, y, 0, x, y, Math.max(bw, bh));
        rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rg; ctx.save(); ctx.translate(x, y); ctx.scale(bw / Math.max(bw, bh), bh / Math.max(bw, bh)); ctx.translate(-x, -y);
        ctx.fillRect(x - 400, y - 400, 800, 800); ctx.restore();
      };
      box(260, 90, 190, 70, 'rgba(255,236,205,1)');
      box(700, 70, 150, 60, 'rgba(255,214,160,0.9)');
      box(520, 30, 380, 40, 'rgba(255,250,240,0.85)');
      box(900, 200, 60, 120, 'rgba(180,200,255,0.45)');
      box(90, 220, 60, 110, 'rgba(255,190,120,0.4)');
    });
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromEquirectangular(tex).texture;
    this.scene.environmentIntensity = 0.85;
    tex.dispose(); pm.dispose();
  }

  _lights() {
    const key = this.key = new THREE.DirectionalLight(0xffe9cf, 2.6);
    key.position.set(-420, 900, 380);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const c = key.shadow.camera;
    c.left = -520; c.right = 520; c.top = 420; c.bottom = -420; c.near = 200; c.far = 2200;
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.6; key.shadow.radius = 5;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd2ff, 0.7);
    rim.position.set(500, 420, -700);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x1a120c, 0.5));
  }

  _table() {
    const tex = canvasTexture(1024, 1024, (ctx, w, h) => paintWood(ctx, w, h, {
      light: [58, 36, 22], dark: [22, 13, 8], ring: 0.09, sharp: 1.6, contrast: 0.9, wobble: 0.004, wobbleAmp: 60, fiber: 0.25, cloud: 0.5,
    }));
    tex.repeat.set(5, 5);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0, envMapIntensity: 0.5 });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), mat);
    table.rotation.x = -Math.PI / 2; table.position.y = -H - 4.5;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  // ---- soundbox -------------------------------------------------------------------
  _body() {
    const pts = outline();
    const shape = new THREE.Shape(pts.map(([x, d]) => new THREE.Vector2(X(x), d - D / 2)));
    const hole = new THREE.Path();
    hole.absarc(X(GEOM.holeX), GEOM.holeD - D / 2, GEOM.holeR, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: H - 4, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelOffset: -2, bevelSegments: 3, curveSegments: 48 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -H + 2, 0);

    // spruce top painted on one canvas: grain, sunburst and purfling together
    const TW = 1536, TH = Math.round(1536 * D / L);
    const top = canvasTexture(TW, TH, (ctx, w, h) => {
      paintWood(ctx, w, h, { light: [226, 164, 84], dark: [168, 100, 40], ring: 1.55, sharp: 2.2, contrast: 0.75, wobble: 0.0016, wobbleAmp: 9, fiber: 0.22, cloud: 0.35 });
      const sx = w / L, sy = h / D;
      // canvas row 0 is the far side
      const P = (k) => pts.map(([x, d]) => [(L / 2 + (x - L / 2) * k) * sx, h - (D / 2 + (d - D / 2) * k) * sy]);
      const trace = (k) => { ctx.beginPath(); P(k).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      // sunburst: darker towards the rim
      ctx.globalCompositeOperation = 'multiply';
      const cx = w * 0.5, cy = h * 0.5;
      const rg = ctx.createRadialGradient(cx, cy, h * 0.18, cx, cy, w * 0.62);
      rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.55, '#f0d2a8'); rg.addColorStop(0.85, '#8f5326'); rg.addColorStop(1, '#3c1c0c');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineJoin = 'round';
      trace(0.992); ctx.lineWidth = 7 * sx; ctx.strokeStyle = '#1b0f08'; ctx.stroke();        // dark binding
      trace(0.972); ctx.lineWidth = 1.1 * sx; ctx.strokeStyle = '#f1e2c0'; ctx.stroke();       // ivory purfling
      trace(0.966); ctx.lineWidth = 0.8 * sx; ctx.strokeStyle = '#2a170c'; ctx.stroke();
      // rosette around the sound hole
      const hx = GEOM.holeX * sx, hy = h - GEOM.holeD * sy, R = GEOM.holeR * sx;
      const ring = (r0, r1, col) => { ctx.beginPath(); ctx.arc(hx, hy, (r0 + r1) / 2 * sx + R, 0, 7); ctx.lineWidth = (r1 - r0) * sx; ctx.strokeStyle = col; ctx.stroke(); };
      ring(0, 2.2, '#170c06'); ring(2.6, 3.4, '#efe0bd'); ring(3.8, 10.5, '#2b170c'); ring(10.9, 11.7, '#efe0bd'); ring(12.1, 13.2, '#170c06');
      for (let k = 0; k < 48; k++) {             // inlaid mother-of-pearl dashes
        const a = k / 48 * Math.PI * 2, rr = R + 7.15 * sx;
        ctx.save(); ctx.translate(hx + rr * Math.cos(a), hy + rr * Math.sin(a)); ctx.rotate(a + Math.PI / 4);
        ctx.fillStyle = k % 2 ? '#e9dcc0' : '#b98a4a'; ctx.fillRect(-1.5 * sx, -1.5 * sx, 3 * sx, 3 * sx); ctx.restore();
      }
    });
    top.wrapS = top.wrapT = THREE.ClampToEdgeWrapping;
    top.repeat.set(1 / L, 1 / D); top.offset.set(0.5, 0.5);
    const side = canvasTexture(512, 512, (ctx, w, h) => paintWood(ctx, w, h, {
      light: [74, 38, 20], dark: [24, 11, 6], ring: 0.22, sharp: 1.3, contrast: 1, wobble: 0.006, wobbleAmp: 30, fiber: 0.3, cloud: 0.5,
    }));
    side.repeat.set(1 / 180, 1 / 180);
    const topMat = new THREE.MeshPhysicalMaterial({ map: top, roughness: 0.34, clearcoat: 0.85, clearcoatRoughness: 0.12 });
    const sideMat = new THREE.MeshPhysicalMaterial({ map: side, roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.18 });
    const body = new THREE.Mesh(geo, [topMat, sideMat]);
    body.castShadow = body.receiveShadow = true;
    this.inst.add(body);
    this.sideTex = side;

    // inside of the box, seen through the sound hole
    const inside = new THREE.Mesh(new THREE.CircleGeometry(GEOM.holeR + 30, 40), new THREE.MeshStandardMaterial({ color: 0x3a2413, roughness: 0.95 }));
    inside.rotation.x = -Math.PI / 2; inside.position.set(X(GEOM.holeX), -H + 6, Z(GEOM.holeD));
    inside.receiveShadow = true;
    this.inst.add(inside);
    // three little feet
    const footMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc2, roughness: 0.45 });
    for (const [x, d] of [[60, 40], [540, 40], [300, 330]]) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 10), footMat);
      f.scale.y = 0.55; f.position.set(X(x), -H - 1, Z(d)); f.castShadow = true;
      this.inst.add(f);
    }
  }

  _fretboard() {
    const g = GEOM, x0 = g.nutX - 14, x1 = g.lastFretX + 9, w = g.fretboardD1 - g.fretboardD0;
    const ebony = canvasTexture(512, 128, (ctx, cw, ch) => paintWood(ctx, cw, ch, {
      light: [34, 28, 25], dark: [10, 8, 8], ring: 0.5, sharp: 1.2, contrast: 0.8, wobble: 0.004, wobbleAmp: 10, fiber: 0.35, cloud: 0.3,
    }));
    const mat = this.ebony = new THREE.MeshPhysicalMaterial({ map: ebony, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.25 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, g.fretboardH, w), mat);
    board.position.set(X((x0 + x1) / 2), g.fretboardH / 2, Z((g.fretboardD0 + g.fretboardD1) / 2));
    board.castShadow = board.receiveShadow = true;
    this.inst.add(board);

    const nickel = this.nickel = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, metalness: 1, roughness: 0.22 });
    const fretGeo = new THREE.CylinderGeometry(0.75, 0.75, w, 8, 1);
    fretGeo.rotateX(Math.PI / 2);
    const frets = new THREE.InstancedMesh(fretGeo, nickel, FRETS + 1);
    const m = new THREE.Matrix4();
    for (let n = 0; n <= FRETS; n++) {
      m.makeTranslation(X(fretX(n)), g.fretboardH + 0.35, Z((g.fretboardD0 + g.fretboardD1) / 2));
      frets.setMatrixAt(n, m);
    }
    frets.castShadow = true;
    this.inst.add(frets);

    // pearl position dots
    const pearl = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.25, metalness: 0.15, emissive: 0x2a2620 });
    const dotGeo = new THREE.CircleGeometry(2.3, 20); dotGeo.rotateX(-Math.PI / 2);
    const mid = (g.fretboardD0 + g.fretboardD1) / 2;
    for (const n of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
      const xs = (fretX(n - 1) + fretX(n)) / 2, dbl = n % 12 === 0;
      for (const off of dbl ? [-17, 17] : [0]) {
        const dot = new THREE.Mesh(dotGeo, pearl);
        dot.position.set(X(xs), g.fretboardH + 0.06, Z(mid + off));
        this.inst.add(dot);
      }
    }
  }

  _hardware() {
    const g = GEOM, inst = this.inst, nickel = this.nickel;
    const dark = new THREE.MeshPhysicalMaterial({ map: this.sideTex, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xcaa253, metalness: 1, roughness: 0.28 });
    const ivory = new THREE.MeshStandardMaterial({ color: 0xefe6d2, roughness: 0.35 });
    const add = (mesh, x, y, d, shadow = true) => { mesh.position.set(X(x), y, Z(d)); mesh.castShadow = shadow; mesh.receiveShadow = true; inst.add(mesh); return mesh; };
    const dA = g.openD0 - 9, dB = STRINGS[N_STRINGS - 1].d + 9, dMid = (dA + dB) / 2, span = dB - dA;

    // bridges for the open strings: wooden bar with a metal saddle rod
    for (const x of [g.openX0, g.openX1]) {
      add(new THREE.Mesh(new THREE.BoxGeometry(8, g.openY - 1.2, span), dark), x, (g.openY - 1.2) / 2, dMid);
      const rod = new THREE.CylinderGeometry(1, 1, span, 8); rod.rotateX(Math.PI / 2);
      add(new THREE.Mesh(rod, nickel), x, g.openY - 0.9, dMid);
    }
    // red felt between bridge and pins
    add(new THREE.Mesh(new THREE.BoxGeometry(13, 3, span - 4), new THREE.MeshStandardMaterial({ color: 0x7c1418, roughness: 1 })), g.openX1 + 15, 1.5, dMid, false);
    // pin block
    add(new THREE.Mesh(new THREE.BoxGeometry(44, 3.5, span + 8), dark), g.pinX + 9, 1.75, dMid);

    // tuning pins (two staggered rows) and hitch pins
    const pinGeo = new THREE.CylinderGeometry(2.1, 2.3, 11, 10);
    const headGeo = new THREE.BoxGeometry(2.6, 4, 2.6);
    const hitchGeo = new THREE.CylinderGeometry(1.1, 1.1, 6, 8);
    const openCount = N_STRINGS - MELODY_COUNT;
    const pins = new THREE.InstancedMesh(pinGeo, nickel, openCount), heads = new THREE.InstancedMesh(headGeo, nickel, openCount);
    const hitch = new THREE.InstancedMesh(hitchGeo, brass, N_STRINGS);
    const m = new THREE.Matrix4();
    STRINGS.forEach((s, i) => {
      if (i >= MELODY_COUNT) {
        const k = i - MELODY_COUNT, px = g.pinX + (k % 2) * 17;
        m.makeTranslation(X(px), 3.5 + 5.5, Z(s.d)); pins.setMatrixAt(k, m);
        m.makeTranslation(X(px), 3.5 + 12.5, Z(s.d)); heads.setMatrixAt(k, m);
        m.makeTranslation(X(26 + (k % 2) * 7), 3, Z(s.d)); hitch.setMatrixAt(i, m);
        s.xs = 26 + (k % 2) * 7; s.xe = px;
      } else {
        m.makeTranslation(X(g.melodyBridgeX + 24), 3, Z(s.d)); hitch.setMatrixAt(i, m);
        s.xs = 30 + i * 4; s.xe = g.melodyBridgeX + 24;
      }
    });
    pins.castShadow = heads.castShadow = true;
    inst.add(pins, heads, hitch);

    // melody strings: nut, bridge and a small machine head with ivory buttons
    const mMid = (g.fretboardD0 + g.fretboardD1) / 2, mW = g.fretboardD1 - g.fretboardD0;
    add(new THREE.Mesh(new THREE.BoxGeometry(4, g.melodyY - 0.9, mW), ivory), g.nutX - 5, (g.melodyY - 0.9) / 2, mMid);
    add(new THREE.Mesh(new THREE.BoxGeometry(9, g.melodyY - 1.6, mW + 2), dark), g.melodyBridgeX + 1, (g.melodyY - 1.6) / 2, mMid);
    const saddle = new THREE.CylinderGeometry(1, 1, mW, 8); saddle.rotateX(Math.PI / 2);
    add(new THREE.Mesh(saddle, nickel), g.melodyBridgeX, g.melodyY - 1.2, mMid);
    add(new THREE.Mesh(new THREE.BoxGeometry(34, 1.4, mW + 4), brass), 31, 0.7, mMid);
    const postGeo = new THREE.CylinderGeometry(2.3, 2.3, 9, 12);
    const btnGeo = new THREE.SphereGeometry(5, 14, 10);
    const shaftGeo = new THREE.CylinderGeometry(1.1, 1.1, 1, 8); shaftGeo.rotateX(Math.PI / 2);
    for (let i = 0; i < MELODY_COUNT; i++) {
      const px = 30 + i * 4, d = STRINGS[i].d;
      add(new THREE.Mesh(postGeo, nickel), px, 4.5, d);
      // each post is geared to a button on the near edge
      const bx = 18 + i * 7.2;
      const shaft = add(new THREE.Mesh(shaftGeo, nickel), bx, -9, -3, false); shaft.scale.z = 12;
      const btn = add(new THREE.Mesh(btnGeo, ivory), bx, -9, -12); btn.scale.set(0.62, 1.15, 0.5);
    }
  }

  // ---- strings ----------------------------------------------------------------------
  _strings() {
    const looks = {
      steel: { color: 0xe3e7ea, roughness: 0.16, metalness: 1 },
      silverwound: { color: 0xc4c7cb, roughness: 0.34, metalness: 1 },
      brass: { color: 0xd0a85a, roughness: 0.3, metalness: 1 },
      copper: { color: 0xbd7b4f, roughness: 0.34, metalness: 1 },
      red: { color: 0xc0262b, roughness: 0.33, metalness: 0.75 },
    };
    const mats = {};
    for (const k in looks) mats[k] = new THREE.MeshStandardMaterial({ ...looks[k], envMapIntensity: 1.5 });
    const SEG = 28;
    STRINGS.forEach((s, i) => {
      const y = i < MELODY_COUNT ? GEOM.melodyY : GEOM.openY;
      const len = s.xe - s.xs, r = s.radius * 1.25;
      const geo = new THREE.CylinderGeometry(r, r, len, 6, SEG, true);
      geo.rotateZ(-Math.PI / 2);                 // axis along +X
      const mesh = new THREE.Mesh(geo, mats[s.look]);
      mesh.position.set(X((s.xs + s.xe) / 2), y, Z(s.d));
      mesh.castShadow = true;
      this.inst.add(mesh);
      // distribute the length segments so the vibrating part is well sampled
      const pos = geo.attributes.position;
      const base = new Float32Array(pos.array);
      // blur ribbon: the envelope of the vibration, drawn translucent
      const rg = new THREE.PlaneGeometry(1, 1, SEG, 1); rg.rotateX(-Math.PI / 2);
      const ribbon = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: looks[s.look].color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      ribbon.position.set(0, y, Z(s.d)); ribbon.visible = false; ribbon.renderOrder = 3; ribbon.frustumCulled = false;
      this.inst.add(ribbon);
      // highlight strip under the string (chord hints, pluck flashes)
      const pitch = i < MELODY_COUNT ? GEOM.melodyPitch : GEOM.openPitch;
      const hg = new THREE.PlaneGeometry(s.x1 - s.x0, pitch * 0.7); hg.rotateX(-Math.PI / 2);
      const glow = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: 0xffc66b, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.position.set(X((s.x0 + s.x1) / 2), y - 1.2, Z(s.d)); glow.visible = false; glow.renderOrder = 2;
      this.inst.add(glow);
      this.strings.push({
        s, mesh, base, ribbon, glow, amp: 0, shown: 0, phase: Math.random() * 6, rate: 95 + (i * 37) % 60,
        maxAmp: pitch * 0.4, vibFrom: s.x0, hint: 0, flash: 0, hintColor: 0,
      });
    });
  }

  _labels() {
    // note names printed on the top under the open strings, like a tuning chart
    const g = GEOM, open = STRINGS.slice(MELODY_COUNT);
    const d0 = open[0].d - g.openPitch / 2, d1 = open[open.length - 1].d + g.openPitch / 2, wmm = 30, S = 9;
    const tex = canvasTexture(wmm * S, Math.round((d1 - d0) * S), (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(g.openPitch * S * 0.86)}px Georgia, "Times New Roman", serif`;
      open.forEach((s) => {
        const y = h - (s.d - d0) * S;
        ctx.fillStyle = s.look === 'red' ? '#7a0f12' : s.group === 'acc' ? '#2a1608' : s.group === 'bass' ? '#3b1d08' : '#1a0d05';
        ctx.fillText(s.name, w / 2, y + 1);
      });
      for (const idx of [12, 24]) {             // group dividers
        const y = h - (open[idx].d - g.openPitch / 2 - d0) * S;
        ctx.fillStyle = 'rgba(40,20,8,0.75)'; ctx.fillRect(4, y - 1, w - 8, 2);
      }
    });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const geo = new THREE.PlaneGeometry(wmm, d1 - d0); geo.rotateX(-Math.PI / 2);
    const mesh = this.labels = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.82, depthWrite: false }));
    mesh.position.set(X(g.openX1 - 30), 0.25, Z((d0 + d1) / 2)); mesh.renderOrder = 1;
    this.inst.add(mesh);
  }

  _markers() {
    // fingertip markers on the fretboard: [user, song] per melody string
    const geo = new THREE.CircleGeometry(4.6, 24); geo.rotateX(-Math.PI / 2);
    const ringGeo = new THREE.RingGeometry(4.6, 5.6, 28); ringGeo.rotateX(-Math.PI / 2);
    this.markers = [];
    for (let i = 0; i < MELODY_COUNT; i++) {
      const pair = {};
      for (const [who, col] of [['user', 0xfff1d0], ['song', 0xffb347]]) {
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.92, depthWrite: false })));
        grp.add(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x1a0f08, transparent: true, opacity: 0.8, depthWrite: false })));
        grp.position.set(0, GEOM.melodyY + 0.9, Z(STRINGS[i].d)); grp.visible = false; grp.renderOrder = 5;
        this.inst.add(grp);
        pair[who] = { grp, fret: -1, pop: 0 };
      }
      this.markers.push(pair);
    }
  }

  // ---- public API ---------------------------------------------------------------------
  setLevels(lv) { this.levels.set(lv); this.lastLevels = performance.now(); }

  /** Show a fingertip on a melody string at a fret (fret <= 0 hides it). */
  setFinger(string, fret, who = 'user') {
    const mk = this.markers[string] && this.markers[string][who];
    if (!mk) return;
    mk.fret = fret;
    if (fret > 0) {
      const x = fretX(fret) - Math.min(9, (fretX(fret) - fretX(fret - 1)) * 0.42);
      mk.grp.position.x = X(x); mk.grp.visible = true; mk.pop = 1;
    } else mk.grp.visible = false;
    this._vibFrom(string);
  }

  _vibFrom(string) {
    const p = this.markers[string];
    const f = Math.max(p.user.fret, p.song.fret);
    this.strings[string].vibFrom = f > 0 ? fretX(f) : STRINGS[string].x0;
  }

  /** Steady hint on a set of strings (chord shapes). kind 0 = accompaniment, 1 = bass. */
  setHints(list) {
    for (const st of this.strings) st.hint = 0;
    for (const [idx, kind] of list) if (this.strings[idx]) { this.strings[idx].hint = 1; this.strings[idx].hintColor = kind; }
  }

  flash(string, strength = 1) { const st = this.strings[string]; if (st) st.flash = Math.max(st.flash, strength); }

  setMirror(on) { this.mirror = !!on; this.inst.scale.x = on ? -1 : 1; this.labels.scale.x = on ? -1 : 1; }
  setLabels(on) { this.labels.visible = !!on; }
  setInsets(top, bottom) { this.insets = { top, bottom }; this.resize(); }

  setView(name, instant = false) {
    this.viewName = name;
    const v = { play: { az: 0, el: 1.2, zoom: 1 }, top: { az: 0, el: 1.5, zoom: 1 }, show: { az: -0.5, el: 0.62, zoom: 1.04 } }[name] || { az: 0, el: 1.2, zoom: 1 };
    Object.assign(this.viewTarget, v);
    this.orbiting = name === 'show';
    if (instant) Object.assign(this.view, v);
  }

  orbit(dx, dy) {
    this.orbiting = false;
    this.viewTarget.az = Math.max(-1.3, Math.min(1.3, this.viewTarget.az - dx * 0.005));
    this.viewTarget.el = Math.max(0.3, Math.min(1.52, this.viewTarget.el + dy * 0.005));
  }
  zoom(f) { this.viewTarget.zoom = Math.max(0.55, Math.min(1.8, this.viewTarget.zoom * f)); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.w = w; this.h = h;
    this._camera();
  }

  /** Place the camera so the whole instrument fits the area left free by the UI. */
  _camera() {
    const cam = this.camera, w = this.w, h = this.h;
    if (!w || !h) return;
    const hEff = Math.max(120, h - this.insets.top - this.insets.bottom);
    const { az, el, zoom } = this.view;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const target = new THREE.Vector3(0, -8, -6);
    const fovEff = 26 * Math.PI / 180, tanV = Math.tan(fovEff / 2), tanH = tanV * w / hEff;
    // camera basis
    const fwd = dir.clone().negate(), right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    let dist = 0;
    const hx = L / 2 + 16, hz = D / 2 + 14;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [-H, 16]) {
      const p = new THREE.Vector3(sx * hx, y, sz * hz).sub(target);
      const a = p.dot(right), b = p.dot(up), c = p.dot(fwd);      // camera-space offsets
      dist = Math.max(dist, Math.abs(a) / tanH - c, Math.abs(b) / tanV - c);
    }
    dist /= zoom;
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.up.set(0, 1, 0); cam.lookAt(target);
    cam.fov = 2 * Math.atan(tanV * h / hEff) * 180 / Math.PI;
    cam.aspect = w / h;
    cam.setViewOffset(w, h, 0, (this.insets.bottom - this.insets.top) / 2, w, h);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Screen point -> model coordinates (mm) on the plane of the strings. */
  locate(clientX, clientY, y = GEOM.melodyY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = (this._ray || (this._ray = new THREE.Raycaster()));
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, dv = ray.ray.direction;
    if (Math.abs(dv.y) < 1e-6) return null;
    const t = (y - o.y) / dv.y; if (t <= 0) return null;
    return { x: (o.x + dv.x * t) * (this.mirror ? -1 : 1) + L / 2, d: D / 2 - (o.z + dv.z * t) };
  }

  /** What is under a screen point: a fret position, a melody pluck zone or an open string. */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = (this._ray || (this._ray = new THREE.Raycaster()));
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, dv = ray.ray.direction;
    const at = (y) => {
      if (Math.abs(dv.y) < 1e-6) return null;
      const t = (y - o.y) / dv.y; if (t <= 0) return null;
      const px = (o.x + dv.x * t) * (this.mirror ? -1 : 1), pz = o.z + dv.z * t;
      return { x: px + L / 2, d: D / 2 - pz };
    };
    const g = GEOM, res = { zone: null, string: -1, fret: 0, x: 0, d: 0, across: 0, onBody: false };
    const pm = at(g.melodyY);
    if (pm) {
      const f = (pm.d - g.melodyD0) / g.melodyPitch;
      if (f > -0.75 && f < MELODY_COUNT - 0.35 && pm.x > g.nutX - 16 && pm.x < g.melodyBridgeX + 6) {
        res.string = Math.max(0, Math.min(MELODY_COUNT - 1, Math.round(f)));
        res.x = pm.x; res.d = pm.d; res.across = f; res.onBody = true;
        if (pm.x < g.pluckX0) {
          res.zone = 'fret';
          let n = 0; while (n < FRETS && fretX(n) < pm.x) n++;
          res.fret = pm.x <= g.nutX ? 0 : n;
        } else res.zone = 'pluck';
        return res;
      }
    }
    const po = at(g.openY);
    if (po) {
      res.x = po.x; res.d = po.d;
      res.onBody = po.x > -5 && po.x < L + 5 && po.d > -5 && po.d < D + 5;
      const count = N_STRINGS - MELODY_COUNT, f = (po.d - g.openD0) / g.openPitch;
      if (f > -1 && f < count && po.x > g.openX0 - 4 && po.x < g.openX1 + 4) {
        res.zone = 'open'; res.across = f;
        res.string = MELODY_COUNT + Math.max(0, Math.min(count - 1, Math.round(f)));
      }
    }
    return res;
  }

  // ---- per-frame -------------------------------------------------------------------------
  update(dt) {
    this.time += dt;
    const v = this.view, t = this.viewTarget, k = 1 - Math.exp(-dt * 5);
    if (this.orbiting) t.az = -0.5 + 0.45 * Math.sin(this.time * 0.11);
    if (Math.abs(v.az - t.az) + Math.abs(v.el - t.el) + Math.abs(v.zoom - t.zoom) > 1e-4) {
      v.az += (t.az - v.az) * k; v.el += (t.el - v.el) * k; v.zoom += (t.zoom - v.zoom) * k;
      this._camera();
    }
    // if the engine stops reporting (asleep), let the strings settle
    const stale = !this.lastLevels || performance.now() - this.lastLevels > 200;
    for (let i = 0; i < this.strings.length; i++) {
      const st = this.strings[i], s = st.s;
      const lv = stale ? 0 : this.levels[i];
      const want = Math.min(st.maxAmp, 2.6 * Math.pow(lv, 0.55));
      st.amp = want > st.amp ? want : st.amp + (want - st.amp) * Math.min(1, dt * 14);
      if (st.amp > 0.04 || st.shown > 0) {
        st.phase += dt * st.rate;
        const A = st.amp > 0.04 ? st.amp : 0;
        const a = st.vibFrom, b = s.x1, cx = (s.xs + s.xe) / 2, sw = Math.sin(st.phase) * 0.8;
        const pos = st.mesh.geometry.attributes.position, arr = pos.array, base = st.base;
        for (let j = 0; j < arr.length; j += 3) {
          const u = (base[j] + cx - a) / (b - a);
          arr[j + 2] = base[j + 2] + (u > 0 && u < 1 ? A * sw * Math.sin(Math.PI * u) : 0);
        }
        pos.needsUpdate = true;
        // envelope ribbon
        const rp = st.ribbon.geometry.attributes.position, ra = rp.array, n = ra.length / 6;
        for (let j = 0; j < n; j++) {
          const u = j / (n - 1), half = A * Math.sin(Math.PI * u) + s.radius;
          const xx = X(a + (b - a) * u);
          ra[j * 3] = xx; ra[j * 3 + 2] = -half;
          ra[(j + n) * 3] = xx; ra[(j + n) * 3 + 2] = half;
        }
        rp.needsUpdate = true;
        st.ribbon.visible = A > 0;
        st.ribbon.material.opacity = Math.min(0.3, 0.12 + A * 0.08);
        st.shown = A;
      }
      st.flash = Math.max(0, st.flash - dt * 3.2);
      const glow = Math.max(st.hint * (0.11 + 0.03 * Math.sin(this.time * 5)), st.flash * 0.2);
      st.glow.visible = glow > 0.004;
      if (st.glow.visible) {
        st.glow.material.opacity = glow;
        st.glow.material.color.setHex(st.flash * 0.2 > st.hint * 0.11 ? 0xffe2ad : st.hintColor ? 0xff9d3c : 0xffd27a);
      }
    }
    for (const pair of this.markers) for (const who in pair) {
      const mk = pair[who];
      if (mk.grp.visible) { mk.pop = Math.max(0, mk.pop - dt * 6); const sc = 1 + mk.pop * 0.5; mk.grp.scale.set(sc, 1, sc); }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
