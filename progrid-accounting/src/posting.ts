// Turns each source document into balanced, tax-tagged journal entries.
import type { Books } from './books.ts';
import { accountByRole } from './books.ts';
import { Ledger, cr, dr } from './ledger.ts';
import type {
  CreditNoteDoc,
  Employee,
  JournalLine,
  PaymentDoc,
  PayrollDoc,
  PurchaseBillDoc,
  ReceiptDoc,
  SalesInvoiceDoc,
  ServicePeriod,
  SourceDoc,
  WhtCategory,
} from './types.ts';
import { type Halalas, allocate, pct, sum, toHalalas, fmt } from './money.ts';
import { addDays, daysBetweenInclusive, monthEnd, monthStart, overlapDays, periodOf, periodRange } from './dates.ts';
import { type ComputedInvoice, type PayslipCalc, computeInvoice, computePayslip, salesBox, whtGrossedUp, whtWithheld } from './tax.ts';

// ───────────────────────── Engine state ─────────────────────────

export interface Schedule {
  kind: 'deferred_revenue' | 'prepaid';
  source: string;
  description: string;
  /** P&L account the amounts are released to. */
  account: string;
  party?: string;
  total: Halalas;
  amounts: Map<string, Halalas>; // period → amount still to release in that period
}

export interface FixedAsset {
  id: string;
  description: string;
  assetClass: string;
  cost: Halalas;
  acquisitionDate: string;
  usefulLifeMonths: number;
  /** Accumulated depreciation already booked before these books started. */
  accumulatedAtStart: Halalas;
  /** First period depreciation is charged in these books. */
  startPeriod: string;
  source: string;
}

export interface OpenItem {
  kind: 'ar' | 'ap';
  party: string;
  ref: string;
  date: string;
  dueDate: string;
  amount: Halalas; // original amount (negative for credit notes)
  open: Halalas;
}

export interface IssuedInvoice {
  doc: SalesInvoiceDoc | CreditNoteDoc;
  calc: ComputedInvoice;
}

export interface EngineState {
  books: Books;
  ledger: Ledger;
  schedules: Schedule[];
  assets: FixedAsset[];
  openItems: OpenItem[];
  payroll: Map<string, PayslipCalc[]>;
  invoices: Map<string, IssuedInvoice>;
  warnings: string[];
}

export function newState(books: Books): EngineState {
  return {
    books,
    ledger: new Ledger(books),
    schedules: [],
    assets: [],
    openItems: [],
    payroll: new Map(),
    invoices: new Map(),
    warnings: [],
  };
}

// ───────────────────────── Helpers ─────────────────────────

/**
 * Split `total` over the months of a service period by days. Everything that
 * falls in or before `postingPeriod` is returned as `now`; the rest per month.
 */
export function spread(total: Halalas, sp: ServicePeriod, postingPeriod: string): { now: Halalas; future: Map<string, Halalas> } {
  if (sp.end < sp.start) throw new Error(`Service period ends before it starts: ${sp.start}..${sp.end}`);
  const periods = periodRange(periodOf(sp.start), periodOf(sp.end));
  const weights = periods.map((p) => overlapDays(sp.start, sp.end, monthStart(p), monthEnd(p)));
  const parts = allocate(total, weights);
  let now = 0;
  const future = new Map<string, Halalas>();
  periods.forEach((p, i) => {
    if (p <= postingPeriod) now += parts[i];
    else if (parts[i] !== 0) future.set(p, parts[i]);
  });
  return { now, future };
}

function role(s: EngineState, r: string): string {
  return accountByRole(s.books, r);
}

function bankOf(s: EngineState, acc?: string): string {
  return acc ?? s.books.company.defaultBankAccount;
}

function dueDate(date: string, explicit: string | undefined, terms: number | undefined): string {
  return explicit ?? addDays(date, terms ?? 30);
}

/** Apply a settlement against open items: listed refs first, then oldest first. */
function settle(s: EngineState, kind: 'ar' | 'ap', party: string, amount: Halalas, refs: string[] = []): Halalas {
  let left = amount;
  const items = s.openItems.filter((i) => i.kind === kind && i.party === party && i.open > 0);
  const ordered = [
    ...refs.map((r) => items.find((i) => i.ref === r)).filter((i): i is OpenItem => !!i),
    ...items.filter((i) => !refs.includes(i.ref)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date)),
  ];
  for (const it of ordered) {
    if (left <= 0) break;
    const take = Math.min(it.open, left);
    it.open -= take;
    left -= take;
  }
  return left; // unapplied (on-account) amount
}

