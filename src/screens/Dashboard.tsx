import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import type { Company, LedgerEntry } from "../api";

const NAVY = "#0d2138";
const GOLD = "#d4a537";
const GREEN = "#15803d";
const SLATE = "#94a3b8";

const sar = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })} SAR`;

export function Dashboard({ company, ledger }: { company: Company; ledger: LedgerEntry[] }) {
  // Monthly spend from the wallet ledger (debits = travel spend).
  const byMonth = new Map<string, number>();
  for (const e of ledger) {
    if (!e.createdAt || !e.debit) continue;
    const m = e.createdAt.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + e.debit);
  }
  const spend = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([m, v]) => ({ month: m.slice(5), spend: Math.round(v) }));

  // Running balance line.
  const balance = ledger
    .filter((e) => e.createdAt)
    .slice(0, 12)
    .reverse()
    .map((e, i) => ({ i: i + 1, balance: Math.round(e.balance) }));

  const creditData = [
    { name: "Used", value: Math.max(0, company.creditUsed) },
    { name: "Available", value: Math.max(0, company.creditLimit - company.creditUsed) },
  ];
  const empty = ledger.length === 0;

  return (
    <>
      <div className="cards">
        <Kpi k="Wallet balance" v={sar(company.walletBalance)} />
        <Kpi k="Credit limit" v={sar(company.creditLimit)} />
        <Kpi k="Credit used" v={sar(company.creditUsed)} />
        <Kpi k="Account status" v={company.status} badge />
      </div>

      {empty ? (
        <div className="panel">
          <h2>Analytics</h2>
          <p className="small">
            Charts populate from your live account activity. Once your company starts booking, monthly
            spend, credit utilisation and balance trends appear here in real time.
          </p>
        </div>
      ) : (
        <div className="row" style={{ alignItems: "stretch" }}>
          <div className="panel" style={{ flex: 2, minWidth: 320 }}>
            <h2>Monthly travel spend</h2>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={spend}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f5" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => sar(v)} />
                <Bar dataKey="spend" fill={NAVY} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="panel" style={{ flex: 1, minWidth: 240 }}>
            <h2>Credit utilisation</h2>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={creditData} dataKey="value" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  <Cell fill={GOLD} />
                  <Cell fill="#e2e8f0" />
                </Pie>
                <Tooltip formatter={(v: number) => sar(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {balance.length > 1 && (
        <div className="panel">
          <h2>Wallet balance trend</h2>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={balance}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eef1f5" />
              <XAxis dataKey="i" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => sar(v)} />
              <Line type="monotone" dataKey="balance" stroke={GREEN} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="panel">
        <h2>Recent account activity</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Debit</th>
              <th>Credit</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            {ledger.slice(0, 10).map((e, i) => (
              <tr key={i}>
                <td>{e.createdAt?.slice(0, 10) ?? "—"}</td>
                <td>{e.descEn || e.kind}</td>
                <td>{e.debit ? sar(e.debit) : "—"}</td>
                <td style={{ color: GREEN }}>{e.credit ? sar(e.credit) : "—"}</td>
                <td>{sar(e.balance)}</td>
              </tr>
            ))}
            {ledger.length === 0 && (
              <tr>
                <td colSpan={5} className="small" style={{ textAlign: "center", padding: 20 }}>
                  No activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small" style={{ color: SLATE }}>
        Analytics are read live from your Flighterz corporate account — the same data as the web portal.
      </p>
    </>
  );
}

function Kpi({ k, v, badge }: { k: string; v: string; badge?: boolean }) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className="v">{badge ? <span className="tag-ok">{v}</span> : v}</div>
    </div>
  );
}
