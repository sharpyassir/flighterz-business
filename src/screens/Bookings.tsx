import { useState } from "react";
import type { Company } from "../api";

const WEB = "https://www.flighterz.com/en";

/**
 * Corporate booking runs through the same Flighterz booking engine as the web
 * portal (same fares, same PNR/ticketing, same wallet/credit settlement). The
 * desktop app launches a search into that flow; a fully embedded booking UI is
 * Phase 2 once the Amadeus AQC search/price/book API is credentialed.
 */
export function Bookings({ company }: { company: Company }) {
  const [from, setFrom] = useState("RUH");
  const [to, setTo] = useState("JED");
  const [depart, setDepart] = useState("");
  const [adults, setAdults] = useState(1);

  const search = () => {
    const q = new URLSearchParams({ from, to, adults: String(adults) });
    if (depart) q.set("depart", depart);
    const url = `${WEB}/flights?${q.toString()}`;
    if (typeof window !== "undefined") window.open(url, "_blank");
  };

  return (
    <>
      <div className="panel">
        <h2>Book a corporate trip</h2>
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
          <button className="pill-btn primary" onClick={search}>
            Search flights
          </button>
        </div>
        <p className="small" style={{ marginTop: 10 }}>
          Bookings settle against {company.name}&apos;s wallet / credit and appear in Analytics and on your
          Daftra statement — the same rails as the web portal.
        </p>
      </div>

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
