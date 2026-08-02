# Deployment

Netlify publishes `apps/web` as configured in `netlify.toml`. The application requires the existing Supabase project URL and publishable key in `apps/web/config.js`.

## Safe order

1. Run `npm run verify`.
2. Review the Git diff for source PDFs, quantities, costs, secrets, and generated private data.
3. Compare the repository migration versions with the hosted migration ledger.
4. Back up the production schema and affected inventory/import tables.
5. Apply and test A.2 on a development database.
6. Re-run Supabase security and performance advisors.
7. Apply the reviewed A.2 migration to production through the controlled migration workflow.
8. Deploy the static web directory.
9. Test manager/admin access, redacted staff reads, denied anonymous/bartender writes, queue upload, review, cancellation, retry, and deletion.

The five recovered migrations are already recorded on the hosted project and must not be manually replayed there. They exist so clean environments have the same history. A.2 is intentionally not applied merely by deploying this repository.
