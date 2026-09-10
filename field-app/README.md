# Opening Intel — Field App

Mobile-first, offline-capable PWA for technicians to scan a tagged opening and
log service/inspection history on site.

## Design intent

Dark, high-contrast UI — this is used in stairwells, mechanical rooms, and
loading docks, often with poor lighting and gloved hands. The `opening_code`
is always rendered inside an "asset plate" chip (see `.asset-plate` in
`index.css`), echoing the physical QR tag on the door itself — that's the
one deliberate visual signature, everything else stays quiet and functional.

## How offline capture works

This is the part that actually matters for adoption — techs are frequently in
dead zones.

1. `src/lib/db.ts` — an IndexedDB store with: a **cache** of the last-seen
   opening record (so a tech can still view details with no signal), an
   **outbox** of queued JSON mutations (service/inspection events), and a
   **photoOutbox** that holds the actual image blob (photos can't go through
   the same JSON outbox — see point 3).
2. Every form write goes to an outbox *first*, synchronously, before any
   network call — the "Saved" confirmation is real and instant, not
   dependent on connectivity. This includes photo capture: the shutter tap
   writes the blob to IndexedDB immediately, the same instant-save pattern
   as service/inspection events.
3. `src/lib/sync.ts` flushes both outboxes whenever the browser fires an
   `online` event, and also polls every 30s as a fallback (some mobile
   browsers don't fire `online` reliably). Photos flush after events on
   purpose — event writes are small and should land first; a large photo
   upload is more likely to hit a flaky connection mid-transfer, and
   shouldn't hold up records that are ready to go. Presigned upload URLs
   expire in 5 minutes, so a photo queued offline for longer than that will
   fail its first upload attempt after reconnecting — this is expected, not
   a bug; the sync manager re-presigns from scratch on every attempt, so the
   *next* flush pass succeeds without any user action.
4. Failed items with a 4xx response are skipped (bad data won't fix itself
   on retry) rather than blocking the rest of the queue; network-level
   failures stop the flush and retry later.
5. The top-bar `SyncBadge` always shows current state: Offline / N queued /
   Syncing / Synced — the count is combined across both outboxes.
6. A queued photo shows immediately in the opening's photo grid (dimmed,
   with a "Queued" or "Retrying…" badge) using a local object URL, then
   automatically resolves to the real synced photo once uploaded — the
   opening detail page subscribes to sync state and refreshes when a flush
   pass completes.

## What's NOT built yet

- **Hardware component editing** — techs can add hardware now, but not edit
  or remove it. Also requires a live connection (not queued offline), since
  it's typically a one-time setup step during initial capture rather than a
  routine field action.
- **Code splitting** — the build bundles `html5-qrcode` into the main chunk
  (~626KB). Fine for MVP; worth lazy-loading before this ships broadly.

## Setup

```
npm install
cp .env.example .env   # for local dev, point VITE_DEV_API_PROXY at your local API instead
npm run dev
```

Requires the API (in the parent `opening-intel` project) running and
reachable — either via the dev proxy (`vite.config.ts`) or `VITE_API_BASE_URL`
for a deployed instance.

To test as an installed PWA: `npm run build && npm run preview`, then open on
a phone and "Add to Home Screen." The service worker only activates on a
production build, not `npm run dev`.

## Core flow

1. Sign in (`/login`) — credentials issued via the API's `/api/auth/register`.
2. Scan a QR (or type the code manually) — resolves to an opening.
3. View health score, hardware, and recent history.
4. Log Service or Log Inspection — saved instantly, synced when possible.
