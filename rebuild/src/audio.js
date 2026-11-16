// Synthesized audio engine (Web Audio API only — no audio files).
// Beds are looped noise/oscillator graphs; volumes are ramped with
// setTargetAtTime(v, now, 0.01) so fades are click-free, and every cue is
// unlocked by the first user gesture, as the original does.
import { clamp } from './lib.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.muted = false;
    this.beds = new Map();
    this.lastBeep = -1;
  }

  get available() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }

  async start() {
    if (this.started || !this.available) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* resume needs a gesture; caller retries on next interaction */
      }
    }

    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);

    this.noise = this._noiseBuffer(3);

    this._buildBeds();
    this.started = true;

    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.85, this.ctx.currentTime, 0.5);
    return true;
  }

  _noiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = 0.97 * last + 0.03 * white; // brown-ish noise, softer than white
      d[i] = last * 3.2;
    }
    return buf;
  }

  _loopNoise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  _bed(name, chain, initial = 0) {
    const gain = this.ctx.createGain();
    gain.gain.value = initial;
    chain(gain);
    gain.connect(this.master);
    this.beds.set(name, gain);
    return gain;
  }

  _buildBeds() {
    // wind: brown noise through a moving band-pass
    this._bed('wind', (gain) => {
      const src = this._loopNoise();
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 520;
      bp.Q.value = 0.6;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 260;
      lfo.connect(lfoGain).connect(bp.frequency);
      lfo.start();
      src.connect(bp).connect(gain);
    });

    // low drone under the igloo
    this._bed('drone', (gain) => {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 340;
      lp.Q.value = 0.9;
      [55, 82.5, 110.3].forEach((f, i) => {
        const o = this.ctx.createOscillator();
        o.type = i === 2 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        o.detune.value = (i - 1) * 7;
        const g = this.ctx.createGain();
        g.gain.value = i === 2 ? 0.14 : 0.22;
        o.connect(g).connect(lp);
        o.start();
      });
      lp.connect(gain);
    });

    // slow pad, always present (the original's music bed)
    this._bed('pad', (gain) => {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      [220, 277.2, 329.6, 440].forEach((f, i) => {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.value = 0.1 - i * 0.018;
        const trem = this.ctx.createOscillator();
        trem.frequency.value = 0.05 + i * 0.017;
        const tremGain = this.ctx.createGain();
        tremGain.gain.value = 0.05;
        trem.connect(tremGain).connect(g.gain);
        trem.start();
        o.connect(g).connect(lp);
        o.start();
      });
      lp.connect(gain);
    }, 0.12);
  }

  setVolume(name, v) {
    if (!this.started) return;
    const gain = this.beds.get(name);
    if (!gain) return;
    gain.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.01);
  }

  setAllBeds(volumes) {
    for (const [name, v] of Object.entries(volumes)) this.setVolume(name, v);
  }

  beep(throttle = 0.4) {
    if (!this.started || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBeep < throttle) return;
    this.lastBeep = now;

    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 620 + Math.random() * 420;
    g.gain.value = 0;
    o.connect(g).connect(this.master);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.16, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    o.start(now);
    o.stop(now + 0.18);
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.started) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.08);
  }

  dispose() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    setTimeout(() => this.ctx && this.ctx.close(), 300);
    this.started = false;
  }
}
