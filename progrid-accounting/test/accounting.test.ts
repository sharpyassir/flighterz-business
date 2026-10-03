import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocate, roundHalf, toHalalas } from '../src/money.ts';
import { loadBooks, isValidVatNumber, validateDocuments } from '../src/books.ts';
import { runBooks } from '../src/engine.ts';
import { close } from '../src/close.ts';
import { spread } from '../src/posting.ts';
import { computeInvoice, computePayslip, eosbEntitlement, whtGrossedUp } from '../src/tax.ts';
import { vatReturn, trialBalance, balanceSheet } from '../src/reports.ts';
import { FIRST_PIH, decodeTlv } from '../src/zatca/crypto.ts';
import { issueInvoices } from '../src/zatca/issue.ts';
import type { Employee, SourceDoc } from '../src/types.ts';

const DEMO = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-books');

function tempBooks(): string {
  const dir = mkdtempSync(join(tmpdir(), 'progrid-'));
  cpSync(DEMO, dir, { recursive: true, filter: (src) => !/[\\/](close|invoices|zatca)$/.test(src) && !src.endsWith('locks.json') });
  return dir;
}

// ───────────── money ─────────────

test('allocate splits exactly and rounding is half-away-from-zero', () => {
  const parts = allocate(12_000_000, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 12_000_000);
  assert.equal(roundHalf(2.5), 3);
  assert.equal(roundHalf(-2.5), -3);
  assert.equal(toHalalas('1,250.505'), 125051);
});

test('VAT number format (15 digits, starts and ends with 3)', () => {
  assert.ok(isValidVatNumber('399999999900003'));
  assert.ok(!isValidVatNumber('399999999900004'));
  assert.ok(!isValidVatNumber('29999999990000'));
});

// ───────────── tax rules ─────────────

test('invoice VAT is computed per category (BR-CO-17) with exemption categories at 0%', () => {
  const b = loadBooks(DEMO);
  const c = computeInvoice(b, [
    { description: 'a', quantity: 3, unitPrice: 33.33 },
    { description: 'b', quantity: 1, unitPrice: 0.05 },
    { description: 'c', quantity: 1, unitPrice: 1000, vatTreatment: 'export', vatExemptionCode: 'VATEX-SA-33' },
  ]);
  const s = c.categories.find((x) => x.code === 'S')!;
  assert.equal(s.taxable, 10004); // 99.99 + 0.05
  assert.equal(s.vat, 1501); // 15 % of 100.04 = 15.006 → 15.01
  assert.equal(c.categories.find((x) => x.code === 'Z')!.vat, 0);
  assert.equal(c.total, 10004 + 1501 + 100000);
});

test('service periods spread by days, remainder kept exact', () => {
  const r = spread(12_000_000, { start: '2026-01-01', end: '2026-12-31' }, '2026-01');
  assert.equal(r.now, 1_019_178); // 31/365 × 120,000.00
  assert.equal(r.now + [...r.future.values()].reduce((a, b) => a + b, 0), 12_000_000);
  // billed in arrears: whole period already elapsed → recognised immediately
  assert.equal(spread(500_000, { start: '2025-11-01', end: '2025-12-31' }, '2026-01').now, 500_000);
});

test('GOSI: Saudi legacy 9.75 % / 11.75 %, new-regime annuity steps up each July, non-Saudi 2 % employer', () => {
  const b = loadBooks(DEMO);
  const base: Employee = { id: 'x', name: 'x', nationality: 'saudi', joinDate: '2020-01-01', basic: 10000, housing: 2500, transport: 1000 };
  const legacy = computePayslip(b, { ...base, gosiRegime: 'legacy' }, '2026-03-31');
  assert.equal(legacy.gosiEmployee, 121875);
  assert.equal(legacy.gosiEmployer, 146875);
  const newJun = computePayslip(b, { ...base, gosiRegime: 'new_2024' }, '2026-06-30');
  const newJul = computePayslip(b, { ...base, gosiRegime: 'new_2024' }, '2026-07-31');
  assert.equal(newJun.gosiEmployee, toHalalas(12500 * 0.1025)); // 9.5 % + 0.75 %
  assert.equal(newJul.gosiEmployee, toHalalas(12500 * 0.1075)); // 10 % + 0.75 %
  const capped = computePayslip(b, { ...base, basic: 50000, housing: 10000 }, '2026-03-31');
  assert.equal(capped.gosiBase, 4_500_000);
  const expat = computePayslip(b, { ...base, nationality: 'non_saudi' }, '2026-03-31');
  assert.equal(expat.gosiEmployee, 0);
  assert.equal(expat.gosiEmployer, 25000);
});

test('EOSB (Art. 84): ½ month per year for 5 years, 1 month per year after', () => {
  const b = loadBooks(DEMO);
  const e: Employee = { id: 'x', name: 'x', nationality: 'non_saudi', joinDate: '2020-01-01', basic: 8000, housing: 1500, transport: 500 };
  assert.equal(eosbEntitlement(b, e, 3), 1_500_000); // 3 × 0.5 × 10,000
  assert.equal(eosbEntitlement(b, e, 7), 4_500_000); // 2.5 + 2 months
});

test('WHT borne by payer is grossed up', () => {
  const b = loadBooks(DEMO);
  const g = whtGrossedUp(b, 850_000, 'royalties');
  assert.equal(g.base, 1_000_000);
  assert.equal(g.tax, 150_000);
});

// ───────────── validation ─────────────

