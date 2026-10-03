// Financial statements, tax returns and sub-ledger reports derived from the ledger.
import type { Books } from './books.ts';
import { accountByRole } from './books.ts';
import type { Account, WhtCategory } from './types.ts';
import { type Halalas, sum } from './money.ts';
import { addDays, addMonths, daysBetweenInclusive, fiscalYearStart, monthEnd, monthStart } from './dates.ts';
import type { EngineState } from './posting.ts';
import { depreciationFor, taxTags, vatPeriodFor } from './engine.ts';
import { whtRate } from './tax.ts';

export const GROUPS: Record<string, { en: string; ar: string }> = {
  cash: { en: 'Cash and bank balances', ar: 'النقد وما في حكمه' },
  receivables: { en: 'Trade and other receivables', ar: 'الذمم المدينة' },
  prepayments: { en: 'Prepayments and other assets', ar: 'المدفوعات المقدمة والأصول الأخرى' },
  tax_assets: { en: 'VAT recoverable', ar: 'ضريبة القيمة المضافة المستردة' },
  ppe: { en: 'Property and equipment', ar: 'الممتلكات والمعدات' },
  intangibles: { en: 'Intangible assets', ar: 'الأصول غير الملموسة' },
  rou: { en: 'Right-of-use assets', ar: 'أصول حق الاستخدام' },
  payables: { en: 'Trade payables and accruals', ar: 'الذمم الدائنة والمستحقات' },
  tax_liabilities: { en: 'VAT, WHT and zakat payable', ar: 'الضرائب والزكاة المستحقة' },
  employee_liabilities: { en: 'Employee-related payables', ar: 'مستحقات الموظفين' },
  contract_liabilities: { en: 'Deferred revenue', ar: 'الإيرادات المؤجلة' },
  other_current: { en: 'Other current liabilities', ar: 'التزامات متداولة أخرى' },
  noncurrent_provisions: { en: 'End-of-service benefits', ar: 'مكافأة نهاية الخدمة' },
  lease: { en: 'Lease liabilities', ar: 'التزامات الإيجار' },
  loans: { en: 'Long-term borrowings', ar: 'القروض طويلة الأجل' },
  capital: { en: 'Share capital & shareholder account', ar: 'رأس المال وجاري الشركاء' },
  reserves: { en: 'Reserves', ar: 'الاحتياطيات' },
  retained: { en: 'Retained earnings', ar: 'الأرباح المبقاة' },
  revenue: { en: 'Revenue', ar: 'الإيرادات' },
  cost_of_revenue: { en: 'Cost of revenue', ar: 'تكلفة الإيرادات' },
  staff: { en: 'Staff costs', ar: 'تكاليف الموظفين' },
  premises: { en: 'Premises', ar: 'المقرات' },
  professional: { en: 'Professional fees', ar: 'الأتعاب المهنية' },
  marketing: { en: 'Marketing', ar: 'التسويق' },
  travel: { en: 'Travel', ar: 'السفر' },
  technology: { en: 'Technology & office', ar: 'التقنية والمكتب' },
  depreciation: { en: 'Depreciation & amortisation', ar: 'الإهلاك والإطفاء' },
  other_expense: { en: 'Other operating expenses', ar: 'مصروفات تشغيلية أخرى' },
  other_income: { en: 'Other income', ar: 'إيرادات أخرى' },
  finance: { en: 'Finance & FX costs', ar: 'التكاليف التمويلية وفروقات العملة' },
  zakat_tax: { en: 'Zakat and income tax', ar: 'الزكاة وضريبة الدخل' },
};

const postable = (b: Books) => [...b.accounts.values()].filter((a) => !a.header).sort((x, y) => x.code.localeCompare(y.code));
const isPL = (a: Account) => a.type === 'revenue' || a.type === 'expense';

// ───────────────────────── Trial balance ─────────────────────────

export interface TbRow {
  code: string;
  nameEn: string;
  nameAr: string;
  opening: Halalas;
  debits: Halalas;
  credits: Halalas;
  closing: Halalas;
}

