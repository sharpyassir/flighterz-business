// UBL 2.1 invoice XML in the ZATCA (KSA e-invoicing, Phase 2) profile.
//
// The XML is emitted on a single line with no inter-element whitespace and
// in canonical form (explicit end tags, sorted attributes, C14N escaping).
// That way removing UBLExtensions / cac:Signature / the QR reference — the
// transforms ZATCA applies before hashing — leaves no whitespace residue and
// the canonicalised result equals the "hashable" document we hash here.
import type { Company, CreditNoteDoc, Customer, SalesInvoiceDoc } from '../types.ts';
import type { ComputedInvoice } from '../tax.ts';
import { dec, toHalalas } from '../money.ts';

export const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
};

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}

/** Element builder. `children` strings are raw XML; use t() for text. */
export function el(name: string, attrs: Record<string, string> | null, ...children: (string | null | undefined | false)[]): string {
  const a = attrs
    ? Object.keys(attrs)
        .sort()
        .map((k) => ` ${k}="${escAttr(attrs[k])}"`)
        .join('')
    : '';
  return `<${name}${a}>${children.filter((c): c is string => typeof c === 'string').join('')}</${name}>`;
}
export const t = (name: string, text: string | number, attrs: Record<string, string> | null = null) => el(name, attrs, escText(String(text)));

const SAR = { currencyID: 'SAR' };
const amt = (name: string, h: number) => t(name, dec(h), SAR);

export interface InvoiceXmlInput {
  company: Company;
  customer: Customer;
  doc: SalesInvoiceDoc | CreditNoteDoc;
  calc: ComputedInvoice;
  uuid: string;
  icv: number;
  pih: string; // base64 previous invoice hash
}

export function typeCode(doc: SalesInvoiceDoc | CreditNoteDoc): string {
  return doc.type === 'credit_note' ? '381' : doc.type === 'debit_note' ? '383' : '388';
}

/** KSA-2 transaction type: 01 = standard (B2B), 02 = simplified (B2C); remaining flags 00000. */
export function subtype(doc: SalesInvoiceDoc | CreditNoteDoc): string {
  return (doc.invoiceKind ?? 'standard') === 'simplified' ? '0200000' : '0100000';
}

function address(a: Partial<Company['address']> | undefined, country: string): string {
  return el(
    'cac:PostalAddress',
    null,
    a?.street ? t('cbc:StreetName', a.street) : null,
    a?.buildingNumber ? t('cbc:BuildingNumber', a.buildingNumber) : null,
    a?.additionalNumber ? t('cbc:PlotIdentification', a.additionalNumber) : null,
    a?.district ? t('cbc:CitySubdivisionName', a.district) : null,
    a?.city ? t('cbc:CityName', a.city) : null,
    a?.postalCode ? t('cbc:PostalZone', a.postalCode) : null,
    el('cac:Country', null, t('cbc:IdentificationCode', country)),
  );
}

const vatScheme = el('cac:TaxScheme', null, t('cbc:ID', 'VAT'));

