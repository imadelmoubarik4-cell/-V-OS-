# Atlas Training — temporary hosted acceptance preview

**This branch and its PR are temporary and MUST NOT be merged.** They exist only to
drive a hosted end-to-end acceptance test of the Atlas Training MVP (PR #108) against a
**dedicated, temporary, non-production** Supabase project, using the repository's existing
GitHub → Netlify Deploy Preview integration.

- Base of the temporary PR: `claude/atlas-training-mvp` (so the diff is preview-wiring only).
- The temporary PR wires the frontend to a throwaway Supabase project (URL, publishable/anon
  key, Training endpoint, CSP `connect-src`) — **no secrets or service-role credentials**.
- On completion (pass or fail): the temporary Supabase project is deleted, this PR is closed,
  and this branch is deleted. PR #108 remains open, unmerged and unchanged at `5d0f019`.

No production Supabase project, Storage, data, migration, or the production Netlify site is
touched by this branch.
