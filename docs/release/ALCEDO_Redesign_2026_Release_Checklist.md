# ALCEDO redesign 2026 — release checklist and rollback

Scope: **frontend only** (`apps/web`, tests, docs). PR #142, branch
`claude/alcedo-full-redesign`. No Supabase migration, RLS, RPC or edge function
changes; no database writes; no backend deploy. Netlify publishes `apps/web`
from `main`, so merging PR #142 into `main` is the production release.

## 1. Rollback point (record before merging)

| Item | Value |
| --- | --- |
| Production commit before the release | `main` @ `4b814c4` (merge of PR #141) — re-check `git rev-parse origin/main` at release time |
| Git tag to create on that commit | `pre-redesign-2026` |
| Netlify | the production deploy built from that commit stays in Deploys; "Publish deploy" on it restores the previous frontend in seconds |
| Service worker | the redesign ships cache `alcedo-shell-v4`; a rollback deploy serves its own worker and cache name, and `config.js` is network-first, so clients pick the rollback up on the next load |

Rollback options, fastest first:
1. Netlify → Deploys → the pre-release production deploy → **Publish deploy**.
2. `git revert -m 1 <merge commit>` on `main` and push (Netlify rebuilds).
3. Reset `main` to `pre-redesign-2026` only with the owner's explicit agreement.

## 2. Gates before merging (all must hold on the final head)

- [ ] Owner's explicit go-ahead in the session (not only a PR comment).
- [ ] CI green on the PR head: `contracts`, `replay`, `Browser tests`, `S34 evidence`.
- [ ] Local: `npm test`, `python -m unittest discover -s tests/python`, full browser suite;
      known environment-only failures identical on `main` (live-voice timeouts under
      concurrency, `atlas-bot` "WebGL in software").
- [ ] No files under `supabase/` or `.github/` changed (`git diff --stat origin/main -- supabase .github` is empty).
- [ ] CSP in `netlify.toml` contains no new hosts (the Lucide CDN entry is removed, nothing added).
- [ ] `docs/release/Atlas_S42_Production_Cutover_Manifest.json` pins match the final files (python tests).
- [ ] Every changed asset carries a new `?v=` key (`tests/node/asset-version-ratchet.test.js`).
- [ ] Branch is up to date with `main` and merges without conflicts.

## 3. Release steps

1. Create the rollback tag on the current production commit and push it.
2. Mark PR #142 ready for review, merge with a merge commit (keeps the history and gives one commit to revert).
3. Watch the Netlify production deploy for `main` until it is published.

## 4. Smoke tests on the live app (record results in the PR)

- [ ] `/` loads the redesigned sign-in screen; `site.webmanifest`, fonts (IBM Plex) and `alcedo-icons.js` load from the app origin with 200.
- [ ] Sign in as an admin: Home, sidebar (17 items) and every module route opens without console errors.
- [ ] A bartender account sees its 10 items; admin-only routes show the "for managers/administrators" state.
- [ ] Bookings: day view, floor plan, open a request, the add-booking sheet (no submit unless a test booking is agreed).
- [ ] Inventory list and a stock-count screen; Recipes detail; Messages thread; Alcedo AI opens with the composer.
- [ ] Icelandic text renders (á ð þ æ ö) in names and menus; prices show as `1.500 kr`.
- [ ] Phone width: tab bar, More sheet, top bar, no horizontal scroll.
- [ ] Service worker: a second load works offline for the shell; a hard reload shows the new `?v=` assets.

## 5. Out of scope (separate approval)

The platform audit's backend and database findings (two security findings among
them) are not part of this release. They need their own reviewed change, tests
and deployment approval.
