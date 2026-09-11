# S34 visual evidence

- The 15-page user-supplied source PDF is mapped in
  `docs/release/Atlas_S34_Launch_Fix_Checklist.md` but is not copied into Git
  because its screenshots contain a real staff name.
- `tests/fixtures/s34-visual-review.html` is the network-free after-state visual
  contract for all 12 affected modules and desktop/mobile modes.
- `.github/workflows/s34-visual-evidence.yml` renders that fixture in a pinned
  headless Chromium runner with all non-file requests blocked. Its single
  `atlas-s34-synthetic-visual-evidence` artifact contains 24 PNGs, an HTML
  gallery, and a SHA-256 manifest: every module at 1440 x 900 and 390 x 844.
- The source PDF remains the before-state reference outside Git. The automated
  artifact supplies sanitized after-state evidence without using a hosted
  preview or copying production/staff data into the repository.

Do not interpret these artifacts as staging or production acceptance.
