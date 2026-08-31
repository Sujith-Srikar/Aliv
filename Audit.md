# DB Boundary Audit Report

## 1. DIRECT DB ACCESS

Every Supabase client instantiation and `.from()` call in the repo:

| File | Function/Scope | Operation | R/W | Uses `src/lib/db.ts`? | Direct Client? | Direct `.from()`? |
|---|---|---|---|---|---|---|
| `src/lib/db.ts:9` | `getDb()` | Creates singleton `SupabaseClient` | — | N/A (is the client) | Yes (`createClient`) | No |
| `src/lib/monitors.ts:9` | `findOrCreateUser` | `users.select` | Read | Yes | No | Yes |
| `src/lib/monitors.ts:16` | `findOrCreateUser` | `users.insert` | Write | Yes | No | Yes |
| `src/lib/monitors.ts:20` | `findOrCreateUser` | `users.select` (retry) | Read | Yes | No | Yes |
| `src/lib/monitors.ts:40` | `createMonitor` | `monitors.insert` | Write | Yes | No | Yes |
| `src/lib/monitors.ts:47` | `getMonitor` | `monitors.select` | Read | Yes | No | Yes |
| `src/lib/monitors.ts:53` | `listMonitorsForUser` | `users.select` | Read | Yes | No | Yes |
| `src/lib/monitors.ts:56` | `listMonitorsForUser` | `monitors.select` | Read | Yes | No | Yes |
| `src/lib/monitors.ts:89` | `updateMonitor` | `monitors.update` | Write | Yes | No | Yes |
| `src/lib/monitors.ts:96` | `deleteMonitor` | `monitors.delete` | Write | Yes | No | Yes |
| `supabase/functions/check-monitors/index.ts:19` | top-level | Creates `SupabaseClient` | — | No | Yes (`createClient`) | No |
| `supabase/functions/check-monitors/index.ts:73` | `dueMonitors` | `monitors.select("*")` | Read | No | No | Yes |
| `supabase/functions/check-monitors/index.ts:92` | `claim` | `monitors.update` | Write | No | No | Yes |
| `supabase/functions/check-monitors/index.ts:113` | `persist` | `monitors.update` | Write | No | No | Yes |

**Caller trace:**

- `createMonitor` ← `src/pages/api/monitors/index.ts:10` (POST handler)
- `listMonitorsForUser` ← `src/pages/api/monitors/index.ts:21` (GET handler), `src/pages/dashboard/[username].astro:12` (SSR)
- `updateMonitor` ← `src/pages/api/monitors/[id].ts:13` (PATCH handler)
- `deleteMonitor` ← `src/pages/api/monitors/[id].ts:26` (DELETE handler)

**Summary:** All Astro/Vercel DB access flows exclusively through `src/lib/monitors.ts` → `src/lib/db.ts`. No API route or page directly calls `.from()`. The Edge Function has its own independent client and query code in `check-monitors/index.ts`.

---

## 2. TYPE DUPLICATION

### 2a. `src/lib/database.types.ts` vs `supabase/functions/_shared/database.types.ts`

**Semantically identical.** Same `Database` type, same tables (`monitors`, `users`), same Row/Insert/Update/Relationships definitions, same `__InternalSupabase.PostgrestVersion: '14.5'`, same helper types (`Tables`, `TablesInsert`, `TablesUpdate`, `Enums`, `CompositeTypes`, `Constants`).

**Differences are formatting only:**

| Aspect | `src/lib/database.types.ts` | `supabase/functions/_shared/database.types.ts` |
|---|---|---|
| Quotes | Double (`"14.5"`) | Single (`"14.5"`) |
| Semicolons | Present | Absent |
| `Json` type layout | Single-line union | Multi-line union |

Both are **auto-generated** by `supabase gen types typescript --local` or `--project-id`. The Supabase CLI writes one copy per context: one for the project root (consumed by app code), one for functions (consumed by Deno). There is no evidence of manual maintenance.

**Import map:**

