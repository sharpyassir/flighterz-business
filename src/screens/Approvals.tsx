import { useEffect, useState } from "react";

/**
 * Travel-approval POLICIES. Note: bookings are never held. A policy defines the
 * conditions under which a trip needs sign-off — day/time window, route
 * (from → to), and whether a reason ("why") is required — and which approver in
 * the employee tree owns it. Stored locally for now; syncs to the account once
 * the corporate-policy API (Phase 2) is live.
 */
type Rule = {
  id: string;
  name: string;
  days: string[]; // Sun..Sat
  timeFrom: string;
  timeTo: string;
  origin: string;
  destination: string;
  reasonRequired: boolean;
  approver: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const KEY = "flz_biz_policies";

const blank = (): Rule => ({
  id: crypto.randomUUID(),
  name: "",
  days: [],
  timeFrom: "",
  timeTo: "",
  origin: "",
  destination: "",
  reasonRequired: true,
  approver: "",
});

export function Approvals() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<Rule>(blank());

  useEffect(() => {
    try {
      const s = localStorage.getItem(KEY);
      if (s) setRules(JSON.parse(s));
    } catch {
      /* ignore */
    }
  }, []);
  const persist = (next: Rule[]) => {
    setRules(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const toggleDay = (d: string) =>
    setDraft((r) => ({ ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d] }));

  const add = () => {
    if (!draft.name.trim()) return;
    persist([...rules, draft]);
    setDraft(blank());
  };
  const remove = (id: string) => persist(rules.filter((r) => r.id !== id));

  return (
    <>
      <div className="panel">
        <h2>New approval policy</h2>
        <div className="form-grid">
          <label>
            <span>Policy name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Weekend / long-haul" />
          </label>
          <label>
            <span>From (IATA / *)</span>
            <input value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value.toUpperCase() })} placeholder="RUH or *" />
          </label>
          <label>
            <span>To (IATA / *)</span>
            <input value={draft.destination} onChange={(e) => setDraft({ ...draft, destination: e.target.value.toUpperCase() })} placeholder="LHR or *" />
          </label>
          <label>
            <span>Time from</span>
            <input type="time" value={draft.timeFrom} onChange={(e) => setDraft({ ...draft, timeFrom: e.target.value })} />
          </label>
          <label>
            <span>Time to</span>
            <input type="time" value={draft.timeTo} onChange={(e) => setDraft({ ...draft, timeTo: e.target.value })} />
          </label>
          <label>
            <span>Approver (email)</span>
            <input value={draft.approver} onChange={(e) => setDraft({ ...draft, approver: e.target.value })} placeholder="manager@company.com" />
          </label>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
          <div>
            <div className="small" style={{ marginBottom: 4 }}>Applies on days</div>
            <div className="row">
              {DAYS.map((d) => (
                <button
                  key={d}
                  className="pill-btn"
                  style={draft.days.includes(d) ? { background: "#0d2138", color: "#fff", borderColor: "#0d2138" } : {}}
                  onClick={() => toggleDay(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18 }}>
            <input type="checkbox" checked={draft.reasonRequired} onChange={(e) => setDraft({ ...draft, reasonRequired: e.target.checked })} />
            <span className="small">Require a reason (&quot;why&quot;)</span>
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="pill-btn primary" onClick={add}>
            Add policy
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Policies ({rules.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Route</th>
              <th>Days</th>
              <th>Time</th>
              <th>Reason</th>
              <th>Approver</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  {(r.origin || "*")} → {(r.destination || "*")}
                </td>
                <td>{r.days.length ? r.days.join(", ") : "Any"}</td>
                <td>{r.timeFrom || r.timeTo ? `${r.timeFrom || "00:00"}–${r.timeTo || "23:59"}` : "Any"}</td>
                <td>{r.reasonRequired ? "Required" : "—"}</td>
                <td>{r.approver || "—"}</td>
                <td>
                  <button className="pill-btn" onClick={() => remove(r.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={7} className="small" style={{ textAlign: "center", padding: 18 }}>
                  No policies yet. A trip that matches a policy asks the traveller for a reason and notifies the
                  approver — the booking is never blocked.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
