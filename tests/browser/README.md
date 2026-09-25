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

## Writing tests: time and waiting

- **No wall clock.** Every page runs on a frozen clock: `launchAtlas` defaults
  `fixedTime` to `HARNESS_NOW` (Thursday 24 September 2026, 14:00 in
  Reykjavík). A test file with its own fixture time passes it as `fixedTime`.
  Fixture data is built from the same anchor (`fixtureTime(offsetMs)`,
  `HARNESS_NOW_MS`), never from `Date.now()` or `new Date()` in Node.
- **No fixed sleeps.** `page.waitForTimeout` is not used
  (`tests/node/browser-suite-hygiene.test.js` enforces it). Wait on the
  condition instead:
  - something in the page: `page.waitForSelector` / `page.waitForFunction`;
  - a request the page sends: `until(() => requestsTo(record, fn, action).length)`;
  - "nothing else happens": `settle(page)` (no mocked request in flight for
    50 ms, two animation frames, finite animations and transitions finished);
  - navigation: `navigateTo(page, hash)` or `openView(page, view)`;
  - retry or backoff windows: launch with `controlTimers: true` and call
    `advanceTimers(page, ms)` instead of sleeping through the window.

## Shell screenshots (`tools/shell-shots.mjs`, not run by `npm run test:browser`)

`node tests/browser/tools/shell-shots.mjs --out DIR [--quick]` captures the S88
shell (Home, Inventory, palette, notifications, account menu, More sheet,
overlay sidebar) for admin and bartender at 1440/1280/1024/768/430/390, plus
sign-in, invitation and recovery, for comparison with
`docs/design/atlas-reference.html`.

## CSS refactor evidence (`tools/`, not run by `npm run test:browser`)

- `tools/style-snapshot.mjs capture --out DIR` records, for admin and bartender
  at 1440/1024/768/390 and every view plus a few open states (Shifts Month,
  recipe detail, scanner, stock count, item master, palette), the computed value of
  every CSS property of every element (and rendered `::before`/`::after`) and a
  screenshot, against the deterministic data in `tools/capture-fixtures.mjs`
  with a frozen clock. `diff BEFORE AFTER` lists every changed property.
  Two runs of the same tree produce identical snapshots.
- `tools/cascade-graph.mjs --out graph.json` records which pairs of CSS rules
  style the same element property (hover/focus rules included), with the
  specificity each matched with. Use it before moving rules between files or
  cascade layers: a move is safe when no such pair changes precedence.
