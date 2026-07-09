import { ROOT } from "./smoke/constants";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";
import { verifyReloadZoneNonAdminRejected, verifyZoneReloadSwap } from "./smoke/zone-reload";

async function main(): Promise<void> {
  await verifyZoneReloadSwap(ROOT);

  const harness = await createSmokeHarness();
  try {
    await verifyReloadZoneNonAdminRejected(harness.pageB);
    if (harness.consoleErrors.length > 0) {
      throw new Error(`console errors during zone reload smoke:\n${harness.consoleErrors.join("\n")}`);
    }
    console.log("[smoke] Zone reload smoke checks passed.");
  } finally {
    await harness.browser.close();
    stopChildProcesses();
  }
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  stopChildProcesses();
  process.exit(1);
});
