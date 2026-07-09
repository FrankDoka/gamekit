// DevKit session-token shim. Included by DevKit-served pages (zone-editor.html, index.html).
// Fetches the same-origin session token once and attaches it to every non-GET same-origin
// fetch, so the pages keep working after the CSRF gate (x-devkit-token) without touching
// each call site. See tools/src/devkit.ts local-safety gate.
(() => {
  const tokenPromise = fetch("/api/session-token")
    .then((r) => (r.ok ? r.json() : { token: "" }))
    .then((d) => d.token || "")
    .catch(() => "");
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const sameOrigin = url.startsWith("/") || url.startsWith(location.origin);
    if (method !== "GET" && sameOrigin) {
      const token = await tokenPromise;
      init = init || {};
      const headers = new Headers(init.headers || (typeof input !== "string" && input.headers) || {});
      if (token) headers.set("x-devkit-token", token);
      init = { ...init, headers };
    }
    return originalFetch(input, init);
  };
})();
