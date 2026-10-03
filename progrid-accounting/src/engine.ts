// Runs the books month by month: posts every document, then the automatic
// month-end entries. The whole history is re-derived from source documents on
// every run, so the ledger is always reproducible from the evidence.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Books } from './books.ts';
import { accountByRole, loadDocuments, readJson, validateDocuments } from './books.ts';
import { cr, dr } from './ledger.ts';
import type { JournalLine, SourceDoc } from './types.ts';
import { type Halalas, allocate, roundHalf, toHalalas } from './money.ts';
import { addMonths, fiscalYearStart, monthEnd, monthStart, periodOf, periodRange, yearsOfService } from './dates.ts';
import { type EngineState, type FixedAsset, employeeAsOf, newState, postDocument } from './posting.ts';
import { eosbEntitlement } from './tax.ts';
import { computeZakat } from './zakat.ts';

export interface VatPeriod {
  label: string; // "2026-01" or "2026-Q1"
  start: string; // YYYY-MM
  end: string; // YYYY-MM
}

export function vatPeriodFor(books: Books, period: string): VatPeriod {
  if (books.company.vatFilingFrequency === 'monthly') return { label: period, start: period, end: period };
  const [y, m] = period.split('-').map(Number);
  const q = Math.ceil(m / 3);
  const start = `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}`;
  return { label: `${y}-Q${q}`, start, end: addMonths(start, 2) };
}

const TYPE_ORDER: Record<string, number> = {
  sales_invoice: 1,
  debit_note: 2,
  credit_note: 3,
  purchase_bill: 4,
  payroll: 5,
  receipt: 6,
  payment: 7,
  transfer: 8,
  tax_payment: 9,
  journal: 10,
};

export interface RunOptions {
  /** Called after each period is fully posted (including month-end entries). */
  onPeriodEnd?: (period: string, state: EngineState) => void;
}

export function runBooks(books: Books, upto: string, opts: RunOptions = {}): EngineState {
  const s = newState(books);
  const start = periodOf(books.company.booksStartDate);
  if (upto < start) throw new Error(`Period ${upto} is before the books start (${books.company.booksStartDate})`);
  postOpening(s);

  const seen = new Set<string>();
  for (const p of periodRange(start, upto)) {
    const docs = loadDocuments(books, p);
    const errs = validateDocuments(books, p, docs, seen);
    if (errs.length) throw new Error(`Documents for ${p} have errors:\n  - ${errs.join('\n  - ')}`);
    const ordered = docs
      .map((d, i) => ({ d, i }))
      .sort((a, b) => a.d.date.localeCompare(b.d.date) || (TYPE_ORDER[a.d.type] ?? 99) - (TYPE_ORDER[b.d.type] ?? 99) || a.i - b.i)
      .map((x) => x.d);
    for (const d of ordered) {
      try {
        postDocument(s, d as SourceDoc);
      } catch (e) {
        throw new Error(`${p} ${d.type} ${d.id}: ${(e as Error).message}`);
      }
    }
    monthEndEntries(s, p);
    opts.onPeriodEnd?.(p, s);
  }
  return s;
}

function postOpening(s: EngineState): void {
  const b = s.books;
  const ob = b.opening;
  if (ob && ob.lines.length) {
    s.ledger.post({
      date: ob.date,
      period: periodOf(ob.date),
      source: 'opening-balances',
      sourceType: 'opening',
      memo: 'Opening balances',
      lines: ob.lines.map((l) => ({ account: l.account, debit: toHalalas(l.debit ?? 0), credit: toHalalas(l.credit ?? 0), party: l.party, memo: l.memo })),
    });
    for (const it of ob.openItems ?? []) {
      const amt = toHalalas(it.amount);
      s.openItems.push({ kind: it.kind, party: it.party, ref: it.ref, date: it.date, dueDate: it.dueDate ?? it.date, amount: amt, open: amt });
    }
  }
  const faPath = join(b.dir, 'fixed-assets.json');
  if (existsSync(faPath)) {
    const start = periodOf(b.company.booksStartDate);
    for (const a of readJson<
      { id: string; description: string; assetClass: string; cost: number; acquisitionDate: string; usefulLifeMonths?: number; accumulatedDepreciation?: number; remainingLifeMonths?: number }[]
    >(faPath)) {
      const life = a.usefulLifeMonths ?? b.rules.fixedAssets.usefulLifeMonths[a.assetClass];
      s.assets.push({
        id: a.id,
        description: a.description,
        assetClass: a.assetClass,
        cost: toHalalas(a.cost),
        acquisitionDate: a.acquisitionDate,
        usefulLifeMonths: a.remainingLifeMonths ?? life,
        accumulatedAtStart: toHalalas(a.accumulatedDepreciation ?? 0),
        startPeriod: start,
        source: 'fixed-assets.json',
      });
    }
  }
}

/** Depreciation charge for an asset in a period (straight-line, exact to the halala over its life). */
export function depreciationFor(a: FixedAsset, period: string): Halalas {
  const months = periodRange(a.startPeriod, period).length - 1;
  if (period < a.startPeriod || months >= a.usefulLifeMonths) return 0;
  const parts = allocate(a.cost - a.accumulatedAtStart, Array(a.usefulLifeMonths).fill(1));
  return parts[months];
}

