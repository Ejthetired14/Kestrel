// Scene 2 — IGLOO
// A dome built from instanced bricks on a sphere, a snowfield with caustic
// sparkle, low-poly mountains and a ring of ice shards. Scroll progress drives
// the camera push (fov 22 -> 30, forward dolly) and, near the end, an exploded
// brick state. Height 2.35 scroll units, as in the original stack.
import * as THREE from '../../vendor/three.module.js';
import { makeSky, scrub, rng, damp, fit, ease } from '../lib.js';

const R = 2.6; // dome radius
const ROWS = 11;
const BRICK_DEPTH = 0.34;

function buildDome() {
  const rand = rng(424242);
  const bricks = [];
  for (let row = 0; row < ROWS; row++) {
    const y0 = (R * row) / ROWS;
    const y1 = (R * (row + 1)) / ROWS;
    const yc = (y0 + y1) / 2;
    const rad = Math.sqrt(Math.max(0.05, R * R - yc * yc));
    const count = Math.max(5, Math.round((2 * Math.PI * rad) / 0.62));
    const rowH = y1 - y0;
    const segLen = (2 * Math.PI * rad) / count;

    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (row % 2 ? Math.PI / count : 0);
      const sin = Math.sin(a);
      const cos = Math.cos(a);

      // carve the entrance: a widening gap on the +Z face for the lower rows
      const angleFromFront = Math.abs(Math.atan2(sin, cos));
      const gap = 0.30 + Math.max(0, 1.25 - yc) * 0.18;
      if (angleFromFront < gap && yc < 1.25) continue;

      const pos = new THREE.Vector3(sin * rad, yc, cos * rad);
      const normal = pos.clone().normalize();

      bricks.push({
        pos,
        normal,
        w: segLen * 0.94,
        h: rowH * 0.92,
        d: BRICK_DEPTH * (0.85 + rand() * 0.3),
        seed: rand(),
        shade: 0.86 + rand() * 0.14,
      });
    }
  }
  return bricks;
}

