# Repository layout and rollback discipline

## Canonical deploy root

Netlify publishes only `apps/web`.

- `apps/web/index.html` is the single browser entry point.
- Browser styles, scripts, images and configuration belong under `apps/web`.
- Do not add repository-root copies such as `index.html`, `index_atlas_all_fixes.html`, `recipes.css` or `atlas-icon.png`.
- Supabase migrations and Edge Functions remain under `supabase` and are not browser assets.

The Node contract `tests/node/repository-layout.test.js` protects this boundary so a legacy root file cannot silently become a second edit target.

## Rollback discipline

Before a checkpoint closure or high-risk migration pass:

1. Record the current pull-request head SHA.
2. Create a named safety branch at that exact commit.
3. Keep implementation commits focused and reversible.
4. Require the complete verification workflow before changing draft or merge status.
5. Never use a preview deployment as the only rollback reference.

For the Checkpoint K closure pass, the pre-change rollback branch is:

` safety/pr5-pre-k-closure-20260805 `

It points to commit:

`0c0926e602f621845042d260dc1d9cd199dea9f4`

## Release boundary

A successful Netlify deploy proves that static assets were published; it does not replace database migration checks, contract tests, authenticated acceptance or production-data fingerprint verification. Pull requests remain draft until all required boundaries pass.
