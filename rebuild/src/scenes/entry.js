// Scene 1 — ENTRY
// Drifting particle field + translucent slabs, camera dollying through them.
// Height 5.5 scroll units, matching the stack order documented in REVERSE.md.
import * as THREE from '../../vendor/three.module.js';
import { makeSky, scrub, rng, damp, fit } from '../lib.js';

export function createEntryScene({ renderer }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060d16);
  scene.fog = new THREE.FogExp2(0x060d16, 0.03);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);

  scene.add(makeSky(0x04080f, 0x22415c, 200));

  const rand = rng(1337);

  // ---------- particle field ----------
  const COUNT = 2800;
  const pos = new Float32Array(COUNT * 3);
  const size = new Float32Array(COUNT);
  const seed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const r = 3 + rand() * 30;
    const a = rand() * Math.PI * 2;
    pos[i * 3 + 0] = Math.cos(a) * r;
    pos[i * 3 + 1] = -4 + rand() * 16;
    pos[i * 3 + 2] = Math.sin(a) * r;
    size[i] = 0.35 + rand() * 1.1;
    seed[i] = rand();
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

  const pMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uDpr: { value: Math.min(renderer.getPixelRatio(), 2) },
      uColor: { value: new THREE.Color(0xbfdcff) },
      uProgress: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aSeed;
      uniform float uTime;
      uniform float uDpr;
      uniform float uProgress;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float ph = aSeed * 6.28318;
        p.y += sin(uTime * 0.32 + ph) * 0.7;
        p.x += cos(uTime * 0.21 + ph * 1.7) * 0.9;
        p.z += sin(uTime * 0.17 + ph * 2.3) * 0.9;
        // particles stream past the camera as we descend
        p.z += uProgress * 3.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        gl_PointSize = aSize * uDpr * (78.0 / max(dist, 0.6));
        vAlpha = smoothstep(70.0, 6.0, dist) * smoothstep(0.6, 3.0, dist);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.02, d);
        if (a <= 0.001) discard;
        gl_FragColor = vec4(uColor, a * vAlpha * 0.75);
      }
    `,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  scene.add(points);

  // ---------- translucent slabs (the "blurred letterform" stand-ins) ----------
  const slabs = new THREE.Group();
  const slabGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + rand() * 0.4;
    // staggered radii keep neighbouring panes from stacking into a flat wall,
    // and everything stays clear of the camera corridor
    const radius = 9.5 + (i % 3) * 3.2 + rand() * 1.8;
    const w = 1.2 + rand() * 3.4;
    const h = 2.4 + rand() * 5.5;
    // soft light panes rather than solid cards: vertical gradient + edge falloff
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uA: { value: new THREE.Color(0x16324a) },
        uB: { value: new THREE.Color(0x7fb8e0) },
        uOpacity: { value: 0.16 + rand() * 0.16 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uA;
        uniform vec3 uB;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          float g = smoothstep(0.0, 1.0, vUv.y);
          float edge = smoothstep(0.0, 0.07, vUv.x) * smoothstep(1.0, 0.93, vUv.x);
          vec3 col = mix(uA, uB, g * 0.8);
          float a = uOpacity * edge * (0.35 + 0.65 * g);
          if (a <= 0.002) discard;
          gl_FragColor = vec4(col, a);
        }
      `,
    });
    const mesh = new THREE.Mesh(slabGeo, mat);
    mesh.scale.set(w, h * 0.72, 0.06 + rand() * 0.1);
    mesh.position.set(Math.cos(a) * radius, -1.5 + rand() * 6.5, Math.sin(a) * radius);
    mesh.rotation.y = -a + Math.PI / 2;
    mesh.userData = { a, radius, spin: (rand() - 0.5) * 0.12, y0: mesh.position.y, phase: rand() * 6.28 };
    slabs.add(mesh);
  }
  scene.add(slabs);

  // ---------- ground haze plane ----------
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x060e18, roughness: 0.95, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -6;
  scene.add(ground);

  // ---------- lights ----------
  scene.add(new THREE.HemisphereLight(0xbcd9ff, 0x0a1522, 1.15));
  const key = new THREE.DirectionalLight(0xdceeff, 1.5);
  key.position.set(6, 12, 8);
  scene.add(key);
  const rim = new THREE.PointLight(0x7fd4ff, 12, 40, 2);
  rim.position.set(-7, 2, -6);
  scene.add(rim);

  // ---------- camera path (scrubbed by scroll progress) ----------
  const camPos = [
    { t: 0.0, v: [0, 4.6, 17] },
    { t: 0.5, v: [2.8, 2.1, 9.6] },
    { t: 1.0, v: [0.2, 1.2, 4.4] },
  ];
  const camTarget = [
    { t: 0.0, v: [0, 2.4, 0] },
    { t: 0.5, v: [0.3, 1.6, 0] },
    { t: 1.0, v: [0, 1.1, 0] },
  ];
  const camFov = [
    { t: 0.0, v: 40 },
    { t: 1.0, v: 52 },
  ];

  const target = new THREE.Vector3();
  const smooth = { x: 0, y: 0 };
  const offset = new THREE.Vector3();
  let aspectComp = 1;
  let lastProgress = 0;

  function resize(w, h) {
    camera.aspect = w / h;
    aspectComp = Math.max(1, Math.pow(1.35 / (w / h), 0.7));
    camera.updateProjectionMatrix();
  }

  function update({ progress, dt, time, pointer }) {
    lastProgress = progress;
    pMat.uniforms.uTime.value = time;
    pMat.uniforms.uProgress.value = progress;

    // damped pointer parallax — small, so it reads as breathing
    smooth.x = damp(smooth.x, pointer.x, 2.4, dt);
    smooth.y = damp(smooth.y, pointer.y, 2.4, dt);

    const t = scrub(progress, camTarget);
    target.set(t[0] + smooth.x * 0.25, t[1] - smooth.y * 0.15, t[2]);

    const p = scrub(progress, camPos);
    offset.set(p[0] + smooth.x * 0.6, p[1] - smooth.y * 0.4, p[2]).sub(target);
    camera.position.copy(target).addScaledVector(offset, aspectComp);
    camera.lookAt(target);
    const fov = scrub(progress, camFov);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // slabs drift and rotate; they part as we move through
    slabs.children.forEach((m, i) => {
      const d = m.userData;
      const push = fit(progress, 0.25, 1, 0, 1);
      const r = d.radius + push * 3.2;
      m.position.x = Math.cos(d.a) * r;
      m.position.z = Math.sin(d.a) * r;
      m.position.y = d.y0 + Math.sin(time * 0.4 + d.phase) * 0.5;
      m.rotation.y = -d.a + Math.PI / 2 + time * d.spin;
      m.rotation.z = Math.sin(time * 0.25 + d.phase) * 0.05;
    });
  }

  return {
    name: 'entry',
    label: 'Entry',
    height: 5.5,
    scene,
    camera,
    update,
    resize,
    get progress() {
      return lastProgress;
    },
  };
}
