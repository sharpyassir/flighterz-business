import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Account, Company, Customer, Employee, SourceDoc, Supplier } from './types.ts';
import { assertPeriod, periodOf } from './dates.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface TaxRules {
  vat: { standardRate: number; monthlyFilingThresholdSar: number; correctionThresholdSar: number; simplifiedInvoiceMaxSar: number };
  wht: { rates: Record<string, number> };
  gosi: {
    maxBaseSar: number;
    minBaseSar: number;
    saudi: { annuityEmployer: number; annuityEmployee: number; sanedEmployer: number; sanedEmployee: number; hazardsEmployer: number };
    nonSaudi: { hazardsEmployer: number };
    newRegimeAnnuitySchedule: { from: string; rate: number }[];
  };
  eosb: { wageComponents: string[]; firstYearsThreshold: number; firstYearsMonthsPerYear: number; laterYearsMonthsPerYear: number };
  zakat: { hijriRate: number; gregorianDays: number; hijriDays: number; incomeTaxRate: number; monthlyAccrual: boolean };
  fixedAssets: { capitalisationThresholdSar: number; usefulLifeMonths: Record<string, number> };
}

export interface OpeningBalances {
  date: string;
  lines: { account: string; debit?: number; credit?: number; party?: string; memo?: string }[];
  /** Open customer invoices / supplier bills carried in, for aging. */
  openItems?: { kind: 'ar' | 'ap'; party: string; ref: string; date: string; dueDate?: string; amount: number }[];
}

export interface Books {
  dir: string;
  company: Company;
  accounts: Map<string, Account>;
  rules: TaxRules;
  customers: Map<string, Customer>;
  suppliers: Map<string, Supplier>;
  employees: Map<string, Employee>;
  opening: OpeningBalances | null;
}