function addOpenItem(s: EngineState, item: Omit<OpenItem, 'open'>): void {
  if (item.amount >= 0) {
    s.openItems.push({ ...item, open: item.amount });
    return;
  }
  // Negative item (credit note / debit balance) — apply against the party's open items.
  const left = settle(s, item.kind, item.party, -item.amount, []);
  if (left > 0) s.openItems.push({ ...item, amount: -left, open: -left });
}

/** Resolve an employee's pay as of a date (effective-dated salary changes). */
export function employeeAsOf(e: Employee, date: string): Employee {
  let cur: Employee = { ...e };
  delete cur.changes;
  for (const c of [...(e.changes ?? [])].sort((a, b) => a.effective.localeCompare(b.effective))) {
    if (c.effective <= date) cur = { ...cur, ...c };
  }
  return cur;
}

// ───────────────────────── Posting rules ─────────────────────────

export function postDocument(s: EngineState, doc: SourceDoc): void {
  switch (doc.type) {
    case 'sales_invoice':
      return postSalesInvoice(s, doc);
    case 'credit_note':
    case 'debit_note':
      return postNote(s, doc);
    case 'purchase_bill':
      return postBill(s, doc);
    case 'receipt':
      return postReceipt(s, doc);
    case 'payment':
      return postPayment(s, doc);
    case 'payroll':
      return postPayroll(s, doc);
    case 'tax_payment': {
      const acc = { vat: 'vat_settlement', wht: 'wht_payable', gosi: 'gosi_payable', zakat: 'zakat_payable' }[doc.tax];
      const amt = toHalalas(doc.amount);
      s.ledger.post({
        date: doc.date,
        period: periodOf(doc.date),
        source: doc.id,
        sourceType: doc.type,
        memo: `${doc.tax.toUpperCase()} payment${doc.reference ? ` (SADAD ${doc.reference})` : ''}`,
        lines: [dr(role(s, acc), amt), cr(bankOf(s, doc.bankAccount), amt)],
      });
      return;
    }
    case 'transfer': {
      const amt = toHalalas(doc.amount);
      s.ledger.post({
        date: doc.date,
        period: periodOf(doc.date),
        source: doc.id,
        sourceType: doc.type,
        memo: doc.memo ?? `Transfer ${doc.from} → ${doc.to}`,
        lines: [dr(doc.to, amt), cr(doc.from, amt)],
      });
      return;
    }
    case 'journal':
      s.ledger.post({
        date: doc.date,
        period: periodOf(doc.date),
        source: doc.id,
        sourceType: doc.type,
        memo: doc.memo,
        lines: doc.lines.map((l) => ({
          account: l.account,
          debit: toHalalas(l.debit ?? 0),
          credit: toHalalas(l.credit ?? 0),
          memo: l.memo,
          party: l.party,
        })),
      });
      return;
    default: {
      const never: never = doc;
      throw new Error(`Unknown document type: ${(never as { type: string }).type}`);
    }
  }
}

function vatOutputLines(s: EngineState, calc: ComputedInvoice, sign: 1 | -1, ref: string, adjustment: boolean): JournalLine[] {
  const out: JournalLine[] = [];
  const vatAcc = role(s, 'vat_output');
  for (const c of calc.categories) {
    const box = salesBox(c.treatment);
    const tax = box === null ? undefined : { kind: 'vat_out' as const, box, base: sign * c.taxable, tax: sign * c.vat, adjustment, ref };
    out.push(sign === 1 ? cr(vatAcc, c.vat, { tax }) : dr(vatAcc, c.vat, { tax }));
  }
  return out;
}

function postSalesInvoice(s: EngineState, d: SalesInvoiceDoc): void {
  const b = s.books;
  const cu = b.customers.get(d.customer)!;
  const calc = computeInvoice(b, d.lines, cu.vatTreatment);
  const period = periodOf(d.date);
  const lines: JournalLine[] = [dr(role(s, 'ar'), calc.total, { party: cu.id })];
  for (const cl of calc.lines) {
    const acc = cl.line.account ?? role(s, 'revenue_default');
    if (cl.line.servicePeriod) {
      const { now, future } = spread(cl.net, cl.line.servicePeriod, period);
      lines.push(cr(acc, now, { party: cu.id, memo: cl.line.description }));
      const deferred = sum([...future.values()]);
      if (deferred !== 0) {
        lines.push(cr(role(s, 'deferred_revenue'), deferred, { party: cu.id, memo: `Deferred: ${cl.line.description}` }));
        s.schedules.push({ kind: 'deferred_revenue', source: d.id, description: cl.line.description, account: acc, party: cu.id, total: deferred, amounts: future });
      }
    } else {
      lines.push(cr(acc, cl.net, { party: cu.id, memo: cl.line.description }));
    }
  }
  lines.push(...vatOutputLines(s, calc, 1, d.id, false));
  s.ledger.post({ date: d.date, period, source: d.id, sourceType: d.type, memo: `Sales invoice ${d.id} — ${cu.name}`, lines });
  addOpenItem(s, { kind: 'ar', party: cu.id, ref: d.id, date: d.date, dueDate: dueDate(d.date, d.dueDate, cu.paymentTermsDays), amount: calc.total });
  s.invoices.set(d.id, { doc: d, calc });
}

