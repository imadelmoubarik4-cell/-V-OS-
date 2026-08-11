# Release 1 — secure foundation

## Completed locally

- Recovered the five hosted migration records that precede A.1, with their original timestamps, names, and SQL bodies.
- Replaced authentication-only inventory/import policies in pending A.2 with active manager/admin authorization.
- Revoked anonymous access to private inventory and import resources.
- Reserved staging-row and alias writes for the trusted backend `service_role`.
- Limited manager browser reviews to decision columns.
- Restricted the private import bucket to active manager/admin accounts.
- Added `inventory_catalog`, a cost-redacted read model for active bartenders/viewers.
- Added migration-integrity and authorization regression tests.

## Production status

This checkpoint is local only. No GitHub push, pull request, Supabase migration, production data import, or deployment has been performed.

The hosted project currently records the five recovered migrations plus A.1 as applied. A.2 remains pending and must first be tested on a development database.

## Next approval point

Release 2 begins with a GitHub draft PR and a production backup, followed by an A.2 test deployment on a development database. Production remains unchanged until those results are reviewed.
