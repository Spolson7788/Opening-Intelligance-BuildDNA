# Deploying Opening Intel to the Cloud

Three separate deployable pieces, each independently hosted:

| Piece | What it needs | Recommended host |
|---|---|---|
| API + Postgres | A container host + a managed Postgres | Railway or Render |
| Dashboard (React SPA) | Static hosting | Vercel |
| Field app (React PWA) | Static hosting, served over HTTPS (required for camera/geolocation) | Vercel |
| Photo storage | S3-compatible object storage | Cloudflare R2 or Supabase Storage |

This isn't the only valid stack (any container host + any Postgres + any S3-compatible
bucket works, since none of this is vendor-locked on purpose), but it's the
fastest path to something live, and every piece has a generous free tier —
reasonable for a handful of pilot customers before you know if you need
something bigger.

## Why these choices

- **Railway/Render over raw AWS**: no VPC/IAM/ALB setup, a managed Postgres
  is one click, and the `Dockerfile` in this repo is all either one needs —
  point it at the repo, it builds and deploys.
- **Vercel for both frontends**: zero-config for Vite, free SSL, and each
  push to your main branch auto-deploys. The `vercel.json` in each app
  handles the one thing that needs configuring — a rewrite so client-side
  routes (like `/opening/:id`) don't 404 on refresh.
- **R2 over S3 directly**: same API (the code already talks to it via the
  S3 SDK, see `src/services/storage.ts`), zero egress fees, marginally
  simpler to set up than IAM policies on AWS. Supabase Storage is an equally
  fine choice if you're already using Supabase for anything else.

## Step 1 — Database

1. On Railway: New Project → Provision PostgreSQL. Copy the connection
   string it gives you (`DATABASE_URL`).
2. That's it for setup — migrations run automatically on every API deploy
   (see the Dockerfile's `CMD`), not as a separate manual step.

## Step 2 — API

1. New Railway service → Deploy from GitHub repo → point it at this repo
   (Railway auto-detects the `Dockerfile`).
2. Set environment variables (Railway → Variables tab):
   ```
   DATABASE_URL=<from step 1>
   JWT_SECRET=<generate one: openssl rand -base64 32>
   S3_BUCKET=...
   S3_REGION=auto              # "auto" for R2; a real AWS region for S3
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_ENDPOINT=...             # R2/Supabase endpoint; omit entirely for real AWS S3
   S3_PUBLIC_BASE_URL=...      # your R2 public bucket URL or CDN domain
   CORS_ORIGINS=               # fill in after step 3, once you have real frontend URLs
   ```
3. Deploy. Railway gives you a public URL like `opening-intel-api-production.up.railway.app`.
   Confirm it's alive: `curl https://<your-api-url>/health` → `{"status":"ok"}`.

## Step 3 — Frontends

For **each** of `dashboard/` and `field-app/`:

1. New Vercel project → import this repo → set the project **Root Directory**
   to `dashboard` (or `field-app`) — this matters, since both live in the
   same repo as the API.
2. Set the environment variable:
   ```
   VITE_API_BASE_URL=https://<your-api-url>/api
   ```
3. Deploy. Vercel gives you a URL like `opening-intel-dashboard.vercel.app`
   (or attach a real domain under Project Settings → Domains).

## Step 4 — Close the loop: CORS

Now that you have real frontend URLs, go back to the API's environment
variables and set:

```
CORS_ORIGINS=https://opening-intel-dashboard.vercel.app,https://opening-intel-field.vercel.app
```

Redeploy the API (or it'll pick this up automatically on Railway if you're
connected to the same env — check whether a redeploy is needed). Without
this step, every request from the deployed frontends will be silently
blocked by the browser, even though the API itself is healthy — this is
the single most common "it works locally but not in prod" failure mode for
this kind of split-frontend/backend setup.

## Step 5 — Bootstrap your first organization

Visit the deployed dashboard's `/signup` page and create your organization
and admin account through the UI — no manual SQL required (see the root
README for why this used to require a direct database insert, and why that
was closed).

## Step 6 — Seed demo data (before walking into a pilot conversation)

An empty dashboard doesn't demo well. If this deployment is for showing
prospects rather than real customer data, run the seed script against your
deployed database:

```
DATABASE_URL=<your production DATABASE_URL> npm run seed:demo
```

This populates a realistic portfolio — one property, two buildings, ~28-30
openings with hardware, service history, and inspection results, including
a handful deliberately scoring low so the "Needs Attention" card isn't
empty. It prints a separate demo login at the end; use that account (not
your own) when walking someone through the dashboard. Safe to re-run — it
detects the existing demo org and won't create a duplicate.

Skip this step if the deployment is going straight to a real pilot
customer's own data.

## Verifying it's actually working end to end

```
# API health
curl https://<your-api-url>/health

# Sign up
curl -X POST https://<your-api-url>/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"organization_name":"Test Co","email":"you@example.com","password":"testpass123","full_name":"Your Name"}'
```

Then open the dashboard URL, sign in, and confirm the empty-state portfolio
view loads without a CORS error in the browser console (Network tab → any
red/failed request to your API domain means Step 4 needs another look).

## What's NOT handled by this guide

- **Custom domains** — both Vercel and Railway support them; not covered
  here since it's provider-specific and optional for a pilot.
- **CI/CD beyond auto-deploy-on-push** — Railway/Vercel's default "push to
  main deploys" behavior is enough for pilot stage. No test suite exists
  yet to run in a pipeline (see the main README — this is a real gap, not
  an oversight).
- **Secrets rotation, staging environment, database backups** — worth
  setting up before this holds real customer data at any scale beyond a
  handful of pilots; Railway's managed Postgres includes automatic backups
  on paid tiers, which is worth turning on once there's real data to lose.
- **Monitoring/error tracking** — nothing is wired in (no Sentry, no
  structured logging beyond `console.log`/`console.error`). Fine for
  watching a handful of pilots by hand; not fine past that.
