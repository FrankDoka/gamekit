/**
 * Headless advancement proof for card-advancement-feedback (#14).
 *
 * Boots a dedicated world server with GAMEKIT_SMOKE_ADVANCEMENT_PROOF=true so the
 * joining guest is seeded eligible (Lv 10 + quest_wayfarer_orders completed),
 * drives the Combat Trainer's Advance dialogue, and HARD-ASSERTS the class change:
 * class id → Guardian, starting skill (stonebind) granted, and the unmissable
 * class-change celebration fired. Kept out of smoke:client so the base run's Lv 1→2
 * progression assertions are not perturbed by the Lv-10 seed.
 *
 * Usage:  pnpm smoke:advancement   (or:  tsx tools/src/smoke-advancement.ts)
 */

import { createSmokeHarness, saveScreenshotAndClose, stopChildProcesses } from "./smoke/harness";
import { verifyClassAdvancement } from "./smoke/advancement";

async function main(): Promise<void> {
  const harness = await createSmokeHarness({ worldEnv: { GAMEKIT_SMOKE_ADVANCEMENT_PROOF: "true" } });
  const { pageA, consoleErrors } = harness;

  await verifyClassAdvancement(pageA);

  if (consoleErrors.length > 0) {
    throw new Error(`console errors during advancement proof:\n${consoleErrors.join("\n")}`);
  }

  await saveScreenshotAndClose(harness);
  console.log("[smoke] ADVANCEMENT PROOF PASSED.");
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});