/** Body elements between the header and the parties, for both hashable and full XML. */
export function buildInvoiceXml(x: InvoiceXmlInput, parts: { extensions?: string; qr?: string; signature?: boolean } = {}): string {
  const { company: c, customer: cu, doc, calc } = x;
  const time = doc.time ?? '00:00:00';
  const isNote = doc.type !== 'sales_invoice';
  const simplified = (doc.invoiceKind ?? 'standard') === 'simplified';

  const supplier = el(
    'cac:AccountingSupplierParty',
    null,
    el(
      'cac:Party',
      null,
      el('cac:PartyIdentification', null, t('cbc:ID', c.crNumber, { schemeID: 'CRN' })),
      address(c.address, c.address.country),
      el('cac:PartyTaxScheme', null, t('cbc:CompanyID', c.vatNumber), vatScheme),
      el('cac:PartyLegalEntity', null, t('cbc:RegistrationName', c.legalNameAr || c.legalNameEn)),
    ),
  );
  const customer = el(
    'cac:AccountingCustomerParty',
    null,
    el(
      'cac:Party',
      null,
      !cu.vatNumber && cu.crNumber ? el('cac:PartyIdentification', null, t('cbc:ID', cu.crNumber, { schemeID: 'CRN' })) : null,
      address(cu.address, cu.country),
      el('cac:PartyTaxScheme', null, cu.vatNumber ? t('cbc:CompanyID', cu.vatNumber) : null, vatScheme),
      el('cac:PartyLegalEntity', null, t('cbc:RegistrationName', cu.nameAr || cu.name)),
    ),
  );

  const taxSubtotals = calc.categories.map((cat) =>
    el(
      'cac:TaxSubtotal',
      null,
      amt('cbc:TaxableAmount', cat.taxable),
      amt('cbc:TaxAmount', cat.vat),
      el(
        'cac:TaxCategory',
        null,
        t('cbc:ID', cat.code, { schemeAgencyID: '6', schemeID: 'UN/ECE 5305' }),
        t('cbc:Percent', (cat.rate * 100).toFixed(2)),
        cat.code !== 'S' && cat.exemptionCode ? t('cbc:TaxExemptionReasonCode', cat.exemptionCode) : null,
        cat.code !== 'S' && cat.exemptionReason ? t('cbc:TaxExemptionReason', cat.exemptionReason) : null,
        el('cac:TaxScheme', null, t('cbc:ID', 'VAT', { schemeAgencyID: '6', schemeID: 'UN/ECE 5153' })),
      ),
    ),
  );

  const lines = calc.lines.map((cl, i) => {
    const disc = toHalalas(cl.line.discount ?? 0);
    return el(
      'cac:InvoiceLine',
      null,
      t('cbc:ID', i + 1),
      t('cbc:InvoicedQuantity', cl.line.quantity.toFixed(6), { unitCode: 'PCE' }),
      amt('cbc:LineExtensionAmount', cl.net),
      disc
        ? el('cac:AllowanceCharge', null, t('cbc:ChargeIndicator', 'false'), t('cbc:AllowanceChargeReason', 'discount'), amt('cbc:Amount', disc))
        : null,
      el('cac:TaxTotal', null, amt('cbc:TaxAmount', cl.vat), amt('cbc:RoundingAmount', cl.net + cl.vat)),
      el(
        'cac:Item',
        null,
        t('cbc:Name', cl.line.descriptionAr ? `${cl.line.descriptionAr} / ${cl.line.description}` : cl.line.description),
        el(
          'cac:ClassifiedTaxCategory',
          null,
          t('cbc:ID', cl.treatment === 'standard' ? 'S' : cl.treatment === 'exempt' ? 'E' : cl.treatment === 'out_of_scope' ? 'O' : 'Z'),
          t('cbc:Percent', (cl.rate * 100).toFixed(2)),
          vatScheme,
        ),
      ),
      el('cac:Price', null, t('cbc:PriceAmount', cl.line.unitPrice.toFixed(2), SAR)),
    );
  });

  const supplyDate = doc.lines.find((l) => l.servicePeriod)?.servicePeriod?.start ?? doc.date;

  return el(
    'Invoice',
    { xmlns: NS.inv, 'xmlns:cac': NS.cac, 'xmlns:cbc': NS.cbc, 'xmlns:ext': NS.ext },
    parts.extensions,
    t('cbc:ProfileID', 'reporting:1.0'),
    t('cbc:ID', doc.id),
    t('cbc:UUID', x.uuid),
    t('cbc:IssueDate', doc.date),
    t('cbc:IssueTime', time),
    t('cbc:InvoiceTypeCode', typeCode(doc), { name: subtype(doc) }),
    doc.type === 'sales_invoice' && doc.notes ? t('cbc:Note', doc.notes, { languageID: 'ar' }) : null,
    t('cbc:DocumentCurrencyCode', 'SAR'),
    t('cbc:TaxCurrencyCode', 'SAR'),
    isNote ? el('cac:BillingReference', null, el('cac:InvoiceDocumentReference', null, t('cbc:ID', (doc as CreditNoteDoc).originalInvoice))) : null,
    el('cac:AdditionalDocumentReference', null, t('cbc:ID', 'ICV'), t('cbc:UUID', x.icv)),
    el(
      'cac:AdditionalDocumentReference',
      null,
      t('cbc:ID', 'PIH'),
      el('cac:Attachment', null, t('cbc:EmbeddedDocumentBinaryObject', x.pih, { mimeCode: 'text/plain' })),
    ),
    parts.qr
      ? el('cac:AdditionalDocumentReference', null, t('cbc:ID', 'QR'), el('cac:Attachment', null, t('cbc:EmbeddedDocumentBinaryObject', parts.qr, { mimeCode: 'text/plain' })))
      : null,
    parts.signature
      ? el('cac:Signature', null, t('cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice'), t('cbc:SignatureMethod', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'))
      : null,
    supplier,
    customer,
    !simplified || isNote ? el('cac:Delivery', null, t('cbc:ActualDeliveryDate', supplyDate)) : null,
    el(
      'cac:PaymentMeans',
      null,
      t('cbc:PaymentMeansCode', '30'),
      isNote ? t('cbc:InstructionNote', (doc as CreditNoteDoc).reason) : null,
    ),
    el('cac:TaxTotal', null, amt('cbc:TaxAmount', calc.vat)),
    el('cac:TaxTotal', null, amt('cbc:TaxAmount', calc.vat), ...taxSubtotals),
    el(
      'cac:LegalMonetaryTotal',
      null,
      amt('cbc:LineExtensionAmount', calc.net),
      amt('cbc:TaxExclusiveAmount', calc.net),
      amt('cbc:TaxInclusiveAmount', calc.total),
      amt('cbc:AllowanceTotalAmount', 0),
      amt('cbc:PrepaidAmount', 0),
      amt('cbc:PayableAmount', calc.total),
    ),
    ...lines,
  );
}
