// Virtual infinite scroll.
// No native page scrolling: wheel/keyboard/touch feed a target, which is damped
// twice (target -> y), and the folded position wraps modulo the sum of scene
// heights so the sequence loops forever. Mirrors the structure documented in
// REVERSE.md, reimplemented from scratch.
import { clamp } from './lib.js';

export class VirtualScroll {
  constructor(heights, { wheelMultiplier = 0.0055, keyStep = 1.15, dragMultiplier = 0.016 } = {}) {
    this.heights = heights.slice();
    this.total = heights.reduce((a, b) => a + b, 0);
    this.tops = [];
    let acc = 0;
    for (const h of heights) {
      this.tops.push(acc);
      acc += h;
    }
    this.wheelMultiplier = wheelMultiplier;
    this.keyStep = keyStep;
    this.dragMultiplier = dragMultiplier;

    this.y = 0;
    this.targetY = 0;
    this.lastY = 0;
    this.speed = 0; // smoothed scroll speed, used by scenes for extra motion
  }

  addWheel(dy) {
    this.targetY += dy * this.wheelMultiplier;
  }

  addDrag(dy) {
    this.targetY += dy * this.dragMultiplier;
  }

  step(dir) {
    this.targetY += dir * this.keyStep;
  }

  wrap() {
    const t = this.total;
    return ((this.y % t) + t) % t;
  }

  locate() {
    const local = this.wrap();
    let index = 0;
    for (let i = 0; i < this.tops.length; i++) {
      if (local >= this.tops[i]) index = i;
    }
    const height = this.heights[index] || 1;
    return {
      index,
      local,
      progress: clamp((local - this.tops[index]) / height, 0, 1),
    };
  }

  update(dt) {
    // two-stage feel: the target itself keeps its own momentum via the damping
    const k = 1 - Math.exp(-8 * dt);
    this.y += (this.targetY - this.y) * k;
    const inst = dt > 0 ? (this.y - this.lastY) / dt : 0;
    this.speed = this.speed + (inst - this.speed) * (1 - Math.exp(-6 * dt));
    this.lastY = this.y;
    return this.locate();
  }

  jumpTo(index, progress = 0.35) {
    this.y = (this.tops[index] || 0) + (this.heights[index] || 1) * progress;
    this.targetY = this.y;
    this.lastY = this.y;
    this.speed = 0;
  }
}

/** Wire wheel / key / touch / drag input into a VirtualScroll. Returns a detach fn. */
export function attachInput(scroller, target = window) {
  const onWheel = (e) => {
    // nested scrollers (project panel) keep their own wheel handling
    if (e.target && e.target.closest && e.target.closest('[data-scroll]')) return;
    e.preventDefault();
    scroller.addWheel(e.deltaY);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      scroller.step(1);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      scroller.step(-1);
    }
  };

  let dragging = false;
  let lastY = 0;
  const onDown = (e) => {
    dragging = true;
    lastY = e.touches ? e.touches[0].clientY : e.clientY;
  };
  const onMove = (e) => {
    if (!dragging) return;
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    scroller.addDrag(lastY - y);
    lastY = y;
  };
  const onUp = () => {
    dragging = false;
  };

  target.addEventListener('wheel', onWheel, { passive: false });
  target.addEventListener('keydown', onKey);
  target.addEventListener('touchstart', onDown, { passive: true });
  target.addEventListener('touchmove', onMove, { passive: true });
  target.addEventListener('touchend', onUp);
  target.addEventListener('mousedown', onDown);
  target.addEventListener('mousemove', onMove);
  target.addEventListener('mouseup', onUp);

  return () => {
    target.removeEventListener('wheel', onWheel);
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('touchstart', onDown);
    target.removeEventListener('touchmove', onMove);
    target.removeEventListener('touchend', onUp);
    target.removeEventListener('mousedown', onDown);
    target.removeEventListener('mousemove', onMove);
    target.removeEventListener('mouseup', onUp);
  };
}
