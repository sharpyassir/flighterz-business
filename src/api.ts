// API client — talks to the SAME Flighterz backend as the website and mobile
// apps (the /api/mobile/corporate/* endpoints, bearer-token auth). Override the
// base with VITE_API_BASE at build time to point at staging.
const BASE = (import.meta.env.VITE_API_BASE as string) || "https://www.flighterz.com/api/mobile";

export type Company = {
  name: string;
  nameAr: string;
  accountNo: string;
  contact: string;
  walletBalance: number;
  creditLimit: number;
  creditUsed: number;
  status: string;
};

export type LedgerEntry = {
  credit: number;
  debit: number;
  balance: number;
  descEn: string;
  descAr: string;
  kind: string;
  createdAt: string | null;
};

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  }
  return json as T;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error((json as { error?: string }).error || `HTTP ${res.status}`);
  }
  return json as T;
}

/** Step 1: email + password → emails a code, returns a short-lived OTP token. */
export const otpRequest = (email: string, password: string, locale: "en" | "ar" = "en") =>
  post<{ ok: true; otpToken: string }>("/corporate/otp/request", { email, password, locale });

/** Step 2: code + otpToken → corporate bearer token + company summary. */
export const otpVerify = (email: string, code: string, otpToken: string) =>
  post<{ ok: true; token: string; company: Company }>("/corporate/otp/verify", { email, code, otpToken });

/** Passwordless demo access (allowlisted emails only) → token + demo company. */
export const demoLogin = (email: string) =>
  post<{ ok: true; token: string; company: Company }>("/corporate/demo", { email });

export type FlightResult = {
  id: string;
  airlineCode: string;
  airlineEn: string;
  airlineAr: string;
  dep: string;
  arr: string;
  dayOffset: number;
  durationMins: number;
  stops: number;
  viaCode: string | null;
  refundable: boolean;
  seatsLeft: number;
  base: number;
  serviceCharge: number;
  total: number;
  currency: string;
};

/** In-app flight search (same engine as the website). */
export async function searchFlights(params: {
  from: string;
  to: string;
  depart?: string;
  returnDate?: string;
  adults?: number;
}): Promise<FlightResult[]> {
  const q = new URLSearchParams({ from: params.from, to: params.to, adults: String(params.adults ?? 1) });
  if (params.depart) q.set("depart", params.depart);
  if (params.returnDate) q.set("return", params.returnDate);
  const res = await fetch(`${BASE}/flights/search?${q.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as { ok?: boolean }).ok === false) throw new Error("search failed");
  return (json as { flights: FlightResult[] }).flights;
}

/** Signed-in company profile + recent wallet ledger. */
export const getAccount = (token: string) =>
  get<{ ok: true; company: Company; ledger: LedgerEntry[] }>("/corporate/account", token);

export const apiBase = BASE;
