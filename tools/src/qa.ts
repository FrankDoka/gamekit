import { spawnSync } from "node:child_process";

/**
 * `pnpm qa` — the standard local battery, one command (A7 quick-win: product-verb grouping).
 *
 * Runs the same gates a lane runs before READY, in order, and prints a pass/fail summary
 * footer so a contributor sees the whole board at a glance instead of stitching four
 * scrollbacks. Stops at the first failure (a green footer means every leg passed). Each leg
 * is an existing root script — qa groups them, it does not reimplement any gate.
 *
 *   validate      typecheck + manifests + cohesion + asset/zone/ui gates (the CI gate)
 *   build:client  Vite production build
 *   smoke:client  headless client smoke
 *
 * `pnpm qa --no-smoke` skips the smoke leg (needs a booted stack); useful for a fast
 * type/build check. Any other args are rejected so typos don't silently no-op.
 */

type Leg = { name: string; script: string };

const args = process.argv.slice(2);
const skipSmoke = args.includes("--no-smoke");
const unknown = args.filter((a) => a !== "--no-smoke");
if (unknown.length > 0) {
  console.error(`[qa] unknown argument(s): ${unknown.join(" ")} — supported: --no-smoke`);
  process.exit(2);
}

const legs: Leg[] = [
  { name: "validate", script: "validate" },
  { name: "build:client", script: "build:client" },
  ...(skipSmoke ? [] : [{ name: "smoke:client", script: "smoke:client" }]),
];

const results: Array<{ name: string; ok: boolean; ms: number }> = [];
let failed = false;

for (const leg of legs) {
  const started = Date.now();
  console.log(`\n[qa] > ${leg.name} (pnpm ${leg.script})`);
  // shell:true so Windows resolves pnpm -> pnpm.cmd (a direct .cmd spawn errors EINVAL on
  // modern Node). The script name is a fixed literal from `legs`, never user input.
  const run = spawnSync(`pnpm ${leg.script}`, { stdio: "inherit", shell: true });
  const ms = Date.now() - started;
  const ok = run.status === 0;
  results.push({ name: leg.name, ok, ms });
  if (!ok) {
    failed = true;
    break;
  }
}

const bar = "─".repeat(48);
console.log(`\n${bar}\n[qa] summary`);
for (const leg of legs) {
  const r = results.find((x) => x.name === leg.name);
  const glyph = !r ? "·" : r.ok ? "PASS" : "FAIL";
  const detail = !r ? "skipped (earlier failure)" : `${(r.ms / 1000).toFixed(1)}s`;
  console.log(`  [${glyph}] ${leg.name.padEnd(14)} ${detail}`);
}
console.log(bar);

if (failed) {
  console.error("[qa] FAILED — see the failing leg above.");
  process.exit(1);
}
console.log("[qa] OK — full local battery green.");
