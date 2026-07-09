import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { planArchiveResolved } from "./assets-archive-resolved.js";
import { resolveRuntimeAssetPath } from "./asset-bank.js";
import { reconcileAssetBank, updateReviewStatusFile } from "./asset-bank-reconcile.js";
import { repointEntityProfiles } from "./assets-repoint-entities.js";
import { byteRangeFor } from "./http-range.js";
import { promotionOverwriteDecision } from "./promotion-overwrite-guard.js";
import { registryEntriesMissingRuntimeFiles, type PromotedRegistryT } from "./promoted-registry.js";

async function tmpDir(name: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `gamekit-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("asset bank mechanization guards", () => {
  test("promotion overwrite guard refuses a live target with different bytes", async () => {
    const root = await tmpDir("promote-guard");
    const source = path.join(root, "source.png");
    const target = path.join(root, "target.png");
    await writeFile(source, "new source bytes");
    await writeFile(target, "existing runtime bytes");

    await expect(promotionOverwriteDecision(source, target, false)).resolves.toMatchObject({
      targetExisted: true,
      differs: true,
      refused: true,
    });
    await expect(promotionOverwriteDecision(source, target, true)).resolves.toMatchObject({
      targetExisted: true,
      differs: true,
      refused: false,
    });
  });

  test("Range bytes=0-99 returns 206 headers and a 100-byte slice", () => {
    expect(byteRangeFor("bytes=0-99", 1000)).toEqual({
      kind: "partial",
      statusCode: 206,
      start: 0,
      end: 99,
      length: 100,
      headers: {
        "accept-ranges": "bytes",
        "content-range": "bytes 0-99/1000",
        "content-length": "100",
      },
    });
  });

  test("entity repoint reconciles a source binding to the promoted runtime target", () => {
    const profiles = {
      entities: {
        monster_blue_slime: {
          slots: {
            idle_sprite: { assetId: "characters/monsters/slime_blue_source.png", status: "accepted" },
          },
        },
      },
    };
    const result = repointEntityProfiles(profiles, {
      slime_blue: {
        assetId: "asset_slime_blue",
        sourcePath: "characters/monsters/slime_blue_source.png",
        targetPath: "assets/sprites/monster_blue_slime.png",
        targetName: "monster_blue_slime",
      },
    });

    expect(result.changes).toEqual([
      {
        entityId: "monster_blue_slime",
        slot: "idle_sprite",
        from: "characters/monsters/slime_blue_source.png",
        to: "assets/sprites/monster_blue_slime.png",
        registryKey: "slime_blue",
      },
    ]);
    expect((profiles.entities.monster_blue_slime.slots.idle_sprite as { assetId: string; status: string }).assetId).toBe(
      "assets/sprites/monster_blue_slime.png",
    );
    expect((profiles.entities.monster_blue_slime.slots.idle_sprite as { status: string }).status).toBe("reviewed");
  });

  test("registry resync pruning is non-lossy for entries whose runtime file is present", async () => {
    const root = await tmpDir("registry-nonlossy");
    await mkdir(path.join(root, "sprites"), { recursive: true });
    await writeFile(path.join(root, "sprites", "present.png"), "runtime");
    const registry: PromotedRegistryT = {
      promoted: {
        present_entry: {
          assetId: "present_entry",
          sourcePath: "characters/source-present.png",
          targetPath: "assets/sprites/present.png",
          targetName: "present",
          type: "sprite",
          context: "",
          kind: "sprite",
          category: "monsters",
          image: null,
          promotedAt: "2026-07-05T00:00:00.000Z",
          warnings: [],
        },
        missing_entry: {
          assetId: "missing_entry",
          sourcePath: "characters/source-missing.png",
          targetPath: "assets/sprites/missing.png",
          targetName: "missing",
          type: "sprite",
          context: "",
          kind: "sprite",
          category: "monsters",
          image: null,
          promotedAt: "2026-07-05T00:00:00.000Z",
          warnings: [],
        },
      },
      meta: {},
    };

    expect(registryEntriesMissingRuntimeFiles(registry, root)).toEqual(["missing_entry"]);
  });

  test("archive-resolved plans only batches whose final files are promoted and live", async () => {
    const root = await tmpDir("archive-plan");
    const assetsRoot = path.join(root, "Assets");
    const archiveRoot = path.join(root, "Assets-Archive");
    const publicRoot = path.join(root, "repo", "client", "public", "assets");
    await mkdir(path.join(assetsRoot, "generated", "batch-a", "final"), { recursive: true });
    await mkdir(path.join(publicRoot, "props"), { recursive: true });
    await writeFile(path.join(assetsRoot, "generated", "batch-a", "final", "lantern.png"), "source");
    await writeFile(path.join(publicRoot, "props", "lantern.png"), "runtime");

    const plan = await planArchiveResolved({
      assetsRoot,
      archiveRoot,
      publicAssetsRoot: publicRoot,
      registry: {
        promoted: {
          lantern: {
            sourcePath: "generated/batch-a/final/lantern.png",
            targetPath: "assets/props/lantern.png",
          },
        },
      },
    });

    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].finalFiles).toEqual(["generated/batch-a/final/lantern.png"]);
    await expect(readFile(path.join(assetsRoot, "generated", "batch-a", "final", "lantern.png"), "utf8")).resolves.toBe("source");
  });

  test("runtime resolver finds nested audio dirs and exact runtime paths", async () => {
    const repoRoot = await tmpDir("runtime-resolver");
    const nestedAudio = path.join(repoRoot, "client", "public", "assets", "audio", "sfx", "slime_squish", "slime_squish_move.mp3");
    const idleSprite = path.join(repoRoot, "client", "public", "assets", "sprites", "monster_meadow_slime.png");
    await mkdir(path.dirname(nestedAudio), { recursive: true });
    await mkdir(path.dirname(idleSprite), { recursive: true });
    await writeFile(nestedAudio, "audio");
    await writeFile(idleSprite, "sprite");

    expect(resolveRuntimeAssetPath("slime_squish_move", { repoRoot })).toBe(nestedAudio);
    expect(resolveRuntimeAssetPath("assets/audio/sfx/slime_squish/slime_squish_move.mp3", { repoRoot })).toBe(nestedAudio);
    expect(resolveRuntimeAssetPath("monster_meadow_slime", { repoRoot })).toBe(idleSprite);
  });

  test("bank reconcile maps registry source paths, normalizes malformed status, and reports Mara/NPC orphan classes", async () => {
    const root = await tmpDir("bank-reconcile");
    const repoRoot = path.join(root, "repo");
    const metadataRoot = path.join(root, "Assets-metadata");
    const reviewRoot = path.join(metadataRoot, "_review");
    const publicAssets = path.join(repoRoot, "client", "public", "assets");
    const registryPath = path.join(publicAssets, "promoted-registry.json");
    const dataPath = path.join(reviewRoot, "asset-review-data.json");
    const statusPath = path.join(reviewRoot, "asset-review-status.json");
    await mkdir(path.join(publicAssets, "sprites"), { recursive: true });
    await mkdir(reviewRoot, { recursive: true });
    await mkdir(path.join(repoRoot, "content"), { recursive: true });
    await mkdir(path.join(repoRoot, "client", "src", "config"), { recursive: true });
    await writeFile(path.join(publicAssets, "sprites", "monster_dew_slime.png"), "slime");
    await writeFile(path.join(publicAssets, "sprites", "npc_mara_bellweather.png"), "mara");
    await writeFile(path.join(publicAssets, "sprites", "npc_runtime_only.png"), "npc");
    await writeFile(path.join(repoRoot, "content", "manifest.json"), JSON.stringify({ sprite: "assets/sprites/monster_dew_slime.png" }));
    await writeFile(
      registryPath,
      JSON.stringify({
        promoted: {
          monsters_monster_dew_slime: {
            assetId: "monster_dew_slime_source",
            sourcePath: "characters/monsters/slimes/runtime/monster_dew_slime_191px.png",
            targetPath: "assets/sprites/monster_dew_slime.png",
            targetName: "monster_dew_slime",
          },
          npc_mara_bellweather: {
            assetId: "npc_mara_bellweather",
            sourcePath: "characters/npcs/mara/npc_mara_bellweather.png",
            targetPath: "assets/sprites/npc_mara_bellweather.png",
            targetName: "npc_mara_bellweather",
          },
        },
      }),
    );
    await writeFile(
      dataPath,
      JSON.stringify({
        assets: [
          { id: "monster_dew_slime_source", path: "characters/monsters/slimes/runtime/monster_dew_slime_191px.png", category: "monsters", kind: "sprite", status: "unknown" },
        ],
      }),
    );
    await writeFile(statusPath, JSON.stringify({ reviews: [{ id: "monster_dew_slime_source", decision: "accepted", status: "MISSING" }] }));

    const verdict = await reconcileAssetBank({ repoRoot, assetsRoot: path.join(root, "Assets"), metadataRoot, registryPath, dataPath, statusPath });

    expect(verdict.changedReviews.map((change) => change.id)).toContain("monster_dew_slime_source");
    expect(verdict.changedReviews[0].to).toMatchObject({ decision: "runtime-promoted", status: "promoted" });
    expect(verdict.normalizedReviews).toEqual([{ id: "monster_dew_slime_source", from: "MISSING", to: "accepted" }]);
    expect(verdict.orphans.inGameNoBankEntry.some((item) => item.runtimePath.includes("npc_mara_bellweather"))).toBe(true);
    expect(verdict.orphans.inGameNoBankEntry.some((item) => item.runtimePath.includes("npc_runtime_only"))).toBe(true);
    expect(verdict.ingestedAssets).toContainEqual(expect.objectContaining({ id: "sprites_npc_runtime_only", category: "npcs", tags: ["runtime-only-source"] }));
  });

  test("bank reconcile apply writes runtime-promoted status through the locked status store", async () => {
    const root = await tmpDir("bank-reconcile-apply");
    const repoRoot = path.join(root, "repo");
    const metadataRoot = path.join(root, "Assets-metadata");
    const reviewRoot = path.join(metadataRoot, "_review");
    const publicAssets = path.join(repoRoot, "client", "public", "assets");
    const registryPath = path.join(publicAssets, "promoted-registry.json");
    const dataPath = path.join(reviewRoot, "asset-review-data.json");
    const statusPath = path.join(reviewRoot, "asset-review-status.json");
    await mkdir(path.join(publicAssets, "props"), { recursive: true });
    await mkdir(path.join(repoRoot, "content"), { recursive: true });
    await mkdir(path.join(repoRoot, "client", "src", "config"), { recursive: true });
    await mkdir(reviewRoot, { recursive: true });
    await writeFile(path.join(publicAssets, "props", "harbor_crate.png"), "crate");
    await writeFile(path.join(repoRoot, "content", "layout.json"), JSON.stringify({ assetKey: "harbor_crate", path: "assets/props/harbor_crate.png" }));
    await writeFile(registryPath, JSON.stringify({ promoted: { props_harbor_crate: { assetId: "bank_crate", sourcePath: "props/harbor_crate.png", targetPath: "assets/props/harbor_crate.png", targetName: "harbor_crate" } } }));
    await writeFile(dataPath, JSON.stringify({ assets: [{ id: "bank_crate", path: "props/harbor_crate.png", category: "props", kind: "prop" }] }));
    await writeFile(statusPath, JSON.stringify({ reviews: [] }));

    const verdict = await reconcileAssetBank({ repoRoot, assetsRoot: path.join(root, "Assets"), metadataRoot, registryPath, dataPath, statusPath, apply: true });
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { reviews: Array<{ id: string; decision: string; status: string }> };

    expect(verdict.changedReviews).toHaveLength(1);
    expect(status.reviews).toContainEqual(expect.objectContaining({ id: "bank_crate", decision: "runtime-promoted", status: "promoted" }));
  });

  test("review status locked RMW keeps concurrent writer entries and normalizes bad statuses", async () => {
    const root = await tmpDir("review-status-lock");
    const statusPath = path.join(root, "_review", "asset-review-status.json");
    await mkdir(path.dirname(statusPath), { recursive: true });
    await writeFile(statusPath, JSON.stringify({ reviews: [] }));

    await Promise.all([
      updateReviewStatusFile(statusPath, (status) => {
        status.reviews.push({ id: "a", decision: "accepted", status: "MISSING" });
      }),
      updateReviewStatusFile(statusPath, (status) => {
        status.reviews.push({ id: "b", decision: "runtime-promoted", status: "unknown" });
      }),
    ]);
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { reviews: Array<{ id: string; status: string }> };

    expect(status.reviews.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "a", decision: "accepted", status: "accepted" },
      { id: "b", decision: "runtime-promoted", status: "promoted" },
    ]);
  });
});