test('document validation catches the usual mistakes', () => {
  const b = loadBooks(DEMO);
  const docs = [
    { type: 'journal', id: 'J1', date: '2026-04-02', memo: 'x', lines: [{ account: '6990', debit: 10 }, { account: '1120', credit: 9 }] },
    { type: 'sales_invoice', id: 'I1', date: '2026-04-03', customer: 'C003', lines: [{ description: 'export', quantity: 1, unitPrice: 5 }] },
    { type: 'receipt', id: 'R1', date: '2026-05-01', customer: 'C001', amount: 1 },
    { type: 'receipt', id: 'R1', date: '2026-04-01', customer: 'NOPE', amount: 1 },
  ] as SourceDoc[];
  const errs = validateDocuments(b, '2026-04', docs, new Set()).join('\n');
  assert.match(errs, /does not balance/);
  assert.match(errs, /vatExemptionCode/);
  assert.match(errs, /outside period/);
  assert.match(errs, /duplicate document id/);
  assert.match(errs, /unknown customer/);
});

// ───────────── end to end ─────────────

test('demo quarter: every month closes clean and the Q1 VAT return ties to the ledger', () => {
  const dir = tempBooks();
  try {
    const b = loadBooks(dir);
    const sums = close(b, '2026-03', { all: true });
    assert.equal(sums.length, 3);
    for (const sm of sums) for (const c of sm.checks) assert.ok(c.ok, `${sm.period}: ${c.name} ${c.detail ?? ''}`);
    const s = runBooks(b, '2026-03');
    const v = vatReturn(s, '2026-03');
    assert.equal(v.label, '2026-Q1');
    assert.equal(v.boxes.find((x) => x.box === 1)!.amount, toHalalas(196500));
    assert.equal(v.boxes.find((x) => x.box === 1)!.adjustment, toHalalas(-1000));
    assert.equal(v.boxes.find((x) => x.box === 4)!.amount, toHalalas(20000));
    assert.equal(v.boxes.find((x) => x.box === 9)!.vat, toHalalas(14715));
    assert.equal(v.netVatDue, toHalalas(17460));
    assert.equal(v.ledgerSettlement, v.totalVatDue);
    const tb = trialBalance(s, '2026-03');
    assert.equal(tb.reduce((a, r) => a + r.closing, 0), 0);
    assert.ok(balanceSheet(s, '2026-02').balanced);
    assert.ok(existsSync(join(dir, '2026', '03', 'close', 'close-pack.md')));
    assert.ok(existsSync(join(dir, '2026', '03', 'close', 'vat-return-2026-Q1.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locked months cannot be changed', () => {
  const dir = tempBooks();
  try {
    const b = loadBooks(dir);
    close(b, '2026-01', { lock: true });
    assert.ok(JSON.parse(readFileSync(join(dir, 'locks.json'), 'utf8'))['2026-01']);
    const p = join(dir, '2026', '01', 'documents.json');
    const docs = JSON.parse(readFileSync(p, 'utf8'));
    docs[1].lines[0].unitPrice = 401;
    writeFileSync(p, JSON.stringify(docs));
    assert.throws(() => close(loadBooks(dir), '2026-02'), /2026-01 is locked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────── ZATCA ─────────────

test('ZATCA: hash chain, signature, QR and immutability', async () => {
  const dir = tempBooks();
  try {
    const b = loadBooks(dir);
    const s = runBooks(b, '2026-01');
    const r = await issueInvoices(b, s, '2026-01', new Date('2026-01-31T12:00:00Z'));
    assert.equal(r.issued.length, 4);
    assert.equal(r.issued[0].pih, FIRST_PIH);
    assert.equal(FIRST_PIH, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==');
    for (let i = 1; i < r.issued.length; i++) {
      assert.equal(r.issued[i].pih, r.issued[i - 1].hash);
      assert.equal(r.issued[i].icv, r.issued[i - 1].icv + 1);
    }
    const e = r.issued[3]; // simplified B2C invoice
    const xml = readFileSync(join(dir, e.files.xml), 'utf8');
    assert.match(xml, /<cbc:InvoiceTypeCode name="0200000">388<\/cbc:InvoiceTypeCode>/);
    // Re-derive the hash the way ZATCA does: drop the XML declaration, QR reference, UBLExtensions and cac:Signature.
    const hashable = xml
      .replace(/^<\?xml[^>]*>\n/, '')
      .replace(/<ext:UBLExtensions>.*?<\/ext:UBLExtensions>/, '')
      .replace(/<cac:Signature>.*?<\/cac:Signature>/, '')
      .replace(/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>.*?<\/cac:AdditionalDocumentReference>/, '');
    assert.equal(createHash('sha256').update(hashable).digest('base64'), e.hash);
    const qr = decodeTlv(xml.match(/<cbc:ID>QR<\/cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]+)</)![1]);
    assert.equal(qr.get(2)!.toString(), '399999999900003');
    assert.equal(qr.get(4)!.toString(), '920.00');
    assert.equal(qr.get(5)!.toString(), '120.00');
    assert.equal(qr.get(6)!.toString(), e.hash);
    const pub = createPublicKey({ key: qr.get(8)!, format: 'der', type: 'spki' });
    assert.ok(verify('sha256', Buffer.from(e.hash, 'base64'), pub, Buffer.from(qr.get(7)!.toString(), 'base64')));
    // Issuing again is a no-op; changing an issued invoice is refused.
    assert.equal((await issueInvoices(b, runBooks(b, '2026-01'), '2026-01')).skipped.length, 4);
    const p = join(dir, '2026', '01', 'documents.json');
    const docs = JSON.parse(readFileSync(p, 'utf8'));
    docs[0].lines[0].unitPrice = 1;
    writeFileSync(p, JSON.stringify(docs));
    const b2 = loadBooks(dir);
    await assert.rejects(issueInvoices(b2, runBooks(b2, '2026-01'), '2026-01'), /immutable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