- `src/lib/monitors.ts:2` imports `Tables, TablesInsert, TablesUpdate` from `./database.types`
- `src/lib/db.ts:3` imports `Database` from `./database.types`
- `supabase/functions/check-monitors/index.ts:2` imports `Database` from `../_shared/database.types.ts`
- `supabase/functions/_shared/monitor-check.ts:1` imports `Database` from `./database.types.ts`
- `supabase/functions/check-monitors/check-monitors.test.ts` does NOT import database types (uses `MonitorRow` from monitor-check.ts)

### 2b. `src/shared/types.ts`

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type MonitorStatus = 'UP' | 'DOWN';
```

- `LogLevel` is imported by `src/shared/logger.ts:1`.
- `MonitorStatus` is **imported by nothing**. Grep across the entire `src/` tree returns zero imports of `MonitorStatus`.
- Neither type duplicates generated DB types. `MonitorStatus` duplicates the _concept_ of the DB `status` check constraint (`check (status in ('UP', 'DOWN'))`) but is defined as a standalone string union, not derived from the DB schema.

### 2c. DB types as API types

The `Monitor` type (`src/lib/monitors.ts:5`) is `Tables<'monitors'>`, which is the full DB row. This type is used as:

- The return type of `createMonitor`, `getMonitor`, `listMonitorsForUser`, `updateMonitor` — correct, these return DB rows.
- The type in `MonitorCard.astro` props via `import type { Monitor } from '../lib/monitors'` — this means a **DB column type leaks into UI components**. The component accesses `monitor.status`, `monitor.check_lease_until`, `monitor.check_started_at`, `monitor.next_check_at`, `monitor.user_id`, etc., all of which are internal columns not needed for display. This is not a boundary violation per se, but it means the component is coupled to the full DB schema.

---

## 3. RUNTIME / BUILD BOUNDARIES

### Runtimes

| Code path | Runtime | Execution env |
|---|---|---|
| `src/lib/db.ts`, `src/lib/monitors.ts`, `src/pages/api/**/*.ts` | Node.js (Vercel Serverless) | `@astrojs/vercel` adapter, `output: 'server'` |
| `src/pages/dashboard/[username].astro` (frontmatter) | Node.js (Vercel SSR) | `prerender = false` |
| `supabase/functions/check-monitors/index.ts` | Deno | Supabase Edge Runtime (`deno_version = 2`) |

### `@supabase/supabase-js` compatibility

- **Package.json:** `"@supabase/supabase-js": "^2.112.4"` — Node.js npm package.
- **Edge Function deno.json:** `"@supabase/supabase-js": "npm:@supabase/supabase-js@^2"` — Deno npm: specifier, resolves to the same 2.112.4 (confirmed in `deno.lock`).
- **Both runtimes can use `@supabase/supabase-js`.** This is a well-supported pattern; Supabase's own docs recommend it.

### Can a top-level `db/` be imported by both runtimes?

**Partially.** The client creation logic (`createClient`) works in both runtimes. However:

1. `src/lib/db.ts:11` reads `env.SUPABASE_URL` and `env.SUPABASE_SERVICE_ROLE_KEY` from `src/shared/env.ts:12-14`, which uses `import.meta.env` (Astro/Vite's compile-time env replacement). This pattern **does not work in Deno**.

2. The Edge Function uses `Deno.env.toObject()` + `requireEnv()` helper instead.

3. The **type definitions** (`database.types.ts`) are runtime-agnostic pure TypeScript — they work everywhere.

4. The **query functions** in `src/lib/monitors.ts` call `getDb()` which is Astro-specific. The Edge Function has its own `createClient()` call.

**Conclusion:** You cannot share a single `getDb()` / client-creation module between runtimes without conditional branching or separate entry points. The types can be shared. The query functions have different enough patterns (CRUD vs batch-claim-check-persist) that sharing them would require abstraction.

### Supabase CLI constraints

| Path | CLI expectation | Can move? |
|---|---|---|
| `supabase/config.toml` | CLI default lookup is `supabase/config.toml` relative to CWD. Can override with `--config` flag. | Yes, with `--config` flag or symlink |
| `supabase/migrations/*.sql` | CLI default is `./migrations` relative to config dir. Can override with `[db.migrations] schema_paths`. | Yes, with config change |
| `supabase/functions/**/*.ts` | CLI default is `./functions` relative to config dir. Each function dir must contain its entrypoint. `[functions.NAME] entrypoint` in config.toml points to the file. | Yes, with config change |
| `supabase/functions/_shared/` | Not a function dir — it's a shared import directory bundled into functions. The CLI does not treat it specially. | Move freely |

**Critical detail from `config.toml:415-421`:**

```toml
[functions.check-monitors]
enabled = true
verify_jwt = false
import_map = "./functions/check-monitors/deno.json"
entrypoint = "./functions/check-monitors/index.ts"
```

These are **relative to the config file**. If you move config.toml, these paths break.

**Would moving `supabase/` under `db/` break things?** Yes, unless you update `config.toml` paths and pass `--config` to every `supabase` CLI command. The CLI does not search for `db/config.toml`.

---

## 4. CURRENT RESPONSIBILITIES

### `src/lib/db.ts`

- **Single responsibility:** Create and cache a singleton Supabase client using the service-role key.
- **20 lines.** Exports one function: `getDb()`.
- **Is it a useful boundary?** Yes — it centralizes client creation and ensures the service-role key is only used server-side. Every DB call in the Astro app goes through it.

### `src/lib/monitors.ts`

- **Responsibilities:**
  1. `findOrCreateUser(username)` — upsert logic with race-condition retry (lines 7-28)
  2. `createMonitor(input)` — insert monitor (lines 30-43)
  3. `getMonitor(id)` — read single monitor (lines 45-49)
  4. `listMonitorsForUser(username)` — read user's monitors (lines 51-62)
  5. `updateMonitor(id, input)` — patch monitor with schedule recalculation (lines 64-92)
  6. `deleteMonitor(id)` — delete monitor (lines 94-104)

- **Is it a useful DB boundary?** Yes. It already IS the DB boundary for the Astro app. API routes and SSR pages only call these functions, never `.from()` directly.

- **Is it merely a thin wrapper?** Mostly, but `updateMonitor` contains real business logic:
  - `interval_minutes` change → recalculates `next_check_at` (line 83)
  - Resume from paused → sets `next_check_at` to now (line 85)
  - `findOrCreateUser` has race-condition handling (lines 19-27)

  This is business logic, not just query routing.

### `supabase/functions/_shared/monitor-check.ts`

- **Responsibility:** HTTP health-check execution and classification. Takes a monitor's URL + timeout, performs `fetch`, classifies the result into `UP/DOWN` with error codes.
- **Does it duplicate `monitors.ts`?** No. This file does NOT do any database queries. It's a pure HTTP-check utility. The DB operations (dueMonitors, claim, persist) are in `check-monitors/index.ts`.
- **Overlapping domain concept:** The `CheckResult.status` type is `"UP" | "DOWN"`, which matches the DB check constraint, but this is a local interface, not a DB type import.

### `supabase/functions/check-monitors/index.ts`

- **Responsibilities:** Batch orchestration — find due monitors, claim with optimistic locking, run HTTP checks, persist results. Contains its own `createClient`, `dueMonitors`, `claim`, `persist`, and `isAuthorized`.
- **Does it duplicate `monitors.ts`?** No overlapping queries. The Edge Function queries are fundamentally different (batch claim/persist pattern vs. CRUD). The only shared concept is that both talk to the `monitors` table, but the query shapes are entirely different.

---

## 5. API → DB FLOW

### POST `/api/monitors` (`src/pages/api/monitors/index.ts:6`)

```
HTTP request
  → readJson(request)                  // src/lib/http.ts:38 — validates body size + JSON parse
  → CreateMonitorSchema.parse(body)    // src/shared/schemas.ts:25 — Zod runtime validation
  → createMonitor(input)               // src/lib/monitors.ts:30 — DB insert
  → created(data)                      // src/lib/http.ts:26 — JSON response