export function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (e) {
    throw new Error(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function optionalList<T extends { id: string }>(path: string): Map<string, T> {
  if (!existsSync(path)) return new Map();
  const list = readJson<T[]>(path);
  const m = new Map<string, T>();
  for (const x of list) {
    if (m.has(x.id)) throw new Error(`Duplicate id "${x.id}" in ${path}`);
    m.set(x.id, x);
  }
  return m;
}

export function loadBooks(dir: string): Books {
  if (!existsSync(join(dir, 'company.json'))) throw new Error(`No company.json in books directory ${dir}`);
  const coaPath = existsSync(join(dir, 'chart-of-accounts.json'))
    ? join(dir, 'chart-of-accounts.json')
    : join(ROOT, 'config', 'chart-of-accounts.json');
  const rulesPath = existsSync(join(dir, 'tax-rules.json')) ? join(dir, 'tax-rules.json') : join(ROOT, 'config', 'tax-rules.json');
  const accounts = new Map<string, Account>();
  for (const a of readJson<{ accounts: Account[] }>(coaPath).accounts) {
    if (accounts.has(a.code)) throw new Error(`Duplicate account ${a.code}`);
    accounts.set(a.code, a);
  }
  const books: Books = {
    dir,
    company: readJson<Company>(join(dir, 'company.json')),
    accounts,
    rules: readJson<TaxRules>(rulesPath),
    customers: optionalList<Customer>(join(dir, 'customers.json')),
    suppliers: optionalList<Supplier>(join(dir, 'suppliers.json')),
    employees: optionalList<Employee>(join(dir, 'employees.json')),
    opening: existsSync(join(dir, 'opening-balances.json')) ? readJson<OpeningBalances>(join(dir, 'opening-balances.json')) : null,
  };
  validateMasterData(books);
  return books;
}

export function monthDir(books: Books, period: string): string {
  assertPeriod(period);
  const [y, m] = period.split('-');
  return join(books.dir, y, m);
}

export function documentsPath(books: Books, period: string): string {
  return join(monthDir(books, period), 'documents.json');
}

export function loadDocuments(books: Books, period: string): SourceDoc[] {
  const p = documentsPath(books, period);
  if (!existsSync(p)) return [];
  const docs = readJson<SourceDoc[]>(p);
  if (!Array.isArray(docs)) throw new Error(`${p} must contain a JSON array of documents`);
  return docs;
}

export function hashFile(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

/** Periods that have a documents.json, sorted. */
export function periodsWithDocuments(books: Books): string[] {
  const out: string[] = [];
  for (const y of readdirSync(books.dir).filter((d) => /^\d{4}$/.test(d))) {
    for (const m of readdirSync(join(books.dir, y)).filter((d) => /^\d{2}$/.test(d))) {
      if (existsSync(join(books.dir, y, m, 'documents.json'))) out.push(`${y}-${m}`);
    }
  }
  return out.sort();
}

// ───────────────────────── Accounts helpers ─────────────────────────

export function accountByRole(books: Books, role: string): string {
  for (const a of books.accounts.values()) if (a.role === role) return a.code;
  throw new Error(`Chart of accounts has no account with role "${role}"`);
}

export function assertPostable(books: Books, code: string, ctx: string): void {
  const a = books.accounts.get(code);
  if (!a) throw new Error(`${ctx}: unknown account ${code}`);
  if (a.header) throw new Error(`${ctx}: account ${code} (${a.nameEn}) is a heading and cannot be posted to`);
}

// ───────────────────────── Validation ─────────────────────────

/** KSA VAT registration number: 15 digits, first and last digit 3. */
export function isValidVatNumber(v: string): boolean {
  return /^3\d{13}3$/.test(v);
}

function validateMasterData(b: Books): void {
  const c = b.company;
  const errs: string[] = [];
  if (!isValidVatNumber(c.vatNumber)) errs.push(`company.vatNumber "${c.vatNumber}" must be 15 digits starting and ending with 3`);
  if (c.address && !/^\d{5}$/.test(c.address.postalCode)) errs.push('company.address.postalCode must be 5 digits');
  if (c.address && !/^\d{4}$/.test(c.address.buildingNumber)) errs.push('company.address.buildingNumber must be 4 digits');
  if (!(c.fiscalYearStartMonth >= 1 && c.fiscalYearStartMonth <= 12)) errs.push('company.fiscalYearStartMonth must be 1–12');
  if (!b.accounts.has(c.defaultBankAccount)) errs.push(`company.defaultBankAccount ${c.defaultBankAccount} not in chart`);
  for (const cu of b.customers.values()) {
    if (cu.vatNumber && cu.country === 'SA' && !isValidVatNumber(cu.vatNumber))
      errs.push(`customer ${cu.id}: invalid KSA VAT number ${cu.vatNumber}`);
  }
  for (const s of b.suppliers.values()) {
    if (s.vatNumber && s.country === 'SA' && !isValidVatNumber(s.vatNumber))
      errs.push(`supplier ${s.id}: invalid KSA VAT number ${s.vatNumber}`);
    if (s.defaultAccount) {
      try {
        assertPostable(b, s.defaultAccount, `supplier ${s.id}`);
      } catch (e) {
        errs.push((e as Error).message);
      }
    }
  }
  if (errs.length) throw new Error('Master data errors:\n  - ' + errs.join('\n  - '));
}

/** Structural checks on a month's documents before posting. Returns error strings. */
export function validateDocuments(books: Books, period: string, docs: SourceDoc[], seenIds: Set<string>): string[] {
  const errs: string[] = [];
  for (const d of docs) {
    const tag = `${d.type} ${d.id ?? '(no id)'}`;
    if (!d.id) errs.push(`${tag}: missing id`);
    else if (seenIds.has(d.id)) errs.push(`${tag}: duplicate document id`);
    else seenIds.add(d.id);
    if (!d.date) errs.push(`${tag}: missing date`);
    else {
      try {
        if (periodOf(d.date) !== period) errs.push(`${tag}: date ${d.date} is outside period ${period}`);
      } catch (e) {
        errs.push(`${tag}: ${(e as Error).message}`);
      }
    }
    if (d.type === 'sales_invoice' || d.type === 'credit_note' || d.type === 'debit_note') {
      const cu = books.customers.get(d.customer);
      if (!cu) errs.push(`${tag}: unknown customer "${d.customer}"`);
      if (!d.lines?.length) errs.push(`${tag}: no lines`);
      if ((d.invoiceKind ?? 'standard') === 'standard' && cu && cu.country === 'SA' && !cu.vatNumber && !cu.crNumber)
        errs.push(`${tag}: standard (B2B) tax invoice needs the buyer's VAT number or CR — or use invoiceKind "simplified"`);
      if (d.type !== 'sales_invoice' && !d.reason) errs.push(`${tag}: credit/debit note requires a reason (ZATCA KSA-10)`);
      for (const l of d.lines ?? []) {
        if (!(l.quantity > 0)) errs.push(`${tag}: line "${l.description}" quantity must be > 0`);
        if (l.unitPrice < 0) errs.push(`${tag}: line "${l.description}" unit price must be ≥ 0 (use a credit note)`);
        const t = l.vatTreatment ?? cu?.vatTreatment ?? 'standard';
        if (t !== 'standard' && !l.vatExemptionCode)
          errs.push(`${tag}: line "${l.description}" is ${t} — vatExemptionCode (VATEX-SA-…) is required`);
      }
    }
    if (d.type === 'purchase_bill') {
      if (!books.suppliers.get(d.supplier)) errs.push(`${tag}: unknown supplier "${d.supplier}"`);
      if (!d.lines?.length) errs.push(`${tag}: no lines`);
    }
    if (d.type === 'receipt' && !books.customers.get(d.customer)) errs.push(`${tag}: unknown customer "${d.customer}"`);
    if (d.type === 'payment' && !books.suppliers.get(d.supplier)) errs.push(`${tag}: unknown supplier "${d.supplier}"`);
    if (d.type === 'journal') {
      let dr = 0;
      let cr = 0;
      for (const l of d.lines) {
        dr += Math.round((l.debit ?? 0) * 100);
        cr += Math.round((l.credit ?? 0) * 100);
      }
      if (dr !== cr) errs.push(`${tag}: journal does not balance (Dr ${dr / 100} ≠ Cr ${cr / 100})`);
    }
  }
  return errs;
}
