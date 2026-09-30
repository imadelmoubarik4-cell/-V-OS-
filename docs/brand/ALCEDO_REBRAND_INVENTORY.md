# ALCEDO Rebrand Inventory

Rebrand of the application UI from **Atlas** to **ALCEDO** on branch
`claude/alcedo-rebrand`. This documents what changed (user-visible), what was
deliberately preserved (internal identifiers), and the design system applied.

No production data, infrastructure names, or MFA enforcement were changed. No
merge or deploy is implied by this branch.

## Brand palette (ALCEDO logo kit v1)

| Token | Hex | Use |
|-------|-----|-----|
| Deep teal | `#08495C` | Primary brand, dark panels, accent text/links, focus ring |
| Orange | `#E8732A` | Vivid accent — primary CTAs (with ink text), nav indicator, ::selection |
| Warm ivory | `#F8F5ED` | App canvas background |
| Sage | `#B6C3B0` | Secondary/marketing surface |
| Ink | `#10201F` | Primary text; text colour on orange fills |

Semantic status colours are kept distinct from brand orange: positive green
`#047857`, warning amber (text `#b45309` / icon `#d97706`), danger red `#c42020`.

## Typography (self-hosted, OFL)

- **Instrument Serif** — display / headings (`--font-display`)
- **Manrope** — body / UI (`--font-sans`)
- **JetBrains Mono** — labels, eyebrows, numeric fields (`--font-mono`, selective)

woff2 files live in `apps/web/assets/fonts/`, loaded via `@font-face`
(`font-display: swap`) declared in `atlas-tokens.css`; the old Fraunces / IBM
Plex Google-Fonts links were removed from `index.html`, `invitation.html`,
`recovery.html`.

## Shape & depth (matches the Alcedo website)

Radii 12/16/20px (inputs/cards/dialogs) with pill buttons; soft teal-tinted
shadows; 3px teal focus ring.

## User-visible naming

- Atlas → **Alcedo** across visible copy (nav "Alcedo AI", omni "Search or ask
  Alcedo", "Create with Alcedo", marketing publish messages, Flavor Map
  "Alcedo-learned/curated", Reports/Knowledge copy, etc.).
- **Food Intelligence** is unchanged (not an Atlas-branded name).

## Logo & icons

The ALCEDO logo kit (open-A kingfisher mark + wordmark, teal + orange) was
swapped into the existing brand filenames under `apps/web/assets/brand/`
(filenames kept so internal paths are unchanged): `Atlas_Primary_*`,
`Atlas_Mark_*`, favicons, apple-touch, `favicon.svg`, and the web manifest
colours.

## AI mascot — genuine animated 3D kingfisher

The assistant mascot is an owner-approved **3D GLB** (Blender-authored, stylized
kingfisher), rigged and animated at runtime with Three.js:

- Model: `apps/web/assets/atlas-bot/alcedo-mascot.glb` (glTF v2, ~25k verts,
  vertex colours, no textures).
- Scene: `scripts/mascot/alcedo-glb-scene.src.mjs` → built by
  `scripts/build_atlas_mascot.mjs` to `apps/web/assets/atlas-bot/atlas-mascot-scene.js`
  (three + GLTFLoader bundled). Loads the GLB at runtime.
- Animations (node-transform rig, no skeleton): idle breathing, eye-squash
  blink, mirror-symmetric head turns (yaw capped ~20° to hide the head/body
  seam), speaking beak, wing lift (success), small jump (react/wake).
- Static fallback: `alcedo-mascot-poster.png` (idle front) and
  `alcedo-mascot-head.png` (small badge) — used for reduced-motion, no-WebGL,
  software renderer, Save-Data, and context-loss, via the existing `atlas-bot.js`
  guards. All assistant behaviour, controls, voice sessions, labels
  ("Alcedo, your assistant"), and the `window.AtlasBot` API are unchanged.
- Cache token `20260930-glb` on `atlas-bot.js`, the scene bundle, GLB, and
  posters.

## Login

The stale Atlas sign-in motion `<video>` was removed; the sign-in screen now
settles on the static ALCEDO stacked lockup. `atlas-signin-intro.js` no-ops
safely when no video is present.

## Preserved internal identifiers (NOT renamed)

JS globals (`window.Atlas*` — `AtlasShell`, `AtlasApi`, `AtlasBot`,
`AtlasFlavorMap`, `AtlasPlatformRules`, …), CSS class names (`.atlas-*`), element
ids (`#atlas-*`), `data-atlas-*` attributes, DB tables/RPCs, edge-function names,
storage/event keys, service-worker cache tags, the Lucide icon name `atlas-bot`,
brand asset **filenames** (`Atlas_*.svg/.jpg`), the web-manifest `id`/`scope`,
and production URLs. The evidence-type key `atlas_learned` and the
`AtlasPlatformRules` global were kept while their visible labels/copy were
rebranded.

## Tests

Full node suite green (`node --test tests/node/*.test.js packages/*/tests/*.test.js`
→ 1500 pass, 0 fail, 42 skipped). Updated for the rebranded reality:
`brand-kit-v1` (static sign-in lockup, no video), `flavor-ui`, `knowledge-workspace-ui`,
`reports-workspace-ui`, `platform-rules-s94` (copy Atlas→Alcedo),
`shell-contract-s88`, `s34-preproduction`, `stock-truth-recipes-s84`
(cache-token / hash pins). The mascot suite `atlas-bot.test.js` was rewritten to
the GLB contract (17/17). Browser tests (`atlas-bot.browser.test.mjs`,
`signin-intro.browser.test.mjs`) updated to the GLB + static-login reality.

## Known follow-ups

- `apps/web/assets/brand/Atlas_OpenGraph_1200x630.jpg` — social card regenerated
  with ALCEDO branding (see this branch); confirm it renders as expected.
- `apps/web/menu.html` (public VÁ venue menu) keeps its own VÁ palette and system
  fonts by design; not part of the Alcedo app chrome.
- The now-unreferenced sign-in motion files remain on disk only as a generic
  fixture for the Training browser tests; they are not served by the app.
