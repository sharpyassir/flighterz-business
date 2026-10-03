// Hashing, ECDSA (secp256k1) signing and the TLV QR payload for ZATCA.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';

/** PIH for the very first invoice of an EGS unit: base64 of the hex SHA-256 of "0". */
export const FIRST_PIH = Buffer.from(createHash('sha256').update('0').digest('hex')).toString('base64');

/** Invoice hash = base64(SHA-256(canonical hashable XML)). */
export function invoiceHash(hashableXml: string): string {
  return createHash('sha256').update(hashableXml, 'utf8').digest('base64');
}

export function newEgsKey(): { privatePem: string; publicDer: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return {
    privatePem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
    publicDer: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

export function loadKey(pem: string): { priv: KeyObject; publicDer: Buffer } {
  const priv = createPrivateKey(pem);
  return { priv, publicDer: createPublicKey(priv).export({ type: 'spki', format: 'der' }) };
}

/** ECDSA-SHA256 signature (DER) over the invoice hash bytes, base64 — as the ZATCA SDK does. */
export function signHash(priv: KeyObject, hashB64: string): string {
  return sign('sha256', Buffer.from(hashB64, 'base64'), { key: priv, dsaEncoding: 'der' }).toString('base64');
}

export interface CertInfo {
  base64: string; // DER base64 (no PEM armour) — the CSID binarySecurityToken, decoded once
  issuer: string; // "CN=…, DC=…" as expected in X509IssuerName
  serialDecimal: string;
  /** Signature of the certificate by ZATCA's CA — QR tag 9 (simplified invoices). */
  signature: Buffer;
  digest: string; // base64 of hex SHA-256 of the base64 certificate (ZATCA convention)
}

export function parseCert(base64OrPem: string): CertInfo {
  const b64 = base64OrPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const x = new X509Certificate(Buffer.from(b64, 'base64'));
  const der = Buffer.from(b64, 'base64');
  return {
    base64: b64,
    issuer: x.issuer.split('\n').reverse().join(', '),
    serialDecimal: BigInt('0x' + x.serialNumber).toString(10),
    signature: certSignature(der),
    digest: Buffer.from(createHash('sha256').update(b64).digest('hex')).toString('base64'),
  };
}

/** Extract the signatureValue BIT STRING (last element of the outer SEQUENCE) from a DER certificate. */
function certSignature(der: Buffer): Buffer {
  const readLen = (i: number): [number, number] => {
    const b = der[i];
    if (b < 0x80) return [b, i + 1];
    const n = b & 0x7f;
    let len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | der[i + 1 + k];
    return [len, i + 1 + n];
  };
  let [, i] = readLen(1); // outer SEQUENCE content start
  for (let k = 0; k < 2; k++) {
    const [len, start] = readLen(i + 1); // tbsCertificate, signatureAlgorithm
    i = start + len;
  }
  const [len, start] = readLen(i + 1); // BIT STRING
  return der.subarray(start + 1, start + len); // skip unused-bits byte
}

// ───────────────────────── QR (TLV, base64) ─────────────────────────

export function tlv(fields: [number, string | Buffer][]): string {
  const parts: Buffer[] = [];
  for (const [tag, value] of fields) {
    const v = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    if (v.length > 255) throw new Error(`QR tag ${tag} value too long (${v.length} bytes)`);
    parts.push(Buffer.from([tag, v.length]), v);
  }
  return Buffer.concat(parts).toString('base64');
}

export function decodeTlv(b64: string): Map<number, Buffer> {
  const buf = Buffer.from(b64, 'base64');
  const m = new Map<number, Buffer>();
  for (let i = 0; i < buf.length; ) {
    const tag = buf[i];
    const len = buf[i + 1];
    m.set(tag, buf.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return m;
}
