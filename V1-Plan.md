# Uptime Monitor — V1 Plan (Condensed)

## Goal
Passwordless uptime monitor. User → username, monitor name, URL, interval, timeout. System does periodic `GET`, stores only latest state (no history).

## In Scope / Out of Scope
| In Scope (V1) | Out of Scope (V1) |
|---|---|
| Create / List / Update / Delete monitor | Passwords, auth |
| Pause / Resume | Monitor history / uptime % |
| Latest status, response time, last checked, last error | Alerts (email/SMS/Slack) |
| Auto-scheduling of next check | Multiple HTTP methods, custom headers/body |
| SSRF protection, input validation | Redis, queues, separate backend, Turborepo |

## Architecture (2 deployed surfaces only)
| Layer | Tech | Responsibility |
|---|---|---|
| App | Astro on Vercel | UI + CRUD API routes |
| Data + Scheduler | Supabase Postgres + pg_cron | Storage, decides due monitors |
| Worker | Supabase Edge Function `check-monitors` | Finds due → claims → GET → timeout → updates state |

Flow: `pg_cron (every 10 min)` → `Edge Function` → reads/writes `Postgres` + calls target `Public URL`. Edge Function never talks to Astro API.

## Data Model
| Table | Key Columns |
|---|---|
| `users` | `id (uuid)`, `username (unique)`, `created_at` |
| `monitors` | `id (uuid)`, `user_id (fk→users, cascade)`, `name`, `url`, `interval_minutes`, `timeout_seconds`, `is_paused`, `status (UP/DOWN)`, `response_time_ms`, `last_checked_at`, `last_error`, `next_check_at`, `created_at`, `updated_at` |

Indexes: `monitors(next_check_at) WHERE is_paused=false` (due query), `monitors(user_id)` (list query).

## Constraints
| Field | Rule |
|---|---|
| Username | 3–30 chars, `a-z A-Z 0-9 _ -`, lowercase-normalized, unique |
| Monitor name | 1–80 chars |
| URL | `http/https` only; block localhost, loopback, RFC1918, link-local, cloud metadata IPs (SSRF check) |
| Interval | 10–60 min, fixed options: 10/15/20/30/45/60, default 10 |
| Timeout | 1–60 sec, fixed options: 1/5/10/15/20/30/45/60, default 10 |

## Scheduling Model
- pg_cron wakes every 10 min (global tick, not per-monitor).
- Due query: `is_paused=false AND next_check_at <= now()`, batch limit 40.
- Next run anchored to **scheduled time**, not completion time (avoids drift).
- Late/overlapping runs: skip stale misses, don't replay; use atomic claim/lease (`check_started_at` / `check_lease_until`) to avoid double-checking.

## Check Lifecycle
`claim → start timer → GET (with AbortSignal timeout) → stop timer → 2xx=UP else DOWN → store response_time_ms/last_error/last_checked_at → compute next_check_at`

Error codes to store in `last_error`: `TIMEOUT, DNS_ERROR, CONNECTION_ERROR, HTTP_4xx/5xx, UNKNOWN_ERROR`.

## API Endpoints (Astro server routes)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/monitors` | Create monitor (body: username, name, url, intervalMinutes, timeoutSeconds) |
| GET | `/api/monitors?username=` | List monitors for a user |
| PATCH | `/api/monitors/:id` | Update name/url/interval/timeout/isPaused (recalculates `next_check_at` when relevant) |
| DELETE | `/api/monitors/:id` | Delete monitor |

Response shape: `{ data: {...} }` on success, `{ error: { code, message } }` on failure. Status codes: 200/201/204/400/404/409/429/500.

## Security
- Service-role key: server/Edge Function only — never sent to browser.
- Browser gets `SUPABASE_URL` + `SUPABASE_ANON_KEY` only.
- No RLS-based auth (V1 has no real auth) — DB access stays behind server/API.
- Edge Function requires internal secret/token for invocation (not public).
- Rate limiting + request size limits on API routes.

## Folder Structure
```
uptime-monitor/
├── src/
│   ├── components/      MonitorCard, MonitorForm, StatusBadge, EmptyState
│   ├── layouts/         Layout.astro
│   ├── pages/
│   │   ├── index.astro
│   │   ├── dashboard/[username].astro
│   │   └── api/monitors/  index.ts, [id].ts
│   ├── lib/             db.ts, monitors.ts, validation.ts
│   └── styles/          global.css
├── supabase/
│   ├── functions/check-monitors/index.ts
│   ├── migrations/001_initial.sql
│   └── config.toml
├── public/
├── .env.example, .gitignore, astro.config.mjs, package.json, tsconfig.json
```
Single pnpm package. No monorepo/Turborepo for V1 (revisit only if `apps/web, apps/worker` etc. become real).

## Success Criteria
Username entry → monitor create/edit/pause/delete → stored in Supabase → `next_check_at` computed → pg_cron wakes every 10 min → Edge Function checks due monitors, respects timeout, updates status/response time/next check → dashboard reflects latest state → invalid/private URLs rejected → no separate backend deployed.