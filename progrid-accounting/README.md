# Progrid Cloud — Accounting & Bookkeeping (KSA)

Double-entry bookkeeping for **Progrid Cloud**, built for Saudi rules: IFRS as
endorsed by SOCPA, VAT at 15 %, withholding tax, Zakat, GOSI, end-of-service
benefits, and **ZATCA e-invoicing (Fatoora, Phase 2)**.

Every journal entry is **derived from source documents**: invoices, bills,
receipts, payments and payroll, kept as JSON in `books/YYYY/MM/documents.json`.
Run the close and you get the month's statements, tax returns and working
papers. To change a figure, change the evidence and re-run. Nobody types a
journal number by hand that can't be traced back to a document.

```
books/
  company.json            legal entity, VAT/CR, fiscal year, VAT frequency
  customers.json          customers (VAT no., country → VAT treatment)
  suppliers.json          suppliers (resident? → reverse charge + WHT)
  employees.json          staff (nationality → GOSI, join date → EOSB)
  opening-balances.json   prior-year closing trial balance + open invoices/bills
  fixed-assets.json       assets already owned at the start of the books
  2026/01/documents.json  ← everything that happened in January
  2026/01/bank-statement.json   closing bank balances (for the bank rec)
  2026/01/close/          ← generated close pack
  2026/01/invoices/       ← generated ZATCA XML + printable invoices
  locks.json              closed months (tamper-evident)
  zatca/registry.json     e-invoice counter (ICV) and hash chain (PIH)
```

## Quick start

```bash
cd progrid-accounting
npm install
npm test                      # 11 tests: tax maths, a full quarter, locking, ZATCA chain
npm run demo                  # closes the fictional demo quarter in examples/demo-books
```

Open `examples/demo-books/2026/03/close/close-pack.md` to see a complete
month-end pack, and `examples/demo-books/2026/01/invoices/*.html` for
bilingual e-invoices with the ZATCA QR code. **The demo data is fictional.**

## Monthly bookkeeping cycle

| When | Step | Command |
|---|---|---|
| During the month | Record every document in `books/YYYY/MM/documents.json` (format below) | `npm run acc -- new-month 2026-10` |
| As invoices are raised | Issue e-invoices (if this system issues them) | `npm run acc -- issue 2026-10` |
| Any time | Check everything posts | `npm run acc -- validate 2026-10` |
| Month end (by day 5) | Add `bank-statement.json`, post accrual journals, run the close | `npm run acc -- close 2026-10` |
| Review | Read `close/close-pack.md`. Every check must be ✅ | |
| By the 10th | File and pay WHT for payments to non-residents | (pack §8) |
| By the 15th | Pay GOSI | (pack §9) |
| End of the month after the VAT period | File and pay VAT on the ZATCA portal using pack §7 | |
| After approval | Lock the month. It can never change silently again. | `npm run acc -- close 2026-10 --lock` |
| Year end | The December close trues up zakat to the annual computation | `npm run acc -- zakat 2026-12` |

`close` posts these month-end entries automatically:

- **Revenue recognition (IFRS 15):** a subscription line with a `servicePeriod`
  is booked to deferred revenue and released day by day over the period.
- **Prepaid expenses:** a bill line with a `servicePeriod` is amortised the same way.
- **Depreciation:** straight-line from the month after purchase, exact to the
  halala over the asset's life.
- **End-of-service benefits:** the provision is trued up each month to the
  Labour Law Art. 84 entitlement.
- **VAT settlement:** at each VAT period end, input and output VAT move to
  the ZATCA payable account. The return is reconciled to the ledger.
- **Zakat / income tax:** each month accrues its share of the annual
  estimate, and the year-end month trues it up.

The close pack contains: integrity checks; key figures; P&L (month and YTD);
balance sheet; cash flow (indirect); trial balance; VAT return in ZATCA box
layout; WHT return; payroll & GOSI register; AR/AP aging; deferral
roll-forward; fixed-asset register; zakat working; compliance calendar;
checklist; and the full journal. CSVs (UTF-8 with BOM, so Arabic opens
correctly in Excel) are written alongside it.

## Document reference

All amounts are SAR. Unit prices and bill amounts **exclude VAT**, because
the system computes VAT.

