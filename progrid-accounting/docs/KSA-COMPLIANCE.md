# Saudi compliance rules implemented

Parameters live in `config/tax-rules.json`. Rates change, so check them
against the official ZATCA, GOSI and MHRSD sources at least yearly and
before every annual close. The items under **"Needs professional sign-off"**
are deliberate simplifications. A licensed Saudi accountant or zakat adviser
should review them before any return is filed.

## Accounting framework

- **IFRS as endorsed by SOCPA**, which is mandatory for Saudi companies. The
  chart of accounts (`config/chart-of-accounts.json`) is bilingual and grouped
  for IFRS presentation. Statements are bilingual (Arabic/English) in SAR.
- **Revenue (IFRS 15):** subscription revenue is recognised over the service
  period, pro-rata by day. Amounts billed in advance sit in *contract
  liabilities* (deferred revenue).
- **Employee benefits (IAS 19):** the EOSB provision is formula-based (see
  below). For the audited year end, get an actuarial (projected unit credit)
  valuation and post the difference as a journal.
- **Records:** books are re-derivable from documents, closed months are
  locked, and e-invoices are kept with their hash chain. Keep the repository
  and the source PDFs for the statutory retention period. That is at least
  10 years for commercial books under the Law of Commercial Books (2023) and
  at least 6 years for VAT records. Confirm the periods that apply to
  Progrid with your adviser.

## VAT

| Rule | Implementation |
|---|---|
| Standard rate 15 % | `vat.standardRate` |
| Categories S / Z / E / O | `vatTreatment`: standard, zero_domestic, export, exempt, out_of_scope. Z/E/O lines require a `VATEX-SA-…` code (e.g. `VATEX-SA-33` export of services, `VATEX-SA-32` export of goods, `VATEX-SA-29` financial services, `VATEX-SA-OOS`). |
| Rounding | VAT is computed per category on the invoice total (BR-CO-17). Line VAT is shown for information. |
| Tax point | Output VAT is recognised on the invoice date, even when the revenue is deferred. |
| Credit/debit notes | Must reference the original invoice and give a reason. They report in the *adjustments* column. |
| Input VAT | Recoverable from VAT-registered resident suppliers (box 7). Flag blocked items (entertainment, hospitality, personal-use cars, etc.) with `"vatRecoverable": false` and the VAT is expensed. |
| Imported services | Non-resident supplier → **reverse charge**. The VAT is self-assessed as output (2215) and claimed as input (1415), both reported in box 9. The ZATCA portal adds box-9 VAT to the output side, so the net cost is nil when it is fully recoverable. |
| Imported goods | Customs VAT is entered as `importCustomsVat` (box 8). |
| Return | The ZATCA layout (boxes 1–16) is built from tax tags on the journal lines and reconciled to the ledger settlement entry. A difference fails the close. Quarterly filing (calendar quarters) applies if annual taxable supplies are ≤ SAR 40 m, otherwise monthly. The return is due by the last day of the month after the period. |
| Corrections | Errors within the ±SAR 5,000 threshold can go in box 14 of the next return. Larger errors need a voluntary disclosure on the portal. |

## Withholding tax (non-residents)

Income Tax Law Art. 68 and Implementing Regulations Art. 63. WHT applies when
a non-resident is **paid**. It is withheld automatically on `payment`
documents to non-resident suppliers, and on bills paid immediately
(`paidFrom`).

| Category | Rate |
|---|---|
| Rent, airline tickets/freight, international telecoms, dividends, loan returns, insurance, technical & consulting services | 5 % |
| Royalties, services to head office/related parties, other services | 15 % |
| Management fees | 20 % |

If the supplier must receive the full amount (e.g. charged to a card),
set `whtBorneByPayer`. The tax is then grossed up (`net × r / (1 − r)`) and
expensed. The return and payment are due by the **10th** of the following
month (pack §8).

> **Needs professional sign-off:** the WHT category of cloud/SaaS fees
> (IaaS hosting, software licences) is a judgement call. ZATCA has treated
> some software payments as royalties (15 %). Agree the category for each
> major supplier with your tax adviser and set it on the supplier record.
> Also check whether a supplier is **registered for KSA VAT** (many global
> cloud providers are). If so, mark it `resident: true` with its VAT number,
> and no reverse charge applies. Double tax treaties may also reduce WHT;
> treaty relief needs the supplier's residency certificate.

## GOSI (social insurance)

The contribution base is basic + housing, capped at SAR 45,000. For Saudis
there is a SAR 1,500 floor.

| | Employer | Employee |
|---|---|---|
| Saudi, registered before 3 Jul 2024 | 9 % annuity + 0.75 % SANED + 2 % occupational hazards = **11.75 %** | 9 % + 0.75 % = **9.75 %** |
| Saudi, first registered on/after 3 Jul 2024 (`gosiRegime: "new_2024"`) | annuity per schedule + 0.75 % + 2 % | annuity per schedule + 0.75 % |
| Non-Saudi | 2 % occupational hazards | – |

Under the new Social Insurance Law, the annuity rate for new registrants
rises by 0.5 % a side each July from 2025 until it reaches 11 % in 2028
(`newRegimeAnnuitySchedule`). Contributions are due by the **15th** of the
following month. Salaries are paid through WPS (Mudad).

## End-of-service benefits (Labour Law Art. 84)

Each month the provision is trued up to the termination-basis entitlement:
half a month's wage for each of the first five years, then one month's wage
per year. The wage is basic + housing + transport, configurable in
`eosb.wageComponents`. Payouts are booked as a journal debiting 2610.
Resignation reductions (Art. 85) are not applied, which is the prudent
accounting basis.

## Zakat and income tax

The estimate follows the Zakat Implementing Regulations for fiscal years
starting on or after 1 Jan 2024. The zakat base is built as:

- **Plus:** capital, reserves and shareholder current account; retained
  earnings at the start of the year; adjusted net profit (provisions charged
  are added back, EOSB paid is deducted); provisions at the start of the year
  less amounts used; non-current liabilities.
- **Minus:** net property and equipment, net intangibles, and net
  right-of-use assets.
- **Minimum:** if the base is below adjusted net profit, adjusted net profit
  is the base. The base is floored at zero.

The rate is 2.5 % for a Hijri year, pro-rated to the Gregorian year
(× 365/354 ≈ 2.5777 %), and applied to the Saudi/GCC ownership share. The
non-GCC share pays 20 % income tax on adjusted profit. The monthly accrual
is the annual estimate × months elapsed / 12, trued up in the last month of
the year. The return is due within **120 days** of year end, with audited
financial statements.

> **Needs professional sign-off:** this is a planning estimate and leaves
> out several adjustments: long-term investments, related-party balances
> held for a full year, other deductible assets, the timing of capital
> changes, and tax-depreciation differences for CIT. The filed zakat return
> must be prepared or reviewed by a licensed adviser.

## Not automated (post as journals)

- Unbilled supplier costs (cloud usage invoiced after month end) and other accruals
- Expected credit losses (review the aging in pack §10)
- Asset disposals and impairment
- IFRS 16 leases. The rent example is a short-term lease, expensed. Leases
  over 12 months need right-of-use and lease-liability entries (accounts
  1710/1715/2620 exist).
- Foreign-currency revaluation. Enter foreign invoices at their SAR value on
  the invoice date. The SAR–USD peg makes USD differences small, but post
  any FX difference on settlement to 4910/6810.
- Accrued leave and tickets (account 2330)
