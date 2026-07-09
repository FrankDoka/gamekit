import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_DOCS } from "./api-docs.js";

type JsonRecord = Record<string, unknown>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const port = Number(argValue("--port") ?? "8796");
const baseUrl = `http://127.0.0.1:${port}`;

function commandName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function requestJson(pathName: string, init?: RequestInit): Promise<JsonRecord> {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: JsonRecord;
  try {
    body = text ? (JSON.parse(text) as JsonRecord) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathName} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return body;
}

async function waitForDevKit(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const status = await requestJson("/api/status");
      assert(typeof status.repoRoot === "string", "DevKit status did not include repoRoot");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw new Error(`DevKit did not become ready on ${baseUrl}`);
}

function startDevKit(): ChildProcess {
  return spawn(commandName("pnpm"), ["devkit", "--", "--port", String(port)], {
    cwd: repoRoot,
    stdio: "ignore",
    windowsHide: true,
    shell: true,
  });
}

function stopDevKit(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort cleanup only.
    }
  }
}

function stopChildProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort cleanup only.
    }
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function main(): Promise<void> {
  const devkit = startDevKit();
  let editorMetadataSnapshot: string | undefined;
  try {
    await waitForDevKit();

    const status = await requestJson("/api/status");
    const repoBase = path.basename(String(status.repoRoot)).toLowerCase();
    // The DevKit must resolve to the same repo the smoke runs from — name-agnostic, so the
    // toolkit repo (or a game's) can be called anything. Matches base names or a `<base>-<lane>` worktree.
    const expectedBase = path.basename(process.env.GAME_ROOT ?? process.cwd()).toLowerCase();
    assert(repoBase === expectedBase || repoBase.startsWith(`${expectedBase}-`), `DevKit repoRoot '${repoBase}' does not match the expected repo '${expectedBase}'`);

    const hubStatus = await requestJson("/api/hub/status");
    assert(hubStatus.ok === true, "hub status endpoint failed");
    assert(asArray(hubStatus.health).length === 3, "hub health did not include DB/server/tunnel");

    const hubHealth = await requestJson("/api/hub/health");
    assert(asArray(hubHealth.health).length === 3, "hub fresh health did not include all services");

    const world = await requestJson("/api/hub/world");
    assert(world.ok === true && typeof world.totals === "object", "hub world dashboard endpoint failed");
    assert(asArray(world.maps).length > 0, "hub world dashboard returned no maps");

    const captures = await requestJson("/api/hub/captures");
    assert(captures.ok === true && asArray(captures.groups).length >= 2, "hub capture gallery endpoint failed");

    const pipeline = await requestJson("/api/hub/pipeline");
    assert(pipeline.ok === true && typeof pipeline.counts === "object" && Array.isArray(pipeline.rows), "hub pipeline endpoint failed");

    // P4: API reference generated from the route table (drift also fails server boot).
    const docs = await requestJson("/api/docs");
    assert(docs.ok === true, "api docs endpoint failed");
    const docRoutes = asArray(docs.routes);
    assert(docRoutes.length === API_DOCS.length, "api docs route count does not match tools/src/api-docs.ts");
    assert(
      docRoutes.every((r) => typeof (r as JsonRecord).auth === "string" && typeof (r as JsonRecord).summary === "string"),
      "api docs entries missing auth/summary",
    );
    const docsHtmlResponse = await fetch(`${baseUrl}/api-docs.html`);
    const docsHtml = await docsHtmlResponse.text();
    assert(
      docsHtmlResponse.ok && docsHtml.includes("GameKit Tool API Reference") && docsHtml.includes("/api/hub/zone-loop"),
      "api-docs.html render failed",
    );

    const zoneLoopDryRun = await requestJson("/api/hub/zone-loop", {
      method: "POST",
      body: JSON.stringify({ mapId: "map_harbor_outskirts", dryRun: true }),
    });
    assert(zoneLoopDryRun.ok === true && asArray(zoneLoopDryRun.steps).length === 6, "hub zone-loop dry-run failed");

    const prefs = await requestJson("/api/hub/prefs");
    assert(prefs.ok === true && typeof prefs.prefs === "object", "hub prefs endpoint failed");
    const savePrefs = await requestJson("/api/hub/prefs", {
      method: "POST",
      body: JSON.stringify({ guestMode: true, autoRestart: true, backupMaxCount: 10 }),
    });
    assert(savePrefs.ok === true, "hub prefs save failed");

    const serviceDryRun = await requestJson("/api/hub/service", {
      method: "POST",
      body: JSON.stringify({ service: "server", action: "start", dryRun: true }),
    });
    assert(serviceDryRun.ok === true && serviceDryRun.dryRun === true, "hub service dry-run failed");

    const profileDryRun = await requestJson("/api/hub/profile", {
      method: "POST",
      body: JSON.stringify({ profile: "dev", dryRun: true }),
    });
    assert(profileDryRun.ok === true && profileDryRun.profile === "dev", "hub profile dry-run failed");

    const launcherDryRun = await requestJson("/api/hub/launcher", {
      method: "POST",
      body: JSON.stringify({ action: "build-client", dryRun: true }),
    });
    assert(launcherDryRun.ok === true && launcherDryRun.dryRun === true, "hub launcher dry-run failed");

    // Tool-server launchers surface a real state (dry-run avoids spawning a live :8765/:5217).
    // Regression guard for the silent-fail-start class (backlog p0): the endpoints must respond
    // with a structured, well-formed state rather than an optimistic fire-and-forget.
    const assetBankDryRun = await requestJson("/api/start-asset-bank", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    assert(
      assetBankDryRun.ok === true && assetBankDryRun.dryRun === true && typeof assetBankDryRun.alreadyRunning === "boolean" && assetBankDryRun.port === 8765,
      "start-asset-bank dry-run did not report structured state",
    );
    const framePickerDryRun = await requestJson("/api/start-frame-picker", {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    assert(
      framePickerDryRun.ok === true && framePickerDryRun.dryRun === true && typeof framePickerDryRun.alreadyRunning === "boolean" && framePickerDryRun.port === 5217,
      "start-frame-picker dry-run did not report structured state",
    );

    const logs = await requestJson("/api/hub/logs?log=server&lines=5");
    assert(logs.ok === true && Array.isArray(logs.lines), "hub log tail failed");
    const clearLogDryRun = await requestJson("/api/hub/logs/clear", {
      method: "POST",
      body: JSON.stringify({ log: "server", dryRun: true }),
    });
    assert(clearLogDryRun.ok === true, "hub log clear dry-run failed");
    const rotateLogDryRun = await requestJson("/api/hub/logs/rotate", {
      method: "POST",
      body: JSON.stringify({ log: "server", dryRun: true }),
    });
    assert(rotateLogDryRun.ok === true, "hub log rotate dry-run failed");

    const backups = await requestJson("/api/hub/backups");
    assert(backups.ok === true && Array.isArray(backups.backups), "hub backups list failed");
    const backupDryRun = await requestJson("/api/hub/backup", { method: "POST", body: JSON.stringify({ dryRun: true }) });
    assert(backupDryRun.ok === true && backupDryRun.dryRun === true, "hub backup dry-run failed");
    const scratchBackupDir = path.join(repoRoot, "backups");
    const scratchBackup = path.join(scratchBackupDir, "devkit-smoke-restore.sql");
    await mkdir(scratchBackupDir, { recursive: true });
    await writeFile(scratchBackup, "-- smoke restore dry-run\n", "utf8");
    try {
      const restoreDryRun = await requestJson("/api/hub/restore", {
        method: "POST",
        body: JSON.stringify({ file: "devkit-smoke-restore.sql", dryRun: true }),
      });
      assert(restoreDryRun.ok === true && restoreDryRun.dryRun === true, "hub restore dry-run failed");
    } finally {
      await unlink(scratchBackup).catch(() => undefined);
    }

    const diagnostics = await requestJson("/api/hub/diagnostics");
    assert(diagnostics.ok === true && typeof diagnostics.diagnostics === "object", "hub diagnostics failed");

    const schema = await requestJson("/api/editor-inspector-schema");
    assert(schema.version === 1, "editor inspector schema version mismatch");
    assert(asArray(schema.layers).length >= 7, "editor inspector schema is missing layers");

    const layouts = await requestJson("/api/zone-layouts");
    const harbor = asArray(layouts.layouts).find((entry): entry is JsonRecord => {
      return Boolean(entry) && typeof entry === "object" && (entry as JsonRecord).mapId === "map_harbor_outskirts";
    });
    assert(harbor, "Harbor layout not returned by DevKit");
    assert(typeof harbor.hash === "string" && typeof harbor.modifiedMs === "number", "Harbor layout missing freshness metadata");
    const harborData = harbor.data as JsonRecord;
    const harborProps = asArray(harborData.props) as JsonRecord[];
    const prop = harborProps.find((item) => item.assetKey === "harbor_barrel_cluster") ?? harborProps[0];
    assert(prop?.instanceId && prop.assetKey, "No suitable Harbor prop found for instance/default smoke");

    // Snapshot the real content file so a placement-defaults save that actually writes
    // (sanitize round-trip differs -> diff>0) never leaves the committed file dirty. Restored
    // in `finally`. Belt-and-suspenders with the handler now preserving placementClasses.
    const editorMetadataPath = path.join(repoRoot, "content", "asset-editor-metadata.json");
    editorMetadataSnapshot = await readFile(editorMetadataPath, "utf8");

    const defaults = await requestJson("/api/asset-placement-defaults");
    assert(defaults.file === "content/asset-editor-metadata.json", "placement defaults endpoint returned unexpected file");
    assert(typeof defaults.hash === "string" && typeof defaults.modifiedMs === "number", "placement defaults missing freshness metadata");

    const preview = await requestJson("/api/asset-placement-defaults/preview", {
      method: "POST",
      body: JSON.stringify({
        layer: "props",
        assetKey: prop.assetKey,
        instance: prop,
        defaults: ((defaults.metadata as JsonRecord).assets as JsonRecord)[String(prop.assetKey)] ?? {
          assetKey: prop.assetKey,
          placementKind: "prop",
        },
      }),
    });
    assert(preview.ok === true, "placement default preview failed");
    assert(typeof preview.resolved === "object", "placement default preview did not return resolved placement");
    assert(typeof preview.sources === "object", "placement default preview did not return field sources");

    const saveDefaults = await requestJson("/api/asset-placement-defaults/save", {
      method: "POST",
      body: JSON.stringify({
        layer: "props",
        assetKey: prop.assetKey,
        defaults: ((defaults.metadata as JsonRecord).assets as JsonRecord)[String(prop.assetKey)] ?? {
          assetKey: prop.assetKey,
          placementKind: "prop",
        },
        baseHash: defaults.hash,
        baseModifiedMs: defaults.modifiedMs,
      }),
    });
    assert(saveDefaults.ok === true, "placement defaults no-op save failed");
    // Regression guard: a per-asset save must PRESERVE top-level placementClasses (the
    // prop-collision rule classes). Dropping them silently wiped ~85 lines on every save.
    if ((defaults.metadata as JsonRecord).placementClasses !== undefined) {
      const afterSave = JSON.parse(await readFile(editorMetadataPath, "utf8")) as JsonRecord;
      assert(afterSave.placementClasses !== undefined, "placement-defaults save DROPPED placementClasses (data loss)");
    }

    const overrideSave = await requestJson("/api/zone-layout/instance-override/save", {
      method: "POST",
      body: JSON.stringify({
        mapId: "map_harbor_outskirts",
        layer: "props",
        instanceId: prop.instanceId,
        instance: prop,
        baseHash: harbor.hash,
        baseModifiedMs: harbor.modifiedMs,
      }),
    });
    assert(overrideSave.ok === true && overrideSave.unchanged === true, "instance override no-op save failed or wrote unexpectedly");

    const bankContext = await requestJson("/api/bank-context?mapId=map_harbor_outskirts");
    assert(bankContext.ok === true, "bank context endpoint failed");
    assert(bankContext.zoneId === "zone_harbor", "Harbor did not resolve to zone_harbor");
    const contextCategories = bankContext.categories as JsonRecord;
    // Content-agnostic: the R2A purge (2026-07-02) legitimately emptied Harbor bank props
    // pending R2 regeneration, so assert the endpoint SHAPE, not candidate presence.
    assert(contextCategories !== null && typeof contextCategories === "object", "bank context did not return categories");
    assert(Array.isArray(contextCategories.props), "bank context props is not an array");
    if (asArray(contextCategories.props).length === 0) {
      console.log("[smoke] NOTE: bank context returned 0 Harbor prop candidates (bank purged pending R2 regeneration)");
    }

    const bankAssets = await requestJson("/api/bank-assets");
    const bankCategories = bankAssets.categories as JsonRecord;
    assert(bankCategories && typeof bankCategories === "object", "bank assets endpoint did not return categories");

    const promoted = await requestJson("/api/promoted-assets");
    assert(asArray(promoted.promoted).length > 0, "promoted assets endpoint returned no runtime assets");

    const validate = await requestJson("/api/zone-validate", { method: "POST", body: "{}" });
    assert(validate.ok === true, "zone validation endpoint failed");

    const exportDryRun = await requestJson("/api/zone-export", {
      method: "POST",
      body: JSON.stringify({ mapId: "map_harbor_outskirts", dryRun: true }),
    });
    assert(exportDryRun.ok === true, "zone export dry-run endpoint failed");

    const bankSmokeRoot = path.join(repoRoot, "tools", "_smoke", "asset-bank-qol");
    const bankAssetsRoot = path.join(bankSmokeRoot, "assets");
    const bankMetadataRoot = path.join(bankSmokeRoot, "metadata");
    const bankReviewRoot = path.join(bankMetadataRoot, "_review");
    const bankPort = port + 101;
    await rm(bankSmokeRoot, { recursive: true, force: true });
    await mkdir(path.join(bankAssetsRoot, "props"), { recursive: true });
    await mkdir(bankReviewRoot, { recursive: true });
    await writeFile(path.join(bankAssetsRoot, "props", "smoke-note.txt"), "asset bank smoke\n", "utf8");
    await writeFile(path.join(bankAssetsRoot, "props", "mismatch-note.txt"), "asset bank promoted mismatch smoke\n", "utf8");
    // --no-repo-roots: this fixture exercises a pure Z:/Assets bank (2 seeded files). The repo
    // roots are on by default in production, but here they would swamp the fixture assertions.
    const bank = spawn(commandName("pnpm"), ["exec", "tsx", "tools/src/asset-bank-server.ts", String(bankPort), "--assets-root", bankAssetsRoot, "--metadata-root", bankMetadataRoot, "--auto-rescan-mins", "0", "--no-repo-roots"], {
      cwd: repoRoot,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
    });
    try {
      const bankBase = `http://127.0.0.1:${bankPort}`;
      const bankJson = async (pathName: string, init?: RequestInit): Promise<JsonRecord> => {
        const response = await fetch(`${bankBase}${pathName}`, {
          ...init,
          headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        });
        const text = await response.text();
        const body = text ? (JSON.parse(text) as JsonRecord) : {};
        if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${pathName} returned ${response.status}: ${text.slice(0, 300)}`);
        return body;
      };
      const start = Date.now();
      while (Date.now() - start < 20_000) {
        try {
          await bankJson("/api/health");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      const rescan = await bankJson("/api/catalog/rescan", { method: "POST", body: "{}" });
      assert(rescan.ok === true && rescan.total === 2, "fixture Asset Bank rescan failed");
      // Health must succeed on a fresh bank whose review/related stores have never been written
      // (no asset-review-status.json yet). Previously readJsonStrict ENOENT'd here and Health 500'd.
      const freshHealth = await bankJson("/api/asset-bank/health");
      assert(
        freshHealth.ok === true && (freshHealth.reviews as JsonRecord).total === 0,
        "Asset Bank health failed on a fresh bank with no review status file",
      );
      const unreviewed = await bankJson("/api/assets?decision=unreviewed");
      assert(unreviewed.total === 2 && asArray(unreviewed.assets).length === 2, "Asset Bank decision=unreviewed filter failed");
      const bulk = await bankJson("/api/reviews/bulk", {
        method: "POST",
        body: JSON.stringify({
          reviews: [
            { id: "props_smoke_note_txt", decision: "rejected", notes: "smoke valid" },
            { id: "props_smoke_note_txt", decision: "not-a-real-decision", notes: "smoke invalid" },
          ],
        }),
      });
      assert(bulk.saved === 1 && asArray(bulk.blocked).length === 1, "Asset Bank bulk review did not report partial failure truthfully");
      await bankJson("/api/review", {
        method: "POST",
        body: JSON.stringify({
          id: "legacy_promoted_mismatch",
          path: "props/mismatch-note.txt",
          decision: "runtime-promoted",
          status: "promoted",
          notes: "smoke path-join promoted",
        }),
      });
      const promotedByPath = await bankJson("/api/assets?decision=runtime-promoted");
      const promotedAssets = asArray(promotedByPath.assets) as JsonRecord[];
      assert(
        promotedByPath.total === 1 && (promotedAssets[0].review_decision as JsonRecord).decision === "runtime-promoted",
        "Asset Bank did not join runtime-promoted review rows by path",
      );
    } finally {
      stopChildProcess(bank);
      await rm(bankSmokeRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    // Repo-roots regression: a bank with repo roots ON (default) must catalog post-cel-pivot
    // repo deliverables as READ-ONLY repo-origin rows. Uses the REAL repo roots (read-only, so
    // safe) with a throwaway metadata root, so this never touches the owner's :8765 or Z:/Assets.
    const repoBankRoot = path.join(repoRoot, "tools", "_smoke", "asset-bank-repo-roots");
    const repoBankAssets = path.join(repoBankRoot, "assets");
    const repoBankMetadata = path.join(repoBankRoot, "metadata");
    const repoBankPort = port + 102;
    await rm(repoBankRoot, { recursive: true, force: true });
    await mkdir(path.join(repoBankMetadata, "_review"), { recursive: true });
    await mkdir(repoBankAssets, { recursive: true });
    const repoBank = spawn(commandName("pnpm"), ["exec", "tsx", "tools/src/asset-bank-server.ts", String(repoBankPort), "--assets-root", repoBankAssets, "--metadata-root", repoBankMetadata, "--auto-rescan-mins", "0"], {
      cwd: repoRoot,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
    });
    try {
      const repoBase = `http://127.0.0.1:${repoBankPort}`;
      const repoBankJson = async (pathName: string, init?: RequestInit): Promise<JsonRecord> => {
        const response = await fetch(`${repoBase}${pathName}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
        const text = await response.text();
        const body = text ? (JSON.parse(text) as JsonRecord) : {};
        return { ...body, __status: response.status };
      };
      const start = Date.now();
      while (Date.now() - start < 20_000) {
        try {
          const h = await repoBankJson("/api/health");
          if (h.__status === 200) break;
        } catch {
          // keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const rescan = await repoBankJson("/api/catalog/rescan", { method: "POST", body: "{}" });
      assert(typeof rescan.total === "number" && (rescan.total as number) > 100, "repo-roots bank rescan cataloged no repo assets");
      const gloam = await repoBankJson("/api/assets?q=monster_gloamslime.png&limit=5");
      const gloamRows = asArray(gloam.assets) as JsonRecord[];
      const gloamRow = gloamRows.find((row) => row.path === "runtime-only/sprites/monster_gloamslime.png");
      assert(
        gloamRow && gloamRow.origin === "repo-runtime" && gloamRow.category === "monsters" && gloamRow.status === "promoted" && asArray(gloamRow.tags).includes("in-game"),
        "gloamslime did not surface as a promoted repo-runtime monsters row",
      );
      const ore = await repoBankJson("/api/assets?q=ore_node_copper&limit=5");
      const oreRow = (asArray(ore.assets) as JsonRecord[]).find((row) => row.path === "runtime-only/props/ore_node_copper.png");
      assert(oreRow && oreRow.origin === "repo-runtime" && oreRow.category === "props", "ore_node_copper did not surface as a repo-runtime props row");
      // READ-ONLY: promote + review of a repo-origin row must be refused with 409.
      const promoteBlocked = await repoBankJson("/api/promote", { method: "POST", body: JSON.stringify({ assetId: gloamRow!.id, type: "sprite" }) });
      assert(promoteBlocked.__status === 409 && promoteBlocked.ok === false, "repo-origin promote was not refused (read-only guard missing)");
      const reviewBlocked = await repoBankJson("/api/review", { method: "POST", body: JSON.stringify({ id: gloamRow!.id, decision: "rejected" }) });
      assert(reviewBlocked.__status === 409 && reviewBlocked.ok === false, "repo-origin review was not refused (read-only guard missing)");
    } finally {
      stopChildProcess(repoBank);
      await rm(repoBankRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    console.log(
      [
        "DevKit compatibility smoke passed.",
        `base=${baseUrl}`,
        `assetBank=${((status.assetBank as JsonRecord | undefined)?.running ?? false) ? "live-api" : "metadata-fallback"}`,
        "checked=status,hub-lifecycle-api,hub-p3-zone-loop-world-captures-pipeline,api-docs,schema,layouts,placement-defaults,instance-override,bank-context,bank-assets,promoted-assets,zone-validate,zone-export-dry-run,start-asset-bank-dry-run,start-frame-picker-dry-run,asset-bank-fixture-unreviewed-filter,asset-bank-fixture-runtime-promoted-path-join,asset-bank-fixture-bulk-partial,asset-bank-fixture-fresh-health,asset-bank-repo-roots-gloamslime-ore-readonly",
      ].join("\n"),
    );
  } finally {
    // Restore the content file if any placement-defaults save wrote to it, so the smoke
    // gate is non-destructive to the committed tree.
    if (typeof editorMetadataSnapshot === "string") {
      try {
        const now = await readFile(path.join(repoRoot, "content", "asset-editor-metadata.json"), "utf8");
        if (now !== editorMetadataSnapshot) await writeFile(path.join(repoRoot, "content", "asset-editor-metadata.json"), editorMetadataSnapshot, "utf8");
      } catch {
        // best-effort restore
      }
    }
    stopDevKit(devkit);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
