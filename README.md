├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── src/
│   ├── components/
│   │   ├── EmptyState.astro
│   │   ├── MonitorCard.astro
│   │   ├── MonitorForm.astro
│   │   └── StatusBadge.astro
│   ├── layouts/
│   │   └── Layout.astro
│   ├── lib/
│   │   └── http.ts
│   ├── pages/
│   │   ├── api/
│   │   │   └── monitors/
│   │   │       ├── [id].ts
│   │   │       └── index.ts
│   │   ├── dashboard/
│   │   │   └── [username].astro
│   │   └── index.astro
│   └── styles/
│       └── global.css
├── shared/
│   ├── env.ts
│   ├── logger.ts
│   ├── schemas.ts
│   └── types.ts
├── supabase/
│   ├── types.ts
│   ├── db/
│   │   ├── client.ts
│   │   └── monitors.ts
│   ├── functions/
│   │   ├── _shared/
│   │   │   ├── env.ts
│   │   │   └── monitor-check.ts
│   │   └── check-monitors/
│   │       ├── .npmrc
│   │       ├── check-monitors.test.ts
│   │       ├── deno.json
│   │       ├── deno.lock
│   │       └── index.ts
│   ├── migrations/
│   │   ├── 20260829080010_create_monitors_tables.sql
│   │   └── 20260829092206_enable_pg_cron_check_monitors.sql
│   └── config.toml
├── .env.example
├── .gitignore
├── astro.config.mjs
├── biome.json
├── Build-Plan.md
├── CODING-GUIDELINES.md
├── HANDOFF.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── SUPABASE-SKILL.md
├── tsconfig.json
└── V1-Plan.md