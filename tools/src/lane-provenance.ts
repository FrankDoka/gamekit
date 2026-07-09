/**
 * lane-provenance — writes the per-lane lineage record required by the
 * Integrator Conductor Loop without coupling it to lane-close.
 *
 * Usage:
 *   pnpm lane:provenance --lane <lane> --card <card.md> --engine codex|agent \
 *     --model <model> --thread-id <id> --prompt-file <file> \
 *     --merged-commit <hash> --gate "pnpm validate=PASS"
 *
 * Optional JSON payloads:
 *   --asset-json <file>   {source_inputs?:[], bank_paths?:[], qa_verdicts?:[]}
 *   --gates-json <file>   object or array of {name,result,detail?}
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type GateResult = {
  name: string;
  result: string;
  detail?: string;
};

type AssetPayload = {
  source_inputs?: unknown[];
  bank_paths?: unknown[];
  qa_verdicts?: unknown[];
};

type Provenance = {
  schemaVersion: 1;
  lane: string;
  card: string;
  engine: string;
  model: string | null;
  thread_id: string | null;
  prompt_hash: string | null;
  prompt_source: string | null;
  merged_commit: string;
  gate_results: GateResult[];
  asset?: {
    source_inputs: unknown[];
    bank_paths: unknown[];
    qa_verdicts: unknown[];
  };
  generated_at: string;
};

const ROOT = process.cwd().replace(/\\/g, "/");

function usage(): never {
  console.error(
    [
      "usage: pnpm lane:provenance --lane <lane> --card <card.md> --engine <engine> --merged-commit <hash>",
      "       [--model <model>] [--thread-id <id>] [--prompt-file <file>|--prompt-text <text>]",
      "       [--gate name=result] [--gates-json <file>] [--asset-json <file>]",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = argv[++i];
    if (!value) usage();
    (out[key] ??= []).push(value);
  }
  return out;
}

function one(args: Record<string, string[]>, key: string): string | null {
  return args[key]?.[0] ?? null;
}

function required(args: Record<string, string[]>, key: string): string {
  const value = one(args, key);
  if (!value) {
    console.error(`[lane-provenance] missing --${key}`);
    usage();
  }
  return value;
}

function resolveRepoPath(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return normalized;
  return join(ROOT, normalized).replace(/\\/g, "/");
}

function repoRelative(file: string): string {
  const abs = resolveRepoPath(file);
  const rel = relative(ROOT, abs).replace(/\\/g, "/");
  return rel.startsWith("..") ? abs : rel;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolveRepoPath(file), "utf8"));
}

function parseGate(value: string): GateResult {
  const [name, ...rest] = value.split("=");
  if (!name || rest.length === 0) {
    throw new Error(`--gate must be name=result, got ${value}`);
  }
  const resultAndDetail = rest.join("=");
  const [result, ...detailParts] = resultAndDetail.split("|");
  return {
    name: name.trim(),
    result: result.trim(),
    ...(detailParts.length ? { detail: detailParts.join("|").trim() } : {}),
  };
}

function parseGates(args: Record<string, string[]>): GateResult[] {
  const gates: GateResult[] = [];
  for (const raw of args.gate ?? []) gates.push(parseGate(raw));
  const gatesJson = one(args, "gates-json");
  if (gatesJson) {
    const parsed = readJson(gatesJson);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const gate = item as Partial<GateResult>;
        if (gate.name && gate.result) gates.push({ name: gate.name, result: gate.result, detail: gate.detail });
      }
    } else if (parsed && typeof parsed === "object") {
      for (const [name, result] of Object.entries(parsed as Record<string, unknown>)) {
        gates.push({ name, result: String(result) });
      }
    }
  }
  return gates;
}

function parseAssetPayload(args: Record<string, string[]>): Provenance["asset"] | undefined {
  const assetJson = one(args, "asset-json");
  if (!assetJson) return undefined;
  const parsed = readJson(assetJson) as AssetPayload;
  return {
    source_inputs: Array.isArray(parsed.source_inputs) ? parsed.source_inputs : [],
    bank_paths: Array.isArray(parsed.bank_paths) ? parsed.bank_paths : [],
    qa_verdicts: Array.isArray(parsed.qa_verdicts) ? parsed.qa_verdicts : [],
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const lane = required(args, "lane");
  const card = repoRelative(required(args, "card"));
  const engine = required(args, "engine");
  const mergedCommit = required(args, "merged-commit");
  const promptFile = one(args, "prompt-file");
  const promptText = one(args, "prompt-text");
  if (promptFile && promptText) {
    console.error("[lane-provenance] choose either --prompt-file or --prompt-text, not both");
    return 2;
  }

  const promptSource = promptFile ? repoRelative(promptFile) : promptText ? "inline" : null;
  const promptContent = promptFile ? readFileSync(resolveRepoPath(promptFile), "utf8") : promptText;
  const provenance: Provenance = {
    schemaVersion: 1,
    lane,
    card,
    engine,
    model: one(args, "model"),
    thread_id: one(args, "thread-id"),
    prompt_hash: promptContent ? sha256Text(promptContent) : null,
    prompt_source: promptSource,
    merged_commit: mergedCommit,
    gate_results: parseGates(args),
    asset: parseAssetPayload(args),
    generated_at: new Date().toISOString(),
  };

  const outDir = join(ROOT, "docs", "provenance");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${lane}.json`);
  writeFileSync(out, JSON.stringify(provenance, null, 2) + "\n", "utf8");
  console.log(`[lane-provenance] wrote ${repoRelative(out)}`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[lane-provenance] ${(error as Error).message}`);
  process.exit(1);
}
