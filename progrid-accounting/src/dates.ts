// Date helpers on plain YYYY-MM-DD strings (no time-zone surprises).

export function parseDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date (want YYYY-MM-DD): ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

export function assertPeriod(p: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new Error(`Invalid period (want YYYY-MM): ${p}`);
}

export function monthStart(period: string): string {
  return `${period}-01`;
}

export function monthEnd(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return iso(d);
}

export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export function daysBetweenInclusive(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000) + 1;
}

export function comparePeriods(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Periods from a to b inclusive. */
export function periodRange(a: string, b: string): string[] {
  const out: string[] = [];
  for (let p = a; p <= b; p = addMonths(p, 1)) out.push(p);
  return out;
}

/** First month (YYYY-MM) of the fiscal year containing `period`. */
export function fiscalYearStart(period: string, startMonth: number): string {
  const [y, m] = period.split('-').map(Number);
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}`;
}

export function fiscalYearEnd(period: string, startMonth: number): string {
  return addMonths(fiscalYearStart(period, startMonth), 11);
}

/** Overlap in days between [a1,a2] and [b1,b2] (inclusive). */
export function overlapDays(a1: string, a2: string, b1: string, b2: string): number {
  const s = a1 > b1 ? a1 : b1;
  const e = a2 < b2 ? a2 : b2;
  return s > e ? 0 : daysBetweenInclusive(s, e);
}

/** Completed years of service (fractional) between two dates. */
export function yearsOfService(join: string, asOf: string): number {
  return Math.max(0, (parseDate(asOf).getTime() - parseDate(join).getTime() + 86_400_000) / (365.25 * 86_400_000));
}
