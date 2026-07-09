/**
 * Shared classifier for transient Playwright navigation-race errors seen during zone capture.
 * Extracted from capture-zone.ts so the retry decision (retry the shot vs. fail the run) is
 * unit-testable — see the `--selftest` block below (run: `tsx tools/src/capture-retry.ts --selftest`).
 */

export function isTransientNavError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright throws these when the page navigates/reloads (e.g. a stray Vite HMR full reload)
  // while a page.evaluate/screenshot is in flight. They are per-shot transients, not run failures.
  return /Execution context was destroyed|because of a navigation|Target (?:page|closed)|frame was detached|Execution context is not available|Most likely the page has been closed/i.test(
    message,
  );
}

if (process.argv.includes("--selftest")) {
  const cases: Array<{ input: unknown; expected: boolean; name: string }> = [
    {
      // The exact message the owner hit (backlog p0, capture-zone flake, 2026-07-02).
      name: "observed Execution-context-destroyed flake",
      input: new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation"),
      expected: true,
    },
    { name: "frame detached", input: new Error("frame was detached"), expected: true },
    { name: "target closed", input: new Error("Target closed"), expected: true },
    { name: "context not available", input: new Error("Execution context is not available in detached frames"), expected: true },
    { name: "string form", input: "Execution context was destroyed because of a navigation", expected: true },
    { name: "unrelated assertion error is NOT retried", input: new Error("selected prop validation failed: missing anchor"), expected: false },
    { name: "timeout is NOT retried", input: new Error("Timeout 30000ms exceeded"), expected: false },
  ];
  let failures = 0;
  for (const testCase of cases) {
    const actual = isTransientNavError(testCase.input);
    const ok = actual === testCase.expected;
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}: ${testCase.name} (expected ${testCase.expected}, got ${actual})`);
  }
  if (failures > 0) {
    console.error(`[capture-retry selftest] ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log(`[capture-retry selftest] all ${cases.length} cases passed`);
}
