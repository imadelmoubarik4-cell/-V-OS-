# Security model

Release 1 makes authorization depend on the active role stored in `public.profiles`. Authentication alone is not authorization.

## Access matrix

| Principal | Safe inventory catalogue | Cost-bearing inventory, suppliers, movements | Import batches and private files | Staging review | Staging and alias writes |
|---|---|---|---|---|---|
| Anonymous | No | No | No | No | No |
| Active bartender/viewer | Read via `inventory_catalog` | No | No | No | No |
| Active manager/admin | Read | Read/write | Read/write | Read and decision-only update | No |
| Trusted backend `service_role` | Uses canonical tables directly | Full | Full | Full | Full |
| Inactive profile | No | No | No | No | No |

`inventory_catalog` deliberately excludes supplier identifiers, cost prices, discounts, case costs, private notes, and source evidence. The raw `inventory_items`, `suppliers`, and `inventory_movements` tables require an active manager/admin profile.

## Authorization helpers

`private.is_active_staff()` and `private.is_manager_or_admin()`:

- use the server-controlled `public.profiles` row for `auth.uid()`;
- require `active = true`;
- keep authorization functions outside exposed schemas;
- use a fixed empty `search_path`;
- revoke execution from anonymous and service-key roles;
- never trust user-editable metadata.

The safe catalogue is implemented by a private, explicitly authorized function and a public `security_invoker` view. Browser clients must never receive a service-role or secret key.

## Import boundary

Managers/admins may create an upload batch, manage its private file, and review limited decision columns. Authenticated browser clients cannot insert staging rows, write aliases, or perform promotion. Those operations are reserved for a trusted backend worker.

## Migration rules

A.2 removes all existing policies on the inventory/import target tables before installing one deterministic policy set. This prevents older permissive policies from combining with manager-only policies. Anonymous grants are revoked, service-worker grants are explicit, and future public objects default to private.

The five migration files before A.1 were recovered from the hosted migration ledger. Their SQL bodies are hash-locked by `tests/node/security-contract.test.js`; do not rewrite them.

## Verification

Run locally:

```bash
npm run verify
git diff --check
```

A.2 must also be applied and exercised on a development Supabase database before production. Re-run Supabase security and performance advisors after that test deployment.
