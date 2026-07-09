/**
 * imagegen-extract — recover Codex image_gen outputs from session rollout JSONLs.
 *
 * WHY (2026-07-04): the Codex platform stopped emitting `saved_path` on
 * `image_generation_end` events (no file lands in ~/.codex/generated_images),
 * but the full base64 PNG still arrives in the event's `result` field inside
 * the session rollout. This tool writes those bytes back to real files so
 * image lanes can persist their own outputs (ai-architecture §6c(n),
 * codex-asset-generation-playbook.md "Output persistence").
 *
 * Usage:
 *   pnpm imagegen:extract -- --thread <thread-id-or-substring> --out <dir> [--since <ISO>]
 *
 * Finds the newest rollout-*.jsonl under ~/.codex/sessions matching the thread
 * substring, scans for image_generation_end events, and writes each result as
 * <out>/ig_<call_id-prefix>.png (skipping files that already exist). Exits 1
 * if no rollout or no images are found.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv: string[]): { thread: string; out: string; since?: Date } {
  let thread = "";
  let out = "";
  let since: Date | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") thread = argv[++i] ?? "";
    else if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--since") {
      const raw = argv[++i] ?? "";
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new Error(`--since is not a valid date: ${raw}`);
      since = parsed;
    }
  }
  if (!thread || !out) {
    throw new Error("Usage: pnpm imagegen:extract -- --thread <id-substring> --out <dir> [--since <ISO>]");
  }
  return { thread, out, since };
}

function findRollout(threadSub: string): string {
  const root = path.join(os.homedir(), ".codex", "sessions");
  if (!existsSync(root)) throw new Error(`sessions dir not found: ${root}`);
  const matches: { p: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(threadSub)) {
        matches.push({ p: full, mtime: st.mtimeMs });
      }
    }
  };
  walk(root);
  if (!matches.length) throw new Error(`no rollout matching "${threadSub}" under ${root}`);
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].p;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { thread, out, since } = parseArgs(args);
  const rollout = findRollout(thread);
  console.log(`[imagegen-extract] rollout: ${rollout}`);
  mkdirSync(out, { recursive: true });

  let rawImageEvents = 0;
  let claimMarkers = 0;
  let found = 0;
  let written = 0;
  const rl = createInterface({ input: createReadStream(rollout, { encoding: "utf8" }) });
  for await (const line of rl) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = evt.payload as Record<string, unknown> | undefined;
    const payloadType = typeof payload?.type === "string" ? payload.type : "";
    if (/image|saved_path|generated_images/i.test(line)) claimMarkers++;
    if (payloadType.includes("image_generation")) rawImageEvents++;
    // Platform shape change #3 (2026-07-07): base64 now arrives in the
    // `image_generation_call` response_item's `result`; the older
    // `image_generation_end` event kept an empty result. Accept BOTH shapes —
    // call_id dedup below makes double-reads harmless.
    const isImagePayload =
      payload && (payload.type === "image_generation_end" || payload.type === "image_generation_call");
    if (!isImagePayload) continue;
    if (since) {
      const ts = typeof evt.timestamp === "string" ? new Date(evt.timestamp) : null;
      if (ts && ts < since) continue;
    }
    const result = payload.result;
    if (typeof result !== "string" || result.length < 100) continue;
    found++;
    const rawCallId = payload.call_id ?? payload.id;
    const callId = typeof rawCallId === "string" ? rawCallId : `unknown_${found}`;
    const safeCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const file = path.join(out, `${safeCallId.slice(0, 72)}.png`);
    if (existsSync(file)) {
      console.log(`[imagegen-extract] exists, skipped: ${file}`);
      continue;
    }
    const bytes = Buffer.from(result, "base64");
    // PNG magic check — refuse to write garbage.
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      console.log(`[imagegen-extract] not a PNG, skipped call ${callId} (${bytes.length} bytes)`);
      continue;
    }
    writeFileSync(file, bytes);
    written++;
    console.log(`[imagegen-extract] wrote ${file} (${bytes.length} bytes)`);
  }

  console.log(
    `[imagegen-extract] ${found} generation event(s), ${rawImageEvents} raw image lifecycle event(s), ${written} file(s) written`,
  );
  if (found === 0) {
    if (claimMarkers > 0 || rawImageEvents > 0) {
      console.error(
        "[imagegen-extract] CANARY FAIL: rollout mentions image output but yielded 0 extractable image_generation_end payloads; Codex event schema may have changed.",
      );
    }
    console.error("[imagegen-extract] FAIL: no image_generation_end events with data found");
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
