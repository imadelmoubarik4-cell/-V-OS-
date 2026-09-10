# S33 disposable runtime integration

This draft change prepares a PostgreSQL 17 integration experiment for the S33
review package. It is Git-only and does not authorize a hosted migration,
deployment, email, Auth setting change, preview publication or production action.

The 64 fingerprinted historical SQL sources in
`tests/fixtures/s33-runtime-sources.json` form an experimental dependency order.
They are **not** a hosted deployment allowlist. A successful replay is necessary
but insufficient for approving a runtime delta: historical seed/status records,
object changes and runtime fixture limits still need review. In particular,
historical System status records must not count as current acceptance evidence.
The later PR27 data-only release-closure migration is excluded.

The workflow uses a dedicated GitHub Actions PostgreSQL 17 service with only
`contents: read` permission and an ephemeral synthetic password. It contains no
hosted credentials or deployment commands. The runner refuses use outside that
CI service; do not falsify its environment guard to run it on another database.

The runner reconstructs the committed core schema and the nine accepted
version/name pairs. Its ledger statements and Auth identities are synthetic;
they are not an exact export or fingerprint match of hosted S32. It checks both
an empty baseline (required by the existing rollback-only core tests) and a clone
with one synthetic active administrator. It verifies protected rows and the
last-admin function remain intact while applying the runtime sources.

Further checks cover the existing role, recipe and purchase-order SQL tests,
the security gate, existence and effective execute privileges for 96 literal
runtime RPC names, a private import-review decision with audit/source retention,
and native dump/restore with all application row contents compared. RPC presence
does not prove all signatures, PL/pgSQL branches or handler authorization work.
No Deno handler, managed Auth login, email or Storage-byte restore is exercised.

The import-review test intentionally demonstrates that review approval does not
write canonical inventory. The browser upload queue and private review schema
remain separate. A trusted upload/extraction mapping and atomic promotion worker
are still missing; the existing local PDF extractor and private-export validator
do not fill this gap. Do not describe this test as end-to-end CSV import.

CI stores synthetic acceptance JSON and a native database dump for seven days.
All databases disappear with the disposable service. Full-stack recovery and
hosted staging acceptance remain open after this check.

The earlier S33 offline runtime ZIP remains separately reviewable at its saved
SHA-256 `c7b907deb502e77d0383744e9b73fdc973cb5274990be2e1881b3e6b355c1112`.
Its prior temporary preparation commit is unavailable in this restored checkout.
This change starts from reviewed revision
`6608eb791a8c06dd183f32b499c03dc5f3c07f87`; it does not claim to contain that missing
commit or its builder tests.
