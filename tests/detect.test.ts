import { describe, expect, it } from 'vitest';
import { detectWallMask } from '../src/lib/recolor';

function wallImage(w: number, h: number) {
  // Warm-to-cool lit wall with a dark "baseboard" strip and an "outlet".
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 10;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const t = x / w;
    let r = 235 - 30 * t + rnd(), g = 225 - 10 * t + rnd(), b = 200 + 20 * t + rnd();
    if (y > h * 0.9) { r = 250; g = 250; b = 250; } // white baseboard
    if (y > h * 0.9 - 2 && y <= h * 0.9) { r = 90; g = 90; b = 90; } // shadow line above it
    if (x > 40 && x < 48 && y > 60 && y < 70) { r = 255; g = 255; b = 255; } // outlet
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe('wall detection', () => {
  it('fills the wall but stops at the baseboard and outlet, quickly', () => {
    const img = wallImage(160, 120);
    const t0 = performance.now();
    const m = detectWallMask(img, {
      seedQuad: [{ x: 20, y: 10 }, { x: 140, y: 10 }, { x: 140, y: 100 }, { x: 20, y: 100 }],
      exclude: [], tolerance: 0.6, taps: [], strokes: [],
    });
    expect(performance.now() - t0).toBeLessThan(2000);
    const at = (x: number, y: number) => m.m[y * m.w + x];
    expect(at(5, 5)).toBeGreaterThan(0.5);      // far corner of the wall
    expect(at(150, 50)).toBeGreaterThan(0.5);   // cool side
    expect(at(80, 115)).toBeLessThan(0.5);      // baseboard
  }, 10000);
});

describe('wall detection at photo size', () => {
  it('finishes on a large textured wall', () => {
    const w = 540, h = 720;
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 40;
    for (let i = 0; i < w * h; i++) { data[i * 4] = 220 + rnd(); data[i * 4 + 1] = 215 + rnd(); data[i * 4 + 2] = 200 + rnd(); data[i * 4 + 3] = 255; }
    const t0 = performance.now();
    const m = detectWallMask({ data, width: w, height: h }, {
      seedQuad: [{ x: 50, y: 50 }, { x: 490, y: 50 }, { x: 490, y: 670 }, { x: 50, y: 670 }],
      exclude: [], tolerance: 0.2, taps: [], strokes: [],
    });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(m.m[360 * m.w + 270]).toBeGreaterThan(0.5);
  }, 60000);
});
