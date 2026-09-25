# Repository layout and rollback discipline

## Canonical deploy root

Netlify publishes only `apps/web`.

- `apps/web/index.html` is the single browser entry point.
- Browser styles, scripts, images and configuration belong under `apps/web`.
- The canonical recipe stylesheet is `apps/web/assets/css/recipes.css`.
- Atlas logos, favicons and platform icons live in `apps/web/assets/brand/`, byte-identical copies of the brand kit in `docs/brand/Atlas_Brand_Identity_Kit_v1.0/` (rules: `docs/brand/README.md`). Never redraw or re-export them.
- Do not add repository-root copies such as `index.html`, `index_atlas_all_fixes.html`, `recipes.css` or `atlas-icon.png`.
- Supabase migrations and Edge Functions remain under `supabase` and are not browser assets.

The Node contract `tests/node/repository-layout.test.js` protects this boundary so a legacy root file cannot silently become a second edit target.

## Shared Edge Function code

`supabase/functions/_shared` holds the canonical server domain layer. Functions import it with `../_shared/<module>.mjs`, which the Supabase bundler includes at deploy time; the `_`-prefixed folder is never deployed as a function.

- `stock-provenance.mjs`: stock evidence, trust states, the historical cutoff, the Reports stock and recipe reports.
- `atlas-domain.mjs`: stock projection, below par, recipe status, blockers and cost, order suggestions and inventory value. Each rule is a port of the browser rule it names and is parity-tested against the shipped browser modules (`tests/node/domain-parity-s88.test.js`).
- `auth.mjs`: caller authentication for every gateway (`resolveActor`, `requireRole`, `isManager`) and the one staff label (`actorLabel`: display name, otherwise "Team member", never an email address). No function calls `/auth/v1/user` itself or hard-codes an Auth project URL or publishable key; configuration comes from `ATLAS_AUTH_PROJECT_URL` / `ATLAS_AUTH_PUBLISHABLE_KEY` and an unconfigured function refuses every request (`tests/node/edge-auth-contract.test.js`).

Shared modules stay plain ESM with no Deno APIs so Node tests import them directly. A function that imports a shared module must list it among its reviewed sources in the release manifests (`tests/node/shared-modules-s88.test.js`); the runtime builders keep `_shared` beside the function folders.

`atlas-stock-counts` and `atlas-reports` deploy `entrypoint.ts` (`supabase/config.toml`). The former second stock-count implementation (`atlas-stock-counts/index.ts`) was deleted together with its S35 manifest and S33 fixture records; `atlas-reports/entrypoint.ts` only loads `index.ts`, which handles optional production columns explicitly.

## Rollback discipline

Before a checkpoint closure or high-risk migration pass:

1. Record the current pull-request head SHA.
2. Create a named safety branch at that exact commit.
3. Keep implementation commits focused and reversible.
4. Require the complete verification workflow before changing draft or merge status.
5. Never use a preview deployment as the only rollback reference.

For the Checkpoint K closure pass, the pre-change rollback branch is:

`safety/pr5-pre-k-closure-20260805`

It points to commit:

`0c0926e602f621845042d260dc1d9cd199dea9f4`

## Release boundary

A successful Netlify deploy proves that static assets were published; it does not replace database migration checks, contract tests, authenticated acceptance or production-data fingerprint verification. Pull requests remain draft until all required boundaries pass.