export function trialBalance(s: EngineState, period: string): TbRow[] {
  const b = s.books;
  const start = monthStart(period);
  const end = monthEnd(period);
  const fy = monthStart(fiscalYearStart(period, b.company.fiscalYearStartMonth));
  const mv = new Map<string, { d: Halalas; c: Halalas }>();
  for (const e of s.ledger.entries) {
    if (e.date < start || e.date > end) continue;
    for (const l of e.lines) {
      const m = mv.get(l.account) ?? { d: 0, c: 0 };
      m.d += l.debit;
      m.c += l.credit;
      mv.set(l.account, m);
    }
  }
  const before = s.ledger.balances(addDays(start, -1));
  const beforeFy = s.ledger.balances(addDays(fy, -1));
  const re = accountByRole(b, 'retained_earnings');
  const priorPl = sum(postable(b).filter(isPL).map((a) => beforeFy.get(a.code) ?? 0));
  const rows: TbRow[] = [];
  for (const a of postable(b)) {
    // P&L accounts restart each fiscal year; prior years' result sits in retained earnings.
    let opening = (before.get(a.code) ?? 0) - (isPL(a) ? (beforeFy.get(a.code) ?? 0) : 0);
    if (a.code === re) opening += priorPl;
    const m = mv.get(a.code) ?? { d: 0, c: 0 };
    if (!opening && !m.d && !m.c) continue;
    rows.push({ code: a.code, nameEn: a.nameEn, nameAr: a.nameAr, opening, debits: m.d, credits: m.c, closing: opening + m.d - m.c });
  }
  return rows;
}

// ───────────────────────── Income statement ─────────────────────────

export interface StatementLine {
  key: string;
  en: string;
  ar: string;
  amount: Halalas;
  ytd?: Halalas;
  kind: 'line' | 'subtotal' | 'total' | 'heading';
}

function plGroupTotals(s: EngineState, from: string, to: string): Map<string, Halalas> {
  const bal = s.ledger.balances(to, from);
  const m = new Map<string, Halalas>();
  for (const a of postable(s.books).filter(isPL)) m.set(a.group, (m.get(a.group) ?? 0) - (bal.get(a.code) ?? 0));
  return m; // credit-positive: revenue +, expenses −
}

export function incomeStatement(s: EngineState, period: string): StatementLine[] {
  const fy = monthStart(fiscalYearStart(period, s.books.company.fiscalYearStartMonth));
  const mth = plGroupTotals(s, monthStart(period), monthEnd(period));
  const ytd = plGroupTotals(s, fy, monthEnd(period));
  const g = (k: string) => ({ m: mth.get(k) ?? 0, y: ytd.get(k) ?? 0 });
  const out: StatementLine[] = [];
  const line = (k: string) => {
    const v = g(k);
    out.push({ key: k, en: GROUPS[k].en, ar: GROUPS[k].ar, amount: v.m, ytd: v.y, kind: 'line' });
  };
  const tot = (key: string, en: string, ar: string, keys: string[], kind: 'subtotal' | 'total' = 'subtotal') =>
    out.push({ key, en, ar, amount: sum(keys.map((k) => g(k).m)), ytd: sum(keys.map((k) => g(k).y)), kind });
  const opex = ['staff', 'premises', 'professional', 'marketing', 'travel', 'technology', 'depreciation', 'other_expense'];
  line('revenue');
  line('cost_of_revenue');
  tot('gross', 'Gross profit', 'مجمل الربح', ['revenue', 'cost_of_revenue']);
  opex.forEach(line);
  tot('operating', 'Operating profit', 'الربح التشغيلي', ['revenue', 'cost_of_revenue', ...opex]);
  line('other_income');
  line('finance');
  tot('pbz', 'Profit before zakat and income tax', 'الربح قبل الزكاة وضريبة الدخل', ['revenue', 'cost_of_revenue', ...opex, 'other_income', 'finance']);
  line('zakat_tax');
  tot('net', 'Net profit for the period', 'صافي الربح للفترة', ['revenue', 'cost_of_revenue', ...opex, 'other_income', 'finance', 'zakat_tax'], 'total');
  return out;
}

// ───────────────────────── Balance sheet ─────────────────────────

export interface BalanceSheet {
  asOf: string;
  sections: { title: string; titleAr: string; lines: StatementLine[]; total: Halalas }[];
  totalAssets: Halalas;
  totalLiabilitiesEquity: Halalas;
  balanced: boolean;
}

