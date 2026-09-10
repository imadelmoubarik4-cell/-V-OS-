# S33 runtime and recovery candidate

This is preparation in draft PR33. It does not authorize hosted execution or a
production change. The disposable database integration passed; real Auth,
Storage and gateway recovery acceptance is being verified separately.

The proposed runtime delta is
`supabase/s33/migrations/20260910205055_atlas_s33_runtime_delta.sql`.
Supabase CLI 2.117.0 allocated its filename. Its SHA-256 is
`a7f71345e453444974b320c4cd1263e1873c3876f57137e46c6ff6acf10dc5b6`.
`runtime-delta-audit.json` records every included/omitted statement and source
hash. The verification script checks the complete artifact and each included
statement. The original historical migration files are unchanged.

The delta requires the reviewed nine-entry core baseline, an absent
`atlas_private` schema, and the existing last-admin guard. It includes 1,365
statements in dependency order, omits 24 historical/sample statements and
excludes three unused experimental intelligence files. Historical System
health, deployment, incident and release claims are absent. Venue-specific
routine/equipment examples, marketing recommendations, prices and hours are
omitted. Ten neutral settings sections start in review status. Reference
categories/channels and disabled publication defaults remain explicit seeds.
The public Reports definition previously encoded to fit a connector payload
limit is readable SQL here; its decoded content hash is recorded in the audit.

The explicit order is runtime delta first, then
`20260910201435_atlas_s33_csv_import_pipeline.sql`. Both remain outside automatic
migrations. Do not run a directory-wide database push: filenames are allocation
identities, and the import migration depends on the runtime schema. A later
hosted execution package must record this exact order and the expected ledger
entries and verify the actual hosted fingerprint before changing it.

## Disposable recovery boundary

The pinned Supabase CLI creates `atlas-s33-source`, then an empty
`atlas-s33-recovery` in GitHub Actions. No hosted credential or target argument is
accepted. The six identities use synthetic `example.invalid` addresses. Email
is captured by local Mailpit; it is never delivered to a real mailbox. The local
Auth provider remains enabled while self-service signup is globally disabled.
The hosted S33 function artifact is unchanged. A separate generated CI build
pins functions to the CLI internal gateway, uses local API credentials and
removes declaration-only package imports. This distinction must remain visible
in the acceptance report; it is not proof of hosted deployment compatibility.

The test exercises login, active/inactive/missing profiles and manager/staff
permissions across all sixteen gateways. It uploads one private CSV through the
Storage API, reviews and publishes it through actual gateways, verifies retry
safety, and creates bounded synthetic message/campaign/schedule/Knowledge
records. Reset emails must contain working links, consumed links must fail,
expired links must fail, and the previous password must fail after reset.

Recovery captures application schema/data, synthetic Auth users/identities,
custom Auth trigger, Storage bucket settings/policies, and actual file bytes.
It stops and removes the source stack before creating the destination. Auth
identities are restored before the application's profile trigger, without
disabling triggers. Source sessions are excluded; old refresh tokens must fail.
The target must support fresh logins, private object upload/download with
identical bytes and owner/MIME/size, all gateway role checks and password reset.
Application table hashes must match before new journeys run, and retrying the
restored CSV publication must not change rows.

Only redacted acceptance evidence is retained in the public CI artifact for
30 days. Temporary identity/password-hash recovery material and local logs stay
on the disposable runner and are removed in cleanup. This is a reproducible
synthetic recovery drill, not a retained production backup. Hosted mail delivery,
operator browser acceptance, production backup custody and production recovery
objectives remain separate requirements.
