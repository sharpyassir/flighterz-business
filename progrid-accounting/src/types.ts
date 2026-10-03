import type { Halalas } from './money.ts';

// ───────────────────────── Master data ─────────────────────────

export interface Company {
  legalNameEn: string;
  legalNameAr: string;
  vatNumber: string; // 15 digits, starts and ends with 3
  crNumber: string; // Commercial Registration
  address: {
    street: string;
    buildingNumber: string; // 4 digits (national address)
    additionalNumber?: string;
    district: string;
    city: string;
    postalCode: string; // 5 digits
    country: string; // ISO 3166-1 alpha-2, "SA"
  };
  fiscalYearStartMonth: number; // 1 = January
  vatFilingFrequency: 'monthly' | 'quarterly';
  /** Share of capital owned by Saudi/GCC persons (0–100). Drives Zakat vs CIT split. */
  saudiGccOwnershipPercent: number;
  invoicePrefix: string; // e.g. "PGC"
  /** If true, this system issues ZATCA e-invoices (XML + QR + hash chain). */
  issueZatcaInvoices: boolean;
  /** Postable bank/cash account used when a document does not name one. */
  defaultBankAccount: string;
  booksStartDate: string; // YYYY-MM-DD — first day of the books
}

export type VatTreatment =
  | 'standard' // S — 15 %
  | 'zero_domestic' // Z — zero-rated domestic supply
  | 'export' // Z — export of goods/services
  | 'exempt' // E
  | 'out_of_scope'; // O

export interface Customer {
  id: string;
  name: string;
  nameAr?: string;
  vatNumber?: string;
  crNumber?: string;
  country: string; // ISO alpha-2
  address?: Partial<Company['address']>;
  /** Default VAT treatment for supplies to this customer. */
  vatTreatment?: VatTreatment;
  paymentTermsDays?: number;
}

export type WhtCategory =
  | 'rent'
  | 'airline_freight'
  | 'telecom_international'
  | 'dividends'
  | 'loan_returns'
  | 'insurance'
  | 'technical_consulting'
  | 'royalties'
  | 'related_party_services'
  | 'other_services'
  | 'management_fees';

export interface Supplier {
  id: string;
  name: string;
  vatNumber?: string;
  country: string;
  /** Non-resident with no KSA VAT registration → reverse-charge VAT + WHT applies. */
  resident: boolean;
  defaultAccount?: string;
  whtCategory?: WhtCategory;
  paymentTermsDays?: number;
}

export interface Employee {
  id: string;
  name: string;
  nationality: 'saudi' | 'non_saudi';
  /** GOSI regime for Saudis: 'legacy' = registered before 3 Jul 2024, 'new_2024' = first registered on/after. */
  gosiRegime?: 'legacy' | 'new_2024';
  joinDate: string; // YYYY-MM-DD
  leaveDate?: string;
  basic: number; // SAR / month
  housing: number;
  transport: number;
  otherAllowances?: number;
  costCenter?: string;
  department?: 'cost_of_revenue' | 'operations';
  /** Effective-dated pay changes, so re-running a closed month never picks up a later raise. */
  changes?: ({ effective: string } & Partial<Pick<Employee, 'basic' | 'housing' | 'transport' | 'otherAllowances' | 'department'>>)[];
}

// ───────────────────────── Accounts ─────────────────────────

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface Account {
  code: string;
  nameEn: string;
  nameAr: string;
  type: AccountType;
  /** Balance-sheet / P&L grouping used by the statements. */
  group: string;
  current?: boolean; // for assets/liabilities
  contra?: boolean;
  header?: boolean; // non-postable heading
  /** Marks special-purpose accounts the engine posts to automatically. */
  role?: string;
}

// ───────────────────────── Source documents ─────────────────────────

