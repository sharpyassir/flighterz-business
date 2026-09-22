# Flighterz Business (desktop)

A Windows desktop app for **corporate accounts**. As of v0.2.0 it is a **branded,
auto-updating shell around the live Flighterz corporate portal**
(`https://www.flighterz.com/en/corporate`). The desktop app therefore *is* the web
portal — every screen (Command Center, Book, Requests & approvals, Trips,
Bookings, Wallet, Budgets, Billing, Statement, Employees, Policies, Company setup)
is always identical to the website, and **every web deploy reflects instantly on
every user's PC** with no reinstall.

Why a shell instead of native screens: the corporate portal is a rich,
fast-moving app (policy engine, approval workflows, budgets, analytics…).
Re-implementing it natively would mean a second parallel codebase that perpetually
drifts. Loading the live portal guarantees true, permanent equivalence.

- **Launch update-gate:** on start the app shows a navy splash, checks GitHub
  Releases for a newer shell, and — if found — downloads and installs it **before**
  loading the portal. If the feed is slow/offline (or in dev) it proceeds after a
  short timeout so startup is never blocked.
- **Login:** handled by the portal itself (email + access code). The session
  cookie persists between launches (standard Electron session storage).
- **External links** (e.g. a PDF, the public site) open in the OS browser; portal
  navigation stays in-app.
- **Offline screen** with a "Try again" button when the portal can't be reached.

## Two kinds of "update" — important

| You changed… | How it reaches users | Action needed |
|---|---|---|
| A **portal feature** (any screen, the policy engine, pricing, copy…) | Instantly — the app loads the live site | **Just deploy the web app.** No desktop release. |
| The **desktop shell** (this repo: window, splash, update logic, icon) | `electron-updater` auto-updates on next launch | Publish a new GitHub Release (below). |

So day-to-day, you update the web app and every desktop user sees it immediately.
You only cut a new `.exe` when the native wrapper itself changes.

## Stack

Electron (main process only). No renderer bundle — the window loads the remote
portal. `contextIsolation` on, `nodeIntegration` off; the preload exposes only a
tiny safe surface (`window.flz`).

## Run in development

```bash
npm install
npm run dev            # loads the PRODUCTION portal in an Electron window
npm run dev:local      # loads http://localhost:3000/en/corporate (run the web app first)
```

Point at any portal with an env var: `PORTAL_URL=https://staging.example/en/corporate npm run dev`.
(Update checks are skipped unless the app is packaged.)

## Build the Windows installer (.exe)

```bash
npm run dist            # NSIS install wizard  → release/Flighterz Business Setup <version>.exe
npm run dist:portable   # single portable .exe → release/Flighterz Business <version>.exe
```

- **App icon:** `build/icon.png` (electron-builder derives the multi-res `.ico`).
- **Code signing (recommended):** set `CSC_LINK` (path/URL to a `.pfx`) and
  `CSC_KEY_PASSWORD` before building; unsigned builds trigger a SmartScreen warning
  on first run and make auto-update less seamless.

## Ship a shell update (GitHub Releases)

The app self-updates via `electron-updater` from the **public** repo
`sharpyassir/flighterz-business` (set in `electron-builder.yml`).

1. Bump `version` in `package.json`.
2. Build + publish in one step:
   ```bash
   GH_TOKEN=<github-token-with-repo-scope> npm run publish
   ```
   This builds the installer and creates a GitHub Release with `latest.yml`, the
   `.exe` and the `.exe.blockmap`. (Manual alternative: `npm run dist`, then create
   a Release and upload those three files from `release/`.)
3. Every installed app picks it up on next launch via the update-gate.

> **One-time:** the public repo `sharpyassir/flighterz-business` must exist (it only
> needs to hold Releases — no source). The first version that carries this shell
> must be installed manually; every version after auto-updates.

## Hosting the first download

1. Build the `.exe`.
2. Upload it somewhere public (e.g. `web/public/downloads/` on the site, or a CDN).
3. Set `NEXT_PUBLIC_BUSINESS_APP_URL` on the website to that URL — the "Flighterz
   Business for Windows" button then links to it.

## Legacy native screens

The pre-0.2.0 native React screens (`src/`, `index.html`, `vite.config.ts`,
`src/api.ts`) are **no longer used** by the shell and are kept only for reference.
They can be deleted once you're happy with the shell.

---
© Middle East Marina Company. Internal corporate tooling for Flighterz.
