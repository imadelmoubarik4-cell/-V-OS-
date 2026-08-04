// Reports runs in the isolated Phase 3 project while reading role-permitted
// source records from the production VÁ project. Production and branch schemas
// can differ during checkpoint development, so production REST projections are
// retried after unsupported fields are removed. Source tables are never changed.

const nativeFetch = globalThis.fetch.bind(globalThis);
const productionOrigin = "https://dnefgcmjcgxlynycxkts.supabase.co";

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

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const initialUrl = requestUrl(input);
  if (!initialUrl || initialUrl.origin !== productionOrigin || !initialUrl.pathname.startsWith("/rest/v1/")) {
    return nativeFetch(input, init);
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
