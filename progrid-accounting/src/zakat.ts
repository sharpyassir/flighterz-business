// Zakat base & income-tax estimate (Zakat Implementing Regulations, FY ≥ 2024).
// This is a working-paper estimate for monthly accruals and year-end planning.
// The filed return must be reviewed by a licensed zakat/tax adviser.
import type { Books } from './books.ts';
import { accountByRole } from './books.ts';
import type { Ledger } from './ledger.ts';
import { type Halalas, pct, roundHalf, sum } from './money.ts';
import { addDays } from './dates.ts';

export interface ZakatLine {
  label: string;
  labelAr: string;
  amount: Halalas;
}

export interface ZakatCalc {
  fyStart: string;
  asOf: string;
  profitBeforeZakat: Halalas;
  adjustedProfit: Halalas;
  additions: ZakatLine[];
  deductions: ZakatLine[];
  computedBase: Halalas;
  base: Halalas; // after minimum-base rule and floor at zero
  minimumBaseApplied: boolean;
  saudiSharePercent: number;
  zakatRate: number;
  zakat: Halalas;
  incomeTax: Halalas;
}

/** Net credit balance (positive = credit) for a set of accounts. */
function creditBal(bal: Map<string, Halalas>, codes: string[]): Halalas {
  return -sum(codes.map((c) => bal.get(c) ?? 0));
}

export function computeZakat(books: Books, ledger: Ledger, fyStart: string, asOf: string): ZakatCalc {
  const accts = [...books.accounts.values()].filter((a) => !a.header);
  const by = (pred: (a: (typeof accts)[number]) => boolean) => accts.filter(pred).map((a) => a.code);
  const closing = ledger.balances(asOf);
  const beforeFy = ledger.balances(addDays(fyStart, -1));
  const ytd = ledger.balances(asOf, fyStart);

  const plCodes = by((a) => (a.type === 'revenue' || a.type === 'expense') && a.group !== 'zakat_tax');
  const allPl = by((a) => a.type === 'revenue' || a.type === 'expense');
  const profitBeforeZakat = creditBal(ytd, plCodes);

  const eosbExp = accountByRole(books, 'eosb_expense');
  const eosbProv = accountByRole(books, 'eosb_provision');
  const provisionCharges = sum([eosbExp, '6820'].map((c) => ytd.get(c) ?? 0));
  const eosbUtilised = ledger.linesFor(eosbProv, asOf, fyStart).reduce((s, x) => s + x.line.debit, 0);
  const adjustedProfit = profitBeforeZakat + provisionCharges - eosbUtilised;

  const re = accountByRole(books, 'retained_earnings');
  const openingRetained = creditBal(beforeFy, [re, ...allPl]);
  const capital = creditBal(closing, by((a) => a.group === 'capital' || a.group === 'reserves'));
  const provOpeningLessUsed = creditBal(closing, [eosbProv]) - (ytd.get(eosbExp) ?? 0);
  const nonCurrentLiab = creditBal(closing, by((a) => a.type === 'liability' && a.current === false && a.code !== eosbProv));

  const netOf = (group: string) => -creditBal(closing, by((a) => a.group === group));
  const additions: ZakatLine[] = [
    { label: 'Share capital, reserves & shareholder current account', labelAr: 'رأس المال والاحتياطيات وجاري الشركاء', amount: capital },
    { label: 'Retained earnings / (accumulated losses) at start of year', labelAr: 'الأرباح المبقاة (الخسائر المتراكمة) أول العام', amount: openingRetained },
    { label: 'Adjusted net profit / (loss) for the year', labelAr: 'صافي الربح (الخسارة) المعدل للعام', amount: adjustedProfit },
    { label: 'Provisions at start of year less utilised', labelAr: 'المخصصات أول العام ناقصاً المستخدم', amount: provOpeningLessUsed },
    { label: 'Non-current liabilities (loans, leases)', labelAr: 'الالتزامات غير المتداولة (قروض، إيجارات)', amount: nonCurrentLiab },
  ];
  const deductions: ZakatLine[] = [
    { label: 'Property & equipment, net', labelAr: 'صافي الممتلكات والمعدات', amount: netOf('ppe') },
    { label: 'Intangible assets, net', labelAr: 'صافي الأصول غير الملموسة', amount: netOf('intangibles') },
    { label: 'Right-of-use assets, net', labelAr: 'صافي أصول حق الاستخدام', amount: netOf('rou') },
  ];
  const computedBase = sum(additions.map((x) => x.amount)) - sum(deductions.map((x) => x.amount));
  let base = computedBase;
  let minimumBaseApplied = false;
  if (adjustedProfit > base) {
    base = adjustedProfit;
    minimumBaseApplied = true;
  }
  base = Math.max(0, base);

  const z = books.rules.zakat;
  const share = books.company.saudiGccOwnershipPercent / 100;
  const zakatRate = (z.hijriRate * z.gregorianDays) / z.hijriDays;
  const zakat = pct(roundHalf(base * share), zakatRate);
  const incomeTax = pct(roundHalf(Math.max(0, adjustedProfit) * (1 - share)), z.incomeTaxRate);
  return {
    fyStart,
    asOf,
    profitBeforeZakat,
    adjustedProfit,
    additions,
    deductions,
    computedBase,
    base,
    minimumBaseApplied,
    saudiSharePercent: books.company.saudiGccOwnershipPercent,
    zakatRate,
    zakat,
    incomeTax,
  };
}