```

### GET `/api/monitors?username=...` (`src/pages/api/monitors/index.ts:16`)

```
HTTP request
  → ListMonitorsQuerySchema.parse()    // src/shared/schemas.ts:53 — Zod validation
  → listMonitorsForUser(username)      // src/lib/monitors.ts:51 — DB select
  → ok(data)                           // src/lib/http.ts:22 — JSON response
```

### PATCH `/api/monitors/:id` (`src/pages/api/monitors/[id].ts:6`)

```
HTTP request
  → params.id guard                    // manual null check
  → readJson(request)
  → UpdateMonitorSchema.parse(body)    // src/shared/schemas.ts:39 — Zod validation
  → updateMonitor(id, input)           // src/lib/monitors.ts:64 — DB update + schedule logic
  → ok(data)
```

### DELETE `/api/monitors/:id` (`src/pages/api/monitors/[id].ts:21`)

```
HTTP request
  → params.id guard
  → deleteMonitor(id)                  // src/lib/monitors.ts:94 — DB delete
  → noContent()
```

### Findings:

- **Runtime validation:** Yes, every request is Zod-validated at the API boundary.
- **Schema-derived types:** `CreateMonitorInput` and `UpdateMonitorInput` are `z.infer<>` from schemas.
- **DB types as API input types?** No — Zod schemas are the input contract, DB types are only output.
- **API routes know DB column names?** No — the Zod schemas use camelCase (`intervalMinutes`), and `monitors.ts` maps to snake_case (`interval_minutes`).
- **Business logic in API routes?** Minimal — only null-checking `params.id`. The real logic is in `monitors.ts`.
- **Response types explicitly typed?** The return type of `ok()`/`created()` is `unknown` — the response is implicitly typed by whatever `createMonitor` etc. return. There is no explicit `Response` type annotation on the handlers. Minor concern.
- **Type safety issues:**
  - `handleError` in `src/lib/http.ts:65` accepts `unknown` — fine.
  - `isPostgrestError` at line 61 uses `'code' in e || 'message' in e` — a duck-typing check, not a type guard. Works correctly but is loose.
  - No `as` casts, no `!` non-null assertions, no `any` or `unknown` type escapes in the API routes.

### SSR flow (dashboard page)

```
src/pages/dashboard/[username].astro:12
  → listMonitorsForUser(username)  // direct DB call in Astro frontmatter (SSR)
  → passes Monitor[] to MonitorCard components
