// Issues ZATCA e-invoices for the month's sales documents: assigns UUID and
// invoice counter (ICV), chains the previous invoice hash (PIH), signs,
// builds the QR, and writes XML + a printable bilingual HTML copy.
//
// Issued invoices are immutable: the registry stores a fingerprint of the
// source document and refuses to re-issue a changed one (issue a credit
// note instead, as ZATCA requires).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Books } from '../books.ts';
import { monthDir, readJson, writeJson } from '../books.ts';
import type { EngineState, IssuedInvoice } from '../posting.ts';
import { dec } from '../money.ts';
import { FIRST_PIH, type CertInfo, invoiceHash, loadKey, newEgsKey, parseCert, signHash, tlv } from './crypto.ts';
import { buildInvoiceXml, el, t } from './xml.ts';
import { renderInvoiceHtml } from './render.ts';

export interface RegistryEntry {
  id: string;
  type: string;
  kind: 'standard' | 'simplified';
  uuid: string;
  icv: number;
  pih: string;
  hash: string;
  issuedAt: string;
  fingerprint: string;
  signed: boolean;
  /** Fatoora status once submitted: reported (B2C) / cleared (B2B). */
  zatcaStatus: 'pending_submission' | 'reported' | 'cleared' | 'rejected';
  files: { xml: string; html: string };
}

export interface Registry {
  egs: { name: string; serial: string };
  lastIcv: number;
  lastHash: string;
  invoices: Record<string, RegistryEntry>;
}

function zatcaDir(b: Books) {
  return join(b.dir, 'zatca');
}

export function loadRegistry(b: Books): Registry {
  const p = join(zatcaDir(b), 'registry.json');
  if (existsSync(p)) return readJson<Registry>(p);
  return { egs: { name: 'Progrid-Accounting-EGS-1', serial: `1-Progrid|2-Accounting|3-${randomUUID()}` }, lastIcv: 0, lastHash: FIRST_PIH, invoices: {} };
}

function fingerprint(inv: IssuedInvoice): string {
  return createHash('sha256').update(JSON.stringify(inv.doc)).digest('hex');
}

function egsKey(b: Books) {
  const dir = join(zatcaDir(b), 'egs');
  const keyPath = join(dir, 'private-key.pem');
  if (!existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyPath, newEgsKey().privatePem, { mode: 0o600 });
  }
  const certPath = join(dir, 'certificate.pem');
  const cert: CertInfo | null = existsSync(certPath) ? parseCert(readFileSync(certPath, 'utf8')) : null;
  return { ...loadKey(readFileSync(keyPath, 'utf8')), cert };
}

