// EGS onboarding: generates the CSR ZATCA expects (secp256k1, ZATCA extensions)
// using the system openssl, ready for the compliance-CSID request.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Books } from '../books.ts';
import { newEgsKey } from './crypto.ts';
import { loadRegistry } from './issue.ts';
import type { FatooraEnv } from './api.ts';

const TEMPLATE: Record<FatooraEnv, string> = {
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

export function generateCsr(b: Books, env: FatooraEnv, opts: { branch?: string; industry?: string; email?: string } = {}): { csrPath: string; csrBase64: string } {
  const dir = join(b.dir, 'zatca', 'egs');
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'private-key.pem');
  if (!existsSync(keyPath)) writeFileSync(keyPath, newEgsKey().privatePem, { mode: 0o600 });
  const c = b.company;
  const reg = loadRegistry(b);
  const a = c.address;
  const cnf = `oid_section = OIDs
[OIDs]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[req]
default_md = sha256
prompt = no
req_extensions = v3_req
distinguished_name = dn

[dn]
C = SA
OU = ${opts.branch ?? 'Main Branch'}
O = ${c.legalNameEn}
CN = ${reg.egs.name}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment
certificateTemplateName = ASN1:PRINTABLESTRING:${TEMPLATE[env]}
subjectAltName = dirName:alt_names

[alt_names]
SN = ${reg.egs.serial}
UID = ${c.vatNumber}
title = 1100
registeredAddress = ${a.buildingNumber} ${a.street}, ${a.district}, ${a.city} ${a.postalCode}
businessCategory = ${opts.industry ?? 'Cloud computing services'}
${opts.email ? `emailAddress = ${opts.email}\n` : ''}`;
  const cnfPath = join(dir, `csr-${env}.cnf`);
  const csrPath = join(dir, `csr-${env}.pem`);
  writeFileSync(cnfPath, cnf);
  execFileSync('openssl', ['req', '-new', '-sha256', '-key', keyPath, '-config', cnfPath, '-out', csrPath], { stdio: 'pipe' });
  return { csrPath, csrBase64: Buffer.from(readFileSync(csrPath, 'utf8')).toString('base64') };
}