function postNote(s: EngineState, d: CreditNoteDoc): void {
  const b = s.books;
  const cu = b.customers.get(d.customer)!;
  if (!s.invoices.has(d.originalInvoice)) s.warnings.push(`${d.id}: original invoice ${d.originalInvoice} not found in these books`);
  const calc = computeInvoice(b, d.lines, cu.vatTreatment);
  const sign = d.type === 'credit_note' ? -1 : 1;
  const lines: JournalLine[] = [];
  const revDefault = d.type === 'credit_note' ? '4500' : role(s, 'revenue_default');
  if (sign === -1) {
    for (const cl of calc.lines) lines.push(dr(cl.line.account ?? revDefault, cl.net, { party: cu.id, memo: cl.line.description }));
    lines.push(...vatOutputLines(s, calc, -1, d.id, true));
    lines.push(cr(role(s, 'ar'), calc.total, { party: cu.id }));
  } else {
    lines.push(dr(role(s, 'ar'), calc.total, { party: cu.id }));
    for (const cl of calc.lines) lines.push(cr(cl.line.account ?? revDefault, cl.net, { party: cu.id, memo: cl.line.description }));
    lines.push(...vatOutputLines(s, calc, 1, d.id, true));
  }
  s.ledger.post({
    date: d.date,
    period: periodOf(d.date),
    source: d.id,
    sourceType: d.type,
    memo: `${d.type === 'credit_note' ? 'Credit' : 'Debit'} note ${d.id} on ${d.originalInvoice} — ${d.reason}`,
    lines,
  });
  addOpenItem(s, { kind: 'ar', party: cu.id, ref: d.id, date: d.date, dueDate: d.date, amount: sign * calc.total });
  s.invoices.set(d.id, { doc: d, calc });
}

