import { describe, expect, it } from 'vitest';
import { fmtLen, parseLen, toInputText, sizeGroup } from '../src/lib/units';
import { homography, applyH, invert3, simplify, polygonArea } from '../src/lib/geometry';
import { snap, suggestFill, suggestFromScratch, rankPictures } from '../src/lib/arrange';
import { classifyShape } from '../src/lib/detect';
import { ellipsePoly, rectPoly } from '../src/lib/geometry';

describe('units', () => {
  it('formats quarters', () => {
    expect(fmtLen(14.25, 'in')).toBe('14¼″');
    expect(fmtLen(14.1, 'in')).toBe('14″');
    expect(fmtLen(0.5, 'in')).toBe('½″');
    expect(fmtLen(10, 'cm')).toBe('25.4 cm');
  });
  it('parses many spellings', () => {
    for (const s of ['14 1/4', '14-1/4', '14.25', '14¼', '14 1/4"']) expect(parseLen(s, 'in')).toBeCloseTo(14.25);
    expect(parseLen('1/2', 'in')).toBeCloseTo(0.5);
    expect(parseLen('25.4 cm', 'in')).toBeCloseTo(10);
    expect(parseLen('254mm', 'in')).toBeCloseTo(10);
    expect(parseLen('25.4', 'cm')).toBeCloseTo(10);
    expect(parseLen('abc', 'in')).toBeNaN();
  });
  it('round-trips input text', () => {
    expect(toInputText(14.25, 'in')).toBe('14 1/4');
    expect(parseLen(toInputText(7.75, 'in'), 'in')).toBeCloseTo(7.75);
  });
  it('groups sizes', () => {
    expect(sizeGroup(5, 7)).toBe('S');
    expect(sizeGroup(11, 14)).toBe('M');
    expect(sizeGroup(18, 24)).toBe('L');
    expect(sizeGroup(24, 36)).toBe('XL');
  });
});

describe('geometry', () => {
  it('homography maps corners and inverts', () => {
    const src = [{ x: 10, y: 20 }, { x: 200, y: 5 }, { x: 220, y: 260 }, { x: 0, y: 240 }];
    const dst = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 14 }, { x: 0, y: 14 }];
    const H = homography(src, dst);
    src.forEach((p, i) => {
      const q = applyH(H, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    });
    const back = applyH(invert3(H), 6, 7);
    const again = applyH(H, back.x, back.y);
    expect(again.x).toBeCloseTo(6);
  });
  it('simplifies without losing the shape', () => {
    const e = ellipsePoly(0, 0, 10, 6, 400);
    const s = simplify(e, 0.02);
    expect(s.length).toBeLessThan(120);
    expect(polygonArea(s)).toBeCloseTo(polygonArea(e), 0);
  });
  it('classifies shapes', () => {
    expect(classifyShape(rectPoly(0, 0, 11, 14))).toBe('rectangular');
    expect(classifyShape(ellipsePoly(0, 0, 8, 10))).toBe('circular/oval');
  });
});

describe('arrange', () => {
  it('snaps to the preferred gap and alignment', () => {
    const r = snap({ x: 12.6, y: 0.3, w: 8, h: 10 }, [{ x: 0, y: 0, w: 10, h: 10 }], { gap: 2, tol: 1, xLines: [], yLines: [] });
    expect(r.dx).toBeCloseTo(-0.6);
    expect(r.dy).toBeCloseTo(-0.3);
  });
  const ctx = {
    pool: [
      { frameId: 'a', w: 16, h: 20 }, { frameId: 'b', w: 11, h: 14 }, { frameId: 'c', w: 11, h: 14 },
      { frameId: 'd', w: 8, h: 10 }, { frameId: 'e', w: 8, h: 10 },
    ],
    placed: [],
    bounds: { x0: 0, y0: 0, x1: 120, y1: 96 },
    zones: [],
    gap: 2,
    centerX: 60,
    centerY: 39,
  };
  const noOverlap = (items: { frameId: string; x: number; y: number }[]) => {
    const size = (id: string) => ctx.pool.find((p) => p.frameId === id)!;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j], sa = size(a.frameId), sb = size(b.frameId);
      const sepX = Math.abs(a.x - b.x) >= (sa.w + sb.w) / 2 + 1.99;
      const sepY = Math.abs(a.y - b.y) >= (sa.h + sb.h) / 2 + 1.99;
      expect(sepX || sepY).toBe(true);
    }
  };
  it('builds non-overlapping layouts from scratch', () => {
    const s = suggestFromScratch(ctx);
    expect(s.length).toBeGreaterThanOrEqual(3);
    for (const sug of s) {
      expect(sug.items.length).toBeGreaterThan(0);
      noOverlap(sug.items);
    }
    const sym = s.find((x) => x.name === 'Symmetric')!;
    expect(sym.items.length).toBe(5);
  });
  it('fills around existing frames without collisions', () => {
    const s = suggestFill({ ...ctx, placed: [{ x: 52, y: 29, w: 16, h: 20 }], pool: ctx.pool.slice(1) });
    expect(s.length).toBeGreaterThan(0);
    for (const sug of s) {
      noOverlap(sug.items);
      for (const it of sug.items) {
        const sz = ctx.pool.find((p) => p.frameId === it.frameId)!;
        const sepX = Math.abs(it.x - 60) >= (sz.w + 16) / 2 + 1.99;
        const sepY = Math.abs(it.y - 39) >= (sz.h + 20) / 2 + 1.99;
        expect(sepX || sepY).toBe(true);
      }
    }
  });
  it('ranks pictures by aspect fit', () => {
    const pics = [
      { id: 'wide', aspect: 1.5, tags: { color: 'red' } },
      { id: 'tall', aspect: 0.7, tags: { color: 'blue' } },
    ] as any;
    const r = rankPictures({ id: 'o', x: 0, y: 0, w: 5, h: 7, shape: 'rect' }, pics, new Set(), []);
    expect(r[0].picture.id).toBe('tall');
  });
});

import { homographyLSQ, reprojectionError } from '../src/lib/geometry';
describe('least-squares homography', () => {
  it('recovers a perspective map from noisy extra points', () => {
    const truth = homography(
      [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 96 }, { x: 0, y: 96 }],
      [{ x: 120, y: 300 }, { x: 900, y: 120 }, { x: 950, y: 1800 }, { x: 150, y: 1500 }],
    );
    const src = [];
    for (let i = 0; i < 8; i++) src.push({ x: (i * 37) % 60, y: (i * 53) % 96 });
    const dst = src.map((p, i) => { const q = applyH(truth, p.x, p.y); return { x: q.x + (i % 2 ? 1.5 : -1.5), y: q.y + (i % 3 ? 1 : -1) }; });
    const H = homographyLSQ(src, dst);
    const probe = applyH(H, 30, 48), exact = applyH(truth, 30, 48);
    expect(Math.hypot(probe.x - exact.x, probe.y - exact.y)).toBeLessThan(4);
    expect(reprojectionError(H, src, dst)).toBeLessThan(3);
  });
});
