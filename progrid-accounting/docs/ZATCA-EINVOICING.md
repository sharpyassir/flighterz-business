# ZATCA e-invoicing (Fatoora): Phase 2

When `company.issueZatcaInvoices` is `true`, `npm run acc -- issue YYYY-MM`
does the following for each new sales invoice, credit note and debit note,
in date/time order:

1. Assigns a **UUID** and the next **invoice counter value (ICV)**.
2. Chains the **previous invoice hash (PIH)**. The first invoice uses the
   ZATCA-defined seed (base64 of SHA-256 of `"0"`).
3. Builds the **UBL 2.1 XML** in the ZATCA profile. That covers the document
   type (388 invoice / 381 credit / 383 debit) and subtype (`0100000`
   standard B2B, `0200000` simplified B2C), seller/buyer parties, per-category
   tax subtotals with VATEX codes, totals, lines, the billing reference and
   reason for notes, and the supply date.
4. Computes the **invoice hash**: SHA-256 of the document without
   UBLExtensions, `cac:Signature` and the QR reference. The XML is emitted
   in canonical single-line form, so this matches the transform ZATCA
   applies.
5. **Signs** the hash with the EGS unit's ECDSA secp256k1 key.
6. Builds the **TLV QR code**: seller name, VAT number, timestamp, total,
   VAT, hash, signature, public key, plus the CA signature for simplified
   invoices once a CSID certificate exists.
7. Writes `books/YYYY/MM/invoices/<id>.xml` and a printable bilingual
   `<id>.html` that shows the QR code.
8. Records everything in `books/zatca/registry.json`. Issued invoices are
   **immutable**: corrections are made by credit or debit note.

## Going live (one-time onboarding)

1. **Confirm the obligation.** Check Progrid's integration wave notification
   from ZATCA, which states the date Phase 2 applies. Until that date, Phase 1
   (generation only, QR tags 1–5) is enough. Many companies use a licensed
   e-invoicing provider instead. If so, keep `issueZatcaInvoices: false` and
   record the provider's invoices as `sales_invoice` documents with the same
   numbers.
2. **Fill in `books/company.json`.** Use the legal Arabic name, VAT number, CR
   and national address. These go into every invoice.
3. **Generate the CSR:** `npm run acc -- onboard sandbox --branch "Riyadh HQ" --email finance@…`.
   This writes `books/zatca/egs/csr-sandbox.pem`, using secp256k1 and the
   ZATCA certificate-template extension, with SN, UID (VAT number), title
   `1100` (standard + simplified), registered address and business category.
4. **Get an OTP.** Log in to the Fatoora portal (fatoora.zatca.gov.sa) and
   use "Onboard new solution unit/device" to generate an OTP.
5. **Request the compliance CSID** with `requestComplianceCsid()` in
   `src/zatca/api.ts`, passing the base64 CSR and the OTP. Save the returned
   `binarySecurityToken` and `secret` in
   `books/zatca/egs/credentials-<env>.json`, and the decoded certificate as
   `books/zatca/egs/certificate.pem`. From then on, invoices are fully
   XAdES-signed and QR tag 9 is added.
6. **Run the compliance checks.** Submit one of each document type you will
   issue (standard and simplified invoice, credit note and debit note) with
   `complianceCheck()`.
7. **Request the production CSID** with `requestProductionCsid()`. Then
   replace the credentials and certificate with the production ones.
8. **Validate before go-live.** Run generated XML through the official
   **ZATCA SDK** (`fatoora -validate -invoice <file>`, available from the
   ZATCA developer portal) and fix anything it reports. The signature block
   (XAdES signed properties, certificate digest conventions) is implemented
   to the published specification but has **not yet been validated against
   the SDK in this repository**. Treat this step as mandatory.
9. **Submit continuously:** `npm run acc -- submit YYYY-MM <env> --yes`.
   Standard (B2B) invoices go to **clearance**, and must be cleared before
   they are given to the buyer. Simplified (B2C) invoices go to
   **reporting** within 24 hours. Responses are stored in
   `books/zatca/responses/`.

## Security

- `books/zatca/egs/` (private key, credentials, CSRs) is **git-ignored**.
  Back it up somewhere secure. If the key is lost, a new EGS unit has to be
  onboarded.
- `registry.json` must never be edited by hand. The hash chain must not
  fork, so never issue invoices from two copies of the books at once.