```

This is a **direct DB call from a page**, not through an API route. It bypasses the `src/pages/api/` layer entirely. This is normal for SSR pages in Astro but means the "no direct DB queries in API routes" goal is currently met — but the page itself IS a DB consumer.

---

## 6. ENVIRONMENT / SECRETS

### Variable inventory

| Variable | `.env.example` | `src/shared/env.ts` | Edge Function | Usage |
|---|---|---|---|---|
| `SUPABASE_URL` | Yes | Yes (parsed) | Yes (`Deno.env`) | Astro server + Edge Function client creation |
| `SUPABASE_ANON_KEY` | Yes | Yes (parsed) | No | Currently unused — no client-side Supabase usage exists |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Yes (parsed) | Yes (`Deno.env`) | Astro server + Edge Function (full admin access) |
| `WORKER_SECRET` | Yes | No | Yes (`Deno.env`) | Edge Function auth; injected by pg_cron from Vault |
| `SUPABASE_PROJECT_REF` | Yes | No | No | Supabase CLI linking only |
| `SUPABASE_DB_PASSWORD` | Yes | No | No | Supabase CLI linking only |

### Duplication between `src/shared/env.ts` and `supabase/functions/_shared/env.ts`

**Completely different modules** despite similar filenames:

| File | What it does |
|---|---|
| `src/shared/env.ts` | Zod-parses `import.meta.env` into a typed `env` object. Astro-only. |
| `supabase/functions/_shared/env.ts` | Generic `requireEnv(source, name)` helper. Runtime-agnostic. |

They share no code and no imports. The Edge Function **does not use** `src/shared/env.ts`.

### Secret leakage risk

- `SUPABASE_SERVICE_ROLE_KEY` is parsed at module scope in `src/shared/env.ts:11`. This module is imported by `src/lib/db.ts`, which is imported by `src/lib/monitors.ts`, which is imported by API routes and the dashboard SSR page.
- Since `output: 'server'` and `@astrojs/vercel` adapter, these run in serverless functions — the key is NOT exposed to the browser.
- There is **no `PUBLIC_` prefix** on any variable — Astro only exposes `PUBLIC_*` to client bundles.
- **No browser code imports `src/shared/env.ts`** — only server modules do.
- **Verdict:** No accidental client-side leakage.

### `SUPABASE_ANON_KEY` is parsed but never used

It is validated in `src/shared/env.ts` and present in `.env.example`, but no code in the Astro app actually uses it. There are no client-side Supabase calls. This is dead config.

---

## 7. SUPABASE CLI CONSTRAINTS

### `supabase/config.toml`

- **Current location:** `supabase/config.toml`
- **CLI default:** `supabase config.toml` (relative to `supabase/` dir)
- **Moveable to `db/config.toml`?** Only with `--config db/config.toml` flag on every CLI command. The CLI does NOT auto-discover `db/config.toml`.
- **Recommendation:** Leave it. The CLI expects it here. Moving it adds friction for no benefit.

### `supabase/migrations/`

- **Current location:** `supabase/migrations/`
- **CLI default:** reads migrations from `./migrations` relative to config file
- **Moveable to `db/migrations/`?** Only if you change `[db.migrations] schema_paths` in config.toml. Since the config lives at `supabase/config.toml`, the path would be `../db/migrations/*.sql`. This works but is unusual.
- **Recommendation:** Leave it. Supabase CLI conventions save tooling friction.

### `supabase/functions/`

- **Current location:** `supabase/functions/`
- **CLI default:** reads from `./functions` relative to config file
- **`[functions.check-monitors]` config** points to `./functions/check-monitors/index.ts` and `./functions/check-monitors/deno.json`
- **Moveable to `db/functions/`?** Only with updated config paths and `--config`. The Deno import map in `deno.json` is self-contained.
- **Recommendation:** Leave it. Moving functions under `db/` gains nothing — the Edge Function already has its own isolated runtime and DB client.

### Summary

The Supabase CLI hardcodes the `supabase/` directory convention. Moving anything breaks default commands (`supabase start`, `supabase db push`, `supabase functions serve`). You can make it work with config overrides, but every developer and CI pipeline needs to remember the `--config` flag. **The cost exceeds the benefit for this project size.**

---

## 8. PROBLEMS FOUND

### P1. Duplicated `database.types.ts` (2 files)

Two identical generated files in different locations. When the schema changes, both must be regenerated. If one is forgotten, types silently diverge.

**Files:** `src/lib/database.types.ts` (257 lines), `supabase/functions/_shared/database.types.ts` (265 lines)

### P2. `MonitorStatus` type is unused

`src/shared/types.ts:3` defines `MonitorStatus = 'UP' | 'DOWN'` — imported by nothing. The actual status constraint is in SQL (`check (status in ('UP', 'DOWN'))`), and the Edge Function re-declares it locally in `monitor-check.ts:15`. This is dead code.

### P3. `SUPABASE_ANON_KEY` is parsed but never used

`src/shared/env.ts:5` validates it. No code uses it. No browser-side Supabase client exists.

### P4. `src/shared/env.ts` and `supabase/functions/_shared/env.ts` are confusingly named

Different modules with the same filename doing different things. One is Zod validation, the other is a generic `requireEnv` helper.

### P5. Edge Function creates its own Supabase client (expected, not a bug)

`check-monitors/index.ts:19` calls `createClient` directly. This is correct — Edge Functions run in Deno and cannot import the Astro `getDb()`. But it means there are two independent client-creation paths in the codebase, which is the correct separation for two different runtimes.

### P6. No DB logic exists in SQL beyond constraints and the `set_updated_at` trigger

The migrations define tables, indexes, constraints, and one trigger. There are no stored procedures, no RPC functions, no Row Level Security policies. All business logic lives in TypeScript. This is clean but means there is no DB-level authorization — the service-role key bypasses RLS.

### P7. The `updated_at` trigger and application-level update have no conflict

The `set_updated_at` trigger in the migration fires on every UPDATE and overwrites `updated_at` with `now()`. The TypeScript code in `monitors.ts` and `check-monitors/index.ts` does NOT set `updated_at` in any update payload — it relies on the trigger. This is correct.

---

## 9. DESIRED ARCHITECTURE

### Proposed boundary 1: API routes → `db/*` → Supabase

```
src/pages/api/*
        ↓
db/* exposed functions
        ↓
Supabase/Postgres
```

**Verdict: Possible but unnecessary.**

- The Astro app already has `src/lib/monitors.ts` as a clean DB boundary. API routes never touch `.from()` directly.
- Moving `monitors.ts` to `db/monitors.ts` changes the path but not the architecture.
- The Edge Function cannot import from this `db/` due to runtime differences (see §3).
- You'd need TWO entries in `db/` — one for Astro, one for Deno — defeating the purpose of a single `db/` directory.

### Proposed boundary 2: Edge Function → `db/` → Postgres

```
db/functions/check-monitors
        ↓
db database access
        ↓
Postgres
```

**Verdict: Problematic.**

- The Supabase CLI expects `supabase/functions/`. Moving `check-monitors` under `db/functions/` breaks `supabase functions serve`, `supabase functions deploy`, and the config.toml entrypoint/import_map paths.
- The Edge Function's `deno.json` import map and `_shared/` imports are self-contained. They don't benefit from being in a `db/` directory.
- The Edge Function creates its own Supabase client. It doesn't share client creation with the Astro app. Moving it doesn't reduce duplication.

### Overall assessment

The proposed `db/` boundary is:
- **Good in concept** (isolating DB access)
- **Already achieved** (`src/lib/monitors.ts` + `src/lib/db.ts` for Astro; `supabase/functions/` for Edge)
- **Technically problematic** if forced into a single top-level directory due to runtime split
- **Unnecessarily coupled** if it tries to share client creation between Node.js and Deno

---

## 10. RECOMMENDED MINIMAL ARCHITECTURE

Do NOT redesign the application. The current structure already achieves the goals. Here is the smallest viable structure with targeted fixes:

### What stays the same

```
src/lib/db.ts              → singleton client (Astro/Vercel)
src/lib/monitors.ts        → DB boundary (queries + business logic)
src/lib/database.types.ts  → generated types (Astro)
src/lib/http.ts            → HTTP helpers
src/shared/env.ts          → env validation (Astro)
src/shared/schemas.ts      → Zod schemas (API contract)
src/shared/logger.ts       → logging
src/pages/api/monitors/    → API routes (validate → delegate → respond)
src/pages/dashboard/       → SSR page (calls monitors.ts directly — correct)

supabase/config.toml       → CLI config (must stay here)
supabase/migrations/       → schema source of truth (must stay here)
supabase/functions/        → Edge Function (must stay here)
supabase/functions/_shared/database.types.ts → generated types (Deno)
supabase/functions/_shared/env.ts            → requireEnv helper
supabase/functions/_shared/monitor-check.ts  → HTTP check utility
```

### What changes

1. **Delete `MonitorStatus`** from `src/shared/types.ts` (dead code, §11).
2. **Delete `SUPABASE_ANON_KEY`** from `src/shared/env.ts` validation (unused, §6).
3. **Add a post-generate script** or CI check that verifies both `database.types.ts` files are semantically equal after `supabase gen types`.
4. **Optionally:** Rename `supabase/functions/_shared/env.ts` to `supabase/functions/_shared/require-env.ts` to avoid confusion with `src/shared/env.ts`.

### For every proposed file move: why it is necessary

**No files need to move.** Moving files under `db/` would:

- Break `supabase` CLI defaults
- Require `--config` flags on every CLI command
- Not reduce duplication (runtimes are different)
- Not simplify imports (Edge Function already has its own)

### For every file recommended deleting: what replaces it

| File to delete | Replacement |
|---|---|
| `MonitorStatus` from `src/shared/types.ts` | Nothing — it's dead code. The SQL CHECK constraint and `monitor-check.ts:15` local type already cover this. |
| `SUPABASE_ANON_KEY` from `src/shared/env.ts` | Nothing — no code uses it. Add it back when client-side Supabase is needed. |

### For every file recommended keeping: responsibility

| File | Responsibility |
|---|---|
| `src/lib/db.ts` | Singleton Supabase client creation (Astro/Vercel, server-only) |
| `src/lib/monitors.ts` | DB queries + business logic. The Astro app's DB boundary. |
| `src/lib/http.ts` | HTTP response helpers and error handling. No DB knowledge. |
| `src/lib/database.types.ts` | Auto-generated types for Astro TypeScript compilation |
| `src/shared/env.ts` | Zod-validated env access via `import.meta.env` (Astro-only) |
| `src/shared/schemas.ts` | Zod schemas — the API input contract |
| `src/shared/logger.ts` | Structured JSON logging |
| `src/shared/types.ts` | `LogLevel` type only (after removing `MonitorStatus`) |
| `src/pages/api/monitors/index.ts` | POST + GET handlers (validate → delegate → respond) |
| `src/pages/api/monitors/[id].ts` | PATCH + DELETE handlers (validate → delegate → respond) |
| `src/pages/dashboard/[username].astro` | SSR dashboard (calls `listMonitorsForUser` — correct SSR pattern) |
| `src/components/MonitorCard.astro` | UI component (accepts `Monitor` type for rendering) |
| `supabase/config.toml` | Supabase CLI configuration (must stay at `supabase/`) |
| `supabase/migrations/*.sql` | Schema source of truth (must stay at `supabase/migrations/`) |
| `supabase/functions/_shared/database.types.ts` | Auto-generated types for Edge Function Deno runtime |
| `supabase/functions/_shared/env.ts` | Runtime-agnostic `requireEnv` helper for Edge Functions |
| `supabase/functions/_shared/monitor-check.ts` | HTTP health-check classification (no DB) |
| `supabase/functions/check-monitors/index.ts` | Edge Function entry point (batch monitor checking) |
| `supabase/functions/check-monitors/deno.json` | Deno import map for the Edge Function |
| `supabase/functions/check-monitors/check-monitors.test.ts` | Deno tests for HTTP check logic |

---

## 11. RISKS / DRAWBACKS

### R1. No Row Level Security

The app uses the **service-role key** for all DB access, which bypasses RLS. This is fine for a server-only API but means:
- If the service-role key leaks, full DB access is compromised.
- There is no DB-level authorization — all access control is in TypeScript.
- If you ever add client-side Supabase calls, you must set up RLS policies.

### R2. `database.types.ts` divergence risk

Two generated files must stay in sync. If someone runs `supabase gen types` and only copies to one location, the other becomes stale. The current format differences (semicolons, quotes) make diffing harder.

**Mitigation:** Add a CI check or post-generate script that verifies both files are semantically equal.

### R3. No `SUPABASE_ANON_KEY` usage

The env is validated but unused. If you ever add client-side Supabase calls (e.g., real-time subscriptions, auth), you'll need it. Until then, it's dead config that could mask a typo or misconfiguration.

### R4. Business logic in `monitors.ts` could grow

The `updateMonitor` function contains schedule-recalculation logic. As the app grows, this module could accumulate more business rules. There's no current problem, but the temptation to add "just one more check" here is real.

### R5. Windows development path separators

The codebase uses forward slashes in imports (e.g., `../shared/env`), which works on Windows with Node.js. But the Edge Function's Deno imports use `.ts` extensions (`import { requireEnv } from "../_shared/env.ts"`), which is Deno-specific. This is correct for each runtime but means you cannot share import statements between them.

### R6. Hardcoded Edge Function URL in migration

`supabase/migrations/20260829092206_enable_pg_cron_check_monitors.sql:16` contains:

```sql
url := 'https://ahqicxezwyenwksbigzh.supabase.co/functions/v1/check-monitors'
```

This is a **hardcoded project ref** in a migration. If the project is cloned or the ref changes, this SQL breaks silently (pg_cron fires but hits a dead URL). This should ideally be parameterized or documented.
