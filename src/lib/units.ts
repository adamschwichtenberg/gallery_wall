import type { Units } from './types';

const CM_PER_IN = 2.54;
const QUARTER_GLYPH: Record<number, string> = { 1: '¼', 2: '½', 3: '¾' };

/** Round to the nearest 1/4 inch. */
export function roundQuarter(inches: number): number {
  return Math.round(inches * 4) / 4;
}

/** Format inches like 14¼″ (or 36.2 cm). */
export function fmtLen(inches: number, units: Units, withUnit = true): string {
  if (!isFinite(inches)) return '–';
  if (units === 'cm') {
    const cm = Math.round(inches * CM_PER_IN * 10) / 10;
    return `${cm}${withUnit ? ' cm' : ''}`;
  }
  const neg = inches < 0;
  const q = Math.round(Math.abs(inches) * 4);
  const whole = Math.floor(q / 4);
  const frac = q % 4;
  let s = frac ? (whole ? `${whole}${QUARTER_GLYPH[frac]}` : QUARTER_GLYPH[frac]) : `${whole}`;
  if (neg && q) s = '−' + s;
  return s + (withUnit ? '″' : '');
}

/** Format a width × height pair, e.g. 11 × 14″. */
export function fmtSize(w: number, h: number, units: Units): string {
  return `${fmtLen(w, units, false)} × ${fmtLen(h, units, false)}${units === 'cm' ? ' cm' : '″'}`;
}

/** Plain editable text for an input field. */
export function toInputText(inches: number, units: Units): string {
  if (units === 'cm') return String(Math.round(inches * CM_PER_IN * 10) / 10);
  const q = Math.round(inches * 4);
  const whole = Math.trunc(q / 4);
  const frac = Math.abs(q % 4);
  const fracText = ['', '1/4', '1/2', '3/4'][frac];
  if (!frac) return String(whole);
  return whole ? `${whole} ${fracText}` : (q < 0 ? '-' : '') + fracText;
}

/**
 * Parse user input into inches. Accepts "14", "14.25", "14 1/4", "14-1/4", "14¼", "1/2",
 * "36 cm", "360mm", `14"`. Returns NaN when unreadable.
 */
export function parseLen(text: string, units: Units): number {
  let s = text.trim().toLowerCase().replace(/[″"]|in(ches)?$/g, '').trim();
  let unit: Units | 'mm' = units;
  const m = s.match(/(cm|mm)$/);
  if (m) {
    unit = m[1] as 'cm' | 'mm';
    s = s.slice(0, -2).trim();
  }
  s = s.replace(/¼/g, ' 1/4').replace(/½/g, ' 1/2').replace(/¾/g, ' 3/4').replace(/,/g, '.');
  let value = NaN;
  const mixed = s.match(/^(-?\d+(?:\.\d+)?)?\s*[-\s]?\s*(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = mixed[1] ? parseFloat(mixed[1]) : 0;
    const frac = parseInt(mixed[2]) / parseInt(mixed[3]);
    value = whole < 0 || s.startsWith('-') ? whole - frac : whole + frac;
  } else if (/^-?\d*\.?\d+$/.test(s)) {
    value = parseFloat(s);
  }
  if (unit === 'cm') return value / CM_PER_IN;
  if (unit === 'mm') return value / 25.4;
  return value;
}

export function sizeGroup(w: number, h: number): 'S' | 'M' | 'L' | 'XL' {
  const longSide = Math.max(w, h);
  if (longSide <= 10) return 'S';
  if (longSide <= 16) return 'M';
  if (longSide <= 24) return 'L';
  return 'XL';
}

export const SIZE_LABEL: Record<string, string> = {
  S: 'Small',
  M: 'Medium',
  L: 'Large',
  XL: 'XL',
};
