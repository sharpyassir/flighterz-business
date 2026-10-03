// Minimal client for the ZATCA Fatoora e-invoicing API (v2).
// Not called automatically: onboarding needs an OTP from the Fatoora portal,
// and production submissions should only be made deliberately.
//   sandbox:    https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal
//   simulation: https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation
//   production: https://gw-fatoora.zatca.gov.sa/e-invoicing/core

export type FatooraEnv = 'sandbox' | 'simulation' | 'production';

const BASE: Record<FatooraEnv, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

export interface Credentials {
  binarySecurityToken: string;
  secret: string;
}

async function call(env: FatooraEnv, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(BASE[env] + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Version': 'V2', 'Accept-Language': 'en', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

const basic = (c: Credentials) => ({ Authorization: 'Basic ' + Buffer.from(`${c.binarySecurityToken}:${c.secret}`).toString('base64') });

/** Step 1 — compliance CSID from a CSR (base64) and the portal OTP. */
export function requestComplianceCsid(env: FatooraEnv, csrBase64: string, otp: string) {
  return call(env, '/compliance', { csr: csrBase64 }, { OTP: otp });
}

/** Step 2 — submit sample invoices for the compliance check. */
export function complianceCheck(env: FatooraEnv, c: Credentials, inv: { invoiceHash: string; uuid: string; xml: string }) {
  return call(env, '/compliance/invoices', { invoiceHash: inv.invoiceHash, uuid: inv.uuid, invoice: Buffer.from(inv.xml).toString('base64') }, basic(c));
}

/** Step 3 — exchange the compliance CSID for a production CSID. */
export function requestProductionCsid(env: FatooraEnv, c: Credentials, complianceRequestId: string) {
  return call(env, '/production/csids', { compliance_request_id: complianceRequestId }, basic(c));
}

/** Simplified (B2C) invoices — report within 24 hours of issue. */
export function reportInvoice(env: FatooraEnv, c: Credentials, inv: { invoiceHash: string; uuid: string; xml: string }) {
  return call(env, '/invoices/reporting/single', { invoiceHash: inv.invoiceHash, uuid: inv.uuid, invoice: Buffer.from(inv.xml).toString('base64') }, {
    ...basic(c),
    'Clearance-Status': '0',
  });
}

/** Standard (B2B) invoices — must be cleared before being shared with the buyer. */
export function clearInvoice(env: FatooraEnv, c: Credentials, inv: { invoiceHash: string; uuid: string; xml: string }) {
  return call(env, '/invoices/clearance/single', { invoiceHash: inv.invoiceHash, uuid: inv.uuid, invoice: Buffer.from(inv.xml).toString('base64') }, {
    ...basic(c),
    'Clearance-Status': '1',
  });
}
