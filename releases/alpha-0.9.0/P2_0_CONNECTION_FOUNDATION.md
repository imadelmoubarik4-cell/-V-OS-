# P2.0 Connection Foundation — release record

## Scope

This milestone establishes one canonical connection registry, a controlled
health-check protocol, append-only event evidence, reviewed capability grants and
a shared Settings/System Connection Center API.

## Safety contract

- production Auth remains authoritative for identity;
- `public.profiles` remains authoritative for active roles;
- private connection tables are RLS protected and service-role only;
- no service-role key or provider credential reaches the browser;
- healthy state requires recent verification evidence;
- custom SMTP requires invitation and password-reset delivery evidence;
- high-risk capability grants require an administrator;
- automatic external execution remains hard-disabled;
- no supplier order, social post, production deployment or stock mutation occurs.

## Acceptance target

P2.0 closes when:

1. all migrations replay from an empty database;
2. the isolated preview migration applies successfully;
3. every private connection table has RLS and no browser grants;
4. the public RPC surface is service-role only;
5. automated core-platform checks create idempotent evidence;
6. completed checks and event history are immutable;
7. Settings and System render the same connection snapshot;
8. Brain receives the derived provider-health projection;
9. Node, Python, browser syntax, migration replay and Netlify preview checks pass;
10. production inventory remains unchanged.

## Deploy Preview gate

Browser acceptance may use only the exact Deploy Preview URL published by the
Netlify bot on this pull request. A guessed `deploy-preview-<number>` address is
not release evidence. Until Netlify publishes a successful deployment comment or
status for this PR, the web-preview gate remains blocked.

Owner-confirmed that the Netlify branch/deploy context for the PR #5 base branch
has been enabled. Commit `netlify: retrigger P2.0 preview after branch-context enablement`
exists only to request a fresh PR #8 Deploy Preview; it does not change runtime
behavior or authorize production deployment.

## Production boundary

This release record does not authorize production deployment. Phase 1 manual
security gates and its controlled production migration remain separate. P2.0
continues in preview until authenticated role acceptance is recorded.