```jsonc
// Sales invoice. VAT is computed per ZATCA rules; servicePeriod spreads revenue.
{ "type": "sales_invoice", "id": "PGC-2026-000101", "date": "2026-10-05", "time": "10:15:00",
  "customer": "C001", "invoiceKind": "standard",            // "simplified" for B2C
  "lines": [
    { "description": "Enterprise plan — annual", "descriptionAr": "اشتراك سنوي", "quantity": 1, "unitPrice": 120000,
      "servicePeriod": { "start": "2026-10-01", "end": "2027-09-30" } },
    { "description": "Implementation", "quantity": 1, "unitPrice": 15000, "account": "4300", "discount": 500 },
    { "description": "Consulting for overseas client", "quantity": 1, "unitPrice": 20000,
      "vatTreatment": "export", "vatExemptionCode": "VATEX-SA-33", "vatExemptionReason": "Export of services" } ] }

// Credit / debit note. Must reference the original invoice and give a reason.
{ "type": "credit_note", "id": "PGC-CN-2026-000007", "date": "2026-10-14", "customer": "C002",
  "originalInvoice": "PGC-2026-000095", "reason": "SLA credit", "lines": [ { "description": "Service credit", "quantity": 1, "unitPrice": 1000 } ] }

// Supplier bill. Resident supplier → input VAT (box 7). Non-resident → reverse charge (box 9).
{ "type": "purchase_bill", "id": "BILL-2026-101", "supplierInvoiceNo": "INV-77812", "date": "2026-10-31", "supplier": "S001",
  "lines": [
    { "description": "Cloud hosting — October", "amount": 28000 },
    { "description": "Laptops", "amount": 22500, "capitalize": { "assetClass": "computers", "usefulLifeMonths": 36 } },
    { "description": "Annual licence", "amount": 9600, "servicePeriod": { "start": "2026-10-01", "end": "2027-09-30" } },
    { "description": "Client dinner", "amount": 1400, "account": "6990", "vatRecoverable": false } ],
  "paidFrom": "1140",              // optional: paid immediately by card/bank instead of via AP
  "whtBorneByPayer": true,         // non-resident paid in full: company bears the WHT (grossed up)
  "importCustomsVat": 0 }          // VAT paid at customs on imported goods (box 8)

{ "type": "receipt",  "id": "RCPT-2026-101", "date": "2026-10-08", "customer": "C001", "amount": 57500, "invoices": ["PGC-2026-000090"], "bankCharges": 0 }
{ "type": "payment",  "id": "PAY-2026-101",  "date": "2026-10-20", "supplier": "S001", "amount": 28000, "bills": ["BILL-2026-090"] }  // WHT withheld automatically for non-residents
{ "type": "payroll",  "id": "PAYROLL-2026-10", "month": "2026-10", "date": "2026-10-27", "paid": true,
  "adjustments": [ { "employee": "E002", "bonus": 2000, "deduction": 500, "unpaidDays": 2 } ] }
{ "type": "tax_payment", "id": "TAX-2026-101", "date": "2026-10-10", "tax": "wht", "amount": 4200, "reference": "SADAD 123" }  // vat | wht | gosi | zakat
{ "type": "transfer", "id": "TRF-2026-101", "date": "2026-10-30", "from": "1120", "to": "1140", "amount": 9600 }
{ "type": "journal",  "id": "JV-2026-101",  "date": "2026-10-31", "memo": "Accrue unbilled cloud usage",
  "lines": [ { "account": "5100", "debit": 1650 }, { "account": "2120", "credit": 1650 } ] }
```

Master-data fields are in `src/types.ts`, and `examples/demo-books/` has a
worked example of every file. Salary changes go in an employee's `changes`
list with an `effective` date. That way re-running a closed month never
picks up a later raise.

## Safeguards

- Every entry must balance and post to a real, non-heading account. Amounts
  are integer halalas, so there is no floating-point drift.
- Documents are validated before posting. The checks cover: duplicate IDs;
  dates outside the month; unknown customers or suppliers; zero-rated or
  exempt lines without a VATEX code; B2B invoices without a buyer VAT/CR
  number; credit notes without a reason; unbalanced journals.
- **Locking:** a locked month stores hashes of its documents and its derived
  journal. Any later change that would alter it is refused, and the
  correction has to go into an open month, as auditors expect.
- **E-invoice immutability:** once an invoice is issued (ICV and hash chain),
  changing its source is refused. You must issue a credit or debit note.
- The EGS private key and Fatoora credentials (`books/zatca/egs/`) are
  git-ignored.

## Further reading

- [`docs/KSA-COMPLIANCE.md`](docs/KSA-COMPLIANCE.md): every Saudi rule the engine applies, its parameters, and what still needs professional sign-off.
- [`docs/ZATCA-EINVOICING.md`](docs/ZATCA-EINVOICING.md): onboarding the EGS unit to Fatoora and going live.