function signedPropertiesXml(signingTime: string, cert: CertInfo): string {
  const ds = 'http://www.w3.org/2000/09/xmldsig#';
  return el(
    'xades:SignedProperties',
    { Id: 'xadesSignedProperties', 'xmlns:xades': 'http://uri.etsi.org/01903/v1.3.2#' },
    el(
      'xades:SignedSignatureProperties',
      null,
      t('xades:SigningTime', signingTime),
      el(
        'xades:SigningCertificate',
        null,
        el(
          'xades:Cert',
          null,
          el('xades:CertDigest', null, el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', 'xmlns:ds': ds }), t('ds:DigestValue', cert.digest, { 'xmlns:ds': ds })),
          el('xades:IssuerSerial', null, t('ds:X509IssuerName', cert.issuer, { 'xmlns:ds': ds }), t('ds:X509SerialNumber', cert.serialDecimal, { 'xmlns:ds': ds })),
        ),
      ),
    ),
  );
}

function ublExtensions(hash: string, signature: string, cert: CertInfo, signingTime: string): string {
  const sp = signedPropertiesXml(signingTime, cert);
  const spDigest = Buffer.from(createHash('sha256').update(sp).digest('hex')).toString('base64');
  const xpath = (expr: string) => el('ds:Transform', { Algorithm: 'http://www.w3.org/TR/1999/REC-xpath-19991116' }, t('ds:XPath', expr));
  const sha = el('ds:DigestMethod', { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  const sig = el(
    'ds:Signature',
    { Id: 'signature', 'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#' },
    el(
      'ds:SignedInfo',
      null,
      el('ds:CanonicalizationMethod', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
      el('ds:SignatureMethod', { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
      el(
        'ds:Reference',
        { Id: 'invoiceSignedData', URI: '' },
        el(
          'ds:Transforms',
          null,
          xpath('not(//ancestor-or-self::ext:UBLExtensions)'),
          xpath('not(//ancestor-or-self::cac:Signature)'),
          xpath("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
          el('ds:Transform', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
        ),
        sha,
        t('ds:DigestValue', hash),
      ),
      el('ds:Reference', { Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties', URI: '#xadesSignedProperties' }, sha, t('ds:DigestValue', spDigest)),
    ),
    t('ds:SignatureValue', signature),
    el('ds:KeyInfo', null, el('ds:X509Data', null, t('ds:X509Certificate', cert.base64))),
    el('ds:Object', null, el('xades:QualifyingProperties', { Target: 'signature', 'xmlns:xades': 'http://uri.etsi.org/01903/v1.3.2#' }, sp)),
  );
  return el(
    'ext:UBLExtensions',
    null,
    el(
      'ext:UBLExtension',
      null,
      t('ext:ExtensionURI', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'),
      el(
        'ext:ExtensionContent',
        null,
        el(
          'sig:UBLDocumentSignatures',
          {
            'xmlns:sac': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
            'xmlns:sbc': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
            'xmlns:sig': 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
          },
          el(
            'sac:SignatureInformation',
            null,
            t('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1'),
            t('sbc:ReferencedSignatureID', 'urn:oasis:names:specification:ubl:signature:Invoice'),
            sig,
          ),
        ),
      ),
    ),
  );
}

export interface IssueResult {
  issued: RegistryEntry[];
  skipped: string[];
}

/** Issue every not-yet-issued sales document of `period`, in date/time order. */
export async function issueInvoices(b: Books, s: EngineState, period: string, now = new Date()): Promise<IssueResult> {
  const reg = loadRegistry(b);
  const key = egsKey(b);
  const outDir = join(monthDir(b, period), 'invoices');
  mkdirSync(outDir, { recursive: true });
  const res: IssueResult = { issued: [], skipped: [] };
  const docs = [...s.invoices.values()]
    .filter((x) => x.doc.date.startsWith(period))
    .sort((a, b2) => `${a.doc.date}T${a.doc.time ?? '00:00:00'}`.localeCompare(`${b2.doc.date}T${b2.doc.time ?? '00:00:00'}`));

  for (const inv of docs) {
    const fp = fingerprint(inv);
    const existing = reg.invoices[inv.doc.id];
    if (existing) {
      if (existing.fingerprint !== fp)
        throw new Error(`${inv.doc.id} was already issued to ZATCA (ICV ${existing.icv}) and its source document has since changed. Issued invoices are immutable — revert the change and issue a credit/debit note.`);
      res.skipped.push(inv.doc.id);
      continue;
    }
    const customer = b.customers.get(inv.doc.customer)!;
    const icv = reg.lastIcv + 1;
    const uuid = randomUUID();
    const base = { company: b.company, customer, doc: inv.doc, calc: inv.calc, uuid, icv, pih: reg.lastHash };
    const hashable = buildInvoiceXml(base);
    const hash = invoiceHash(hashable);
    const signature = signHash(key.priv, hash);
    const timestamp = `${inv.doc.date}T${inv.doc.time ?? '00:00:00'}`;
    const simplified = (inv.doc.invoiceKind ?? 'standard') === 'simplified';
    const qrFields: [number, string | Buffer][] = [
      [1, b.company.legalNameAr || b.company.legalNameEn],
      [2, b.company.vatNumber],
      [3, timestamp],
      [4, dec(inv.calc.total)],
      [5, dec(inv.calc.vat)],
      [6, hash],
      [7, signature],
      [8, key.publicDer],
    ];
    if (simplified && key.cert) qrFields.push([9, key.cert.signature]);
    const qr = tlv(qrFields);
    const extensions = key.cert ? ublExtensions(hash, signature, key.cert, now.toISOString().slice(0, 19)) : undefined;
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + buildInvoiceXml(base, { extensions, qr, signature: !!key.cert });
    const xmlFile = join(outDir, `${inv.doc.id}.xml`);
    const htmlFile = join(outDir, `${inv.doc.id}.html`);
    writeFileSync(xmlFile, xml);
    writeFileSync(htmlFile, await renderInvoiceHtml(b, inv, { uuid, icv, qr, hash }));
    const entry: RegistryEntry = {
      id: inv.doc.id,
      type: inv.doc.type,
      kind: simplified ? 'simplified' : 'standard',
      uuid,
      icv,
      pih: reg.lastHash,
      hash,
      issuedAt: now.toISOString(),
      fingerprint: fp,
      signed: !!key.cert,
      zatcaStatus: 'pending_submission',
      files: { xml: xmlFile.slice(b.dir.length + 1), html: htmlFile.slice(b.dir.length + 1) },
    };
    reg.invoices[inv.doc.id] = entry;
    reg.lastIcv = icv;
    reg.lastHash = hash;
    res.issued.push(entry);
    writeJson(join(zatcaDir(b), 'registry.json'), reg); // persist after each invoice — the chain must never fork
  }
  return res;
}
