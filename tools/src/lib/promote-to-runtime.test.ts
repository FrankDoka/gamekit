import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromoteInput } from "../promoted-registry.js";
import { promoteToRuntime } from "./promote-to-runtime.js";

// Single-promotion-route regression (card-devkit-shell-cohesion, s24).
//
// The DevKit editor (:8787 handlePromoteAsset) and the Asset Bank (:8765 handlePromote) now
// funnel through promoteToRuntime. This test proves the two surfaces produce IDENTICAL
// registry writes for the same asset: it feeds each surface's PromoteInput shape through
// the shared function with a capturing registry writer and asserts the captured writes match.
// It also proves the shared overwrite guard + copy-rollback behavior. No real registry file
// is touched — the canonical writer is injected.

const roots: string[] = [];
function tmpRoot(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gamekit-promote-${name}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A registry writer that captures the exact PromoteInput instead of writing to disk. */
function capturingWriter(): { writer: (i: PromoteInput) => Promise<{ key: string; replacedKeys: string[] }>; calls: PromoteInput[] } {
  const calls: PromoteInput[] = [];
  return {
    calls,
    writer: async (input) => {
      calls.push(input);
      // Mimic canonicalKey (assetId when present, else category_targetName) so the returned
      // key is realistic; the parity assertion is on the captured PromoteInput, not the key.
      const key = (input.assetId?.trim() || `${input.category}_${input.targetName}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_");
      return { key, replacedKeys: [] };
    },
  };
}

describe("promoteToRuntime — single promotion route parity", () => {
  it("DevKit and Asset Bank produce identical registry writes for the same asset", async () => {
    // Same asset, same runtime target — the only difference is the per-surface plumbing that
    // resolves paths. The registry write (PromoteInput) must be byte-identical.
    const bankRoot = tmpRoot("bank");
    const devkitRoot = tmpRoot("devkit");
    const bankSource = join(bankRoot, "Harbor_Barrel.png");
    const devkitSource = join(devkitRoot, "Harbor_Barrel.png");
    writeFileSync(bankSource, "PNGDATA");
    writeFileSync(devkitSource, "PNGDATA");
    const bankDest = join(bankRoot, "props", "harbor_barrel.png");
    const devkitDest = join(devkitRoot, "props", "harbor_barrel.png");
    await mkdir(join(bankRoot, "props"), { recursive: true });
    await mkdir(join(devkitRoot, "props"), { recursive: true });

    const shared = {
      assetId: "prop_harbor_barrel",
      sourcePath: "props/Harbor_Barrel.png",
      targetPath: "assets/props/harbor_barrel.png",
      targetName: "harbor_barrel",
      type: "prop",
      kind: "prop",
      category: "props",
      image: { width: 128, height: 128 },
    } as const;

    const bank = capturingWriter();
    const bankResult = await promoteToRuntime({ sourceAbs: bankSource, destAbs: bankDest, ...shared }, bank.writer);

    const devkit = capturingWriter();
    const devkitResult = await promoteToRuntime({ sourceAbs: devkitSource, destAbs: devkitDest, ...shared }, devkit.writer);

    expect(bankResult).toEqual({ status: "ok", registryKey: "prop_harbor_barrel", replacedKeys: [], targetExisted: false });
    expect(devkitResult).toEqual(bankResult);
    // The captured registry write is identical between the two surfaces.
    expect(bank.calls).toHaveLength(1);
    expect(devkit.calls).toHaveLength(1);
    expect(devkit.calls[0]).toEqual(bank.calls[0]);
    // Both actually copied the source into the runtime target.
    expect(readFileSync(bankDest, "utf8")).toBe("PNGDATA");
    expect(readFileSync(devkitDest, "utf8")).toBe("PNGDATA");
  });

  it("refuses a byte-different existing target without force, and does not write the registry", async () => {
    const root = tmpRoot("refuse");
    const source = join(root, "src.png");
    const dest = join(root, "dest.png");
    writeFileSync(source, "NEW");
    writeFileSync(dest, "OLD"); // different bytes already at target
    const cap = capturingWriter();

    const result = await promoteToRuntime(
      { sourceAbs: source, destAbs: dest, sourcePath: "src.png", targetPath: "assets/props/dest.png", targetName: "dest", type: "prop", category: "props" },
      cap.writer,
    );

    expect(result.status).toBe("refused");
    expect(cap.calls).toHaveLength(0); // no registry write on refusal
    expect(readFileSync(dest, "utf8")).toBe("OLD"); // target untouched
  });

  it("rolls back a freshly copied file when the registry write fails", async () => {
    const root = tmpRoot("rollback");
    const source = join(root, "src.png");
    const dest = join(root, "dest.png"); // does not exist yet
    writeFileSync(source, "DATA");

    await expect(
      promoteToRuntime(
        { sourceAbs: source, destAbs: dest, sourcePath: "src.png", targetPath: "assets/props/dest.png", targetName: "dest", type: "prop", category: "props" },
        async () => {
          throw new Error("registry boom");
        },
      ),
    ).rejects.toThrow("registry boom");

    // The copy that was made for a NEW target is rolled back.
    expect(() => readFileSync(dest)).toThrow();
  });
});
