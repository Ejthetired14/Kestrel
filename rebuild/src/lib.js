// Small maths / helper library shared by the scenes.
// Everything here is written for this rebuild; nothing is taken from the original bundle.
import * as THREE from '../vendor/three.module.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent damping: the "damped follow" every camera move uses. */
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/** Remap v from [a,b] into [c,d], clamped. */
export const fit = (v, a, b, c, d) => c + (d - c) * clamp((v - a) / (b - a || 1), 0, 1);

export const ease = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  in: (t) => t * t * t,
  power3InOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

/**
 * Scrub a keyframe list. keys = [{t, v}] where v is a number or an array.
 * This replaces GSAP's timeline.progress() for our purposes.
 */
export function scrub(t, keys, easing = ease.inOut) {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b.t) {
      const a = keys[i - 1];
      const k = easing((t - a.t) / (b.t - a.t || 1));
      if (Array.isArray(a.v)) return a.v.map((x, j) => lerp(x, b.v[j], k));
      return lerp(a.v, b.v, k);
    }
  }
  return keys[keys.length - 1].v;
}

/** Deterministic pseudo-random generator so scenes look identical on every load. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Gradient sky dome. Rendered behind everything, ignores fog and depth. */
export function makeSky(topColor = 0x14293f, horizonColor = 0xa9cbe8, radius = 150) {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(topColor) },
      uHorizon: { value: new THREE.Color(horizonColor) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        float k = smoothstep(0.35, 0.95, h);
        vec3 col = mix(uHorizon, uTop, k * 0.92);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/** Equirect gradient turned into a usable environment map (for glass / specular). */
export function makeEnvironment(renderer, { top = [0.72, 0.86, 1.0], bottom = [0.03, 0.06, 0.1] } = {}) {
  const w = 64;
  const h = 32;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1); // 0 = top row
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = lerp(top[c], bottom[c], Math.pow(t, 0.8));
        data[i + c] = Math.round(clamp(v, 0, 1) * 255);
      }
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return target.texture;
}