export function balanceSheet(s: EngineState, period: string): BalanceSheet {
  const b = s.books;
  const end = monthEnd(period);
  const fy = monthStart(fiscalYearStart(period, b.company.fiscalYearStartMonth));
  const bal = s.ledger.balances(end);
  const grp = new Map<string, Halalas>();
  for (const a of postable(b).filter((a) => !isPL(a))) grp.set(a.group, (grp.get(a.group) ?? 0) + (bal.get(a.code) ?? 0));
  const allPl = postable(b).filter(isPL);
  const cyProfit = -sum(allPl.map((a) => s.ledger.balance(a.code, end, fy)));
  const priorPl = -sum(allPl.map((a) => s.ledger.balance(a.code, addDays(fy, -1))));
  const mk = (keys: string[], sign: 1 | -1) =>
    keys.map((k) => ({ key: k, en: GROUPS[k].en, ar: GROUPS[k].ar, amount: sign * (grp.get(k) ?? 0), kind: 'line' as const })).filter((l) => l.amount !== 0);
  const ca = mk(['cash', 'receivables', 'prepayments', 'tax_assets'], 1);
  const nca = mk(['ppe', 'intangibles', 'rou'], 1);
  const cl = mk(['payables', 'tax_liabilities', 'employee_liabilities', 'contract_liabilities', 'other_current'], -1);
  const ncl = mk(['noncurrent_provisions', 'lease', 'loans'], -1);
  const eq = [
    ...mk(['capital', 'reserves'], -1),
    { key: 'retained', en: GROUPS.retained.en, ar: GROUPS.retained.ar, amount: -(grp.get('retained') ?? 0) + priorPl, kind: 'line' as const },
    { key: 'cy', en: 'Profit for the current year', ar: 'ربح السنة الحالية', amount: cyProfit, kind: 'line' as const },
  ];
  const t = (ls: StatementLine[]) => sum(ls.map((l) => l.amount));
  const sections = [
    { title: 'Current assets', titleAr: 'الأصول المتداولة', lines: ca, total: t(ca) },
    { title: 'Non-current assets', titleAr: 'الأصول غير المتداولة', lines: nca, total: t(nca) },
    { title: 'Current liabilities', titleAr: 'الالتزامات المتداولة', lines: cl, total: t(cl) },
    { title: 'Non-current liabilities', titleAr: 'الالتزامات غير المتداولة', lines: ncl, total: t(ncl) },
    { title: 'Equity', titleAr: 'حقوق الملكية', lines: eq, total: t(eq) },
  ];
  const totalAssets = t(ca) + t(nca);
  const totalLiabilitiesEquity = t(cl) + t(ncl) + t(eq);
  return { asOf: end, sections, totalAssets, totalLiabilitiesEquity, balanced: totalAssets === totalLiabilitiesEquity };
}

// ───────────────────────── Cash flow (indirect) ─────────────────────────

export interface CashFlow {
  netProfit: Halalas;
  operating: { label: string; amount: Halalas }[];
  investing: { label: string; amount: Halalas }[];
  financing: { label: string; amount: Halalas }[];
  netOperating: Halalas;
  netInvesting: Halalas;
  netFinancing: Halalas;
  openingCash: Halalas;
  closingCash: Halalas;
  reconciles: boolean;
}

export function cashFlow(s: EngineState, from: string, to: string): CashFlow {
  const b = s.books;
  const accts = postable(b);
  const mv = s.ledger.balances(to, from);
  const netProfit = -sum(accts.filter(isPL).map((a) => mv.get(a.code) ?? 0));
  const operating: CashFlow['operating'] = [];
  const investing: CashFlow['investing'] = [];
  const financing: CashFlow['financing'] = [];
  const opGroups = new Set(['receivables', 'prepayments', 'tax_assets', 'payables', 'tax_liabilities', 'employee_liabilities', 'contract_liabilities', 'other_current', 'noncurrent_provisions']);
  const bucket = new Map<string, { list: CashFlow['operating']; amount: Halalas }>();
  for (const a of accts) {
    if (isPL(a) || a.group === 'cash') continue;
    const d = -(mv.get(a.code) ?? 0);
    if (!d) continue;
    let list = financing;
    let label = GROUPS[a.group]?.en ?? a.group;
    if (a.contra && ['ppe', 'intangibles', 'rou'].includes(a.group)) {
      list = operating;
      label = 'Depreciation & amortisation';
    } else if (['ppe', 'intangibles', 'rou'].includes(a.group)) {
      list = investing;
      label = `Purchase of ${GROUPS[a.group].en.toLowerCase()}`;
    } else if (opGroups.has(a.group) && a.code !== '2520') {
      list = operating;
      label = `${a.type === 'asset' ? '(Increase)/decrease' : 'Increase/(decrease)'} in ${(GROUPS[a.group]?.en ?? a.group).toLowerCase()}`;
    } else if (a.group === 'retained') label = 'Dividends / distributions';
    const key = `${list === operating ? 'o' : list === investing ? 'i' : 'f'}|${label}`;
    const cur = bucket.get(key) ?? { list, amount: 0 };
    cur.amount += d;
    bucket.set(key, cur);
  }
  for (const [k, v] of bucket) v.list.push({ label: k.split('|')[1], amount: v.amount });
  const cash = accts.filter((a) => a.group === 'cash').map((a) => a.code);
  const openingCash = sum(cash.map((c) => s.ledger.balance(c, addDays(from, -1))));
  const closingCash = sum(cash.map((c) => s.ledger.balance(c, to)));
  const netOperating = netProfit + sum(operating.map((x) => x.amount));
  const netInvesting = sum(investing.map((x) => x.amount));
  const netFinancing = sum(financing.map((x) => x.amount));
  return {
    netProfit,
    operating,
    investing,
    financing,
    netOperating,
    netInvesting,
    netFinancing,
    openingCash,
    closingCash,
    reconciles: openingCash + netOperating + netInvesting + netFinancing === closingCash,
  };
}

