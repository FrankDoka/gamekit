import { copyFile, unlink } from "node:fs/promises";
import { promoteEntry, type PromoteInput } from "../promoted-registry.js";
import { promotionOverwriteDecision } from "../promotion-overwrite-guard.js";

/**
 * The single promotion route (card-devkit-shell-cohesion, s24).
 *
 * Both promote entry points — the Asset Bank server (`:8765`, handlePromote) and the DevKit
 * editor (`:8787`, handlePromoteAsset) — used to inline the SAME three-step core:
 *   1. promotionOverwriteDecision (refuse byte-different existing targets unless force)
 *   2. copyFile source → runtime target
 *   3. promoteEntry (the canonical promoted-registry writer) with copy rollback on failure
 * That inlined trio was the "two promotion routes" the A7 cohesion review flagged
 * (docs/reviews/10of10/a7-cohesion.md §Critical). Both handlers now call this one function,
 * so the two paths produce byte-identical registry writes for the same input; per-surface
 * concerns (defect/quality gate choice, source resolution, entity repoint, review-merge)
 * stay in each handler.
 *
 * `overwrite.refused` is surfaced (not thrown) so each caller can map it to its own HTTP
 * shape. A registry-write failure rolls back a freshly-copied file and throws.
 */

export type PromoteToRuntimeResult =
  | { status: "refused"; reason: string; targetExisted: boolean }
  | { status: "ok"; registryKey: string; replacedKeys: string[]; targetExisted: boolean };

export type PromoteToRuntimeInput = PromoteInput & {
  /** Absolute source file to copy from. */
  sourceAbs: string;
  /** Absolute runtime destination the source is copied to. */
  destAbs: string;
  /** Pass force:true to overwrite an existing byte-different target. */
  force?: boolean;
};

/** The canonical registry writer both callers use. Injectable only so the parity regression
 * test can capture the exact PromoteInput each surface funnels through, without mutating the
 * real client/public/assets/promoted-registry.json. Production callers never pass this. */
export type RegistryWriter = (input: PromoteInput) => Promise<{ key: string; replacedKeys: string[] }>;

/**
 * Copy an asset into the runtime and register it through the canonical writer, under the
 * shared overwrite guard. The runtime directory must already exist (callers own mkdir so
 * they can lay out their own subdir scheme). Registry write failure rolls back the copy.
 */
export async function promoteToRuntime(
  input: PromoteToRuntimeInput,
  writeRegistry: RegistryWriter = promoteEntry,
): Promise<PromoteToRuntimeResult> {
  const { sourceAbs, destAbs, force = false, ...registryInput } = input;
  const overwrite = await promotionOverwriteDecision(sourceAbs, destAbs, force);
  if (overwrite.refused) {
    return { status: "refused", reason: overwrite.reason ?? "target exists with different bytes", targetExisted: overwrite.targetExisted };
  }
  const targetExisted = overwrite.targetExisted;
  await copyFile(sourceAbs, destAbs);
  try {
    const { key, replacedKeys } = await writeRegistry(registryInput);
    return { status: "ok", registryKey: key, replacedKeys, targetExisted };
  } catch (error) {
    if (!targetExisted) await unlink(destAbs).catch(() => undefined);
    throw error;
  }
}
