# Phase 2 / P2.0 — Canonical Connection Center

## Decision

`atlas_private.integration_connections` is the only runtime and external-provider
connection registry. Existing Settings, System, Marketing and Operations surfaces
may retain compatibility fields, but they do not own connection truth.

Checkpoint K's `brain_data_connections` table remains an **evidence-readiness
registry**, not a second provider registry. Its `source_ref` values link relevant
evidence gates to the canonical connection row, and P2.0 exposes a derived Brain
projection containing both evidence readiness and provider health.

## Canonical states

Every active connection resolves to exactly one state:

- `not_configured`
- `authorization_required`
- `verifying`
- `healthy`
- `degraded`
- `expired`
- `blocked`
- `intentionally_disabled`

`healthy` cannot be written directly. It requires a completed controlled health
check with passed outcome and successful verification evidence. A previously
healthy connection becomes effectively degraded when its successful evidence is
older than its configured freshness window.

## Private data model

Four ordered migrations extend the canonical registry and add four private, RLS-protected tables:

- `connection_health_checks` — idempotent check attempts and sanitized evidence;
- `connection_events` — append-only state, check and capability history;
- `connection_capability_grants` — reviewed read/write/publish/admin capability state;
- `connection_dependencies` — modules and safety boundaries that depend on each connection.

Browser roles receive no direct grants. Public RPC wrappers are service-role only.
The browser uses the authenticated `atlas-connections` Edge Function, which
revalidates the production Auth user and active `public.profiles` record on every
request.

## Health-check protocol

Automated P2.0 checks cover:

- production Supabase Auth;
- production Data API and active-profile RLS path;
- Atlas private database RPC contract;
- Atlas Edge runtime;
- Atlas private profile-photo Storage bucket;
- public GitHub branch metadata;
- approved Netlify production or deploy-preview origin.

Manual evidence is explicit. Custom SMTP is healthy only after both an invitation
and a password-reset message are demonstrated as delivered. Unsupported or
unconfigured providers remain visible without being falsely marked healthy.

Every request carries a UUID request ID. Health-check creation is idempotent on
`connection_key + request_id`. Errors are returned through a bounded taxonomy:

- authentication expired;
- permission denied;
- provider rate limited;
- provider unavailable;
- connection timeout;
- invalid provider response;
- configuration missing;
- environment mismatch.

Raw provider responses, credentials, tokens and stack traces are not returned.

## Capability boundary

Each capability records kind, grant state, risk, manager-approval requirement and
review provenance. High-risk, write, publish and admin grants require an
administrator. The database hard-codes `automatic_execution_allowed = false`.

The following remain blocked:

- supplier order submission;
- automatic ordering;
- social publishing;
- production deployment from Atlas;
- automatic external side effects;
- uncontrolled production synchronization.

## Shared UI

The same authenticated Connection Center mounts in:

- **Settings → Integrations** for business-facing connection state and actions;
- **System → Integrations** for technical health, latency, freshness, capabilities,
  dependencies and event history.

The legacy integration cards are hidden rather than allowed to present a second
status model. No secret or privileged key is rendered.

## Release boundary

P2.0 is implemented on a stacked Phase 2 branch and isolated Supabase preview.
It does not authorize PR #5, production migration, automatic publication, supplier
submission or live-stock mutation.
