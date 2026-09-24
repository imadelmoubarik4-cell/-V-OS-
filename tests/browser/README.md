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

## CSS refactor evidence (`tools/`, not run by `npm run test:browser`)

- `tools/style-snapshot.mjs capture --out DIR` records, for admin and bartender
  at 1440/1024/768/390 and every view plus a few open states (Shifts Month,
  recipe detail, scanner, stock count, item master, FAB), the computed value of
  every CSS property of every element (and rendered `::before`/`::after`) and a
  screenshot, against the deterministic data in `tools/capture-fixtures.mjs`
  with a frozen clock. `diff BEFORE AFTER` lists every changed property.
  Two runs of the same tree produce identical snapshots.
- `tools/cascade-graph.mjs --out graph.json` records which pairs of CSS rules
  style the same element property (hover/focus rules included), with the
  specificity each matched with. Use it before moving rules between files or
  cascade layers: a move is safe when no such pair changes precedence.
