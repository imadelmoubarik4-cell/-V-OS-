// Reports runs in the isolated Phase 3 project while reading role-permitted
// source records from the production VÁ project. Production and branch schemas
// can differ during checkpoint development, so production REST projections are
// retried after unsupported fields are removed. The private RPC payload is also
// normalized before calculation. Source tables are never changed.

const nativeFetch = globalThis.fetch.bind(globalThis);
const productionOrigin = "https://dnefgcmjcgxlynycxkts.supabase.co";
const branchOrigin = (() => {
  try {
    return new URL(Deno.env.get("SUPABASE_URL") || "").origin;
  } catch {
    return "";
  }
})();

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

function withUrl(input: RequestInfo | URL, url: URL): RequestInfo | URL {
  if (!(input instanceof Request)) return url;
  const method = input.method || "GET";
  return new Request(url.toString(), {
    method,
    headers: input.headers,
    body: method === "GET" || method === "HEAD" ? undefined : input.body,
    redirect: input.redirect,
    signal: input.signal,
  });
}

function missingColumn(message: string): string | null {
  const patterns = [
    /Could not find the ['\"]([^'\"]+)['\"] column/i,
    /column [^\s.]+\.([^\s]+) does not exist/i,
    /column ['\"]?([^'\"\s]+)['\"]? does not exist/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].replace(/[\"']/g, "").trim();
  }
  return null;
}

function normalizePackageSize(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  const number = normalized.match(/([0-9]+(?:[.,][0-9]+)?)/)?.[1]?.replace(",", ".");
  if (!number) return value;

  // Historical VÁ imports contain labels such as "250gr". The Reports SQL
  // parser understands canonical grams ("250 g"), while "250gr" previously
  // left a trailing "r" and caused a numeric-cast failure.
  if (/(?:^|[^a-z])(gr|gram|grams)(?:[^a-z]|$)/i.test(normalized)
      || /[0-9]\s*(gr|gram|grams)(?:[^a-z]|$)/i.test(normalized)) {
    return `${number} g`;
  }
  return value;
}

async function normalizedRpcRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: URL,
): Promise<{ input: RequestInfo | URL; init?: RequestInit }> {
  if (!branchOrigin
      || url.origin !== branchOrigin
      || url.pathname !== "/rest/v1/rpc/atlas_reports_snapshot_v2") {
    return { input, init };
  }

  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return { input, init };

  let bodyText = "";
  if (typeof init?.body === "string") bodyText = init.body;
  else if (input instanceof Request) bodyText = await input.clone().text();
  if (!bodyText) return { input, init };

  try {
    const payload = JSON.parse(bodyText);
    if (Array.isArray(payload?.p_inventory)) {
      payload.p_inventory = payload.p_inventory.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const row = { ...(item as Record<string, unknown>) };
        row.package_size = normalizePackageSize(row.package_size);
        return row;
      });
    }

    const nextInit: RequestInit = {
      ...(init || {}),
      method,
      body: JSON.stringify(payload),
    };
    if (input instanceof Request) {
      return {
        input: new Request(url.toString(), {
          method,
          headers: init?.headers || input.headers,
          body: nextInit.body,
          redirect: input.redirect,
          signal: init?.signal || input.signal,
        }),
      };
    }
    return { input: url, init: nextInit };
  } catch (error) {
    console.error("Reports RPC payload normalization failed", error instanceof Error ? error.message : "unknown");
    return { input, init };
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const initialUrl = requestUrl(input);
  if (!initialUrl) return nativeFetch(input, init);

  const normalized = await normalizedRpcRequest(input, init, initialUrl);
  input = normalized.input;
  init = normalized.init;

  if (initialUrl.origin !== productionOrigin || !initialUrl.pathname.startsWith("/rest/v1/")) {
    const response = await nativeFetch(input, init);
    if (!response.ok && initialUrl.pathname === "/rest/v1/rpc/atlas_reports_snapshot_v2") {
      console.error("Reports private RPC failed", response.status, await response.clone().text());
    }
    return response;
  }

  const url = new URL(initialUrl);
  const knownUnsupported = new Set(["brand", "subcategory", "needs_review"]);
  const originalSelect = url.searchParams.get("select");
  if (originalSelect) {
    const safeSelect = originalSelect
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value && !knownUnsupported.has(value));
    url.searchParams.set("select", safeSelect.join(","));
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await nativeFetch(withUrl(input, url), init);
    if (response.ok || response.status !== 400) return response;

    const body = await response.clone().text();
    let message = body;
    try {
      const parsed = JSON.parse(body);
      message = String(parsed?.message || parsed?.details || body);
    } catch {
      // Keep the response body as the diagnostic message.
    }

    const column = missingColumn(message);
    const select = url.searchParams.get("select");
    if (!column || !select) return response;

    const columns = select.split(",").map((value) => value.trim());
    const filtered = columns.filter((value) => value !== column && !value.endsWith(`.${column}`));
    if (filtered.length === columns.length) return response;
    url.searchParams.set("select", filtered.join(","));
  }

  return nativeFetch(withUrl(input, url), init);
}) as typeof fetch;

await import("./index.ts");
