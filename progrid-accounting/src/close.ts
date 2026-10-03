// Month-end close: runs the books to a period, performs the integrity checks,
// writes the close pack (Markdown + CSV + JSON) and optionally locks the month.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Books } from './books.ts';
import { accountByRole, documentsPath, hashFile, monthDir, readJson, writeJson } from './books.ts';
import { runBooks, vatPeriodFor } from './engine.ts';
import type { EngineState } from './posting.ts';
import { type Halalas, dec, fmt, sum, toHalalas } from './money.ts';
import { addDays, addMonths, fiscalYearEnd, fiscalYearStart, monthEnd, monthStart, periodRange } from './dates.ts';
import {
  type StatementLine,
  aging,
  assetRegister,
  balanceSheet,
  cashFlow,
  deferralRollForward,
  incomeStatement,
  trialBalance,
  vatReturn,
  whtReturn,
} from './reports.ts';
import { computeZakat } from './zakat.ts';

// ───────────────────────── Locks ─────────────────────────

interface LockFile {
  [period: string]: { journalHash: string; documentsHash: string; lockedAt: string };
}

function lockPath(b: Books) {
  return join(b.dir, 'locks.json');
}

export function loadLocks(b: Books): LockFile {
  return existsSync(lockPath(b)) ? readJson<LockFile>(lockPath(b)) : {};
}

