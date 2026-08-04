// Reports runs in the isolated Phase 3 project while reading role-permitted
// source records from the production VÁ project. The production inventory
// schema intentionally does not include the branch-only review fields below.
// Remove those fields from the PostgREST projection before the main gateway
// loads, so Reports remains compatible without changing production tables.

const nativeFetch = globalThis.fetch.bind(globalThis);
const productionOrigin = "https://dnefgcmjcgxlynycxkts.supabase.co";
const unsupportedInventoryColumns = new Set([
  "brand",
  "subcategory",
  "needs_review",
]);

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const originalUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(originalUrl);

    if (url.origin === productionOrigin && url.pathname === "/rest/v1/inventory_items") {
      const select = url.searchParams.get("select");
      if (select) {
        const safeSelect = select
          .split(",")
          .map((column) => column.trim())
          .filter((column) => column && !unsupportedInventoryColumns.has(column))
          .join(",");
        url.searchParams.set("select", safeSelect);
      }

      if (input instanceof Request) {
        const method = input.method || "GET";
        const replacement = new Request(url.toString(), {
          method,
          headers: input.headers,
          body: method === "GET" || method === "HEAD" ? undefined : input.body,
          redirect: input.redirect,
          signal: input.signal,
        });
        return nativeFetch(replacement, init);
      }

      return nativeFetch(url, init);
    }
  } catch {
    // Preserve native fetch behaviour for non-URL inputs.
  }

  return nativeFetch(input, init);
}) as typeof fetch;

await import("./index.ts");
