/**
 * Proof: non-pickup toasts render bottom-right (loot drops / quest / success),
 * and item PICKUPS render top-center as the reference-style rich toast
 * (card-item-toast, owner 2026-07-06). Fires representative toasts, asserts
 * both containers' geometry, screenshots for eyes-on.
 */
import { mkdirSync } from "node:fs";
import { createSmokeHarness, stopChildProcesses } from "./smoke/harness";

const outDir = process.argv[2] ?? "tools/_toast-proof";

const main = async (): Promise<void> => {
  mkdirSync(outDir, { recursive: true });
  const harness = await createSmokeHarness();
  const page = harness.pageA;

  const geometry = await page.evaluate(async () => {
    // Vite-served module path, resolved in the BROWSER (tsc cannot see it —
    // keep the specifier a variable so it type-checks as a dynamic any-import).
    const toastModulePath = "/src/ui/toast.ts";
    const mod = await import(toastModulePath);
    mod.toastQuestProgress("Suncradle First Hunt", "4/5");
    mod.toastSuccess("Moss Spore x1 dropped");
    // Item pickup -> top-center rich toast (card-item-toast).
    mod.toastItemReceived("Moss Spore", 4, "/assets/ui/icons/icon_moss_spore.png");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const doc = (globalThis as unknown as {
      document: { querySelector: (s: string) => ({
        childElementCount: number;
        querySelector: (s: string) => ({ textContent: string | null } | null);
        getBoundingClientRect: () => { left: number; right: number; top: number };
      } | null) };
    }).document;
    const inner = (globalThis as unknown as { innerWidth: number; innerHeight: number });
    const right = doc.querySelector(".lm-toast-container--bottom-right");
    const top = doc.querySelector(".lm-toast-container--top-center");
    if (!right) throw new Error("bottom-right toast container missing");
    if (!top) throw new Error("top-center toast container missing");
    const richToast = top.querySelector(".lm-toast--item-received");
    const richIcon = top.querySelector(".lm-toast--item-received img.lm-toast__icon");
    const richEyebrow = top.querySelector(".lm-toast--item-received .lm-toast__eyebrow");
    const rr = right.getBoundingClientRect();
    const tr = top.getBoundingClientRect();
    return {
      rightToasts: right.childElementCount,
      rightRightGapPx: Math.round(inner.innerWidth - rr.right),
      topToasts: top.childElementCount,
      topCenterXOffsetPx: Math.round((tr.left + tr.right) / 2 - inner.innerWidth / 2),
      topGapPx: Math.round(tr.top),
      hasRichIcon: !!richIcon,
      richEyebrow: richEyebrow?.textContent ?? null,
      richPresent: !!richToast,
      // Base class retained so hints keep yielding (hints.ts systemToastActive).
      hintGuardSeesIt: doc.querySelector(".lm-toast-container .lm-toast--item-received") !== null,
      viewport: { w: inner.innerWidth, h: inner.innerHeight },
    };
  });
  if (geometry.rightToasts < 2) throw new Error(`expected >=2 bottom-right toasts, got ${JSON.stringify(geometry)}`);
  if (geometry.rightRightGapPx < 0 || geometry.rightRightGapPx > 60) throw new Error(`bottom-right not right-anchored: ${JSON.stringify(geometry)}`);
  if (geometry.topToasts < 1) throw new Error(`expected top-center item toast, got ${JSON.stringify(geometry)}`);
  if (!geometry.richPresent) throw new Error(`rich item toast missing: ${JSON.stringify(geometry)}`);
  if (!geometry.hasRichIcon) throw new Error(`rich item toast missing icon: ${JSON.stringify(geometry)}`);
  if (geometry.richEyebrow !== "Item received") throw new Error(`rich item toast eyebrow wrong: ${JSON.stringify(geometry)}`);
  if (Math.abs(geometry.topCenterXOffsetPx) > 12) throw new Error(`top-center not centered: ${JSON.stringify(geometry)}`);
  if (geometry.topGapPx > 200) throw new Error(`top-center not near the top: ${JSON.stringify(geometry)}`);
  if (!geometry.hintGuardSeesIt) throw new Error(`hint-yield contract broken: ${JSON.stringify(geometry)}`);
  await page.screenshot({ path: `${outDir}/toast-placement.png` });
  console.log(`[toast-proof] geometry OK: ${JSON.stringify(geometry)}`);
  console.log(`[toast-proof] screenshot -> ${outDir}/toast-placement.png`);
  console.log("[toast-proof] ALL CHECKS PASSED.");
};

main()
  .then(() => {
    stopChildProcesses();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[toast-proof] FATAL:", error instanceof Error ? error.message : error);
    stopChildProcesses();
    process.exit(1);
  });
