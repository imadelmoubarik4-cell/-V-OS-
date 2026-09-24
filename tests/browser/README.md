# Atlas browser tests

These tests run the real `apps/web` shell and runtime modules in Chromium with
a mocked Supabase backend (`harness.mjs`). No request reaches production.

Requirements: Playwright with a Chromium build, and the pinned browser
libraries (`@supabase/supabase-js@2.45.4`, `lucide@0.454.0`, optionally
`xlsx@0.18.5`) installed in `node_modules` or a directory named by
`ATLAS_BROWSER_LIBS`. Tests skip automatically when these are missing.

```sh
npm i --no-save @supabase/supabase-js@2.45.4 lucide@0.454.0 xlsx@0.18.5 playwright
npm run test:browser
```

Environment overrides: `ATLAS_BROWSER_LIBS` (library `node_modules`),
`ATLAS_PLAYWRIGHT` (Playwright package path), `ATLAS_CHROMIUM` (browser binary).
