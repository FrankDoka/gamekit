/**
 * zone-lint self-test — proves every zone-lint check FIRES on a deliberately broken
 * fixture (tools/zone-fixtures/broken.layout.json). A green zone-lint on the live
 * layout is only half the proof; this is the other half (each rule catches its own
 * defect). Run: `pnpm zone:lint:selftest`. Exit 0 = every expected status matched,
 * 1 = a check did not fire as expected (regression in the gate itself).
 *
 * This is the executable form of the card gate "zone-lint proven on a deliberately
 * broken fixture layout (each check fires)" — mechanized per the owner standing order
 * (second occurrence of a failure class -> a gate, not a note).
 */
import { join } from "node:path";
import { lintLayout } from "./zone-lint";

const FIXTURE = join(process.cwd(), "tools", "zone-fixtures", "broken.layout.json");

// Expected status for each check when run against the broken fixture.
const EXPECT: Record<string, "PASS" | "WARN" | "FAIL"> = {
  "prop_scale_1.0": "FAIL", // p_scale_bad has scale 2.0
  promoted_keys_on_disk: "FAIL", // p_missing_on_disk key has no file
  spawn_ids_ordinal: "FAIL", // monster_spawn_no_ordinal has no trailing ordinal
  anchors_within_bounds: "FAIL", // p_out_of_bounds x=99999
  no_duplicate_position_stacks: "FAIL", // p_dup_a/p_dup_b share (300,300)
  scatter_density_band: "WARN", // 5 placements over a 2400x1800 map is far below the band
};

function main(): number {
  const verdict = lintLayout(FIXTURE);
  const byName = new Map(verdict.checks.map((c) => [c.name, c.status]));
  let failures = 0;

  console.log(`[zone:lint:selftest] ${FIXTURE}`);
  for (const [name, expected] of Object.entries(EXPECT)) {
    const actual = byName.get(name);
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`  [${ok ? "ok" : "MISS"}] ${name}: expected ${expected}, got ${actual ?? "MISSING"}`);
  }

  // Every rule must be represented; a new rule without a fixture expectation is a hole.
  for (const check of verdict.checks) {
    if (!(check.name in EXPECT)) {
      console.log(`  [MISS] ${check.name}: no fixture expectation — add one to zone-lint-selftest.ts`);
      failures += 1;
    }
  }

  if (verdict.result !== "FAIL") {
    console.error("[zone:lint:selftest] expected overall verdict FAIL on the broken fixture");
    failures += 1;
  }

  if (failures > 0) {
    console.error(`[zone:lint:selftest] FAILED: ${failures} expectation(s) not met`);
    return 1;
  }
  console.log(`[zone:lint:selftest] OK — all ${Object.keys(EXPECT).length} checks fired as expected.`);
  return 0;
}

process.exit(main());