// ───────────────────────── VAT return ─────────────────────────

export interface VatBox {
  box: number;
  en: string;
  ar: string;
  amount: Halalas;
  adjustment: Halalas;
  vat: Halalas;
}

export interface VatReturn {
  label: string;
  from: string;
  to: string;
  dueDate: string;
  boxes: VatBox[];
  totalSales: VatBox;
  totalPurchases: VatBox;
  reverseChargeOutput: Halalas;
  totalVatDue: Halalas;
  corrections: Halalas;
  creditCarriedForward: Halalas;
  netVatDue: Halalas;
  ledgerSettlement: Halalas;
  reconciles: boolean;
  lines: { box: number; ref: string; date: string; base: Halalas; tax: Halalas; adjustment: boolean }[];
}

const VAT_BOXES: [number, string, string][] = [
  [1, 'Standard rated sales', 'المبيعات الخاضعة للنسبة الأساسية'],
  [2, 'Private healthcare / private education sales to citizens', 'المبيعات للمواطنين (خدمات صحية/تعليم أهلي)'],
  [3, 'Zero rated domestic sales', 'المبيعات المحلية الخاضعة للنسبة الصفرية'],
  [4, 'Exports', 'الصادرات'],
  [5, 'Exempt sales', 'المبيعات المعفاة'],
  [7, 'Standard rated domestic purchases', 'المشتريات الخاضعة للنسبة الأساسية'],
  [8, 'Imports subject to VAT paid at customs', 'الاستيرادات الخاضعة للضريبة المدفوعة في الجمارك'],
  [9, 'Imports subject to VAT accounted for through reverse charge', 'الاستيرادات الخاضعة للضريبة بآلية الاحتساب العكسي'],
  [10, 'Zero rated purchases', 'المشتريات الخاضعة للنسبة الصفرية'],
  [11, 'Exempt purchases', 'المشتريات المعفاة'],
];

export function vatReturn(s: EngineState, period: string, corrections: Halalas = 0): VatReturn {
  const b = s.books;
  const vp = vatPeriodFor(b, period);
  const tags = taxTags(s, vp.start, vp.end).filter((t) => t.tag.kind === 'vat_out' || t.tag.kind === 'vat_in');
  const boxes: VatBox[] = VAT_BOXES.map(([box, en, ar]) => {
    const kind = box <= 6 ? 'vat_out' : 'vat_in';
    const ts = tags.filter((t) => t.tag.kind === kind && t.tag.box === box);
    return {
      box,
      en,
      ar,
      amount: sum(ts.filter((t) => !t.tag.adjustment).map((t) => t.tag.base)),
      adjustment: sum(ts.filter((t) => t.tag.adjustment).map((t) => t.tag.base)),
      vat: sum(ts.map((t) => t.tag.tax)),
    };
  });
  const total = (box: number, en: string, ar: string, from: number[]): VatBox => {
    const bs = boxes.filter((x) => from.includes(x.box));
    return { box, en, ar, amount: sum(bs.map((x) => x.amount)), adjustment: sum(bs.map((x) => x.adjustment)), vat: sum(bs.map((x) => x.vat)) };
  };
  const totalSales = total(6, 'Total sales', 'إجمالي المبيعات', [1, 2, 3, 4, 5]);
  const totalPurchases = total(12, 'Total purchases', 'إجمالي المشتريات', [7, 8, 9, 10, 11]);
  const reverseChargeOutput = sum(tags.filter((t) => t.tag.kind === 'vat_out' && t.tag.box === 9).map((t) => t.tag.tax));
  // The ZATCA portal adds reverse-charge VAT (box 9) to the output side automatically.
  const totalVatDue = totalSales.vat + reverseChargeOutput - totalPurchases.vat;
  const settle = accountByRole(b, 'vat_settlement');
  const priorBal = s.ledger.balance(settle, addDays(monthStart(vp.start), -1));
  const creditCarriedForward = priorBal > 0 ? priorBal : 0; // debit balance = refundable credit
  const settlementEntry = s.ledger.entries.find((e) => e.source === `auto:vat-settlement:${vp.label}`);
  const ledgerSettlement = settlementEntry ? -sum(settlementEntry.lines.filter((l) => l.account === settle).map((l) => l.debit - l.credit)) : 0;
  const due = monthEnd(addMonths(vp.end, 1));
  return {
    label: vp.label,
    from: monthStart(vp.start),
    to: monthEnd(vp.end),
    dueDate: due,
    boxes,
    totalSales,
    totalPurchases,
    reverseChargeOutput,
    totalVatDue,
    corrections,
    creditCarriedForward,
    netVatDue: totalVatDue + corrections - creditCarriedForward,
    ledgerSettlement,
    reconciles: ledgerSettlement === totalVatDue,
    lines: tags
      .filter((t) => t.tag.box !== undefined && (t.tag.kind === 'vat_out' ? t.tag.box !== 9 : true))
      .map((t) => ({ box: t.tag.box!, ref: t.tag.ref ?? t.entry.source, date: t.entry.date, base: t.tag.base, tax: t.tag.tax, adjustment: !!t.tag.adjustment })),
  };
}

