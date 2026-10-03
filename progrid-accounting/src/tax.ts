// VAT, WHT and GOSI calculations (pure functions).
import type { Books } from './books.ts';
import type { Employee, SalesLine, VatTreatment, WhtCategory } from './types.ts';
import { type Halalas, pct, roundHalf, toHalalas, sum } from './money.ts';

// ───────────────────────── VAT ─────────────────────────

/** UNCL5305 category code used in the ZATCA XML. */
export function vatCategoryCode(t: VatTreatment): 'S' | 'Z' | 'E' | 'O' {
  return t === 'standard' ? 'S' : t === 'exempt' ? 'E' : t === 'out_of_scope' ? 'O' : 'Z';
}

/** ZATCA VAT return box for an output supply. Out-of-scope supplies are not reported. */
export function salesBox(t: VatTreatment): number | null {
  switch (t) {
    case 'standard':
      return 1;
    case 'zero_domestic':
      return 3;
    case 'export':
      return 4;
    case 'exempt':
      return 5;
    default:
      return null;
  }
}

export interface ComputedLine {
  line: SalesLine;
  treatment: VatTreatment;
  rate: number;
  net: Halalas; // qty × price − discount
  vat: Halalas; // line VAT (display, KSA-11)
}

export interface ComputedInvoice {
  lines: ComputedLine[];
  /** Per VAT category: taxable amount and VAT (BR-CO-17 — computed at category level). */
  categories: { treatment: VatTreatment; code: string; rate: number; taxable: Halalas; vat: Halalas; exemptionCode?: string; exemptionReason?: string }[];
  net: Halalas;
  vat: Halalas;
  total: Halalas;
}

export function computeInvoice(books: Books, lines: SalesLine[], customerDefault?: VatTreatment): ComputedInvoice {
  const std = books.rules.vat.standardRate;
  const computed: ComputedLine[] = lines.map((l) => {
    const treatment = l.vatTreatment ?? customerDefault ?? 'standard';
    const rate = treatment === 'standard' ? std : 0;
    const net = roundHalf(l.quantity * l.unitPrice * 100) - toHalalas(l.discount ?? 0);
    return { line: l, treatment, rate, net, vat: pct(net, rate) };
  });
  const cats = new Map<string, ComputedInvoice['categories'][number]>();
  for (const c of computed) {
    const key = `${c.treatment}|${c.line.vatExemptionCode ?? ''}`;
    const cur = cats.get(key) ?? {
      treatment: c.treatment,
      code: vatCategoryCode(c.treatment),
      rate: c.rate,
      taxable: 0,
      vat: 0,
      exemptionCode: c.line.vatExemptionCode,
      exemptionReason: c.line.vatExemptionReason,
    };
    cur.taxable += c.net;
    cats.set(key, cur);
  }
  const categories = [...cats.values()].map((c) => ({ ...c, vat: pct(c.taxable, c.rate) }));
  const net = sum(computed.map((c) => c.net));
  const vat = sum(categories.map((c) => c.vat));
  return { lines: computed, categories, net, vat, total: net + vat };
}

// ───────────────────────── WHT ─────────────────────────

export function whtRate(books: Books, cat: WhtCategory): number {
  const r = books.rules.wht.rates[cat];
  if (r === undefined) throw new Error(`Unknown WHT category "${cat}"`);
  return r;
}

/** WHT withheld from a gross payment. */
export function whtWithheld(books: Books, gross: Halalas, cat: WhtCategory): Halalas {
  return pct(gross, whtRate(books, cat));
}

/**
 * WHT when the payer bears it (supplier receives the full amount):
 * the payment is grossed up, tax = net × r / (1 − r).
 */
export function whtGrossedUp(books: Books, net: Halalas, cat: WhtCategory): { base: Halalas; tax: Halalas } {
  const r = whtRate(books, cat);
  const base = roundHalf(net / (1 - r));
  return { base, tax: base - net };
}

// ───────────────────────── GOSI & payroll ─────────────────────────

export function annuityRateNewRegime(books: Books, date: string): number {
  let rate = books.rules.gosi.saudi.annuityEmployee;
  for (const s of books.rules.gosi.newRegimeAnnuitySchedule) if (date >= s.from) rate = s.rate;
  return rate;
}

export interface PayslipCalc {
  employee: Employee;
  gross: Halalas;
  unpaidDeduction: Halalas;
  bonus: Halalas;
  otherDeduction: Halalas;
  gosiBase: Halalas;
  gosiEmployee: Halalas;
  gosiEmployer: Halalas;
  net: Halalas;
}

export function computePayslip(
  books: Books,
  e: Employee,
  date: string,
  adj?: { bonus?: number; deduction?: number; unpaidDays?: number },
): PayslipCalc {
  const g = books.rules.gosi;
  const monthly = toHalalas(e.basic) + toHalalas(e.housing) + toHalalas(e.transport) + toHalalas(e.otherAllowances ?? 0);
  const unpaidDeduction = adj?.unpaidDays ? roundHalf((monthly / 30) * adj.unpaidDays) : 0;
  const bonus = toHalalas(adj?.bonus ?? 0);
  const otherDeduction = toHalalas(adj?.deduction ?? 0);
  const gross = monthly - unpaidDeduction + bonus;
  let gosiBase = Math.min(toHalalas(e.basic) + toHalalas(e.housing), toHalalas(g.maxBaseSar));
  let gosiEmployee = 0;
  let gosiEmployer = 0;
  if (e.nationality === 'saudi') {
    gosiBase = Math.max(gosiBase, toHalalas(g.minBaseSar));
    const annuity = e.gosiRegime === 'new_2024' ? annuityRateNewRegime(books, date) : g.saudi.annuityEmployee;
    const annuityEr = e.gosiRegime === 'new_2024' ? annuityRateNewRegime(books, date) : g.saudi.annuityEmployer;
    gosiEmployee = pct(gosiBase, annuity + g.saudi.sanedEmployee);
    gosiEmployer = pct(gosiBase, annuityEr + g.saudi.sanedEmployer + g.saudi.hazardsEmployer);
  } else {
    gosiEmployer = pct(gosiBase, g.nonSaudi.hazardsEmployer);
  }
  return {
    employee: e,
    gross,
    unpaidDeduction,
    bonus,
    otherDeduction,
    gosiBase,
    gosiEmployee,
    gosiEmployer,
    net: gross - gosiEmployee - otherDeduction,
  };
}

/** End-of-service entitlement at `asOf` under Labour Law Art. 84 (termination basis). */
export function eosbEntitlement(books: Books, e: Employee, years: number): Halalas {
  const r = books.rules.eosb;
  const wage = sum(r.wageComponents.map((k) => toHalalas(Number((e as unknown as Record<string, number>)[k] ?? 0))));
  const first = Math.min(years, r.firstYearsThreshold) * r.firstYearsMonthsPerYear;
  const later = Math.max(0, years - r.firstYearsThreshold) * r.laterYearsMonthsPerYear;
  return roundHalf(wage * (first + later));
}