function postBill(s: EngineState, d: PurchaseBillDoc): void {
  const b = s.books;
  const sup = b.suppliers.get(d.supplier)!;
  const period = periodOf(d.date);
  const std = b.rules.vat.standardRate;
  const nonResident = !sup.resident;
  const lines: JournalLine[] = [];
  let payable = 0;
  let netTotal = 0;

  d.lines.forEach((l, idx) => {
    const net = toHalalas(l.amount);
    netTotal += net;
    const treatment = l.vatTreatment ?? (nonResident || sup.vatNumber ? 'standard' : 'out_of_scope');
    const recoverable = l.vatRecoverable !== false;
    const vat = !nonResident && treatment === 'standard' ? (l.vat !== undefined ? toHalalas(l.vat) : pct(net, std)) : 0;
    const rc = nonResident && treatment === 'standard' ? pct(net, std) : 0;
    if (!nonResident && treatment === 'standard' && !sup.vatNumber)
      s.warnings.push(`${d.id}: VAT claimed from supplier ${sup.id} who has no VAT number — input VAT needs a valid tax invoice`);
    const cost = net + (recoverable ? 0 : vat + rc);
    payable += net + vat;

    let account = l.account ?? sup.defaultAccount ?? role(s, 'expense_default');
    if (l.capitalize) {
      const cls = l.capitalize.assetClass;
      account = role(s, `asset:${cls}`);
      if (cost < toHalalas(b.rules.fixedAssets.capitalisationThresholdSar))
        s.warnings.push(`${d.id}: "${l.description}" capitalised below the SAR ${b.rules.fixedAssets.capitalisationThresholdSar} threshold`);
      s.assets.push({
        id: l.capitalize.assetId ?? `${d.id}-${idx + 1}`,
        description: l.description,
        assetClass: cls,
        cost,
        acquisitionDate: d.date,
        usefulLifeMonths: l.capitalize.usefulLifeMonths ?? b.rules.fixedAssets.usefulLifeMonths[cls],
        accumulatedAtStart: 0,
        startPeriod: nextPeriod(period), // straight-line from the month after acquisition
        source: d.id,
      });
      lines.push(dr(account, cost, { party: sup.id, memo: l.description }));
    } else if (l.servicePeriod) {
      const { now, future } = spread(cost, l.servicePeriod, period);
      lines.push(dr(account, now, { party: sup.id, memo: l.description }));
      const pre = sum([...future.values()]);
      if (pre !== 0) {
        lines.push(dr(role(s, 'prepaid'), pre, { party: sup.id, memo: `Prepaid: ${l.description}` }));
        s.schedules.push({ kind: 'prepaid', source: d.id, description: l.description, account, party: sup.id, total: pre, amounts: future });
      }
    } else {
      lines.push(dr(account, cost, { party: sup.id, memo: l.description }));
    }

    if (!nonResident) {
      if (treatment === 'standard' && recoverable && vat !== 0)
        lines.push(dr(role(s, 'vat_input'), vat, { tax: { kind: 'vat_in', box: 7, base: net, tax: vat, ref: d.id } }));
      else if (treatment === 'zero') lines.push(dr(role(s, 'vat_input'), 0, { tax: { kind: 'vat_in', box: 10, base: net, tax: 0, ref: d.id } }));
      else if (treatment === 'exempt') lines.push(dr(role(s, 'vat_input'), 0, { tax: { kind: 'vat_in', box: 11, base: net, tax: 0, ref: d.id } }));
    } else if (rc !== 0) {
      // Reverse charge: self-account output VAT and (if recoverable) claim the same as input.
      if (recoverable) lines.push(dr(role(s, 'vat_input_rc'), rc, { tax: { kind: 'vat_in', box: 9, base: net, tax: rc, ref: d.id } }));
      else lines.push(dr(role(s, 'vat_input_rc'), 0, { tax: { kind: 'vat_in', box: 9, base: net, tax: 0, ref: d.id } }));
      lines.push(cr(role(s, 'vat_output_rc'), rc, { tax: { kind: 'vat_out', box: 9, base: net, tax: rc, ref: d.id } }));
    }
  });

  if (d.importCustomsVat) {
    const iv = toHalalas(d.importCustomsVat);
    lines.push(dr(role(s, 'vat_input_import'), iv, { tax: { kind: 'vat_in', box: 8, base: netTotal, tax: iv, ref: d.id } }));
    payable += iv;
  }

  let creditAcc = role(s, 'ap');
  let paidNow = payable;
  if (d.paidFrom) {
    creditAcc = d.paidFrom;
    if (nonResident) {
      const cat = d.whtCategory ?? sup.whtCategory;
      if (!cat) throw new Error(`${d.id}: payment to non-resident ${sup.id} needs whtCategory (on the bill or supplier)`);
      if (d.whtBorneByPayer) {
        const g = whtGrossedUp(b, payable, cat);
        lines.push(dr(role(s, 'wht_expense'), g.tax, { memo: `WHT borne (${cat})` }));
        lines.push(cr(role(s, 'wht_payable'), g.tax, { party: sup.id, tax: { kind: 'wht', whtCategory: cat, base: g.base, tax: g.tax, ref: d.id } }));
      } else {
        const w = whtWithheld(b, payable, cat);
        paidNow = payable - w;
        lines.push(cr(role(s, 'wht_payable'), w, { party: sup.id, tax: { kind: 'wht', whtCategory: cat, base: payable, tax: w, ref: d.id } }));
      }
    }
  }
  lines.push(cr(creditAcc, paidNow, { party: sup.id }));
  s.ledger.post({ date: d.date, period, source: d.id, sourceType: d.type, memo: `Bill ${d.supplierInvoiceNo} — ${sup.name}`, lines });
  if (!d.paidFrom)
    addOpenItem(s, { kind: 'ap', party: sup.id, ref: d.id, date: d.date, dueDate: dueDate(d.date, d.dueDate, sup.paymentTermsDays), amount: payable });
}

