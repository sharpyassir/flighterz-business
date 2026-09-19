import { useState } from "react";
import {
  searchFlights,
  searchStays,
  searchActivities,
  searchTransfers,
  type FlightResult,
  type StayItem,
  type ActivityItem,
  type TransferItem,
  type Company,
} from "../api";

const WA = "966580028428";
const CITIES = ["RUH", "JED", "DMM", "MED", "DXB", "AUH", "DOH", "CAI", "IST", "LHR"];
const sar = (n: number) => `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} SAR`;
const dur = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

type Product = "flights" | "hotels" | "activities" | "transfers";

export function Bookings({ company }: { company: Company }) {
  const [product, setProduct] = useState<Product>("flights");

  const tabs: { key: Product; label: string }[] = [
    { key: "flights", label: "Flights" },
    { key: "hotels", label: "Hotels" },
    { key: "activities", label: "Activities" },
    { key: "transfers", label: "Transfers" },
  ];

  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 4 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className="pill-btn"
            style={product === t.key ? { background: "#0d2138", color: "#fff", borderColor: "#0d2138" } : {}}
            onClick={() => setProduct(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {product === "flights" && <Flights company={company} />}
      {product === "hotels" && <Hotels />}
      {product === "activities" && <Activities />}
      {product === "transfers" && <Transfers />}
    </>
  );
}

function useSearch<T>(fn: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setItems(await fn());
    } catch {
      setError("Search failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return { items, busy, error, run };
}

const citySelect = (v: string, set: (s: string) => void) => (
  <select value={v} onChange={(e) => set(e.target.value)}>
    {CITIES.map((c) => (
      <option key={c} value={c}>{c}</option>
    ))}
  </select>
);

function Flights({ company }: { company: Company }) {
  const [from, setFrom] = useState("RUH");
  const [to, setTo] = useState("JED");
  const [depart, setDepart] = useState("");
  const [adults, setAdults] = useState(1);
  const s = useSearch<FlightResult>(() => searchFlights({ from, to, depart: depart || undefined, adults }));
  const req = (f: FlightResult) =>
    window.open(`https://wa.me/${WA}?text=${encodeURIComponent(`Flight booking — ${company.name}: ${from}→${to}, ${f.airlineEn}, ${sar(f.total)}`)}`, "_blank");
  return (
    <>
      <div className="panel">
        <h2>Flights</h2>
        <div className="form-grid">
          <label><span>From</span>{citySelect(from, setFrom)}</label>
          <label><span>To</span>{citySelect(to, setTo)}</label>
          <label><span>Departure</span><input type="date" value={depart} onChange={(e) => setDepart(e.target.value)} /></label>
          <label><span>Travellers</span><input type="number" min={1} max={9} value={adults} onChange={(e) => setAdults(Number(e.target.value))} /></label>
        </div>
        <button className="pill-btn primary" style={{ marginTop: 12 }} onClick={s.run} disabled={s.busy}>{s.busy ? "Searching…" : "Search flights"}</button>
        {s.error && <p className="small" style={{ color: "#b91c1c" }}>{s.error}</p>}
      </div>
      {s.items && (
        <div className="panel">
          <h2>{s.items.length} results</h2>
          {s.items.map((f) => (
            <div key={f.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eef1f5", padding: "8px 0" }}>
              <b style={{ width: 130 }}>{f.airlineEn}</b>
              <span className="small">{f.dep}–{f.arr} · {dur(f.durationMins)} · {f.stops === 0 ? "Direct" : `${f.stops} stop`}</span>
              <b>{sar(f.total)}</b>
              <button className="pill-btn primary" onClick={() => req(f)}>Request</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Hotels() {
  const [dest, setDest] = useState("DXB");
  const [cin, setCin] = useState("");
  const [cout, setCout] = useState("");
  const s = useSearch<StayItem>(() => searchStays({ dest, in: cin || undefined, out: cout || undefined }));
  return (
    <>
      <div className="panel">
        <h2>Hotels</h2>
        <div className="form-grid">
          <label><span>Destination</span>{citySelect(dest, setDest)}</label>
          <label><span>Check-in</span><input type="date" value={cin} onChange={(e) => setCin(e.target.value)} /></label>
          <label><span>Check-out</span><input type="date" value={cout} onChange={(e) => setCout(e.target.value)} /></label>
        </div>
        <button className="pill-btn primary" style={{ marginTop: 12 }} onClick={s.run} disabled={s.busy}>{s.busy ? "Searching…" : "Search hotels"}</button>
        {s.error && <p className="small" style={{ color: "#b91c1c" }}>{s.error}</p>}
      </div>
      {s.items && (
        <div className="panel">
          <h2>{s.items.length} hotels</h2>
          {s.items.map((h) => (
            <div key={h.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eef1f5", padding: "8px 0" }}>
              <span><b>{h.name}</b> <span className="small">{"★".repeat(h.category)} · {h.area} · {h.board}</span></span>
              <b>{sar(h.nightly)} / night</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Activities() {
  const [dest, setDest] = useState("DXB");
  const [date, setDate] = useState("");
  const s = useSearch<ActivityItem>(() => searchActivities({ dest, date: date || undefined }));
  return (
    <>
      <div className="panel">
        <h2>Activities</h2>
        <div className="form-grid">
          <label><span>Destination</span>{citySelect(dest, setDest)}</label>
          <label><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <button className="pill-btn primary" style={{ marginTop: 12 }} onClick={s.run} disabled={s.busy}>{s.busy ? "Searching…" : "Search activities"}</button>
        {s.error && <p className="small" style={{ color: "#b91c1c" }}>{s.error}</p>}
      </div>
      {s.items && (
        <div className="panel">
          <h2>{s.items.length} activities</h2>
          {s.items.map((a) => (
            <div key={a.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eef1f5", padding: "8px 0" }}>
              <span><b>{a.name}</b> <span className="small">{a.category} · {a.duration} · ★{a.rating}</span></span>
              <b>from {sar(a.from)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Transfers() {
  const [from, setFrom] = useState("DXB");
  const [to, setTo] = useState("RUH");
  const [date, setDate] = useState("");
  const s = useSearch<TransferItem>(() => searchTransfers({ from, to, date: date || undefined }));
  return (
    <>
      <div className="panel">
        <h2>Transfers</h2>
        <div className="form-grid">
          <label><span>From</span>{citySelect(from, setFrom)}</label>
          <label><span>To</span>{citySelect(to, setTo)}</label>
          <label><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <button className="pill-btn primary" style={{ marginTop: 12 }} onClick={s.run} disabled={s.busy}>{s.busy ? "Searching…" : "Search transfers"}</button>
        {s.error && <p className="small" style={{ color: "#b91c1c" }}>{s.error}</p>}
      </div>
      {s.items && (
        <div className="panel">
          <h2>{s.items.length} options</h2>
          {s.items.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #eef1f5", padding: "8px 0" }}>
              <span><b>{t.vehicle}</b> <span className="small">{t.type} · {t.maxPax} pax · {t.bags} bags</span></span>
              <b>{sar(t.price)}</b>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
