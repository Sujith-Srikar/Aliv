# HANDOFF

> For the next agent to continue this work with fresh context. Created from an in-progress build session.

## Goal

Build a passwordless uptime monitor (Astro on Vercel + Supabase Postgres/pg_cron + Edge Function worker) per
`V1-Plan.md` and `Build-Plan.md`, working phase-by-phase, stopping after each phase for user review.

Developer mode: **"lazy senior dev"** — minimal, reusable, YAGNI code; leave one runnable check; mark deliberate
corner-cuts with `ponytail:` comments.

**Hard rule from user (since Phase 2 review):** *"make sure all the files are with no errors, every file you committed
should not be with errors."* Both Deno and Astro projects must type-check clean and tests must pass.

## Current Progress

### Committed (git) — all green at commit time
- `e11005c` — Phase 0: git, Astro 5.18.2 + `@supabase/supabase-js` 2.112.4, `supabase init`, `.env.example`, `.gitignore`,
  `pnpm build` passes.
- `d910c2a` — Phase 1: migration `create_monitors_tables.sql` (users + monitors + CHECK constraints + partial index
  `monitors_due_idx` + `monitors_user_id_idx` + `updated_at` trigger). Applied to cloud, in-sync.
- `96302d3` — Phase 2: Edge Function `check-monitors` deployed to cloud `ahqicxezwyenwksbigzh` (bundles `_shared/`),
  `WORKER_SECRET` set, `verify_jwt=false`. 6 Deno unit tests pass. Live E2E verified (check flips row UP/DOWN, bad token 401).
- `935523c` — Validation infra: `@astrojs/check` + `typescript@~5.9.3` pinned, `"check": "astro check"` script,
  `tsconfig.json` excludes `dist` + `supabase/functions`.
- `b136483` — Phase 3: pg_cron scheduling. Migration schedules `check-monitors` every 10 min via `cron.schedule`
  (Vault secret referenced only). Auto-fire proven with temp every-minute job; cleaned up.
- `2da60d2` — Shared infra refactor (Phase 4 API + zod/env/schemas/logger + biome setup). See "Shared infra refactor" below.
- `414ff52` — Build: `nodeLinker: hoisted` in `pnpm-workspace.yaml` fixes the Windows `pnpm build` symlink EPERM.

