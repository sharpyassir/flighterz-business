// Printable bilingual (Arabic / English) tax invoice with the ZATCA QR code.
import QRCode from 'qrcode';
import type { Books } from '../books.ts';
import type { IssuedInvoice } from '../posting.ts';
import { fmt, toHalalas } from '../money.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function titles(inv: IssuedInvoice): [string, string] {
  const simplified = (inv.doc.invoiceKind ?? 'standard') === 'simplified';
  if (inv.doc.type === 'credit_note') return ['إشعار دائن', 'Credit Note'];
  if (inv.doc.type === 'debit_note') return ['إشعار مدين', 'Debit Note'];
  return simplified ? ['فاتورة ضريبية مبسطة', 'Simplified Tax Invoice'] : ['فاتورة ضريبية', 'Tax Invoice'];
}

export async function renderInvoiceHtml(b: Books, inv: IssuedInvoice, z: { uuid: string; icv: number; qr: string; hash: string }): Promise<string> {
  const c = b.company;
  const cu = b.customers.get(inv.doc.customer)!;
  const [ar, en] = titles(inv);
  const qrSvg = await QRCode.toString(z.qr, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  const addr = (a: Partial<typeof c.address> | undefined) =>
    a ? [a.buildingNumber, a.street, a.district, a.city, a.postalCode].filter(Boolean).map((x) => esc(String(x))).join('، ') : '';
  const rows = inv.calc.lines
    .map(
      (l, i) => `<tr>
  <td>${i + 1}</td>
  <td>${l.line.descriptionAr ? `<div dir="rtl">${esc(l.line.descriptionAr)}</div>` : ''}${esc(l.line.description)}${
    l.line.servicePeriod ? `<div class="muted">${l.line.servicePeriod.start} → ${l.line.servicePeriod.end}</div>` : ''
  }</td>
  <td class="n">${l.line.quantity}</td>
  <td class="n">${fmt(toHalalas(l.line.unitPrice))}</td>
  <td class="n">${fmt(toHalalas(l.line.discount ?? 0))}</td>
  <td class="n">${fmt(l.net)}</td>
  <td class="n">${(l.rate * 100).toFixed(0)}%</td>
  <td class="n">${fmt(l.vat)}</td>
  <td class="n">${fmt(l.net + l.vat)}</td>
</tr>`,
    )
    .join('\n');
  const exemptions = inv.calc.categories
    .filter((k) => k.code !== 'S')
    .map((k) => `<p class="muted">${esc(k.code)} — ${esc(k.exemptionCode ?? '')} ${esc(k.exemptionReason ?? '')}</p>`)
    .join('');
  const ref =
    inv.doc.type !== 'sales_invoice'
      ? `<tr><th>الفاتورة الأصلية / Original invoice</th><td>${esc(inv.doc.originalInvoice)}</td></tr><tr><th>السبب / Reason</th><td>${esc(inv.doc.reason)}</td></tr>`
      : '';
  return `<!doctype html>
<html lang="ar" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(en)} ${esc(inv.doc.id)}</title>
<style>
  :root{--ink:#1b2333;--muted:#667085;--line:#d0d5dd;--head:#f2f4f7}
  body{font-family:"Segoe UI","Noto Naskh Arabic",Tahoma,sans-serif;color:var(--ink);background:#fff;margin:0;padding:24px;max-width:980px;margin-inline:auto}
  h1{margin:0;font-size:22px} .ar{direction:rtl;text-align:right}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:12px}
  .qr svg{width:140px;height:140px} .muted{color:var(--muted);font-size:12px;margin:2px 0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{border:1px solid var(--line);padding:6px 8px;vertical-align:top}
  th{background:var(--head);text-align:start} .n{text-align:right;white-space:nowrap}
  .totals{width:auto;margin-inline-start:auto;margin-top:12px} .totals td{min-width:140px}
  .grand td{font-weight:700;font-size:15px} footer{margin-top:20px}
  @media print{body{padding:0}}
</style></head><body>
<header>
  <div><h1>${esc(en)}</h1><div class="ar"><h1>${esc(ar)}</h1></div>
    <p class="muted">No. ${esc(inv.doc.id)} · ${inv.doc.date} ${esc(inv.doc.time ?? '')}</p></div>
  <div class="qr" aria-label="ZATCA QR code">${qrSvg}</div>
</header>
<div class="grid">
  <table><tr><th colspan="2">البائع / Seller</th></tr>
    <tr><td colspan="2"><div class="ar">${esc(c.legalNameAr)}</div>${esc(c.legalNameEn)}</td></tr>
    <tr><th>الرقم الضريبي / VAT No.</th><td>${esc(c.vatNumber)}</td></tr>
    <tr><th>السجل التجاري / CR No.</th><td>${esc(c.crNumber)}</td></tr>
    <tr><th>العنوان / Address</th><td>${addr(c.address)}</td></tr></table>
  <table><tr><th colspan="2">المشتري / Buyer</th></tr>
    <tr><td colspan="2">${cu.nameAr ? `<div class="ar">${esc(cu.nameAr)}</div>` : ''}${esc(cu.name)}</td></tr>
    ${cu.vatNumber ? `<tr><th>الرقم الضريبي / VAT No.</th><td>${esc(cu.vatNumber)}</td></tr>` : ''}
    ${cu.crNumber ? `<tr><th>السجل التجاري / CR No.</th><td>${esc(cu.crNumber)}</td></tr>` : ''}
    <tr><th>العنوان / Address</th><td>${addr(cu.address)} ${esc(cu.country)}</td></tr>
    ${ref}</table>
</div>
<table>
  <thead><tr><th>#</th><th>الوصف / Description</th><th>الكمية / Qty</th><th>سعر الوحدة / Unit price</th><th>الخصم / Discount</th>
  <th>المبلغ الخاضع / Taxable</th><th>النسبة / Rate</th><th>الضريبة / VAT</th><th>الإجمالي / Total</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<table class="totals">
  <tr><th>الإجمالي غير شامل الضريبة / Total excl. VAT</th><td class="n">${fmt(inv.calc.net)}</td></tr>
  <tr><th>ضريبة القيمة المضافة / VAT</th><td class="n">${fmt(inv.calc.vat)}</td></tr>
  <tr class="grand"><th>الإجمالي المستحق / Total due (SAR)</th><td class="n">${fmt(inv.calc.total)}</td></tr>
</table>
${exemptions}
<footer class="muted">UUID ${z.uuid} · ICV ${z.icv} · Hash ${esc(z.hash)}</footer>
</body></html>
`;
}
