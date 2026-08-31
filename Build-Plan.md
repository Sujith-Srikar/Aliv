# Uptime Monitor — Build Plan (Backend First)

Order: **DB → Edge Function → Scheduler → Astro API → Frontend → Harden → Deploy**. Don't touch UI until the checker works end-to-end.

## Prerequisites
```bash
node -v            # Node 20+
pnpm -v
supabase --version # Supabase CLI
git --version
```

---

## Phase 0 — Project init
```bash
git init
pnpm create astro@latest .      # choose minimal/empty template
pnpm install
pnpm add @supabase/supabase-js
supabase init
```
Result: `supabase/{config.toml, migrations/, functions/}` alongside the Astro app.

---

## Phase 1 — Database (Postgres)
1. Create `supabase/migrations/001_initial.sql` with:
   - `users(id uuid, username unique, created_at)`
   - `monitors(id uuid, user_id fk cascade, name, url, interval_minutes, timeout_seconds, is_paused, status, response_time_ms, last_checked_at, last_error, next_check_at, created_at, updated_at)`
   - CHECK constraints: `interval_minutes 10–60`, `timeout_seconds 1–60`, `status in ('UP','DOWN')`
   - Indexes: `monitors(next_check_at) WHERE is_paused=false`, `monitors(user_id)`
2. Apply:
```bash
supabase start
supabase db reset
# OR against remote:
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```
3. Generate types:
```bash
supabase gen types typescript --local > supabase/types.ts
```
**Done when:** tables + constraints + indexes exist, test rows insert successfully.

---

## Phase 2 — Edge Function (`check-monitors`)
```bash
supabase functions new check-monitors
```
Implement in `supabase/functions/check-monitors/index.ts`:
```
authenticate internal invocation (secret/token)
  → select due monitors (is_paused=false AND next_check_at<=now(), limit 40)
  → claim atomically (lease/check_started_at)
  → for each: fetch(url, { signal: AbortSignal.timeout(timeoutSeconds*1000) })
  → classify UP/DOWN + error code
  → update status, response_time_ms, last_checked_at, last_error, next_check_at (anchored to schedule, not completion)
```
Test locally before wiring cron:
```bash
supabase functions serve check-monitors
curl -i http://localhost:54321/functions/v1/check-monitors -H "Authorization: Bearer <local-token>"
```
**Done when:** manual invocation correctly checks a seeded due monitor and updates its row.

---

## Phase 3 — Scheduling (pg_cron)
1. Enable `pg_cron` extension (dashboard or migration).
2. Create cron job → invoke `check-monitors` every 10 minutes.
3. Seed a test monitor with `next_check_at` a minute in the future.
```bash
supabase db push   # if cron config lives in a migration
```
**Done when:** `monitors.next_check_at`, `status`, `response_time_ms` change automatically without manual calls.

---

## Phase 4 — Astro CRUD API
Set env vars first:
```bash
cp .env.example .env
# .env
SUPABASE_URL=...
SUPABASE_ANON_KEY=...        # browser-safe
SUPABASE_SERVICE_ROLE_KEY=...# server-only, never exposed to client
```
Build `src/lib/{db.ts, validation.ts, monitors.ts}`, then routes:
```
POST   /api/monitors            src/pages/api/monitors/index.ts
GET    /api/monitors?username=  src/pages/api/monitors/index.ts
PATCH  /api/monitors/:id        src/pages/api/monitors/[id].ts
DELETE /api/monitors/:id        src/pages/api/monitors/[id].ts
```
Run + test:
```bash
pnpm dev
curl -X POST localhost:4321/api/monitors -H "Content-Type: application/json" \
  -d '{"username":"sujith","name":"My API","url":"https://example.com","intervalMinutes":10,"timeoutSeconds":10}'
```
**Done when:** all 4 endpoints work independently via curl/Postman before any UI exists.

---

## Phase 5 — Frontend (Astro pages, modifiable)
```
src/pages/index.astro (or /dashboard/[username].astro)
src/components/{MonitorCard, MonitorForm, StatusBadge, EmptyState}.astro
```
Wire create / edit / pause-resume / delete to the API routes above.
```bash
pnpm dev
```

---

## Phase 6 — Production hardening
- SSRF validation on URL (block private/loopback/link-local/metadata IPs) — server-side, at the trust boundary.
- Rate limiting + request size limits on API routes.
- Cron/Edge Function requires internal secret, not publicly callable.
- Confirm service-role key never reaches client bundle.

## Phase 7 — Deploy
```bash
pnpm build
pnpm preview     # sanity check production build locally
```
- Push to GitHub, connect repo to Vercel (auto-detects Astro), build command `pnpm build`.
- Supabase: push final migrations (`supabase db push`), confirm Edge Function + pg_cron are live in the linked project.
- Set production env vars in Vercel dashboard (anon key only) and Supabase (service role + secrets).

**Final deployment:**
```
Vercel   → Astro UI + API
Supabase → Postgres + pg_cron + Edge Function (check-monitors)
```