### Phase 5 — Frontend (written, verified; NOT yet committed)
- `src/layouts/Layout.astro` (imports `global.css` in frontmatter so it's bundled), `src/styles/global.css`
  (clean light theme, CSS-vars, dialog/empty-state styles).
- `src/pages/index.astro` — username lookup form → redirects to `/dashboard/<username>`.
- `src/pages/dashboard/[username].astro` — SSR list via `listMonitorsForUser`, toolbar, empty state,
  `MonitorForm` dialog, and a vanilla-TS module script wiring create / edit / pause-resume / delete to the API
  (all mutations `location.reload()`). `export const prerender = false`.
- Components: `MonitorCard` (badge, meta dl, Pause/Resume, Edit, Delete with `data-*` attrs for the editor),
  `MonitorForm` (native `<dialog>`, options from `ALLOWED_INTERVALS`/`ALLOWED_TIMEOUTS`), `StatusBadge`
  (UP / DOWN / PENDING when never checked), `EmptyState`.
- Client payloads use real booleans (`{ isPaused: !paused }`) — no string-truthiness. Error responses surface
  the zod message from the API.
- Checks green: `pnpm check` 0/0, `pnpm biome:check` clean. Smoke-tested on dev server: dashboard renders card
  for created monitor, paused tag + Resume after PATCH, empty state after DELETE, index form present, client
  module script compiles (200). Test row deleted.

### Shared infra refactor (committed in `2da60d2`)
- Added `zod@4.4.3` + `@biomejs/biome@2.5.11` (devDep); conservative `biome.json` (recommended preset, single
  quotes, 2-space, w100). **Biome `.astro` caveat:** its analyzer sees frontmatter vars/imports used ONLY in the
  template as unused, so `biome.json` has an `overrides` entry for `**/*.astro` disabling `noUnusedVariables`
  + `noUnusedImports` (config key inside overrides is `linter.rules`, NOT `rules` — that's Biome 2.x).
  Note: `pnpm dev` first run after editing `biome.json` triggers a Vite re-optimize + slow `astro check` (~12s).

## What Worked

- **Cloud-only Supabase** (no Docker): `supabase link` + `db push` / `db query --linked`; never `supabase start`.
- **tsconfig split**: `tsconfig.json` excludes `supabase/functions` from the Astro check; Deno files checked separately
  with `deno check`. Astro TypeScript can't resolve `Deno.*` globals — this split is required and works.
- **Pin `typescript@~5.9.3`**: `@astrojs/check` cannot use the TS 7 native compiler (no programmatic API). Do NOT bump TS.
- **`@astrojs/vercel@9.0.5`** (NOT 11.x): v11 requires `astro ^7` and has no `./serverless` subpath. Correct setup:
  `import vercel from '@astrojs/vercel'` (non-deprecated), `adapter: vercel({})` (v9 serverless requires a config arg),
  `output: 'server'` (required for `.ts` API routes).
- **Vault for secret**: `worker_secret` via `vault.create_secret` (one-time manual step, not committed); mutations
  reference it by name via `decrypted_secrets`, keeping the raw secret out of code/migrations.
- **`supabase db query --linked -f file`** for running secret-bearing SQL from a temp file (kept off CLI and out of repo).
- **`cmd /c "supabase gen types ... > file"`** for proper UTF-8 output (PowerShell `>` writes UTF-16).
- **pnpm 24.11 fixed**: `pnpm-workspace.yaml` `allowBuilds: { esbuild: true, sharp: true }`.
- **pg_cron has NO `cron.schedule_in`** on this build — only `cron.schedule(job_name, schedule, command)`. Verify via `pg_proc`.
- Dev server (`pnpm dev`) works fine and is the reliable way to exercise API routes locally (Vercel adapter build not invoked).

## What Didn't Work (avoid repeating)

- **`@astrojs/vercel@11.0.8`** — broken (peer `astro ^7` mismatch, no `./serverless`). Leftover in pnpm store; ignore.
- **`pnpm build` symlink EPERM on Windows Node 24.19.0** — pnpm isolated `node_modules` symlinks + `@astrojs/vercel`
  `fs.symlink` recreation needs `SeCreateSymbolicLinkPrivilege`. **FIXED** via `nodeLinker: hoisted`, see BLOCKER below.

## BLOCKER — `pnpm build` Node 24 libuv crash — RESOLVED (root cause differed)

- Previous record blamed `nodejs/node#56645` (libuv async.c assert) on Node 24 / `withastro/astro#15115`.
  On retry, the libuv assert did NOT reproduce; the build reached `@astrojs/vercel`'s `astro:build:done`
  hook and failed differently:
  `EPERM: operation not permitted, symlink '.pnpm\zod@4.4.3\node_modules\zod' -> '.vercel\output\functions\_render.func\node_modules\zod'`.
- **Root cause**: pnpm's isolated linker creates `node_modules/*` as symlinks; `@vercel/nft` reports the
  symlink path, and `@astrojs/internal-helpers/fs::copyFilesToFolder` recreates it via
  `fs.symlink(target, dest, isDir ? 'dir' : 'file')` — real symlinks need `SeCreateSymbolicLinkPrivilege`
  (Windows Developer Mode / admin). Hence EPERM.
- **Fix**: `nodeLinker: hoisted` in `pnpm-workspace.yaml` (pnpm 11 ignores `.npmrc` `node-linker` — it must
  live in the workspace file). Fresh `node_modules` re-layout; `zod` is now a real directory.
- **Verified**: `pnpm build` exits 0 on Node 24.19.0; `.vercel/output/config.json`, `static/`,
  and `_render.func/node_modules/zod` all present. No Node downgrade needed.
- Checks still green after reinstall: `pnpm check` 0 errors, `pnpm biome:check` clean.

## Next Steps

1. **Phase 6 — production hardening** (per `Build-Plan.md`):
   - SSRF validation on URL (block private/loopback/link-local/metadata IPs) server-side at the trust boundary
     — the `ponytail:` deferral in the old validation layer; zod `url()` only checks scheme for now.
   - Rate limiting + request size limits on API routes.
   - Confirm service-role key never reaches the client bundle (`grep` the built output before/after Phase 7).
2. **Phase 7 — deploy**: `pnpm build` + `pnpm preview` sanity, push to GitHub, Vercel connect (build `pnpm build`),
   Supabase `db push` for any new migrations, set prod env vars (anon key in Vercel, service role + other secrets only in Supabase).
3. **Frontend (Phase 5)**: written + verified but **not committed** — commit after user review (suggested
   `feat(ui): dashboard + monitor CRUD frontend`).
4. **This file**: `HANDOFF.md` — update whenever state changes materially so the next agent starts fresh.

## Key Files & Env

- `V1-Plan.md`, `Build-Plan.md`, `SUPABASE-SKILL.md` — source plans. **Do NOT commit** (stay untracked).
- `.env` (gitignored): `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  (project `ahqicxezwyenwksbigzh`), `WORKER_SECRET=kgNXBv4b4xkaFCWX1UjPwXKmyoEnaIAoHCIhBYUJLQI=`.
- Migrations: `20260829080010_create_monitors_tables.sql`, `20260829092206_enable_pg_cron_check_monitors.sql`.
- Edge Function: `supabase/functions/check-monitors/index.ts` + `check-monitors.test.ts` (6 tests pass) +
  `supabase/functions/_shared/{database.types.ts,env.ts,monitor-check.ts}`.
- `astro.config.mjs`: `output:'server'`, `adapter: vercel({})` (import from `@astrojs/vercel`).
- `tsconfig.json`: extends astro strict; excludes `dist`, `supabase/functions`.
- `package.json`: `check: astro check`; devDeps `@astrojs/check@0.9.10`, `typescript@~5.9.3`.
- `src/lib/database.types.ts`: generated DB types (`Tables<'monitors'>`).
- `src/lib/http.ts`: `HttpError`, `ok/created/noContent/fail`, `readJson` (16KB), `handleError`
  (`ZodError` → 400 VALIDATION_ERROR, Postgres `23505` → 409, else `logger.error` + 500). Uses `src/shared/logger`.
- `src/shared/`: `types.ts`, `env.ts` (zod-validated `SUPABASE_URL/ANON/SERVICE_ROLE`), `schemas.ts`
  (create/update/list schemas + `ALLOWED_INTERVALS`/`ALLOWED_TIMEOUTS`), `logger.ts`.
- `src/lib/validation.ts` — **DELETED**, fully replaced by `src/shared/schemas.ts`.
- `src/lib/db.ts`: server-only service-role Supabase client from `src/shared/env`.
- `src/lib/monitors.ts`: `findOrCreateUser` (race-safe), `createMonitor`, `getMonitor`, `listMonitorsForUser`,
  `updateMonitor` (recomputes `next_check_at` on interval change / resume), `deleteMonitor`.
- `src/pages/api/monitors/index.ts` (POST/GET), `src/pages/api/monitors/[id].ts` (PATCH/DELETE).
- Frontend: `src/layouts/Layout.astro`, `src/styles/global.css`, `src/pages/index.astro`,
  `src/pages/dashboard/[username].astro` (SSR + vanilla-TS client), `src/components/{MonitorCard,MonitorForm,StatusBadge,EmptyState}.astro`.
- `pnpm-workspace.yaml`: `allowBuilds: { esbuild: true, sharp: true }` + **`nodeLinker: hoisted`** (required for
  `pnpm build` on Windows; pnpm 11 ignores `.npmrc` `node-linker` — must live in the workspace file).
- `biome.json`: `overrides` for `**/*.astro` disabling `noUnusedVariables`/`noUnusedImports` (template-scope false positives).
- Deno binary: `C:\Users\kandr\AppData\Local\Microsoft\WinGet\Packages\DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe\deno.exe`.
- Supabase CLI: global npm, v2.116.0.
