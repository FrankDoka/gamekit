import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { updateReviewStatusFile } from "./asset-bank-reconcile.js";

// Regression coverage for the cross-process `_review/.review.lock` write lock that
// wraps every `_review` mutation on BOTH the server (asset-bank.ts acquireLock/withLock,
// :450-496) and the CLI (asset-bank-reconcile.ts withReviewLock, :121-145). Both write
// `String(process.pid)` with flag "wx" to the SAME `<reviewRoot>/.review.lock` and steal
// only when the recorded pid is not alive. These tests assert the 2026-06-30 concurrent
// clobber cannot recur while a holder is live, and that a dead-pid holder is reclaimed.

async function tmpReviewRoot(name: string): Promise<{ reviewRoot: string; statusPath: string; lockPath: string }> {
  const root = path.join(os.tmpdir(), `gamekit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const reviewRoot = path.join(root, "_review");
  await mkdir(reviewRoot, { recursive: true });
  const statusPath = path.join(reviewRoot, "asset-review-status.json");
  const lockPath = path.join(reviewRoot, ".review.lock");
  await writeFile(statusPath, JSON.stringify({ reviews: [] }));
  return { reviewRoot, statusPath, lockPath };
}

// A pid that is guaranteed dead: allocate a plausible-looking pid that is not running.
// 2^30 is well above any real Windows/Linux pid, so process.kill(pid, 0) reports ESRCH.
const DEAD_PID = 0x40000000;

describe("review lock cross-process regression", () => {
  test("a live holder blocks a raw concurrent writer — the 2026-06-30 clobber cannot recur", async () => {
    const { lockPath } = await tmpReviewRoot("review-lock-live-block");

    // The server/CLI acquire path: write the lockfile with a LIVE pid using flag "wx".
    // process.pid is, by definition, alive for the duration of this test.
    await writeFile(lockPath, String(process.pid), { flag: "wx" });

    // A second (raw) writer races for the SAME lockfile the way any _review writer would.
    // Legacy-writer toggle mirrors lane-registry.test.ts:59-66: the toggle flips ONLY the
    // writer's flag — the assertions below are identical in both branches. With the lock
    // enforced ("wx") the racer is blocked and the live holder's pid survives; with the
    // toggle set the racer bypasses the lock (flag "w") and this same test goes RED,
    // demonstrating the assertions only pass BECAUSE the lock acquire is honored.
    const bypass = process.env.REVIEW_LOCK_LEGACY_TEST_WRITER === "1";
    const racerFlag = bypass ? "w" : "wx";

    let racerError: NodeJS.ErrnoException | undefined;
    try {
      await writeFile(lockPath, String(DEAD_PID), { flag: racerFlag });
    } catch (error) {
      racerError = error as NodeJS.ErrnoException;
    }

    // The concurrent raw writer must be blocked (EEXIST) and the live holder untouched.
    // Under the bypass toggle both assertions fail: the racer succeeds and clobbers the pid.
    expect(racerError?.code).toBe("EEXIST");
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(process.pid));

    await unlink(lockPath).catch(() => undefined);
  });

  test("the production locked API refuses to clobber while a live holder is present", async () => {
    const { statusPath, lockPath } = await tmpReviewRoot("review-lock-api-block");

    // Simulate the server holding the lock (live pid) while the CLI status writer runs.
    await writeFile(lockPath, String(process.pid), { flag: "wx" });

    let raced: unknown;
    const writer = updateReviewStatusFile(statusPath, (status) => {
      status.reviews.push({ id: "cli", decision: "accepted", status: "unknown" });
    }).catch((error) => {
      raced = error;
    });

    // The locked API must NOT have written yet — the live holder blocks it. Give the
    // acquire loop a few retry cycles (25ms each) to prove it is spinning, not clobbering.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during = JSON.parse(await readFile(statusPath, "utf8")) as { reviews: unknown[] };
    expect(during.reviews).toEqual([]); // still empty: the CLI writer is blocked, not clobbering
    expect(existsSync(lockPath)).toBe(true);
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(process.pid)); // live holder intact

    // Release the live holder; the blocked writer then acquires and completes.
    await unlink(lockPath);
    await writer;
    expect(raced).toBeUndefined();
    const after = JSON.parse(await readFile(statusPath, "utf8")) as { reviews: Array<{ id: string }> };
    expect(after.reviews.map((r) => r.id)).toEqual(["cli"]);
  });

  test("a dead-pid holder is stale-stolen — a crashed writer never wedges the lock", async () => {
    const { statusPath, lockPath } = await tmpReviewRoot("review-lock-stale-steal");

    // A prior writer crashed leaving its lockfile behind with a now-dead pid.
    await writeFile(lockPath, String(DEAD_PID), { flag: "wx" });

    // The production locked API must detect !pidAlive(holder), reclaim the lock, and write.
    await updateReviewStatusFile(statusPath, (status) => {
      status.reviews.push({ id: "reclaimed", decision: "accepted", status: "unknown" });
    });

    const after = JSON.parse(await readFile(statusPath, "utf8")) as { reviews: Array<{ id: string }> };
    expect(after.reviews.map((r) => r.id)).toEqual(["reclaimed"]);
    // Lock is released after the write completes (no wedged .review.lock left behind).
    expect(existsSync(lockPath)).toBe(false);
  });
});
