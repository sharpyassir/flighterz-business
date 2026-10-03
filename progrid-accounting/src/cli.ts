#!/usr/bin/env node
// progrid-accounting command line. Run `npm run acc -- help`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentsPath, loadBooks, readJson, writeJson } from './books.ts';
import { close, complianceCalendar } from './close.ts';
import { runBooks } from './engine.ts';
import { fmt } from './money.ts';
import { assertPeriod, fiscalYearStart, monthEnd, monthStart } from './dates.ts';
import { computeZakat } from './zakat.ts';
import { issueInvoices, loadRegistry } from './zatca/issue.ts';
import { generateCsr } from './zatca/onboard.ts';
import { type FatooraEnv, clearInvoice, reportInvoice } from './zatca/api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `progrid-accounting — Progrid Cloud bookkeeping (KSA / ZATCA)

Usage: npm run acc -- <command> [args] [--books <dir>]

  new-month <YYYY-MM>            create books/YYYY/MM/documents.json
  validate <YYYY-MM>             post everything up to the month, report problems, write nothing
  close <YYYY-MM> [--all] [--lock]
                                 write the month-end close pack (statements, VAT, WHT, GOSI,
                                 aging, zakat…) to books/YYYY/MM/close/. --all = every month up
                                 to YYYY-MM. --lock = freeze the month(s) after checks pass.
  issue <YYYY-MM>                issue ZATCA e-invoices (XML + QR + hash chain + HTML copy)
  zakat <YYYY-MM>                zakat working for the fiscal year containing the month
  calendar <YYYY-MM>             statutory deadlines arising from the month
  onboard <sandbox|simulation|production> [--branch "…"] [--email …]
                                 generate the EGS CSR for the ZATCA compliance CSID
  submit <YYYY-MM> <env> --yes   report (B2C) / clear (B2B) issued invoices on Fatoora
  demo                           build & close the illustrative demo books (examples/demo-books)

