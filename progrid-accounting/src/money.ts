// All amounts are stored as integer halalas (1 SAR = 100 halalas) so that
// sums never drift. Conversion to/from SAR happens only at the edges
// (reading source documents, writing reports).

export type Halalas = number;

/** Round half away from zero — the convention ZATCA uses for 2-dp amounts. */
export function roundHalf(x: number): number {
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 ? -r : r;
}

/** Parse a SAR amount (number or string like "1,250.50") into halalas. */
export function toHalalas(sar: number | string): Halalas {
  const n = typeof sar === 'string' ? Number(sar.replace(/,/g, '')) : sar;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${sar}`);
  return roundHalf(n * 100);
}

export function toSar(h: Halalas): number {
  return h / 100;
}

/** "12,345.67" — plain, for reports. Negative shown as (12,345.67). */
export function fmt(h: Halalas, opts: { parens?: boolean } = {}): string {
  const abs = Math.abs(h);
  const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (h < 0) return opts.parens === false ? `-${s}` : `(${s})`;
  return s;
}

/** "12345.67" — machine format for XML/CSV. */
export function dec(h: Halalas): string {
  const neg = h < 0;
  const abs = Math.abs(h);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** amount × rate, rounded to the halala. `rate` is a fraction (0.15). */
export function pct(h: Halalas, rate: number): Halalas {
  return roundHalf(h * rate);
}

export function sum(xs: Halalas[]): Halalas {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * Split `total` across weights so the parts add back exactly to `total`
 * (largest-remainder method). Used for pro-rata schedules.
 */
export function allocate(total: Halalas, weights: number[]): Halalas[] {
  const w = sum(weights);
  if (w === 0) return weights.map(() => 0);
  const raw = weights.map((x) => (total * x) / w);
  const floored = raw.map((x) => (total >= 0 ? Math.floor(x) : Math.ceil(x)));
  let rem = total - sum(floored);
  const order = raw
    .map((x, i) => ({ i, frac: Math.abs(x - floored[i]) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const step = rem >= 0 ? 1 : -1;
  for (let k = 0; rem !== 0; k = (k + 1) % order.length) {
    floored[order[k].i] += step;
    rem -= step;
  }
  return floored;
}
