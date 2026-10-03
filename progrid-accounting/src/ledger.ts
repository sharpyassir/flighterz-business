import type { Books } from './books.ts';
import { assertPostable } from './books.ts';
import type { JournalEntry, JournalLine } from './types.ts';
import { type Halalas, fmt } from './money.ts';

/** In-memory general ledger. Every entry is validated on the way in. */
export class Ledger {
  readonly entries: JournalEntry[] = [];
  private readonly books: Books;
  private seq = 0;

  constructor(books: Books) {
    this.books = books;
  }

  post(e: Omit<JournalEntry, 'id'> & { id?: string }): JournalEntry {
    const lines = e.lines.filter((l) => l.debit !== 0 || l.credit !== 0 || l.tax);
    let dr = 0;
    let cr = 0;
    for (const l of lines) {
      assertPostable(this.books, l.account, `entry ${e.source}`);
      if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit)) throw new Error(`entry ${e.source}: non-integer halalas`);
      if (l.debit < 0 || l.credit < 0) throw new Error(`entry ${e.source}: negative debit/credit on ${l.account}`);
      dr += l.debit;
      cr += l.credit;
    }
    if (dr !== cr) throw new Error(`entry ${e.source} (${e.memo}) does not balance: Dr ${fmt(dr)} ≠ Cr ${fmt(cr)}`);
    if (e.period !== e.date.slice(0, 7)) throw new Error(`entry ${e.source}: date ${e.date} not in period ${e.period}`);
    this.seq += 1;
    const entry: JournalEntry = { ...e, id: e.id ?? `JE-${e.period.replace('-', '')}-${String(this.seq).padStart(5, '0')}`, lines };
    this.entries.push(entry);
    return entry;
  }

  /** Net (debit − credit) per account for entries with from ≤ date ≤ to. */
  balances(to: string, from = '0000-00-00'): Map<string, Halalas> {
    const m = new Map<string, Halalas>();
    for (const e of this.entries) {
      if (e.date < from || e.date > to) continue;
      for (const l of e.lines) m.set(l.account, (m.get(l.account) ?? 0) + l.debit - l.credit);
    }
    return m;
  }

  balance(account: string, to: string, from = '0000-00-00'): Halalas {
    let b = 0;
    for (const e of this.entries) {
      if (e.date < from || e.date > to) continue;
      for (const l of e.lines) if (l.account === account) b += l.debit - l.credit;
    }
    return b;
  }

  entriesInPeriod(period: string): JournalEntry[] {
    return this.entries.filter((e) => e.period === period);
  }

  linesFor(account: string, to: string, from = '0000-00-00'): { entry: JournalEntry; line: JournalLine }[] {
    const out: { entry: JournalEntry; line: JournalLine }[] = [];
    for (const e of this.entries) {
      if (e.date < from || e.date > to) continue;
      for (const l of e.lines) if (l.account === account) out.push({ entry: e, line: l });
    }
    return out;
  }
}

export function dr(account: string, amount: Halalas, extra: Partial<JournalLine> = {}): JournalLine {
  return amount >= 0 ? { account, debit: amount, credit: 0, ...extra } : { account, debit: 0, credit: -amount, ...extra };
}

export function cr(account: string, amount: Halalas, extra: Partial<JournalLine> = {}): JournalLine {
  return amount >= 0 ? { account, debit: 0, credit: amount, ...extra } : { account, debit: -amount, credit: 0, ...extra };
}