export function createIglooScene({ renderer }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060d16);
  scene.fog = new THREE.FogExp2(0x0c1a2a, 0.026);

  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 500);
  scene.add(makeSky(0x03070d, 0x1d3b57, 260));

  // ---------- moon ----------
  const moon = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 48),
    new THREE.MeshBasicMaterial({ color: 0xe8f3ff, fog: false, toneMapped: false })
  );
  moon.position.set(-22, 17, -46);
  moon.lookAt(0, 2, 0);
  scene.add(moon);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xa8c8ec, 0x0a1420, 0.95);
  scene.add(hemi);

  const moonLight = new THREE.DirectionalLight(0xcfe4ff, 2.1);
  moonLight.position.set(9, 14, 7);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(1024, 1024);
  moonLight.shadow.camera.left = -9;
  moonLight.shadow.camera.right = 9;
  moonLight.shadow.camera.top = 9;
  moonLight.shadow.camera.bottom = -9;
  moonLight.shadow.camera.near = 1;
  moonLight.shadow.camera.far = 45;
  moonLight.shadow.bias = -0.0012;
  scene.add(moonLight);

  const doorwayGlow = new THREE.PointLight(0xffb27a, 4.2, 9, 2);
  doorwayGlow.position.set(0, 1.0, R * 1.15);
  scene.add(doorwayGlow);

  // ---------- ground (MeshStandard so it receives the moonlight shadow) ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xc9dcee, roughness: 0.92, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- caustics + sparkle overlay ----------
  const causticMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uGlow: { value: 0 },
      uDpr: { value: Math.min(renderer.getPixelRatio(), 2) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        // world position: the plane is rotated, so local z is always 0
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uGlow;
      varying vec3 vPos;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
      }

      void main() {
        float d = length(vPos.xz);
        // fade everything out well before the horizon so grazing angles never streak
        float near = smoothstep(16.0, 5.0, d);

        // concentric ripples rolling outward from the dome
        float ring = sin(d * 6.0 - uTime * 0.55) * 0.5 + 0.5;
        ring = pow(ring, 4.0) * near * 0.3;

        // discrete sparkles that twinkle
        vec2 cell = floor(vPos.xz * 30.0);
        float twinkle = pow(hash(cell + floor(uTime * 2.0)), 30.0) * 1.4;
        twinkle *= near;

        vec3 col = vec3(0.35, 0.6, 0.95) * ring + vec3(0.85, 0.95, 1.0) * twinkle;
        float a = clamp(ring + twinkle, 0.0, 1.0) * uGlow;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
  });
  const caustics = new THREE.Mesh(new THREE.PlaneGeometry(46, 46, 1, 1), causticMat);
  caustics.rotation.x = -Math.PI / 2;
  caustics.position.y = 0.012;
  scene.add(caustics);

  // ---------- igloo bricks ----------
  const bricks = buildDome();
  const brickGeo = new THREE.BoxGeometry(1, 1, 1);
  const brickMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.02,
    flatShading: true,
  });
  const dome = new THREE.InstancedMesh(brickGeo, brickMat, bricks.length);
  dome.castShadow = true;
  dome.receiveShadow = true;
  dome.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const color = new THREE.Color();
  bricks.forEach((b, i) => {
    color.setHSL(0.57, 0.22, 0.78 * b.shade);
    dome.setColorAt(i, color);
  });
  if (dome.instanceColor) dome.instanceColor.needsUpdate = true;
  scene.add(dome);

  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  let lastExplode = -1;

  function layBricks(explode) {
    if (Math.abs(explode - lastExplode) < 0.0015) return;
    lastExplode = explode;
    bricks.forEach((b, i) => {
      const tan = new THREE.Vector3().crossVectors(up, b.normal).normalize();
      if (!isFinite(tan.x) || tan.lengthSq() < 1e-6) tan.set(1, 0, 0);
      const bitan = new THREE.Vector3().crossVectors(b.normal, tan).normalize();

      const push = explode * (0.35 + b.seed * 0.5);
      dummy.position.copy(b.pos).addScaledVector(b.normal, push);
      dummy.position.y += explode * b.seed * 0.25;

      const m = new THREE.Matrix4().makeBasis(
        tan.multiplyScalar(b.w),
        bitan.multiplyScalar(b.h),
        b.normal.clone().multiplyScalar(b.d)
      );
      m.setPosition(dummy.position);
      dome.setMatrixAt(i, m);

      dummy.position.set(0, 0, 0);
    });
    dome.instanceMatrix.needsUpdate = true;
  }
  layBricks(0);

  // ---------- entrance tunnel ----------
  const tunnelMat = new THREE.MeshStandardMaterial({ color: 0xdbe9f7, roughness: 0.8, flatShading: true });
  const tunnel = new THREE.Group();
  const pillarGeo = new THREE.BoxGeometry(0.34, 0.95, 0.5);
  [-0.55, 0.55].forEach((x) => {
    const p = new THREE.Mesh(pillarGeo, tunnelMat);
    p.position.set(x, 0.47, R * 0.92);
    p.castShadow = true;
    p.receiveShadow = true;
    tunnel.add(p);
  });
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.5), tunnelMat);
  lintel.position.set(0, 1.06, R * 0.92);
  lintel.castShadow = true;
  tunnel.add(lintel);

  // dark interior so the doorway reads as an opening
  const interior = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 24),
    new THREE.MeshBasicMaterial({ color: 0x08131f })
  );
  interior.position.set(0, 0.6, R * 0.55);
  tunnel.add(interior);
  scene.add(tunnel);

  // ---------- ice shards ----------
  const shardGeo = new THREE.ConeGeometry(0.16, 0.7, 4);
  const shardMat = new THREE.MeshStandardMaterial({
    color: 0xd7ecff,
    roughness: 0.25,
    metalness: 0.1,
    flatShading: true,
    transparent: true,
    opacity: 0.92,
  });
  const shards = new THREE.Group();
  const shardData = [];
  const srand = rng(99);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + srand() * 0.18;
    const radius = R * 1.12 + srand() * 0.7;
    const m = new THREE.Mesh(shardGeo, shardMat);
    m.position.set(Math.cos(a) * radius, 0.1, Math.sin(a) * radius);
    m.rotation.set(srand() * 0.5, srand() * 6.28, (srand() - 0.5) * 0.6);
    m.scale.setScalar(0.7 + srand() * 0.9);
    shards.add(m);
    shardData.push({ base: m.position.clone(), rot: m.rotation.clone(), seed: srand() });
  }
  scene.add(shards);

  // ---------- mountains ----------
  // emissive lift so the ridges read as hazy silhouettes instead of black cut-outs
  const mountainMat = new THREE.MeshStandardMaterial({
    color: 0x93aecb,
    emissive: new THREE.Color(0x1d3348),
    emissiveIntensity: 1,
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  const mrand = rng(2024);
  const mountains = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + mrand() * 0.25;
    const radius = 55 + mrand() * 45;
    const h = 8 + mrand() * 16;
    const geo = new THREE.ConeGeometry(3.4 + mrand() * 6.0, h, 5 + Math.floor(mrand() * 3));
    const m = new THREE.Mesh(geo, mountainMat);
    m.position.set(Math.cos(a) * radius, h * 0.42 - 0.6, Math.sin(a) * radius);
    m.rotation.y = mrand() * 6.28;
    mountains.add(m);
  }
  scene.add(mountains);

  // ---------- camera path ----------
  const camPos = [
    { t: 0.0, v: [0, 5.6, 23] },
    { t: 0.45, v: [-4.4, 4.0, 16] },
    { t: 0.78, v: [3.4, 2.9, 11.4] },
    { t: 1.0, v: [1.1, 2.3, 8.6] },
  ];
  const camTarget = [
    { t: 0.0, v: [0, 1.15, 0] },
    { t: 0.5, v: [0, 1.0, 0] },
    { t: 1.0, v: [0, 0.9, 0] },
  ];
  const camFov = [
    { t: 0.0, v: 22 },
    { t: 1.0, v: 30 },
  ];

  const target = new THREE.Vector3();
  const smooth = { x: 0, y: 0 };
  const offset = new THREE.Vector3();
  let aspectComp = 1;
  let lastProgress = 0;

  function resize(w, h) {
    camera.aspect = w / h;
    // keep the whole dome in frame on narrow (portrait) viewports
    aspectComp = Math.max(1, Math.pow(1.35 / (w / h), 0.85));
    camera.updateProjectionMatrix();
  }

  function update({ progress, dt, time, pointer }) {
    lastProgress = progress;
    causticMat.uniforms.uTime.value = time;
    causticMat.uniforms.uGlow.value = 0.38 + Math.sin(time * 0.7) * 0.08;

    smooth.x = damp(smooth.x, pointer.x, 2.2, dt);
    smooth.y = damp(smooth.y, pointer.y, 2.2, dt);

    const t = scrub(progress, camTarget);
    target.set(t[0] + smooth.x * 0.2, t[1] - smooth.y * 0.12, t[2]);

    const p = scrub(progress, camPos);
    offset.set(p[0] + smooth.x * 0.55, p[1] - smooth.y * 0.35, p[2]).sub(target);
    camera.position.copy(target).addScaledVector(offset, aspectComp);
    camera.lookAt(target);

    const fov = scrub(progress, camFov);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // brick explode in the last quarter of the scene
    const explode = ease.in(fit(progress, 0.72, 1, 0, 1)) * 0.75;
    layBricks(explode);

    // shards lift and rotate outward with the same progress
    shards.children.forEach((m, i) => {
      const d = shardData[i];
      const lift = fit(progress, 0.55, 1, 0, 1);
      m.position.set(d.base.x * (1 + lift * 0.22), d.base.y + lift * (0.5 + d.seed * 1.4), d.base.z * (1 + lift * 0.22));
      m.rotation.set(d.rot.x + lift * d.seed * 2.2, d.rot.y + time * 0.15 * d.seed, d.rot.z + lift * 0.8);
    });

    // doorway light breathes
    doorwayGlow.intensity = 3.6 + Math.sin(time * 1.3) * 0.9 + fit(progress, 0.6, 1, 0, 2.4);
  }

  return {
    name: 'igloo',
    label: 'Igloo',
    height: 2.35,
    scene,
    camera,
    update,
    resize,
    get progress() {
      return lastProgress;
    },
  };
}