Default books directory: ./books`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const VALUE_FLAGS = new Set(['--books', '--branch', '--email']);
  const argv = process.argv.slice(2);
  const [cmd, a1, a2] = argv.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
  const booksDir = resolve(arg('books') ?? (cmd === 'demo' ? join(ROOT, 'examples', 'demo-books') : join(ROOT, 'books')));
  const period = () => {
    if (!a1) throw new Error('Period YYYY-MM required');
    assertPeriod(a1);
    return a1;
  };

  switch (cmd) {
    case 'new-month': {
      const b = loadBooks(booksDir);
      const p = documentsPath(b, period());
      if (existsSync(p)) console.log(`${p} already exists`);
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, '[]\n');
        console.log(`Created ${p}`);
      }
      return;
    }
    case 'validate': {
      const b = loadBooks(booksDir);
      const s = runBooks(b, period());
      console.log(`OK — ${s.ledger.entries.length} journal entries posted through ${a1}.`);
      if (s.warnings.length) console.log('Warnings:\n  - ' + s.warnings.join('\n  - '));
      return;
    }
    case 'close': {
      const b = loadBooks(booksDir);
      const sums = close(b, period(), { all: flag('all'), lock: flag('lock') });
      for (const sm of sums) {
        const bad = sm.checks.filter((c) => !c.ok);
        console.log(
          `${sm.period} [${sm.status}] revenue ${fmt(sm.revenue)} · net profit ${fmt(sm.netProfit)} (YTD ${fmt(sm.netProfitYtd)}) · cash ${fmt(sm.cash)} · VAT payable ${fmt(sm.vatPayable)} · ${bad.length ? `❌ ${bad.map((c) => c.name).join('; ')}` : '✅ all checks pass'}${sm.warnings.length ? ` · ${sm.warnings.length} warning(s)` : ''}`,
        );
      }
      console.log(`Close packs written under ${booksDir}/<YYYY>/<MM>/close/`);
      return;
    }
    case 'issue': {
      const b = loadBooks(booksDir);
      if (!b.company.issueZatcaInvoices) throw new Error('company.issueZatcaInvoices is false — invoices are issued by an external e-invoicing solution');
      const s = runBooks(b, period());
      const r = await issueInvoices(b, s, a1!);
      for (const e of r.issued) console.log(`Issued ${e.id} ICV ${e.icv} ${e.kind} ${e.signed ? 'signed' : 'UNSIGNED (no CSID certificate yet)'} → ${e.files.html}`);
      if (r.skipped.length) console.log(`Already issued: ${r.skipped.join(', ')}`);
      if (!r.issued.length && !r.skipped.length) console.log('No sales documents in this month.');
      return;
    }
    case 'zakat': {
      const b = loadBooks(booksDir);
      const p = period();
      const s = runBooks(b, p);
      const fy = monthStart(fiscalYearStart(p, b.company.fiscalYearStartMonth));
      const z = computeZakat(b, s.ledger, fy, monthEnd(p));
      for (const x of z.additions) console.log(`+ ${x.label.padEnd(58)} ${fmt(x.amount).padStart(16)}`);
      for (const x of z.deductions) console.log(`- ${x.label.padEnd(58)} ${fmt(x.amount).padStart(16)}`);
      console.log(`  ${'Zakat base'.padEnd(58)} ${fmt(z.base).padStart(16)}${z.minimumBaseApplied ? '  (adjusted profit — minimum base)' : ''}`);
      console.log(`  ${`Zakat @ ${(z.zakatRate * 100).toFixed(4)}% × ${z.saudiSharePercent}%`.padEnd(58)} ${fmt(z.zakat).padStart(16)}`);
      if (z.incomeTax) console.log(`  ${'Income tax @ 20% (non-GCC share)'.padEnd(58)} ${fmt(z.incomeTax).padStart(16)}`);
      return;
    }
    case 'calendar': {
      const b = loadBooks(booksDir);
      for (const x of complianceCalendar(b, period())) console.log(`${x.due.padEnd(12)} ${x.item}`);
      return;
    }
    case 'onboard': {
      const b = loadBooks(booksDir);
      const env = a1 as FatooraEnv;
      if (!['sandbox', 'simulation', 'production'].includes(env)) throw new Error('env must be sandbox|simulation|production');
      const r = generateCsr(b, env, { branch: arg('branch'), email: arg('email') });
      console.log(`CSR written to ${r.csrPath}\n\nNext: get an OTP from fatoora.zatca.gov.sa and request the compliance CSID (see docs/ZATCA-EINVOICING.md).`);
      return;
    }
    case 'submit': {
      const b = loadBooks(booksDir);
      const p = period();
      const env = a2 as FatooraEnv;
      if (!['sandbox', 'simulation', 'production'].includes(env)) throw new Error('env must be sandbox|simulation|production');
      if (!flag('yes')) throw new Error('Submitting to ZATCA is irreversible — re-run with --yes');
      const credPath = join(b.dir, 'zatca', 'egs', `credentials-${env}.json`);
      if (!existsSync(credPath)) throw new Error(`Missing ${credPath} ({ "binarySecurityToken": "…", "secret": "…" }) from the CSID response`);
      const cred = readJson<{ binarySecurityToken: string; secret: string }>(credPath);
      const reg = loadRegistry(b);
      for (const e of Object.values(reg.invoices).filter((x) => x.zatcaStatus === 'pending_submission' && x.issuedAt && x.files.xml.includes(`/${p.replace('-', '/')}/`))) {
        const xml = readFileSync(join(b.dir, e.files.xml), 'utf8');
        const res = e.kind === 'simplified' ? await reportInvoice(env, cred, { invoiceHash: e.hash, uuid: e.uuid, xml }) : await clearInvoice(env, cred, { invoiceHash: e.hash, uuid: e.uuid, xml });
        const ok = res.status === 200 || res.status === 202;
        e.zatcaStatus = ok ? (e.kind === 'simplified' ? 'reported' : 'cleared') : 'rejected';
        writeJson(join(b.dir, 'zatca', 'responses', `${e.id}.json`), res);
        console.log(`${e.id}: HTTP ${res.status} → ${e.zatcaStatus}`);
      }
      writeJson(join(b.dir, 'zatca', 'registry.json'), reg);
      return;
    }
    case 'demo': {
      const b = loadBooks(booksDir);
      const sums = close(b, '2026-03', { all: true });
      for (const sm of sums) console.log(`${sm.period} revenue ${fmt(sm.revenue)} · net profit ${fmt(sm.netProfit)} · cash ${fmt(sm.cash)} · ${sm.checks.every((c) => c.ok) ? '✅' : '❌'}`);
      for (const p of ['2026-01', '2026-02', '2026-03']) {
        const s = runBooks(b, p);
        const r = await issueInvoices(b, s, p, new Date(`${p}-28T09:00:00Z`));
        if (r.issued.length) console.log(`${p}: issued ${r.issued.length} demo e-invoice(s)`);
      }
      console.log(`Demo close packs: ${booksDir}/2026/*/close/close-pack.md`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
