# Flighterz — Intelligent Business Platform (desktop)

A Windows desktop app for **corporate accounts**: booking, analytics, travel
approval policies, and an employee tree. It is a client of the **same Flighterz
backend** as the website and the mobile apps — it authenticates against, and
reads/writes through, the existing `/api/mobile/corporate/*` endpoints. No new
parallel system.

- **Launch splash:** navy (`#0D2138`, the website blue) with the logo centered and
  **"Flighterz Intelligent Business Platform"** beneath it.
- **Login only, no registration.** Accounts are created on the website; sign-in is
  **email + password → email OTP** (the `/api/mobile/corporate/otp/*` flow).
- **Analytics:** live wallet/credit KPIs, monthly travel spend, credit utilisation,
  balance trend, and recent activity — read from the corporate account (same data
  as the web portal), charted with Recharts.
- **Bookings:** launches the same Flighterz booking engine (fares, PNR/ticketing,
  wallet/credit settlement, e-ticket + ZATCA invoice).
- **Approval policies:** define when a trip needs sign-off — **day/time window,
  route (from → to), and reason ("why")** — and who approves it. Bookings are
  **never held**; the policy asks for a reason and notifies the approver.
- **Employee tree:** the org hierarchy that drives approvals (X approves for Y, Y
  senior to Z …).

## Stack

Electron + Vite + React + TypeScript. Recharts for charts. The renderer talks to
the API over HTTPS with a bearer token (identical model to the Flutter app).

## Run in development

```bash
npm install
npm run dev        # Vite dev server + Electron window
```

Point at a different backend (e.g. staging) with a build-time env var:

```bash
VITE_API_BASE=https://staging.flighterz.com/api/mobile npm run dev
```

Default base: `https://www.flighterz.com/api/mobile`.

## Build the Windows installer (.exe)

```bash
npm run dist            # NSIS install wizard  → release/Flighterz Business Setup <version>.exe
npm run dist:portable   # single portable .exe → release/Flighterz Business <version>.exe
```

The NSIS target is the standard **install wizard** (choose folder, desktop + Start
menu shortcuts). Output lands in `release/`.

- **App icon:** drop a 256×256 multi-res `build/icon.ico`, then uncomment the
  `icon:` line in `electron-builder.yml` for a branded installer + taskbar icon.
- **Code signing (recommended for distribution):** set `CSC_LINK` (path/URL to a
  `.pfx`) and `CSC_KEY_PASSWORD` env vars before `npm run dist`; electron-builder
  signs automatically. Unsigned builds trigger a SmartScreen warning on first run.

## Automatic updates

The app self-updates via `electron-updater`. On launch it checks the feed in
`electron-builder.yml` (`publish.url`), downloads a newer build in the background,
and installs it on next quit. To ship an update: bump `version` in `package.json`,
run `npm run dist`, and upload `release/latest.yml` + the new installer to that URL
(or `npm run dist -- --publish always` to upload automatically). Clients update on
their own — no manual reinstall. (Signed builds are strongly recommended so the
update is trusted; see code signing below.)

## Hosting the download

1. Build the `.exe` (above).
2. Upload it somewhere public (e.g. `web/public/downloads/` on the site, or object
   storage/CDN).
3. Set `NEXT_PUBLIC_BUSINESS_APP_URL` on the website to that URL — the "Flighterz
   Business for Windows" button on the homepage/footer then links to it.

## Backend it depends on

| Capability | Endpoint | Status |
|---|---|---|
| Corporate email-OTP login | `POST /api/mobile/corporate/otp/request` + `/verify` | ✅ live (added with this app) |
| Company profile + wallet ledger | `GET /api/mobile/corporate/account` | ✅ live |
| Booking engine | website `/flights` flow (Amadeus AQC) | 🟡 gated on AQC credentials + `PAYMENTS_ENABLED` |
| Persist approval policies / employee tree | corporate-org & policy API | 🔴 Phase 2 (currently stored locally per device) |
| Deeper corporate analytics (per-employee, per-route) | corporate-analytics API | 🔴 Phase 2 |

## Roadmap

- **Phase 1 (this scaffold):** OTP login, analytics from account data, booking
  launch, local policy + employee-tree editors, installer pipeline.
- **Phase 2:** server-persisted employee tree & approval policies (new Prisma
  models + endpoints), richer corporate analytics, embedded in-app booking once
  the AQC search/price/book API is credentialed, auto-update, code signing.

---
© Middle East Marina Company. Internal corporate tooling for Flighterz.