function nextPeriod(p: string): string {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function postReceipt(s: EngineState, d: ReceiptDoc): void {
  const amt = toHalalas(d.amount);
  const ch = toHalalas(d.bankCharges ?? 0);
  s.ledger.post({
    date: d.date,
    period: periodOf(d.date),
    source: d.id,
    sourceType: d.type,
    memo: `Receipt from ${s.books.customers.get(d.customer)!.name}`,
    lines: [dr(bankOf(s, d.bankAccount), amt - ch), dr(role(s, 'bank_charges'), ch), cr(role(s, 'ar'), amt, { party: d.customer })],
  });
  const left = settle(s, 'ar', d.customer, amt, d.invoices);
  if (left > 0) {
    s.warnings.push(`${d.id}: SAR ${fmt(left)} received in excess of open invoices for ${d.customer} (held as credit balance)`);
    s.openItems.push({ kind: 'ar', party: d.customer, ref: d.id, date: d.date, dueDate: d.date, amount: -left, open: -left });
  }
}

function postPayment(s: EngineState, d: PaymentDoc): void {
  const b = s.books;
  const sup = b.suppliers.get(d.supplier)!;
  const amt = toHalalas(d.amount);
  const ch = toHalalas(d.bankCharges ?? 0);
  const lines: JournalLine[] = [dr(role(s, 'ap'), amt, { party: sup.id }), dr(role(s, 'bank_charges'), ch)];
  let w = 0;
  if (!sup.resident) {
    const cat: WhtCategory | undefined = d.whtCategory ?? sup.whtCategory;
    if (!cat) throw new Error(`${d.id}: payment to non-resident ${sup.id} needs whtCategory (on the payment or supplier)`);
    w = whtWithheld(b, amt, cat);
    lines.push(cr(role(s, 'wht_payable'), w, { party: sup.id, tax: { kind: 'wht', whtCategory: cat, base: amt, tax: w, ref: d.id } }));
  }
  lines.push(cr(bankOf(s, d.bankAccount), amt - w + ch));
  s.ledger.post({ date: d.date, period: periodOf(d.date), source: d.id, sourceType: d.type, memo: `Payment to ${sup.name}`, lines });
  const left = settle(s, 'ap', sup.id, amt, d.bills);
  if (left > 0) {
    s.warnings.push(`${d.id}: SAR ${fmt(left)} paid in excess of open bills for ${sup.id} (held as advance)`);
    s.openItems.push({ kind: 'ap', party: sup.id, ref: d.id, date: d.date, dueDate: d.date, amount: -left, open: -left });
  }
}

function postPayroll(s: EngineState, d: PayrollDoc): void {
  const b = s.books;
  if (periodOf(d.date) < d.month) s.warnings.push(`${d.id}: payroll for ${d.month} is dated earlier (${d.date})`);
  const start = monthStart(d.month);
  const end = monthEnd(d.month);
  const dim = daysBetweenInclusive(start, end);
  const slips: PayslipCalc[] = [];
  for (const raw of b.employees.values()) {
    const e = employeeAsOf(raw, end);
    if (e.joinDate > end || (e.leaveDate && e.leaveDate < start)) continue;
    const active = overlapDays(e.joinDate, e.leaveDate ?? '9999-12-31', start, end);
    const adj = { ...(d.adjustments?.find((a) => a.employee === e.id) ?? {}) };
    if (active < dim) adj.unpaidDays = (adj.unpaidDays ?? 0) + Math.round(((dim - active) / dim) * 30 * 100) / 100;
    slips.push(computePayslip(b, e, end, adj));
  }
  if (!slips.length) {
    s.warnings.push(`${d.id}: no active employees for ${d.month}`);
    return;
  }
  s.payroll.set(d.month, slips);
  const direct = sum(slips.filter((x) => x.employee.department === 'cost_of_revenue').map((x) => x.gross));
  const ops = sum(slips.filter((x) => x.employee.department !== 'cost_of_revenue').map((x) => x.gross));
  const er = sum(slips.map((x) => x.gosiEmployer));
  const ee = sum(slips.map((x) => x.gosiEmployee));
  const ded = sum(slips.map((x) => x.otherDeduction));
  const net = sum(slips.map((x) => x.net));
  s.ledger.post({
    date: d.date,
    period: periodOf(d.date),
    source: d.id,
    sourceType: d.type,
    memo: `Payroll ${d.month} (${slips.length} employees)${d.paid ? ' — paid via WPS' : ' — accrued'}`,
    lines: [
      dr(role(s, 'staff_direct'), direct, { memo: 'Gross pay — delivery/engineering' }),
      dr(role(s, 'salaries_expense'), ops, { memo: 'Gross pay — operations' }),
      dr(role(s, 'gosi_expense'), er, { memo: 'GOSI employer share' }),
      cr(role(s, 'gosi_payable'), er + ee, { memo: 'GOSI employer + employee' }),
      cr('1320', ded, { memo: 'Advance recoveries / deductions' }),
      cr(d.paid ? bankOf(s, d.bankAccount) : role(s, 'salaries_payable'), net, { memo: 'Net pay' }),
    ],
  });
}
