/**
 * TOOLSUITE-P4 acceptance demo (b): an AI session drives the full dev loop end-to-end
 * through the hub + bank API, UNATTENDED — no browser, no terminal babysitting. Proves
 * the "10/10 AI-operability" acceptance criterion (proposal §8b): every hub action exists
 * as a clean authenticated API.
 *
 * It exercises each stage of a dev day purely over HTTP:
 *   1. boot/visibility — hub + bank health, world dashboard
 *   2. discover        — API reference (GET /api/docs) so the AI needs no server source
 *   3. review          — list a batch, record a decision (write gated to a scratch bank)
 *   4. promote-check   — promotion-readiness / quality gate
 *   5. zone loop       — validate → sync → export → build → restart → reload (dry-run)
 *   6. inspect         — logs, pipeline, captures
 *
 * Auth: state-changing POSTs carry the invisible token. A local CLI with no Origin header
 * is trusted, but this demo still sends x-devkit-token to prove the documented token path
 * an AI session would use (token files: tools/devkit/.session-token,
 * <metadata-root>/_review/.session-token).
 *
 * Usage:
 *   pnpm demo:ai-dev-loop                        # read-only against the running hub/bank
 *   pnpm demo:ai-dev-loop -- --devkit http://127.0.0.1:8787 --bank http://127.0.0.1:8765
 *   pnpm demo:ai-dev-loop -- --write             # also records ONE review decision
 *                                                #   (only safe against a scratch bank)
 *
 * Exit code 0 = every stage passed. Non-zero = a stage failed (CI/agent friendly).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetsMetadataRoot } from "./toolkit-config.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const argVal = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEVKIT = argVal("--devkit", "http://127.0.0.1:8787").replace(/\/$/, "");
const BANK = argVal("--bank", "http://127.0.0.1:8765").replace(/\/$/, "");
const WRITE = args.includes("--write");

function readToken(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}
const devkitToken = readToken(path.join(repoRoot, "tools", "devkit", ".session-token"));
const bankToken = readToken(argVal("--bank-token-file", path.join(assetsMetadataRoot(), "_review", ".session-token")));

type StageResult = { stage: string; ok: boolean; detail: string };
const results: StageResult[] = [];
function record(stage: string, ok: boolean, detail: string): void {
  results.push({ stage, ok, detail });
  console.log(`${ok ? "  ok " : " FAIL"}  ${stage.padEnd(22)} ${detail}`);
}

/** Union of the response fields this demo reads across the DevKit/bank endpoints. */
interface DemoJson {
  ok?: boolean;
  health?: { service: string; status: string }[];
  totals?: { maps?: number; npcs?: number };
  online?: { serverReachable?: boolean };
  routes?: unknown[];
  auth?: { model?: string };
  assets?: { id?: string }[];
  total?: number;
  count?: number;
  counts?: { accepted?: number; promoted?: number; placedPromoted?: number };
  steps?: { name: string; ok: boolean }[];
  lines?: unknown[];
  groups?: { captures?: unknown[] }[];
}

async function getJson(base: string, pathName: string): Promise<DemoJson> {
  const r = await fetch(`${base}${pathName}`);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${pathName} -> ${r.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}
async function postJson(base: string, pathName: string, body: unknown, token: string): Promise<DemoJson> {
  const r = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-devkit-token": token },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${pathName} -> ${r.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<void> {
  console.log(`AI dev-loop demo — devkit=${DEVKIT} bank=${BANK} write=${WRITE}\n`);

  // 1. boot / visibility -------------------------------------------------------
  try {
    const hub = await getJson(DEVKIT, "/api/hub/status");
    const health = await getJson(DEVKIT, "/api/hub/health");
    const services = (health.health ?? []).map((h) => `${h.service}:${h.status}`).join(" ");
    record("boot/visibility", hub.ok === true && Array.isArray(health.health), `prefs+${(health.health ?? []).length} services [${services}]`);
  } catch (e) {
    record("boot/visibility", false, String(e));
  }
  try {
    const world = await getJson(DEVKIT, "/api/hub/world");
    record("world-dashboard", world.ok === true, `${world.totals?.maps ?? 0} maps, ${world.totals?.npcs ?? 0} NPCs, server ${world.online?.serverReachable ? "up" : "down"}`);
  } catch (e) {
    record("world-dashboard", false, String(e));
  }

  // 2. discover the API without reading server source --------------------------
  try {
    const docs = await getJson(DEVKIT, "/api/docs");
    const n = (docs.routes ?? []).length;
    record("discover-api", docs.ok === true && n > 0, `${n} documented routes; auth model: ${docs.auth?.model ?? "?"}`);
  } catch (e) {
    record("discover-api", false, String(e));
  }

  // 3. review a batch ----------------------------------------------------------
  let sampleAssetId = "";
  try {
    const list = await getJson(BANK, "/api/assets?limit=25&offset=0");
    sampleAssetId = list.assets?.[0]?.id ?? "";
    record("review-list", typeof list.total === "number", `${list.total} assets in catalog, page of ${list.count}`);
  } catch (e) {
    record("review-list", false, String(e));
  }
  if (WRITE && sampleAssetId) {
    try {
      const res = await postJson(BANK, "/api/review", { id: sampleAssetId, decision: "promote-later", notes: "ai-dev-loop-demo" }, bankToken);
      record("review-write", res.ok === true, `recorded promote-later on ${sampleAssetId} (scratch bank)`);
    } catch (e) {
      record("review-write", false, String(e));
    }
  } else {
    record("review-write", true, WRITE ? "skipped (no sample asset)" : "skipped (read-only; pass --write against a scratch bank)");
  }

  // 4. promotion-readiness gate ------------------------------------------------
  try {
    const pipeline = await getJson(DEVKIT, "/api/hub/pipeline");
    record("promote-check", pipeline.ok === true, `${pipeline.counts?.accepted ?? 0} accepted, ${pipeline.counts?.promoted ?? 0} promoted, ${pipeline.counts?.placedPromoted ?? 0} placed`);
  } catch (e) {
    record("promote-check", false, String(e));
  }

  // 5. zone loop (dry-run — proves the whole pipeline is one authenticated call) --
  try {
    const loop = await postJson(DEVKIT, "/api/hub/zone-loop", { mapId: "map_harbor_outskirts", dryRun: true }, devkitToken);
    const steps = (loop.steps ?? []).map((s) => `${s.name}${s.ok ? "" : "!"}`).join("→");
    record("zone-loop", loop.ok === true && (loop.steps ?? []).length === 6, `dry-run ${steps}`);
  } catch (e) {
    record("zone-loop", false, String(e));
  }

  // 6. inspect logs & captures -------------------------------------------------
  try {
    const logs = await getJson(DEVKIT, "/api/hub/logs?log=server&lines=20");
    record("inspect-logs", logs.ok === true && Array.isArray(logs.lines), `server.log tail: ${logs.lines?.length ?? 0} lines`);
  } catch (e) {
    record("inspect-logs", false, String(e));
  }
  try {
    const caps = await getJson(DEVKIT, "/api/hub/captures");
    const total = (caps.groups ?? []).reduce((a: number, g) => a + (g.captures?.length ?? 0), 0);
    record("inspect-captures", caps.ok === true, `${total} capture PNGs across ${(caps.groups ?? []).length} groups`);
  } catch (e) {
    record("inspect-captures", false, String(e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `FAILED — ${failed.length}/${results.length} stages` : `PASS — all ${results.length} stages drivable via API`}`);
  process.exit(failed.length ? 1 : 0);
}

void main().catch((e) => {
  console.error(`ai-dev-loop demo crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