function monthEndEntries(s: EngineState, p: string): void {
  const b = s.books;
  const end = monthEnd(p);
  const post = (source: string, memo: string, lines: JournalLine[]) => {
    if (lines.some((l) => l.debit || l.credit)) s.ledger.post({ date: end, period: p, source: `auto:${source}`, sourceType: 'auto', memo, lines });
  };

  // 1. Deferred revenue release & prepaid amortisation.
  for (const sc of s.schedules) {
    const amt = sc.amounts.get(p);
    if (!amt) continue;
    if (sc.kind === 'deferred_revenue')
      post(`revrec:${sc.source}`, `Revenue recognised — ${sc.description} (${sc.source})`, [
        dr(accountByRole(b, 'deferred_revenue'), amt, { party: sc.party }),
        cr(sc.account, amt, { party: sc.party }),
      ]);
    else
      post(`prepaid:${sc.source}`, `Prepaid expense released — ${sc.description} (${sc.source})`, [
        dr(sc.account, amt, { party: sc.party }),
        cr(accountByRole(b, 'prepaid'), amt, { party: sc.party }),
      ]);
  }

  // 2. Depreciation & amortisation, one line per asset class.
  const byClass = new Map<string, Halalas>();
  for (const a of s.assets) byClass.set(a.assetClass, (byClass.get(a.assetClass) ?? 0) + depreciationFor(a, p));
  const depLines: JournalLine[] = [];
  for (const [cls, amt] of byClass) {
    if (!amt) continue;
    depLines.push(dr(accountByRole(b, cls === 'software' ? 'amortisation_expense' : 'depreciation_expense'), amt, { memo: cls }));
    depLines.push(cr(accountByRole(b, `accdep:${cls}`), amt, { memo: cls }));
  }
  post('depreciation', `Depreciation & amortisation ${p}`, depLines);

  // 3. End-of-service benefits — true up the provision to the Art. 84 entitlement.
  if (b.employees.size) {
    let target = 0;
    for (const raw of b.employees.values()) {
      const e = employeeAsOf(raw, end);
      if (e.joinDate > end || (e.leaveDate && e.leaveDate <= end)) continue;
      target += eosbEntitlement(b, e, yearsOfService(e.joinDate, end));
    }
    const prov = accountByRole(b, 'eosb_provision');
    const delta = target + s.ledger.balance(prov, end); // balance is credit-negative
    post('eosb', `End-of-service benefits accrual ${p}`, [dr(accountByRole(b, 'eosb_expense'), delta), cr(prov, delta)]);
  }

  // 4. VAT: at the end of each VAT period move input/output balances to the ZATCA settlement account.
  const vp = vatPeriodFor(b, p);
  if (vp.end === p) {
    const settle = accountByRole(b, 'vat_settlement');
    const lines: JournalLine[] = [];
    let net = 0;
    for (const r of ['vat_output', 'vat_output_rc', 'vat_input', 'vat_input_rc', 'vat_input_import']) {
      const acc = accountByRole(b, r);
      const bal = s.ledger.balance(acc, end);
      if (!bal) continue;
      lines.push(cr(acc, bal));
      net += bal;
    }
    lines.push(dr(settle, net));
    post(`vat-settlement:${vp.label}`, `VAT return ${vp.label} — transfer to ZATCA settlement`, lines);
  }

  // 5. Zakat / income tax accrual — YTD share of the estimated annual charge, trued up at year end.
  if (b.rules.zakat.monthlyAccrual) {
    const fyStartP = fiscalYearStart(p, b.company.fiscalYearStartMonth);
    const fyStart = monthStart(fyStartP);
    const elapsed = periodRange(fyStartP, p).length;
    const z = computeZakat(b, s.ledger, fyStart, end);
    const zAcc = accountByRole(b, 'zakat_expense');
    const tAcc = accountByRole(b, 'income_tax_expense');
    const dz = roundHalf((z.zakat * elapsed) / 12) - s.ledger.balance(zAcc, end, fyStart);
    const dt = roundHalf((z.incomeTax * elapsed) / 12) - s.ledger.balance(tAcc, end, fyStart);
    post('zakat', `Zakat${b.company.saudiGccOwnershipPercent < 100 ? ' & income tax' : ''} accrual ${p} (${elapsed}/12 of estimate)`, [
      dr(zAcc, dz),
      dr(tAcc, dt),
      cr(accountByRole(b, 'zakat_payable'), dz + dt),
    ]);
  }
}

/** Sum of tagged tax amounts in a range — used by the VAT and WHT returns. */
export function taxTags(s: EngineState, fromPeriod: string, toPeriod: string) {
  const out = [];
  for (const e of s.ledger.entries) {
    if (e.period < fromPeriod || e.period > toPeriod) continue;
    for (const l of e.lines) if (l.tax) out.push({ entry: e, line: l, tag: l.tax });
  }
  return out;
}

