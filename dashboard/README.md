# Opening Intel — Dashboard

Desktop, facilities-manager-facing portfolio view over `GET /api/openings`.
This is the screen you demo to a pilot customer and the one that should get
someone to renew — it needs to answer "what needs attention" in one glance.

## Design intent

Light and boardroom-ready, unlike the field app's dark/industrial theme —
this gets shown in a budget meeting, not used on a ladder. It shares one
element with the field app on purpose: the `.asset-plate` treatment for
`opening_code`, so the two apps still read as one product. Safety-orange
survives as an accent but is used only for risk/attention states here, not
as a general brand color the way it functions in the field app.

## What's here

- Sign-in (reuses the same `/api/auth/login` endpoint as the field app), plus
  a self-serve signup screen (`/signup`) that creates a new organization and
  its first admin user in one step
- Four summary stat cards: total openings, average health score, count
  needing attention (health < 50), fire-rated opening count
- Health score distribution chart (bucketed bar chart, recharts)
- Sortable, filterable table of all openings — filter by property, building
  (cascades from the selected property), opening type, and health threshold
- Click any row for a read-only detail view: hardware table, full
  service/inspection history, photo grid
- Export CSV — exports exactly the currently-filtered view (property,
  building, type, health threshold all carry through)

## What's NOT here yet

- **Map view** — the original project brief mentions this as a "system of
  record," and a floor-plan or map visualization would be a strong pilot
  demo feature, but it's out of scope for this pass.
- **Creating properties/buildings from the UI** — the API supports it
  (`POST /api/portfolio/properties`, `/buildings`), but there's no form here
  yet; you'd need to call the API directly or build that screen next.

## Setup

```
npm install
cp .env.example .env   # for local dev, point VITE_DEV_API_PROXY at your local API instead
npm run dev
```
