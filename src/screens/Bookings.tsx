import { useState } from "react";
import { searchFlights, type FlightResult, type Company } from "../api";

const WA = "966580028428";

const dur = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;
const sar = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SAR`;

/**
 * In-app corporate flight search — same engine as the website (no browser
 * hand-off). Booking settles against the company wallet/credit; completing a
 * paid booking is enabled at launch (payments gated), so Select routes the
 * request to our team for now.
 */
export function Bookings({ company }: { company: Company }) {
  const [from, setFrom] = useState("RUH");
  const [to, setTo] = useState("JED");
  const [depart, setDepart] = useState("");
  const [adults, setAdults] = useState(1);
  const [results, setResults] = useState<FlightResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<FlightResult | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      const r = await searchFlights({ from, to, depart: depart || undefined, adults });
      setResults(r);
    } catch {
      setError("Search failed. Please check the route codes and try again.");
    } finally {
      setBusy(false);
    }
  };

  const requestBooking = (f: FlightResult) => {
    const msg = encodeURIComponent(
      `Corporate booking request — ${company.name} (${company.accountNo})\n` +
        `${from} → ${to}${depart ? " on " + depart : ""}, ${adults} traveller(s)\n` +
        `${f.airlineEn} ${f.dep}-${f.arr}, total ${sar(f.total)}`,
    );
    window.open(`https://wa.me/${WA}?text=${msg}`, "_blank");
  };

  return (
    <>
      <div className="panel">
        <h2>Search flights</h2>
        <div className="form-grid">
          <label>
            <span>From (IATA)</span>
            <input value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} maxLength={3} />
          </label>
          <label>
            <span>To (IATA)</span>
            <input value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} maxLength={3} />
          </label>
          <label>
            <span>Departure</span>
            <input type="date" value={depart} onChange={(e) => setDepart(e.target.value)} />
          </label>
          <label>
            <span>Travellers</span>
            <input type="number" min={1} max={9} value={adults} onChange={(e) => setAdults(Number(e.target.value))} />
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="pill-btn primary" onClick={run} disabled={busy}>
            {busy ? "Searching…" : "Search flights"}
          </button>
        </div>
        {error && <p className="small" style={{ color: "#b91c1c", marginTop: 10 }}>{error}</p>}
      </div>

      {results && (
        <div className="panel">
          <h2>
            {results.length} result{results.length === 1 ? "" : "s"} · {from} → {to}
          </h2>
          {results.length === 0 && <p className="small">No flights found for this route.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {results.map((f) => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "12px 14px",
                }}
              >
                <div style={{ width: 140, fontWeight: 800, color: "var(--navy)" }}>{f.airlineEn}</div>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>{f.dep}</div>
                  <div style={{ flex: 1, textAlign: "center" }} className="small">
                    {dur(f.durationMins)} · {f.stops === 0 ? "Direct" : `${f.stops} stop · ${f.viaCode ?? ""}`}
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>
                    {f.arr}
                    {f.dayOffset > 0 ? <sup style={{ color: "#e11d48", fontSize: 10 }}>+{f.dayOffset}</sup> : null}
                  </div>
                </div>
                <div style={{ textAlign: "right", minWidth: 120 }}>
                  <div style={{ fontWeight: 800, fontSize: 16, color: "var(--navy)" }}>{sar(f.total)}</div>
                  <div className="small">{f.refundable ? "Refundable" : "Non-refundable"} · {f.seatsLeft} left</div>
                </div>
                <button className="pill-btn primary" onClick={() => setPicked(f)}>
                  Select
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {picked && (
        <div className="panel" style={{ borderColor: "var(--gold)" }}>
          <h2>Confirm booking</h2>
          <p className="small">
            {picked.airlineEn} · {from} → {to} · {picked.dep}–{picked.arr} · {adults} traveller(s)
          </p>
          <table style={{ maxWidth: 320 }}>
            <tbody>
              <tr><td className="small">Air fare</td><td style={{ textAlign: "right" }}>{sar(picked.base)}</td></tr>
              <tr><td className="small">Service charge</td><td style={{ textAlign: "right" }}>{sar(picked.serviceCharge)}</td></tr>
              <tr><td style={{ fontWeight: 800 }}>Total</td><td style={{ textAlign: "right", fontWeight: 800 }}>{sar(picked.total)}</td></tr>
            </tbody>
          </table>
          <p className="small" style={{ margin: "10px 0" }}>
            Instant online ticketing switches on at launch. For now we issue this booking for you against{" "}
            {company.name}&apos;s account — send the request and our team confirms within the hour.
          </p>
          <div className="row">
            <button className="pill-btn primary" onClick={() => requestBooking(picked)}>
              Request booking
            </button>
            <button className="pill-btn" onClick={() => setPicked(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Booking capabilities</h2>
        <ul className="small" style={{ lineHeight: 1.9, margin: 0, paddingInlineStart: 18 }}>
          <li>Search &amp; book flights within company policy (see Approval policies).</li>
          <li>Wallet &amp; credit-limit settlement, with the full audit trail.</li>
          <li>E-ticket + ZATCA invoice emailed automatically to the traveller and account.</li>
          <li>Cancellation / refund / change requests routed to the Flighterz team.</li>
        </ul>
      </div>
    </>
  );
}