export function journalHash(s: EngineState, period: string): string {
  const entries = s.ledger.entriesInPeriod(period).map((e) => ({ d: e.date, s: e.source, l: e.lines.map((l) => [l.account, l.debit, l.credit, l.party ?? '']) }));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** A locked month must re-derive to exactly the same journal it was locked with. */
export function verifyLocks(b: Books, s: EngineState, upto: string): string[] {
  const errs: string[] = [];
  for (const [p, l] of Object.entries(loadLocks(b))) {
    if (p > upto) continue;
    if (hashFile(documentsPath(b, p)) !== l.documentsHash) errs.push(`${p} is locked but its documents.json has changed since ${l.lockedAt}. Revert it and post corrections in an open month.`);
    else if (journalHash(s, p) !== l.journalHash)
      errs.push(`${p} is locked but its journal no longer re-derives identically (master data, opening balances or tax rules changed). Use effective-dated changes or post adjustments in an open month.`);
  }
  return errs;
}

// ───────────────────────── Output helpers ─────────────────────────

function csv(rows: (string | number)[][]): string {
  const q = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n'; // BOM so Excel shows Arabic
}

function mdTable(head: string[], rows: (string | number)[][], right: number[] = []): string {
  const align = head.map((_, i) => (right.includes(i) ? '---:' : '---'));
  return [`| ${head.join(' | ')} |`, `| ${align.join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

function stmt(lines: StatementLine[], ytd: boolean): string {
  return mdTable(
    ytd ? ['', 'البند', 'Month', 'YTD'] : ['', 'البند', 'SAR'],
    lines.map((l) => {
      const b = l.kind === 'line' ? '' : '**';
      const label = `${b}${l.en}${b}`;
      return ytd ? [label, l.ar, `${b}${fmt(l.amount)}${b}`, `${b}${fmt(l.ytd ?? 0)}${b}`] : [label, l.ar, `${b}${fmt(l.amount)}${b}`];
    }),
    ytd ? [2, 3] : [2],
  );
}

// ───────────────────────── Compliance calendar ─────────────────────────

export function complianceCalendar(b: Books, period: string): { due: string; item: string; itemAr: string }[] {
  const next = addMonths(period, 1);
  const out = [
    { due: `${next}-10`, item: `Withholding tax return & payment for payments made in ${period}`, itemAr: 'إقرار وسداد ضريبة الاستقطاع' },
    { due: `${next}-15`, item: `GOSI contributions for ${period} (GOSI invoice / SADAD)`, itemAr: 'سداد اشتراكات التأمينات الاجتماعية' },
    { due: monthEnd(period), item: `Salaries for ${period} paid through WPS (Mudad) — upload wage file`, itemAr: 'رفع ملف الأجور في منصة مدد' },
    { due: 'within 24h', item: 'Simplified (B2C) e-invoices reported to Fatoora; standard (B2B) invoices cleared before sharing', itemAr: 'الإبلاغ عن الفواتير المبسطة واعتماد الفواتير الضريبية' },
  ];
  const vp = vatPeriodFor(b, period);
  if (vp.end === period) out.push({ due: monthEnd(next), item: `VAT return ${vp.label} — file and pay on the ZATCA portal`, itemAr: 'تقديم وسداد إقرار ضريبة القيمة المضافة' });
  if (fiscalYearEnd(period, b.company.fiscalYearStartMonth) === period) {
    out.push({ due: addDays(monthEnd(period), 120), item: 'Zakat (and income tax) return with audited financial statements', itemAr: 'تقديم الإقرار الزكوي مع القوائم المالية المدققة' });
    out.push({ due: 'per MoC', item: 'Upload audited financial statements to Qawaem (Ministry of Commerce)', itemAr: 'رفع القوائم المالية في منصة قوائم' });
  }
  return out.sort((a, b2) => a.due.localeCompare(b2.due));
}

// ───────────────────────── Close ─────────────────────────

export interface CloseSummary {
  period: string;
  status: 'open' | 'locked';
  revenue: Halalas;
  netProfit: Halalas;
  netProfitYtd: Halalas;
  cash: Halalas;
  receivables: Halalas;
  payables: Halalas;
  vatPayable: Halalas;
  checks: { name: string; ok: boolean; detail?: string }[];
  warnings: string[];
  journalHash: string;
}

export interface CloseOptions {
  lock?: boolean;
  /** Write packs for every month up to `period` (one engine run). */
  all?: boolean;
  quiet?: boolean;
}

export function close(b: Books, period: string, opts: CloseOptions = {}): CloseSummary[] {
  const summaries: CloseSummary[] = [];
  const targets = new Set(opts.all ? periodRange(monthStart(b.company.booksStartDate).slice(0, 7), period) : [period]);
  const state = runBooks(b, period, {
    onPeriodEnd: (p, s) => {
      if (targets.has(p)) summaries.push(writeClosePack(b, s, p));
    },
  });
  const lockErrs = verifyLocks(b, state, period);
  if (lockErrs.length) throw new Error('Locked periods changed:\n  - ' + lockErrs.join('\n  - '));
  if (opts.lock) {
    const locks = loadLocks(b);
    for (const sm of summaries) {
      const failed = sm.checks.filter((c) => !c.ok);
      if (failed.length) throw new Error(`Cannot lock ${sm.period}: failing checks — ${failed.map((c) => c.name).join(', ')}`);
      if (locks[sm.period]) continue;
      locks[sm.period] = { journalHash: sm.journalHash, documentsHash: hashFile(documentsPath(b, sm.period)), lockedAt: new Date().toISOString() };
    }
    writeJson(lockPath(b), locks);
    // Re-render so the packs show their LOCKED status.
    return close(b, period, { ...opts, lock: false });
  }
  return summaries;
}

function writeClosePack(b: Books, s: EngineState, p: string): CloseSummary {
  const dir = join(monthDir(b, p), 'close');
  mkdirSync(dir, { recursive: true });
  const start = monthStart(p);
  const end = monthEnd(p);
  const fyP = fiscalYearStart(p, b.company.fiscalYearStartMonth);
  const fy = monthStart(fyP);
  const locks = loadLocks(b);

  const tb = trialBalance(s, p);
  const is = incomeStatement(s, p);
  const bs = balanceSheet(s, p);
  const cfM = cashFlow(s, start, end);
  const cfY = cashFlow(s, fy, end);
  const vp = vatPeriodFor(b, p);
  const vatEnd = vp.end === p;
  const vat = vatReturn(s, p);
  const wht = whtReturn(s, p);
  const ar = aging(s, 'ar', end);
  const ap = aging(s, 'ap', end);
  const defs = deferralRollForward(s, p);
  const fa = assetRegister(s, p);
  const zk = computeZakat(b, s.ledger, fy, end);
  const slips = s.payroll.get(p) ?? [];
  const entries = s.ledger.entriesInPeriod(p);
  const isFyEnd = fiscalYearEnd(p, b.company.fiscalYearStartMonth) === p;

  // Bank reconciliation against statement balances, if provided.
  const bankStmtPath = join(monthDir(b, p), 'bank-statement.json');
  const bankRec: { account: string; statement: Halalas; ledger: Halalas }[] = [];
  if (existsSync(bankStmtPath)) {
    for (const [acc, bal] of Object.entries(readJson<Record<string, number>>(bankStmtPath))) bankRec.push({ account: acc, statement: toHalalas(bal), ledger: s.ledger.balance(acc, end) });
  }

  const tbDr = sum(tb.map((r) => Math.max(r.closing, 0)));
  const tbCr = sum(tb.map((r) => Math.max(-r.closing, 0)));
  const arCtl = s.ledger.balance(accountByRole(b, 'ar'), end);
  const apCtl = -s.ledger.balance(accountByRole(b, 'ap'), end);
  const checks: CloseSummary['checks'] = [
    { name: 'Trial balance balances', ok: tbDr === tbCr, detail: `Dr ${fmt(tbDr)} / Cr ${fmt(tbCr)}` },
    { name: 'Balance sheet balances', ok: bs.balanced, detail: `Assets ${fmt(bs.totalAssets)} / L+E ${fmt(bs.totalLiabilitiesEquity)}` },
    { name: 'Cash flow reconciles to cash', ok: cfM.reconciles && cfY.reconciles },
    { name: 'AR sub-ledger = control account', ok: sum(ar.map((r) => r.total)) === arCtl, detail: `aging ${fmt(sum(ar.map((r) => r.total)))} vs GL ${fmt(arCtl)}` },
    { name: 'AP sub-ledger = control account', ok: sum(ap.map((r) => r.total)) === apCtl, detail: `aging ${fmt(sum(ap.map((r) => r.total)))} vs GL ${fmt(apCtl)}` },
  ];
  if (vatEnd) checks.push({ name: `VAT return ${vp.label} = ledger settlement`, ok: vat.reconciles, detail: `return ${fmt(vat.totalVatDue)} vs ledger ${fmt(vat.ledgerSettlement)}` });
  for (const r of bankRec) checks.push({ name: `Bank reconciliation ${r.account}`, ok: r.statement === r.ledger, detail: `statement ${fmt(r.statement)} vs ledger ${fmt(r.ledger)}` });
  const cashAccts = [...b.accounts.values()].filter((a) => a.group === 'cash' && !a.header);
  for (const a of cashAccts) {
    const bal = s.ledger.balance(a.code, end);
    if (bal < 0 && a.code !== '1140') checks.push({ name: `No overdrawn cash account (${a.code})`, ok: false, detail: fmt(bal) });
  }

  const warnings = s.warnings.filter((w) => entries.some((e) => w.startsWith(e.source)) || w.includes(p));
  const cash = sum(cashAccts.map((a) => s.ledger.balance(a.code, end)));
  const vatPayable = -sum(['vat_output', 'vat_output_rc', 'vat_input', 'vat_input_rc', 'vat_input_import', 'vat_settlement'].map((r) => s.ledger.balance(accountByRole(b, r), end)));
  const summary: CloseSummary = {
    period: p,
    status: locks[p] ? 'locked' : 'open',
    revenue: is.find((l) => l.key === 'revenue')!.amount,
    netProfit: is.find((l) => l.key === 'net')!.amount,
    netProfitYtd: is.find((l) => l.key === 'net')!.ytd ?? 0,
    cash,
    receivables: arCtl,
    payables: apCtl,
    vatPayable,
    checks,
    warnings,
    journalHash: journalHash(s, p),
  };

  // ── CSV / JSON outputs
  const name = (code: string) => b.accounts.get(code)?.nameEn ?? code;
  writeFileSync(
    join(dir, 'journal.csv'),
    csv([
      ['Entry', 'Date', 'Source', 'Type', 'Memo', 'Account', 'Account name', 'Party', 'Debit', 'Credit', 'Line memo'],
      ...entries.flatMap((e) => e.lines.filter((l) => l.debit || l.credit).map((l) => [e.id, e.date, e.source, e.sourceType, e.memo, l.account, name(l.account), l.party ?? '', dec(l.debit), dec(l.credit), l.memo ?? ''])),
    ]),
  );
  writeFileSync(
    join(dir, 'trial-balance.csv'),
    csv([['Account', 'Name', 'الاسم', 'Opening', 'Debits', 'Credits', 'Closing'], ...tb.map((r) => [r.code, r.nameEn, r.nameAr, dec(r.opening), dec(r.debits), dec(r.credits), dec(r.closing)])]),
  );
  const glRows: (string | number)[][] = [['Account', 'Name', 'Date', 'Entry', 'Source', 'Memo', 'Party', 'Debit', 'Credit', 'Running balance']];
  for (const r of tb) {
    let run = r.opening;
    glRows.push([r.code, r.nameEn, start, '', '', 'Opening balance', '', '', '', dec(run)]);
    for (const { entry, line } of s.ledger.linesFor(r.code, end, start)) {
      run += line.debit - line.credit;
      glRows.push([r.code, r.nameEn, entry.date, entry.id, entry.source, line.memo ?? entry.memo, line.party ?? '', dec(line.debit), dec(line.credit), dec(run)]);
    }
  }
  writeFileSync(join(dir, 'general-ledger.csv'), csv(glRows));
  writeFileSync(join(dir, 'ar-aging.csv'), csv([['Customer', 'Name', 'Current', '1-30', '31-60', '61-90', '>90', 'Total'], ...ar.map((r) => [r.party, r.name, dec(r.current), dec(r.d1_30), dec(r.d31_60), dec(r.d61_90), dec(r.d90), dec(r.total)])]));
  writeFileSync(join(dir, 'ap-aging.csv'), csv([['Supplier', 'Name', 'Current', '1-30', '31-60', '61-90', '>90', 'Total'], ...ap.map((r) => [r.party, r.name, dec(r.current), dec(r.d1_30), dec(r.d31_60), dec(r.d61_90), dec(r.d90), dec(r.total)])]));
  if (wht.rows.length)
    writeFileSync(join(dir, 'wht-return.csv'), csv([['Ref', 'Date', 'Supplier', 'Name', 'Country', 'Category', 'Rate', 'Gross paid', 'WHT'], ...wht.rows.map((r) => [r.ref, r.date, r.supplier, r.supplierName, r.country, r.category, `${r.rate * 100}%`, dec(r.base), dec(r.tax)])]));
  if (slips.length)
    writeFileSync(
      join(dir, 'payroll-register.csv'),
      csv([
        ['Employee', 'Name', 'Nationality', 'Gross', 'Unpaid-leave deduction', 'Bonus', 'GOSI base', 'GOSI employee', 'GOSI employer', 'Other deductions', 'Net pay'],
        ...slips.map((x) => [x.employee.id, x.employee.name, x.employee.nationality, dec(x.gross), dec(x.unpaidDeduction), dec(x.bonus), dec(x.gosiBase), dec(x.gosiEmployee), dec(x.gosiEmployer), dec(x.otherDeduction), dec(x.net)]),
      ]),
    );
  if (fa.length)
    writeFileSync(join(dir, 'fixed-assets.csv'), csv([['Asset', 'Description', 'Class', 'Acquired', 'Cost', 'Life (months)', 'Depreciation this month', 'Accumulated', 'NBV'], ...fa.map((a) => [a.id, a.description, a.assetClass, a.acquisitionDate, dec(a.cost), a.usefulLifeMonths, dec(a.depreciationThisMonth), dec(a.accumulated), dec(a.nbv)])]));
  if (vatEnd) writeJson(join(dir, `vat-return-${vp.label}.json`), vat);
  writeJson(join(dir, 'summary.json'), summary);

  // ── Markdown close pack
  const c = b.company;
  const md: string[] = [];
  md.push(`# ${c.legalNameEn} — Monthly close ${p}`);
  md.push(`**${c.legalNameAr}** · VAT ${c.vatNumber} · CR ${c.crNumber}  `);
  md.push(`Period ${start} → ${end} · Fiscal year from ${fy} · Status: **${summary.status.toUpperCase()}** · All amounts in SAR`);
  md.push('\n## 1. Close checks');
  md.push(mdTable(['Check', 'Result', 'Detail'], checks.map((k) => [k.name, k.ok ? '✅ pass' : '❌ FAIL', k.detail ?? ''])));
  if (warnings.length) md.push('\n**Warnings to review:**\n' + warnings.map((w) => `- ${w}`).join('\n'));
  md.push('\n## 2. Key figures');
  md.push(
    mdTable(
      ['Figure', 'SAR'],
      [
        ['Revenue (month)', fmt(summary.revenue)],
        ['Net profit (month)', fmt(summary.netProfit)],
        ['Net profit (YTD)', fmt(summary.netProfitYtd)],
        ['Cash & bank', fmt(cash)],
        ['Trade receivables', fmt(arCtl)],
        ['Trade payables', fmt(apCtl)],
        ['VAT payable / (refundable)', fmt(vatPayable)],
      ],
      [1],
    ),
  );
  md.push('\n## 3. Statement of profit or loss — قائمة الربح أو الخسارة');
  md.push(stmt(is, true));
  md.push(`\n## 4. Statement of financial position — قائمة المركز المالي (as at ${end})`);
  for (const sec of bs.sections) {
    md.push(`\n**${sec.title} — ${sec.titleAr}**\n`);
    md.push(stmt([...sec.lines, { key: 't', en: `Total ${sec.title.toLowerCase()}`, ar: `إجمالي ${sec.titleAr}`, amount: sec.total, kind: 'subtotal' }], false));
  }
  md.push(`\n**Total assets ${fmt(bs.totalAssets)} · Total liabilities & equity ${fmt(bs.totalLiabilitiesEquity)}**`);
  md.push('\n## 5. Statement of cash flows (indirect) — قائمة التدفقات النقدية');
  const cfRows = (label: string, m: Halalas, y: Halalas) => [label, fmt(m), fmt(y)];
  const labels = new Set([...cfM.operating, ...cfY.operating].map((x) => x.label));
  const pick = (cf: typeof cfM, l: string, k: 'operating' | 'investing' | 'financing') => sum(cf[k].filter((x) => x.label === l).map((x) => x.amount));
  const inv = new Set([...cfM.investing, ...cfY.investing].map((x) => x.label));
  const fin = new Set([...cfM.financing, ...cfY.financing].map((x) => x.label));
  md.push(
    mdTable(
      ['', 'Month', 'YTD'],
      [
        cfRows('Net profit', cfM.netProfit, cfY.netProfit),
        ...[...labels].filter((l) => pick(cfM, l, 'operating') || pick(cfY, l, 'operating')).map((l) => cfRows(`  ${l}`, pick(cfM, l, 'operating'), pick(cfY, l, 'operating'))),
        cfRows('**Net cash from operating activities**', cfM.netOperating, cfY.netOperating),
        ...[...inv].map((l) => cfRows(`  ${l}`, pick(cfM, l, 'investing'), pick(cfY, l, 'investing'))),
        cfRows('**Net cash from investing activities**', cfM.netInvesting, cfY.netInvesting),
        ...[...fin].map((l) => cfRows(`  ${l}`, pick(cfM, l, 'financing'), pick(cfY, l, 'financing'))),
        cfRows('**Net cash from financing activities**', cfM.netFinancing, cfY.netFinancing),
        cfRows('Cash at beginning', cfM.openingCash, cfY.openingCash),
        cfRows('**Cash at end**', cfM.closingCash, cfY.closingCash),
      ],
      [1, 2],
    ),
  );
  md.push('\n## 6. Trial balance — ميزان المراجعة');
  md.push(mdTable(['Account', 'Name', 'Opening', 'Debits', 'Credits', 'Closing'], tb.map((r) => [r.code, r.nameEn, fmt(r.opening), fmt(r.debits), fmt(r.credits), fmt(r.closing)]), [2, 3, 4, 5]));

  md.push(`\n## 7. VAT — ضريبة القيمة المضافة (${vp.label}, ${c.vatFilingFrequency})`);
  md.push(vatEnd ? `Return due **${vat.dueDate}** (file & pay on the ZATCA portal).\n` : `VAT period ${vp.label} still open — figures accumulated to ${end}; return will be prepared at ${monthEnd(vp.end)}.\n`);
  md.push(
    mdTable(
      ['Box', 'Description', 'البيان', 'Amount', 'Adjustments', 'VAT'],
      [
        ...vat.boxes.filter((x) => x.box <= 5).map((x) => [x.box, x.en, x.ar, fmt(x.amount), fmt(x.adjustment), fmt(x.vat)]),
        [6, '**Total sales**', 'إجمالي المبيعات', fmt(vat.totalSales.amount), fmt(vat.totalSales.adjustment), fmt(vat.totalSales.vat)],
        ...vat.boxes.filter((x) => x.box >= 7).map((x) => [x.box, x.en, x.ar, fmt(x.amount), fmt(x.adjustment), fmt(x.vat)]),
        [12, '**Total purchases**', 'إجمالي المشتريات', fmt(vat.totalPurchases.amount), fmt(vat.totalPurchases.adjustment), fmt(vat.totalPurchases.vat)],
        [13, 'Total VAT due for current period (incl. reverse-charge output ' + fmt(vat.reverseChargeOutput) + ')', 'إجمالي الضريبة المستحقة', '', '', fmt(vat.totalVatDue)],
        [14, 'Corrections from previous period (±5,000)', 'تصحيحات من الفترات السابقة', '', '', fmt(vat.corrections)],
        [15, 'VAT credit carried forward', 'الرصيد الدائن المرحل', '', '', fmt(vat.creditCarriedForward)],
        [16, '**Net VAT due (claimed)**', 'صافي الضريبة المستحقة', '', '', `**${fmt(vat.netVatDue)}**`],
      ],
      [3, 4, 5],
    ),
  );
  md.push(`\n## 8. Withholding tax — ضريبة الاستقطاع (payments in ${p}, due ${wht.dueDate})`);
  md.push(wht.rows.length ? mdTable(['Ref', 'Date', 'Supplier', 'Country', 'Category', 'Rate', 'Gross paid', 'WHT'], wht.rows.map((r) => [r.ref, r.date, r.supplierName, r.country, r.category, `${r.rate * 100}%`, fmt(r.base), fmt(r.tax)]), [6, 7]) + `\n\n**Total WHT payable: ${fmt(wht.total)}**` : 'No payments to non-residents this month — file a nil return only if your ZATCA account requires it.');
  md.push(`\n## 9. Payroll & GOSI — الرواتب والتأمينات (${slips.length} employees)`);
  if (slips.length) {
    md.push(mdTable(['Employee', 'Nat.', 'Gross', 'GOSI base', 'GOSI emp.', 'GOSI empr.', 'Net pay'], slips.map((x) => [x.employee.name, x.employee.nationality === 'saudi' ? 'SA' : 'non-SA', fmt(x.gross), fmt(x.gosiBase), fmt(x.gosiEmployee), fmt(x.gosiEmployer), fmt(x.net)]), [2, 3, 4, 5, 6]));
    md.push(`\nGOSI payable for ${p}: **${fmt(sum(slips.map((x) => x.gosiEmployee + x.gosiEmployer)))}** (due ${addMonths(p, 1)}-15). EOSB provision: ${fmt(-s.ledger.balance(accountByRole(b, 'eosb_provision'), end))}.`);
  } else md.push('No payroll document this month.');
  md.push('\n## 10. Receivables aging — أعمار الذمم المدينة');
  md.push(ar.length ? mdTable(['Customer', 'Current', '1–30', '31–60', '61–90', '>90', 'Total'], ar.map((r) => [r.name, fmt(r.current), fmt(r.d1_30), fmt(r.d31_60), fmt(r.d61_90), fmt(r.d90), fmt(r.total)]), [1, 2, 3, 4, 5, 6]) : 'No open receivables.');
  md.push('\n## 11. Payables aging — أعمار الذمم الدائنة');
  md.push(ap.length ? mdTable(['Supplier', 'Current', '1–30', '31–60', '61–90', '>90', 'Total'], ap.map((r) => [r.name, fmt(r.current), fmt(r.d1_30), fmt(r.d31_60), fmt(r.d61_90), fmt(r.d90), fmt(r.total)]), [1, 2, 3, 4, 5, 6]) : 'No open payables.');
  md.push('\n## 12. Deferred revenue & prepayments (IFRS 15 / accruals)');
  md.push(defs.length ? mdTable(['Kind', 'Source', 'Description', 'Released this month', 'Remaining'], defs.map((d) => [d.kind === 'deferred_revenue' ? 'Deferred revenue' : 'Prepaid', d.source, d.description, fmt(d.releasedThisMonth), fmt(d.remaining)]), [3, 4]) : 'None.');
  md.push('\n## 13. Fixed asset register — سجل الأصول الثابتة');
  md.push(fa.length ? mdTable(['Asset', 'Description', 'Class', 'Cost', 'Dep. this month', 'Accumulated', 'NBV'], fa.map((a) => [a.id, a.description, a.assetClass, fmt(a.cost), fmt(a.depreciationThisMonth), fmt(a.accumulated), fmt(a.nbv)]), [3, 4, 5, 6]) : 'No fixed assets.');
  md.push(`\n## 14. Zakat ${isFyEnd ? 'computation (year end)' : 'estimate (YTD)'} — ${isFyEnd ? 'احتساب الزكاة' : 'تقدير الزكاة'}`);
  md.push(
    mdTable(
      ['', 'البيان', 'SAR'],
      [
        ...zk.additions.map((x) => [`+ ${x.label}`, x.labelAr, fmt(x.amount)]),
        ...zk.deductions.map((x) => [`− ${x.label}`, x.labelAr, fmt(x.amount)]),
        ['Computed zakat base', 'الوعاء الزكوي المحتسب', fmt(zk.computedBase)],
        [`Zakat base used${zk.minimumBaseApplied ? ' (adjusted profit — minimum base)' : ''}`, 'الوعاء الزكوي', fmt(zk.base)],
        [`Saudi/GCC share ${zk.saudiSharePercent}% × rate ${(zk.zakatRate * 100).toFixed(4)}%`, 'الزكاة المستحقة', `**${fmt(zk.zakat)}**`],
        ...(zk.incomeTax ? [[`Income tax 20% on non-GCC share of adjusted profit`, 'ضريبة الدخل', `**${fmt(zk.incomeTax)}**`]] : []),
      ],
      [2],
    ),
  );
  md.push(`\nZakat accrued YTD: ${fmt(s.ledger.balance(accountByRole(b, 'zakat_expense'), end, fy))}. ${isFyEnd ? '**Year end:** the accrual above has been trued up to the full annual computation. Have it reviewed by a licensed zakat adviser before filing.' : 'Monthly accrual = estimate × months elapsed / 12; trued up automatically in the final month of the fiscal year.'}`);
  md.push('\n## 15. Compliance calendar — المواعيد النظامية');
  md.push(mdTable(['Due', 'Obligation', 'الالتزام'], complianceCalendar(b, p).map((x) => [x.due, x.item, x.itemAr])));
  md.push('\n## 16. Close checklist');
  const tick = (ok: boolean) => (ok ? '[x]' : '[ ]');
  md.push(
    [
      `- ${tick(true)} All source documents for ${p} entered in \`documents.json\` (sales invoices, bills, receipts, payments, payroll)`,
      `- ${tick(bankRec.length > 0 && bankRec.every((r) => r.statement === r.ledger))} Bank accounts reconciled to statements (\`bank-statement.json\`)`,
      `- ${tick(checks.every((k) => k.ok))} Trial balance, balance sheet, sub-ledgers and VAT reconcile`,
      `- ${tick(true)} Deferred revenue, prepayments, depreciation, EOSB and zakat accruals posted (automatic)`,
      `- [ ] Accruals for unbilled supplier costs (e.g. cloud usage not yet invoiced) posted as journals`,
      `- [ ] Expected credit loss reviewed against the aging report`,
      `- ${tick(!s.books.company.issueZatcaInvoices || [...s.invoices.values()].every((i) => !i.doc.date.startsWith(p)) || existsSync(join(monthDir(b, p), 'invoices')))} E-invoices issued, and reported/cleared on Fatoora`,
      vatEnd ? `- [ ] VAT return ${vp.label} filed and paid by ${vat.dueDate}` : `- ${tick(true)} No VAT return due this month`,
      `- [ ] WHT return filed by ${wht.dueDate}${wht.rows.length ? '' : ' (nil)'}`,
      `- [ ] GOSI paid by ${addMonths(p, 1)}-15`,
      `- [ ] Pack reviewed and approved by finance manager, then locked (\`npm run acc -- close ${p} --lock\`)`,
    ].join('\n'),
  );
  md.push(`\n## 17. Journal — دفتر اليومية (${entries.length} entries)`);
  for (const e of entries) {
    md.push(`\n**${e.id}** · ${e.date} · ${e.source} — ${e.memo}\n`);
    md.push(mdTable(['Account', 'Name', 'Party', 'Debit', 'Credit'], e.lines.filter((l) => l.debit || l.credit).map((l) => [l.account, name(l.account), l.party ?? '', l.debit ? fmt(l.debit) : '', l.credit ? fmt(l.credit) : '']), [3, 4]));
  }
  md.push(`\n---\nGenerated by progrid-accounting. Journal hash \`${summary.journalHash.slice(0, 16)}…\`. Figures are derived entirely from \`documents.json\`; edit the documents and re-run to regenerate.`);
  writeFileSync(join(dir, 'close-pack.md'), md.join('\n') + '\n');
  return summary;
}