export interface ServicePeriod {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

export interface SalesLine {
  description: string;
  descriptionAr?: string;
  quantity: number;
  unitPrice: number; // SAR, excl. VAT
  discount?: number; // SAR, line-level allowance
  account?: string; // revenue account, default 4100
  vatTreatment?: VatTreatment;
  vatExemptionCode?: string; // e.g. VATEX-SA-33 for export of services
  vatExemptionReason?: string;
  servicePeriod?: ServicePeriod; // spreads revenue (IFRS 15) if it extends past the month
}

export interface SalesInvoiceDoc {
  type: 'sales_invoice';
  id: string; // invoice number, e.g. PGC-2026-000001
  date: string;
  time?: string; // HH:MM:SS (Riyadh)
  customer: string; // customer id
  /** 'standard' = B2B tax invoice (clearance), 'simplified' = B2C (reporting). */
  invoiceKind?: 'standard' | 'simplified';
  currency?: 'SAR';
  dueDate?: string;
  lines: SalesLine[];
  notes?: string;
}

export interface CreditNoteDoc {
  type: 'credit_note' | 'debit_note';
  id: string;
  date: string;
  time?: string;
  customer: string;
  originalInvoice: string;
  reason: string; // mandatory per ZATCA (KSA-10)
  invoiceKind?: 'standard' | 'simplified';
  lines: SalesLine[];
}

export interface PurchaseLine {
  description: string;
  amount: number; // SAR, excl. VAT
  account?: string;
  /** VAT charged by the supplier on this line, if it differs from 15 % of amount. */
  vat?: number;
  vatTreatment?: 'standard' | 'zero' | 'exempt' | 'out_of_scope';
  /** Blocked input VAT (entertainment, personal-use cars, …) — expensed instead. */
  vatRecoverable?: boolean;
  servicePeriod?: ServicePeriod; // prepayment spread
  capitalize?: { assetClass: string; usefulLifeMonths: number; assetId?: string };
}

export interface PurchaseBillDoc {
  type: 'purchase_bill';
  id: string;
  supplierInvoiceNo: string;
  date: string;
  supplier: string;
  dueDate?: string;
  /** Imported goods: VAT paid to customs (ZATCA box 8). */
  importCustomsVat?: number;
  lines: PurchaseLine[];
  /** Paid immediately (card / bank) instead of going through AP. */
  paidFrom?: string;
  /** For non-resident suppliers paid in full (e.g. card): company bears the WHT. */
  whtBorneByPayer?: boolean;
  whtCategory?: WhtCategory;
}

export interface ReceiptDoc {
  type: 'receipt';
  id: string;
  date: string;
  customer: string;
  amount: number;
  bankAccount?: string;
  invoices?: string[];
  bankCharges?: number;
}

export interface PaymentDoc {
  type: 'payment';
  id: string;
  date: string;
  supplier: string;
  amount: number; // gross amount settled against the supplier balance
  bankAccount?: string;
  bills?: string[];
  /** Non-resident supplier: withhold this category from the payment. */
  whtCategory?: WhtCategory;
  bankCharges?: number;
}

export interface PayrollDoc {
  type: 'payroll';
  id: string;
  month: string; // YYYY-MM
  date: string; // date salaries were paid (or accrued)
  paid: boolean;
  bankAccount?: string;
  /** Per-employee overrides for the month; default = master data. */
  adjustments?: { employee: string; bonus?: number; deduction?: number; unpaidDays?: number }[];
}

export interface TaxPaymentDoc {
  type: 'tax_payment';
  id: string;
  date: string;
  tax: 'vat' | 'wht' | 'gosi' | 'zakat';
  amount: number;
  bankAccount?: string;
  reference?: string; // SADAD bill number
}

export interface TransferDoc {
  type: 'transfer';
  id: string;
  date: string;
  from: string;
  to: string;
  amount: number;
  memo?: string;
}

export interface JournalDoc {
  type: 'journal';
  id: string;
  date: string;
  memo: string;
  lines: { account: string; debit?: number; credit?: number; memo?: string; party?: string }[];
}

export type SourceDoc =
  | SalesInvoiceDoc
  | CreditNoteDoc
  | PurchaseBillDoc
  | ReceiptDoc
  | PaymentDoc
  | PayrollDoc
  | TaxPaymentDoc
  | TransferDoc
  | JournalDoc;

// ───────────────────────── Ledger ─────────────────────────

export interface JournalLine {
  account: string;
  debit: Halalas;
  credit: Halalas;
  memo?: string;
  party?: string; // customer / supplier / employee id (sub-ledger)
  /** Tax tagging so the VAT/WHT returns are driven straight from the ledger. */
  tax?: TaxTag;
}

export interface TaxTag {
  kind: 'vat_out' | 'vat_in' | 'wht';
  /** ZATCA VAT return box (1,3,4,5,7,8,9,10,11) or WHT category. */
  box?: number;
  whtCategory?: WhtCategory;
  base: Halalas; // taxable amount this tax line relates to (signed)
  tax: Halalas;
  /** Credit/debit notes go to the "adjustments" column of the VAT return. */
  adjustment?: boolean;
  /** Document reference, for the tax return working papers. */
  ref?: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  period: string; // YYYY-MM
  source: string; // document id or "auto:<step>"
  sourceType: string;
  memo: string;
  lines: JournalLine[];
}

export interface Balance {
  debit: Halalas;
  credit: Halalas;
}