// ───────────────────────── WHT return ─────────────────────────

export interface WhtRow {
  ref: string;
  date: string;
  supplier: string;
  supplierName: string;
  country: string;
  category: WhtCategory;
  rate: number;
  base: Halalas;
  tax: Halalas;
}

export function whtReturn(s: EngineState, period: string): { rows: WhtRow[]; total: Halalas; dueDate: string } {
  const rows: WhtRow[] = taxTags(s, period, period)
    .filter((t) => t.tag.kind === 'wht')
    .map((t) => {
      const sup = s.books.suppliers.get(t.line.party ?? '');
      return {
        ref: t.tag.ref ?? t.entry.source,
        date: t.entry.date,
        supplier: t.line.party ?? '',
        supplierName: sup?.name ?? '',
        country: sup?.country ?? '',
        category: t.tag.whtCategory!,
        rate: whtRate(s.books, t.tag.whtCategory!),
        base: t.tag.base,
        tax: t.tag.tax,
      };
    });
  return { rows, total: sum(rows.map((r) => r.tax)), dueDate: `${addMonths(period, 1)}-10` };
}

// ───────────────────────── Aging, deferrals, assets ─────────────────────────

export interface AgingRow {
  party: string;
  name: string;
  current: Halalas;
  d1_30: Halalas;
  d31_60: Halalas;
  d61_90: Halalas;
  d90: Halalas;
  total: Halalas;
}

export function aging(s: EngineState, kind: 'ar' | 'ap', asOf: string): AgingRow[] {
  const rows = new Map<string, AgingRow>();
  for (const it of s.openItems) {
    if (it.kind !== kind || it.open === 0 || it.date > asOf) continue;
    const name = (kind === 'ar' ? s.books.customers.get(it.party)?.name : s.books.suppliers.get(it.party)?.name) ?? it.party;
    const r = rows.get(it.party) ?? { party: it.party, name, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0 };
    const late = it.dueDate >= asOf ? 0 : daysBetweenInclusive(it.dueDate, asOf) - 1;
    if (late <= 0) r.current += it.open;
    else if (late <= 30) r.d1_30 += it.open;
    else if (late <= 60) r.d31_60 += it.open;
    else if (late <= 90) r.d61_90 += it.open;
    else r.d90 += it.open;
    r.total += it.open;
    rows.set(it.party, r);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export function deferralRollForward(s: EngineState, period: string) {
  return s.schedules
    .map((sc) => ({
      kind: sc.kind,
      source: sc.source,
      description: sc.description,
      party: sc.party ?? '',
      total: sc.total,
      releasedThisMonth: sc.amounts.get(period) ?? 0,
      remaining: sum([...sc.amounts.entries()].filter(([p]) => p > period).map(([, v]) => v)),
    }))
    .filter((r) => r.remaining !== 0 || r.releasedThisMonth !== 0);
}

export function assetRegister(s: EngineState, period: string) {
  return s.assets
    .filter((a) => a.acquisitionDate <= monthEnd(period))
    .map((a) => {
      let acc = a.accumulatedAtStart;
      let month = 0;
      for (let p = a.startPeriod; p <= period; p = addMonths(p, 1)) {
        const d = depreciationFor(a, p);
        acc += d;
        if (p === period) month = d;
      }
      return { ...a, depreciationThisMonth: month, accumulated: acc, nbv: a.cost - acc };
    });
}
