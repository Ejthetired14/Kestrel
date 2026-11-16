// Bootstrap: renderer, scene stack, input, HUD, audio mixing, render loop.
import * as THREE from '../vendor/three.module.js';
import { sceneFactories } from './scenes/index.js';
import { VirtualScroll, attachInput } from './scroll.js';
import { AudioEngine } from './audio.js';
import { fit, clamp } from './lib.js';

const canvas = document.getElementById('gl');
const veil = document.getElementById('veil');
const loader = document.getElementById('loader');
const label = document.getElementById('scene-label');
const hint = document.getElementById('hint');
const barFill = document.getElementById('bar-fill');
const soundBtn = document.getElementById('sound');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ---------- pointer ----------
const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
});

// ---------- scenes ----------
const ctx = { renderer, pointer };
const scenes = sceneFactories.map((factory) => factory(ctx)).filter(Boolean);
const heights = scenes.map((s) => s.height);

const scroller = new VirtualScroll(heights);
attachInput(scroller);

// ---------- audio ----------
const audio = new AudioEngine();
let audioArmed = false;

async function armAudio() {
  if (audioArmed) return;
  audioArmed = true;
  const ok = await audio.start();
  if (ok) setSoundButton();
}

function setSoundButton() {
  const off = !audio.started || audio.muted;
  soundBtn.textContent = off ? 'Sound off' : 'Sound on';
  soundBtn.classList.toggle('off', off);
  soundBtn.setAttribute('aria-pressed', String(!off));
}

soundBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!audio.started) {
    await armAudio();
    audio.setMuted(false);
  } else {
    audio.setMuted(!audio.muted);
  }
  setSoundButton();
});

['wheel', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, () => armAudio(), { once: true, passive: true })
);

// ---------- HUD ----------
const sceneLabels = { entry: 'Entry', igloo: 'Igloo', cubes: 'Portfolio' };
const panels = {
  igloo: document.getElementById('panel-manifesto'),
  cubes: document.getElementById('panel-projects'),
};

let firstScene = true;
function onSceneChange(index) {
  const scene = scenes[index];
  label.textContent = sceneLabels[scene.name] || scene.label || scene.name;
  for (const [name, el] of Object.entries(panels)) {
    if (!el) continue;
    const on = name === scene.name;
    el.classList.toggle('on', on);
    // a panel that is showing always starts at the top of its own scroll
    if (on) el.scrollTop = 0;
  }
  if (firstScene) {
    firstScene = false;
    return;
  }
  // short veil dip hides the cut between scenes
  veil.style.transition = 'opacity .1s linear';
  veil.style.opacity = '1';
  setTimeout(() => {
    veil.style.transition = 'opacity .44s ease';
    veil.style.opacity = '0';
  }, 90);
  if (audio.started) audio.beep(0.4);
}

// ---------- audio mixing (per scene, per progress) ----------
const mixCache = { wind: -1, drone: -1 };
function setMix(name, v) {
  if (Math.abs(mixCache[name] - v) < 0.004) return;
  mixCache[name] = v;
  audio.setVolume(name, v);
}
function updateMix(sceneName, p) {
  if (!audio.started) return;
  if (sceneName === 'igloo') {
    setMix('wind', fit(p, 0.05, 0.2, 0, 1) * fit(p, 0.75, 0.95, 1, 0) * 0.4);
    setMix('drone', 0.16 * fit(p, 0.1, 0.4, 0.35, 1));
  } else if (sceneName === 'entry') {
    setMix('wind', 0.14);
    setMix('drone', 0.05);
  } else {
    setMix('wind', 0.05);
    setMix('drone', 0.09);
  }
}

// ---------- resize ----------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  scenes.forEach((s) => s.resize(w, h));
}
window.addEventListener('resize', resize);
resize();

// ---------- URL flags (handy for checking one scene at a time) ----------
const params = new URLSearchParams(location.search);
if (params.has('scene')) {
  const wanted = params.get('scene');
  const idx = scenes.findIndex((s) => s.name === wanted);
  if (idx >= 0) scroller.jumpTo(idx, params.has('p') ? parseFloat(params.get('p')) : 0.3);
}

// ---------- main loop ----------
const clock = new THREE.Clock();
let active = -1;
let started = false;

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const time = clock.elapsedTime;

  pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-4 * dt));
  pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-4 * dt));

  const { index, progress } = scroller.update(dt);

  if (index !== active) {
    active = index;
    onSceneChange(index);
  }

  const scene = scenes[active];
  scene.update({
    progress,
    dt,
    time,
    speed: scroller.speed,
    audio,
    pointer: { x: pointer.sx, y: pointer.sy },
  });

  updateMix(scene.name, progress);

  renderer.render(scene.scene, scene.camera);

  // HUD readouts
  const totalProgress = clamp((scroller.wrap() / scroller.total) * 100, 0, 100);
  barFill.style.width = totalProgress.toFixed(1) + '%';
  if (time > 1.6) hint.style.opacity = '0.55';

  if (!started) {
    started = true;
    loader.classList.add('gone');
    veil.style.opacity = '0';
    setSoundButton();
  }
}

renderer.setAnimationLoop(frame);

// small probe surface so scenes can be checked from the console
window.__rebuild = {
  scenes,
  scroller,
  renderer,
  audio,
  get active() {
    return active;
  },
};
