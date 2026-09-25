// atlas-reports deploy entrypoint (supabase/config.toml). The handler lives in
// index.ts. Production reads handle optional columns explicitly there
// (OPTIONAL_PRODUCTION_COLUMNS: retried without the column and reported as
// missing data), and the private RPC payload is normalized by
// normalizeBranchRpcPayload before calculation. This file no longer replaces
// the global fetch. Source tables are never changed.

await import("./index.ts");
