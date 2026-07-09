import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetsRoot as defaultAssetsRoot, assetsMetadataRoot as defaultAssetsMetadataRoot } from "./toolkit-config.js";
import { AssetBank } from "./asset-bank.js";
import { apiDocsPayload, verifyRouteDocs } from "./api-docs.js";
import { defaultRepoRoots } from "./bank-repo-roots.js";

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isLoopbackOrigin(origin: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const portArg = args.find((arg) => /^\d+$/.test(arg));
const port = Number(portArg ?? argValue("--port") ?? "8765");
const assetsRoot = path.resolve(argValue("--assets-root") ?? defaultAssetsRoot());
const metadataRoot = path.resolve(argValue("--metadata-root") ?? argValue("--assets-metadata-root") ?? defaultAssetsMetadataRoot());
const sessionToken = process.env.DEVKIT_SESSION_TOKEN || randomBytes(24).toString("hex");

// Repo asset roots the bank catalogs alongside Z:/Assets (post-cel-pivot deliverables live
// here, not in Z:/Assets). READ-ONLY: browsed/reviewed, never promoted/mutated. Opt out with
// --no-repo-roots (kept for the scratch-fixture smoke, which drives a pure Z:/Assets bank).
const repoRoots = args.includes("--no-repo-roots") ? [] : defaultRepoRoots(repoRoot);

const routes = new Map<string, (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>>();
const bank = new AssetBank({ repoRoot, assetsRoot, metadataRoot, repoRoots, sessionToken, sendJson, sendText, readRequestJson });
bank.registerRoutes(routes);
routes.set("GET /api/docs", async (_request, response) => sendJson(response, 200, apiDocsPayload()));
// Fail closed: refuse to boot when the route table and the generated API docs drift.
verifyRouteDocs(["bank"], routes.keys());

let boundPort = port;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${boundPort}`);
  void (async () => {
    try {
      const origin = request.headers.origin;
      if (typeof origin === "string") {
        if (!isLoopbackOrigin(origin)) {
          sendJson(response, 403, { ok: false, error: "forbidden origin" });
          return;
        }
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        response.setHeader("access-control-allow-headers", "content-type,x-devkit-token");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session-token") {
        const selfOrigins = [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`];
        if (origin === undefined || selfOrigins.includes(origin)) sendJson(response, 200, { token: sessionToken });
        else sendJson(response, 403, { ok: false, error: "session token is same-origin only" });
        return;
      }
      if (request.method === "POST" && typeof origin === "string" && request.headers["x-devkit-token"] !== sessionToken) {
        sendJson(response, 403, { ok: false, error: "missing/invalid x-devkit-token (bank pages fetch /api/session-token; scripts read _review/.session-token)" });
        return;
      }
      const handler = routes.get(`${request.method} ${url.pathname}`);
      if (handler) {
        await handler(request, response, url);
        return;
      }
      if (request.method === "GET" && await bank.serveStatic(response, url.pathname)) return;
      sendText(response, 404, "Not found");
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

await bank.init();
// Fail LOUD, not silent: without this handler an EADDRINUSE (port already held) throws an
// unhandled 'error' event and the process dies with no output. When the DevKit launches this
// server detached, that read as "a cmd window flashed and nothing happened" (backlog p0). Log
// a clear line the launcher's captured log can surface, then exit non-zero.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Asset Bank could not start: port ${port} is already in use (another Asset Bank or process is bound to it).`);
  } else {
    console.error(`Asset Bank server error: ${error.message}`);
  }
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  boundPort = typeof address === "object" && address ? address.port : port;
  void writeFile(path.join(metadataRoot, "_review", ".session-token"), sessionToken, "utf8").catch(() => undefined);
  console.log(`GameKit Node Asset Bank: http://127.0.0.1:${boundPort}/_review/asset-review-server.html`);
  console.log(`Assets root: ${assetsRoot}`);
  console.log(`Metadata root: ${metadataRoot}`);
  if (repoRoots.length) console.log(`Repo roots (read-only): ${repoRoots.map((entry) => `${entry.origin}=${entry.root}`).join(", ")}`);
  const autoRescanMins = Number(argValue("--auto-rescan-mins") ?? "2");
  if (autoRescanMins > 0) {
    bank.startAutoRescan(autoRescanMins * 60_000);
    console.log(`Auto-rescan: every ${autoRescanMins}m (catalog self-heals; POST /api/catalog/rescan for immediate)`);
  }
});
