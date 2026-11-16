// Scene 3 — PORTFOLIO (cubes)
// Two glass cubes with glowing cores floating over a grid, orbiting camera.
// The project text lives in a nested scroller in the DOM, which captures its own
// wheel events — the same separation the original keeps between scene scroll and
// panel scroll. Height 2 scroll units.
import * as THREE from '../../vendor/three.module.js';
import { makeSky, makeEnvironment, scrub, damp, fit, rng } from '../lib.js';

export function createCubesScene({ renderer }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070e17);
  scene.fog = new THREE.FogExp2(0x070e17, 0.032);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
  scene.add(makeSky(0x030609, 0x14324a, 180));
  scene.environment = makeEnvironment(renderer);

  scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x081420, 0.55));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 9, 7);
  scene.add(key);

  const rim = new THREE.PointLight(0x7fd4ff, 16, 22, 2);
  rim.position.set(-5, 1.5, -4);
  scene.add(rim);

  const rand = rng(5150);
  const group = new THREE.Group();
  scene.add(group);

  const cubes = [];
  const layout = [
    { x: -2.15, y: 0.2, z: 0.2, dir: 1 },
    { x: 2.15, y: -0.15, z: -0.7, dir: -1 },
  ];

  layout.forEach((cfg, i) => {
    const root = new THREE.Group();
    root.position.set(cfg.x, cfg.y, cfg.z);

    const size = 1.55;
    const geo = new THREE.BoxGeometry(size, size, size);

    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xd9ecff,
      metalness: 0.06,
      roughness: 0.1,
      transparent: true,
      opacity: 0.52,
      envMapIntensity: 2.6,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      side: THREE.DoubleSide,
    });
    root.add(new THREE.Mesh(geo, glass));

    // bright edges so the cube reads clearly against the fog
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xaee8ff, transparent: true, opacity: 0.95 })
    );
    root.add(edges);

    // inner core: the "project" itself
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.46, 0),
      new THREE.MeshStandardMaterial({
        color: 0x122a3d,
        emissive: i === 0 ? 0x7fd4ff : 0xffb27a,
        emissiveIntensity: 2.4,
        roughness: 0.45,
        metalness: 0.1,
        flatShading: true,
      })
    );
    root.add(core);

    // faint inner shell
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 1),
      new THREE.MeshBasicMaterial({ color: 0x7fd4ff, wireframe: true, transparent: true, opacity: 0.28 })
    );
    root.add(shell);

    // a light inside the glass so the cube reads against the fog
    const inner = new THREE.PointLight(i === 0 ? 0x7fd4ff : 0xffb27a, 5.5, 7, 2);
    root.add(inner);

    group.add(root);
    cubes.push({ root, core, shell, seed: rand(), dir: cfg.dir, baseY: cfg.y, index: i });
  });

  // floor grid
  const grid = new THREE.GridHelper(44, 44, 0x2a5674, 0x122636);
  grid.position.y = -2.4;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);

  // ---------- camera ----------
  const camPos = [
    { t: 0.0, v: [0, 1.9, 11.5] },
    { t: 0.5, v: [3.4, 1.4, 9.2] },
    { t: 1.0, v: [-1.6, 1.0, 8.4] },
  ];
  const camTarget = [
    { t: 0.0, v: [0, 0.15, 0] },
    { t: 1.0, v: [0, 0.05, 0] },
  ];

  const target = new THREE.Vector3();
  const smooth = { x: 0, y: 0 };
  const offset = new THREE.Vector3();
  let aspectComp = 1;
  let lastProgress = 0;

  function resize(w, h) {
    camera.aspect = w / h;
    aspectComp = Math.max(1, Math.pow(1.35 / (w / h), 0.85));
    camera.updateProjectionMatrix();
  }

  function update({ progress, dt, time, pointer }) {
    lastProgress = progress;

    smooth.x = damp(smooth.x, pointer.x, 2.2, dt);
    smooth.y = damp(smooth.y, pointer.y, 2.2, dt);

    const t = scrub(progress, camTarget);
    target.set(t[0] + smooth.x * 0.15, t[1] - smooth.y * 0.1, t[2]);

    const p = scrub(progress, camPos);
    // gentle orbital drift on top of the scrubbed path
    const orbit = Math.sin(time * 0.16) * 1.5;
    offset
      .set(p[0] + orbit + smooth.x * 0.7, p[1] - smooth.y * 0.45, p[2])
      .sub(target);
    camera.position.copy(target).addScaledVector(offset, aspectComp);
    camera.lookAt(target);

    // cubes drift, rotate and separate as the section advances
    const spread = fit(progress, 0, 0.6, 1, 1.22);
    group.position.x = 0;
    cubes.forEach((c, i) => {
      c.root.position.x = layout[i].x * spread;
      c.root.position.y = c.baseY + Math.sin(time * 0.7 + c.seed * 6.28) * 0.07;
      c.root.rotation.y = time * 0.22 * c.dir + progress * 0.9;
      c.root.rotation.x = Math.sin(time * 0.3 + c.seed * 3.1) * 0.06;
      c.core.rotation.y = -time * 0.5;
      c.core.rotation.z = time * 0.2;
      c.core.material.emissiveIntensity = 1.5 + Math.sin(time * 1.8 + c.seed * 5) * 0.45;
      c.shell.rotation.y = time * 0.14;
      c.shell.rotation.x = -time * 0.09;
    });
  }

  return {
    name: 'cubes',
    label: 'Portfolio',
    height: 2,
    scene,
    camera,
    update,
    resize,
    get progress() {
      return lastProgress;
    },
  };
}
