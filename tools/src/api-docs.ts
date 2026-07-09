// API reference generated from the live route tables (TOOLSUITE-P4).
//
// Every route registered in the DevKit (:8787, includes hub) and Asset Bank (:8765)
// route Maps must have a RouteDoc entry here. Both servers call verifyRouteDocs() at
// startup and REFUSE TO BOOT on a mismatch (fail closed, like the defect gate) — so
// this file cannot drift from the real route tables. The rendered page lives at
// http://127.0.0.1:8787/api-docs.html ; machine-readable JSON at GET /api/docs on
// both servers.
//
// Auth is a server-level gate, not per-route (devkit.ts / asset-bank-server.ts):
//   - non-loopback Origin      -> 403 always
//   - GET                      -> loopback only, no token
//   - POST with browser Origin -> requires x-devkit-token (invisible-token auth)
//   - POST without Origin      -> trusted local CLI (token file also accepted)
// DevKit-spawned Asset Bank inherits DEVKIT_SESSION_TOKEN, so both token files
// contain the same token in that mode; standalone Asset Bank mints its own fallback.
// The auth column in the output is derived from the method — never hand-written.

export type RouteServer = "devkit" | "hub" | "bank";

export interface RouteDoc {
  server: RouteServer;
  method: "GET" | "POST";
  path: string;
  summary: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
  returns?: string;
}

export const SERVER_INFO: Record<RouteServer, { base: string; title: string }> = {
  devkit: { base: "http://127.0.0.1:8787", title: "DevKit (zone editor, promotion, zone loop)" },
  hub: { base: "http://127.0.0.1:8787", title: "Hub (stack ops: DB/server/tunnel, logs, backups)" },
  bank: { base: "http://127.0.0.1:8765", title: "Asset Bank (catalog, review, promotion)" },
};

export function authFor(doc: RouteDoc): string {
  return doc.method === "POST" ? "loopback + x-devkit-token" : "loopback, no token";
}

export const API_DOCS: RouteDoc[] = [
  // ── DevKit (:8787) ──────────────────────────────────────────────────────────
  { server: "devkit", method: "GET", path: "/api/status", summary: "DevKit status: repo/asset paths, asset-bank + frame-picker state, audio review state, asset counts, queue summaries.", returns: "{repoRoot, assetsRoot, port, assetBank, framePicker, audio, assetCounts, queues}" },
  { server: "devkit", method: "GET", path: "/api/queues", summary: "Review queues with live/stale item counts from the review metadata.", returns: "{queues: QueueSummary[]}" },
  { server: "devkit", method: "GET", path: "/api/frame-picker-candidates", summary: "Animation source folders containing frames/raw, for the Pipeline v4 frame picker.", returns: "{candidates: {path, frameCount, hasSelection}[]}" },
  { server: "devkit", method: "POST", path: "/api/start-asset-bank", summary: "Launch or restart the Asset Bank Node server (:8765); no-ops with alreadyRunning when healthy, refuses an occupied port, and verifies the launch before reporting success.", body: { restart: "boolean — kill and relaunch if already running (default false)", dryRun: "boolean — report planned state without spawning (optional)" }, returns: "{ok, url, started?, restarted?, alreadyRunning?, pid?, error?, logTail?}" },
  { server: "devkit", method: "POST", path: "/api/start-frame-picker", summary: "Launch the frame picker (:5217), optionally with a candidate folder; no-ops with alreadyRunning when already up and verifies the launch.", body: { candidate: "string — folder path containing frames/raw (optional)", dryRun: "boolean — report planned state without spawning (optional)" }, returns: "{ok, pid?, candidate?, url, started?, alreadyRunning?, error?}" },
  { server: "devkit", method: "POST", path: "/api/refresh-audio-review", summary: "Regenerate audio-review.html under the assets root.", returns: "{ok, pid, path, url}" },
  { server: "devkit", method: "GET", path: "/api/runtime-assets", summary: "Recursive listing of client/public/assets with size and extension.", returns: "{root, count, assets: {path, size, ext}[]}" },
  { server: "devkit", method: "GET", path: "/api/runtime-assets-categorized", summary: "Runtime assets grouped by category (tiles, decals, props, ...) with keys and image dimensions.", returns: "{categories: Record<string, PickerItem[]>}" },
  { server: "devkit", method: "GET", path: "/api/bank-assets", summary: "Accepted Asset Bank assets as categorized picker items (tiles, decals, props).", returns: "{categories: {tiles, decals, props}, error?}" },
  { server: "devkit", method: "GET", path: "/api/bank-context", summary: "Bank context for one zone: categorized assets, entity profiles, layer counts, missing assets.", query: { mapId: "zone id, e.g. map_harbor_outskirts" }, returns: "{ok, mapId, zoneId, zone, source, categories, entityProfiles, emptyState, missingAssets}" },
  { server: "devkit", method: "GET", path: "/api/editor-inspector-schema", summary: "The shared editor inspector contract consumed by the zone editor UI.", returns: "EDITOR_INSPECTOR_CONTRACT" },
  { server: "devkit", method: "GET", path: "/api/asset-placement-defaults", summary: "Placement-defaults metadata for all assets, with file hash/mtime for stale-safe saves.", returns: "{metadata, hash, modifiedMs, file}" },
  { server: "devkit", method: "POST", path: "/api/asset-placement-defaults/preview", summary: "Preview a placement-defaults change: resolved values, diff, and per-field source attribution.", body: { layer: "\"props\" | \"decals\"", assetKey: "string", defaults: "object (optional)", instance: "object (optional)" }, returns: "{ok, file, hash, modifiedMs, before, after, diff, resolved, sources}" },
  { server: "devkit", method: "POST", path: "/api/asset-placement-defaults/save", summary: "Save placement defaults; stale-checked via baseHash/baseModifiedMs.", body: { layer: "\"props\" | \"decals\" (required)", assetKey: "string (required)", defaults: "object (required)", baseHash: "string (optional)", baseModifiedMs: "number (optional)" }, returns: "{ok, file, hash, modifiedMs, before, after, diff, unchanged?}" },
  { server: "devkit", method: "POST", path: "/api/promote-asset", summary: "Promote a bank asset into the runtime (defect gate enforced; refuses byte-different existing runtime targets unless force:true).", body: { path: "string — bank-relative source path", targetType: "\"tiles\" | \"decals\" | \"props\"", force: "boolean optional" }, returns: "{ok, key, registryKey, replacedKeys, targetPath, alreadyExisted, entityRepointed}" },
  { server: "devkit", method: "POST", path: "/api/sync-promoted", summary: "Run pnpm promoted-asset-sync to regenerate promoted-assets.ts from the registry.", returns: "{ok, output}" },
  { server: "devkit", method: "GET", path: "/api/promoted-assets", summary: "Promoted assets from the registry with source/target paths and URLs.", returns: "{promoted: {key, type, sourcePath, targetPath, url}[]}" },
  { server: "devkit", method: "POST", path: "/api/unpromote-asset", summary: "Remove a promoted asset (registry + runtime file); blocked while a zone layout still uses it.", body: { key: "string — registry key (required)" }, returns: "{ok, key, removedFile}" },
  { server: "devkit", method: "GET", path: "/api/zone-layouts", summary: "All zone .layout.json files with mapId, full data, hash, and mtime.", returns: "{layouts: {file, mapId, data, hash, modifiedMs}[]}" },
  { server: "devkit", method: "GET", path: "/api/hub/captures", summary: "Capture gallery: recent zone (_capture) and editor (_editor-captures) PNGs.", returns: "{ok, groups: {kind, root, count, captures}[]}" },
  { server: "devkit", method: "GET", path: "/api/hub/world", summary: "World dashboard: per-map bounds, spawns, NPCs, monster zones, portals, plus live server reachability.", returns: "{ok, online, totals, maps: MapSummary[]}" },
  { server: "devkit", method: "GET", path: "/api/hub/pipeline", summary: "Promote → place → export pipeline view: accepted vs promoted vs placed per map/layer.", returns: "{ok, counts, rows: {key, type, sourcePath, placements}[]}" },
  { server: "devkit", method: "GET", path: "/api/hub/apply-status", summary: "Apply-status card: per-map layout→compiled drift (reuses the cohesion drift gate), plus promoted-registry and generated promoted-assets.ts timestamps. Live sources, no state store.", returns: "{ok, maps: {total, stale, rows: {mapId, status, fresh, detail?, layoutHash?, compiledHash?}[]}, promotedRegistry: {count, updatedAt}, generatedAssets: {path, updatedAt, stale}}" },
  { server: "devkit", method: "POST", path: "/api/hub/zone-loop", summary: "One-button zone loop: validate → sync promoted → export → build → restart server → reload URL. Steps report individually; loop stops at the first failure. build-client step is long (up to ~3 min).", body: { mapId: "string — one zone, or omit for all", dryRun: "boolean — accept every step without executing (optional)" }, returns: "{ok, mapId, dryRun, reloadUrl?, steps: {name, label, ok, output, dryRun?}[]}" },
  { server: "devkit", method: "POST", path: "/api/editor-capture/save", summary: "Save a base64 PNG editor screenshot into tools/_editor-captures.", body: { mapId: "string", label: "string", imageData: "\"data:image/png;base64,...\"" }, returns: "{ok, file}" },
  { server: "devkit", method: "POST", path: "/api/zone-layout/save", summary: "Save a zone layout; stale-checked (hash/mtime), schema-validated, then zone:validate runs.", body: { mapId: "string (required)", data: "ZoneLayout (required)", baseHash: "string (optional)", baseModifiedMs: "number (optional)" }, returns: "{ok, file, hash, modifiedMs, output}" },
  { server: "devkit", method: "POST", path: "/api/zone-layout/instance-override/save", summary: "Save a single placed-instance override (position/rotation/scale) inside a zone layout; stale-checked.", body: { mapId: "string", layer: "\"props\" | \"decals\"", instanceId: "string", instance: "object", baseHash: "string (optional)", baseModifiedMs: "number (optional)" }, returns: "{ok, file, layer, instanceId, hash, modifiedMs, output}" },
  { server: "devkit", method: "POST", path: "/api/zone-validate", summary: "Run pnpm zone:validate across all zone layouts.", returns: "{ok, output}" },
  { server: "devkit", method: "POST", path: "/api/zone-export", summary: "Export zone layout(s) to runtime JSON; optionally scoped to one mapId.", body: { mapId: "string (optional)", dryRun: "boolean (optional)" }, returns: "{ok, output}" },
  { server: "devkit", method: "POST", path: "/api/build-client", summary: "Run the Vite production client build (long-running, ~2-3 min).", returns: "{ok, output}" },
  { server: "devkit", method: "GET", path: "/api/map-manifests", summary: "All map manifest JSON files from content/maps.", returns: "{maps: {id, data}[]}" },
  { server: "devkit", method: "GET", path: "/api/available-asset-keys", summary: "Asset keys (basenames) of every image under client/public/assets.", returns: "{keys: string[]}" },
  { server: "devkit", method: "GET", path: "/api/content-ids", summary: "Content ids by kind: npcs, monsters, portals, lootTables, maps.", returns: "{npcs, monsters, portals, lootTables, maps: string[]}" },
  { server: "devkit", method: "POST", path: "/api/write-assets-bridge", summary: "Rewrite the Z:/Assets bridge README/state files.", returns: "{ok}" },
  { server: "devkit", method: "GET", path: "/api/procgen/generate", summary: "Run the ported room-graph dungeon generator (server/src/procgen) and return a compact render payload for the read-only preview tab. No writes, no gameplay wiring.", query: { seed: "uint32 (default 12345)", roomCount: "4..60 (default 24)", loopChance: "0..1 (default 0.3)" }, returns: "{ok, seed, valid, W, H, gridB64, rooms, edges, spawns, entrance, boss, stats, layoutSummary}" },
  { server: "devkit", method: "GET", path: "/api/docs", summary: "This API reference as JSON, generated from the live route table (devkit + hub + bank).", returns: "{ok, generatedFrom, servers, special, routes: RouteDoc[] (with auth)}" },
  { server: "devkit", method: "GET", path: "/api-docs.html", summary: "This API reference as one rendered HTML page (devkit + hub + bank).", returns: "text/html" },
  { server: "devkit", method: "GET", path: "/tool-map.html", summary: "One-page DevKit tool map generated from the route documentation.", returns: "text/html" },

  // ── Hub (:8787, stack ops) ──────────────────────────────────────────────────
  { server: "hub", method: "GET", path: "/api/hub/status", summary: "Full hub snapshot: prefs, desired services, tracked processes, health, backups, log paths.", returns: "{ok, prefs, desired, processes, health, backups, logs}" },
  { server: "hub", method: "GET", path: "/api/hub/health", summary: "Fresh health probe of database/server/tunnel with per-service latency.", returns: "{ok, health: {service, status, detail, pid?, latencyMs?}[]}" },
  { server: "hub", method: "GET", path: "/api/hub/prefs", summary: "Current hub preferences.", returns: "{ok, prefs}" },
  { server: "hub", method: "POST", path: "/api/hub/prefs", summary: "Save hub preferences; applies Windows autostart when requested.", body: { guestMode: "boolean", autoRestart: "boolean — watchdog", autoStartProfile: "\"none\" | \"dev\" | \"online\"", backupMaxCount: "number", windowsAutostart: "boolean", trayEnabled: "boolean" }, returns: "{ok, prefs}" },
  { server: "hub", method: "POST", path: "/api/hub/service", summary: "Start/stop/restart one managed service (process start/stop lives here).", body: { service: "\"database\" | \"server\" | \"tunnel\" (required)", action: "\"start\" | \"stop\" | \"restart\" (required)", dryRun: "boolean (optional)" }, returns: "{ok, service, action, output, health}" },
  { server: "hub", method: "POST", path: "/api/hub/profile", summary: "Apply a stack profile (dev = DB+server+dev-client, online = adds tunnel).", body: { profile: "\"none\" | \"dev\" | \"online\" (required)", save: "boolean — persist as auto-start profile (optional)", dryRun: "boolean (optional)" }, returns: "{ok, profile, output}" },
  { server: "hub", method: "POST", path: "/api/hub/launcher", summary: "One-shot launcher actions.", body: { action: "\"build-client\" | \"dev-client\" | \"validate\" | \"open-game\" (required)", dryRun: "boolean (optional)" }, returns: "{ok, output?, pid?, url?}" },
  { server: "hub", method: "GET", path: "/api/hub/logs", summary: "Tail a managed log.", query: { log: "\"server\" | \"tunnel\" | \"hub\" | \"dev-client\" (default server)", lines: "1-200 (default 60)" }, returns: "{ok, log, path, lines: string[]}" },
  { server: "hub", method: "POST", path: "/api/hub/logs/clear", summary: "Truncate a managed log.", body: { log: "\"server\" | \"tunnel\" | \"hub\" | \"dev-client\"", dryRun: "boolean (optional)" }, returns: "{ok, log, path}" },
  { server: "hub", method: "POST", path: "/api/hub/logs/rotate", summary: "Rotate a log if it exceeds the size limit.", body: { log: "\"server\" | \"tunnel\"", dryRun: "boolean (optional)" }, returns: "{ok, path}" },
  { server: "hub", method: "GET", path: "/api/hub/backups", summary: "List SQL backups with sizes and total usage.", returns: "{ok, backups: {file, sizeBytes, modifiedAt}[], totalBytes, maxCount}" },
  { server: "hub", method: "POST", path: "/api/hub/backup", summary: "Create a PostgreSQL backup dump (prunes beyond backupMaxCount).", body: { dryRun: "boolean (optional)" }, returns: "{ok, file, sizeBytes, pruned?}" },
  { server: "hub", method: "POST", path: "/api/hub/restore", summary: "Restore the database from a backup file; requires confirm:true.", body: { file: "string — backup filename (required)", confirm: "boolean (required unless dryRun)", dryRun: "boolean (optional)" }, returns: "{ok, file, output}" },
  { server: "hub", method: "GET", path: "/api/hub/diagnostics", summary: "System diagnostics: Docker, DB connectivity, processes, recent log tails.", returns: "{ok, diagnostics}" },
  { server: "hub", method: "POST", path: "/api/hub/tray", summary: "Enable/disable the Windows tray notifier.", body: { enabled: "boolean (required)" }, returns: "{ok, trayEnabled, mode, pid?}" },
  { server: "hub", method: "POST", path: "/api/hub/toast", summary: "Send a notification through the tray notifier.", body: { message: "string" }, returns: "{ok}" },

  // ── Asset Bank (:8765) ──────────────────────────────────────────────────────
  { server: "bank", method: "GET", path: "/api/asset-bank-node/health", summary: "Node bank liveness + assets root mount check.", returns: "{ok, mounted, root}" },
  { server: "bank", method: "GET", path: "/api/asset-bank/health", summary: "Full bank health report (metadata files, counts, disk state).", returns: "{ok, ...health report}" },
  { server: "bank", method: "GET", path: "/api/health", summary: "Simple health check with timestamp.", returns: "{ok, root, time}" },
  { server: "bank", method: "GET", path: "/api/data", summary: "The whole catalog: asset-review-data.json (all assets + metadata). Large; prefer /api/assets for filtered reads.", returns: "{assets: AssetRecord[], generated_at}" },
  { server: "bank", method: "GET", path: "/api/status", summary: "All review decisions (asset-review-status.json).", returns: "{reviews: Record<id, ReviewRecord>, ...}" },
  { server: "bank", method: "GET", path: "/api/assets", summary: "Filtered, paginated asset search.", query: { category: "asset category (optional)", kind: "asset kind (optional)", decision: "review decision (optional)", status: "catalog status (optional)", q: "text search (optional)", unreviewed: "\"true\" — only unreviewed (optional)", limit: "page size (default 100)", offset: "start index (default 0)" }, returns: "{total, offset, limit, count, assets: AssetRecord[]}" },
  { server: "bank", method: "GET", path: "/api/asset/image", summary: "Full-size image bytes for one asset.", query: { id: "asset id (required)" }, returns: "image bytes" },
  { server: "bank", method: "GET", path: "/api/asset/thumb", summary: "Cached 320px WebP thumbnail (PIL-generated, keyed by id+mtime+size+crop).", query: { id: "asset id (required)", crop: "\"alpha\" crops to visible pixels (optional)" }, returns: "image/webp bytes" },
  { server: "bank", method: "GET", path: "/api/asset/fringe-overlay", summary: "Defect-gate overlay visualization for one asset (fringe/chroma analysis).", query: { id: "asset id (required)" }, returns: "overlay image / analysis JSON" },
  { server: "bank", method: "POST", path: "/api/asset/fringe-overlay", summary: "Same as GET variant, accepting a JSON payload.", body: { id: "asset id" }, returns: "overlay image / analysis JSON" },
  { server: "bank", method: "GET", path: "/api/asset/refresh-fringe", summary: "Re-run the Python defect gate for one asset and update its cached fringe flags.", query: { id: "asset id (required)" }, returns: "{ok, fringe, fringe_kind?, asset}" },
  { server: "bank", method: "POST", path: "/api/asset/refresh-fringe", summary: "Same as GET variant, accepting a JSON payload.", body: { id: "asset id (required)" }, returns: "{ok, fringe, fringe_kind?, asset}" },
  { server: "bank", method: "GET", path: "/api/asset/diagnostics", summary: "Per-asset diagnostics: file size, image dimensions, format, review history.", query: { id: "asset id (required)" }, returns: "{ok, asset, fileSize, imageDims, format, reviews}" },
  { server: "bank", method: "GET", path: "/api/stats", summary: "Counts by category, kind, decision, and quality issues.", returns: "{categories, kinds, decisions, qualityIssues}" },
  { server: "bank", method: "GET", path: "/api/related-groups", summary: "Related-asset groups (variants collapsed for batch review).", returns: "{groups: RelatedGroup[]}" },
  { server: "bank", method: "GET", path: "/api/queues", summary: "Review queue files with live vs stale counts.", returns: "{queues: {name, count, liveCount, staleCount, path}[]}" },
  { server: "bank", method: "GET", path: "/api/promotion-plan", summary: "A generated promotion plan by id.", query: { id: "plan id (required)" }, returns: "{plan}" },
  { server: "bank", method: "GET", path: "/api/entity-profiles", summary: "NPC/monster entity profiles (zone-editor asset bindings).", returns: "{entities}" },
  { server: "bank", method: "GET", path: "/api/zone-packs", summary: "Zone packs: map groups + asset layers for bulk operations.", returns: "{zones}" },
  { server: "bank", method: "GET", path: "/api/collections", summary: "Asset collections (thematic groupings).", returns: "{collections}" },
  { server: "bank", method: "GET", path: "/api/coverage-report", summary: "Entity/zone coverage report; flags missing assets per zone layer.", returns: "{report, missingByZone}" },
  { server: "bank", method: "GET", path: "/api/promoted", summary: "The promoted-assets registry.", returns: "{promoted}" },
  { server: "bank", method: "GET", path: "/api/reconcile", summary: "Report-only runtime-vs-bank reconcile verdict and drift/orphan counts.", returns: "{ok, driftCount, changedReviews, orphans}" },
  { server: "bank", method: "GET", path: "/api/docs", summary: "This API reference as JSON (bank's own view of the shared reference).", returns: "{ok, generatedFrom, servers, special, routes: RouteDoc[] (with auth)}" },
  { server: "bank", method: "POST", path: "/api/review", summary: "Record one review decision. Defect gate: accepting a defective image is blocked (fringe/chroma/pink-rim/opaque); single-writer lock + atomic write + .prev backup.", body: { id: "asset id (required)", path: "asset path", decision: "\"accepted\" | \"rejected\" | \"needs-cleanup\" | \"promote-later\" | ...", notes: "string (optional)", priority: "\"normal\" | \"cleanup\" (optional)", status: "string (optional)" }, returns: "{ok, review, vibrancyWarnings?}" },
  { server: "bank", method: "POST", path: "/api/reviews/bulk", summary: "Record many review decisions at once; defective accepts are collected in blocked[].", body: { reviews: "review payload[] (required)" }, returns: "{ok, saved, blocked: {id, error}[], vibrancyWarnings?}" },
  { server: "bank", method: "POST", path: "/api/asset/update", summary: "Update asset metadata (category/kind/tags/name).", body: { id: "asset id (required)", category: "string (optional)", kind: "string (optional)", tags: "string[] (optional)", name: "string (optional)" }, returns: "{ok, updated}" },
  { server: "bank", method: "POST", path: "/api/catalog/rescan", summary: "Rescan Z:/Assets for new/moved/removed files and update the catalog.", returns: "{ok, output, added?, removed?}" },
  { server: "bank", method: "POST", path: "/api/catalog/recategorize", summary: "Re-run category detection, optionally only for assets currently in given categories.", body: { only_from: "string[] — restrict to these current categories (optional)" }, returns: "{ok, recategorized}" },
  { server: "bank", method: "POST", path: "/api/asset-bank/repair", summary: "Repair bank state: rebuild indices, drop orphans, validate file existence.", body: { fullScan: "boolean (optional)" }, returns: "{ok, output, repaired?}" },
  { server: "bank", method: "POST", path: "/api/quality-check", summary: "Promotion-readiness check for one asset (size/format/defect gate).", body: { assetId: "string (required)", type: "\"sprite\" | \"tile\" | \"prop\" | ... (optional)" }, returns: "{passed, errors, warnings}" },
  { server: "bank", method: "POST", path: "/api/promote", summary: "Promote an accepted asset into the runtime (defect gate enforced; registry updated).", body: { assetId: "string (required)", type: "\"sprite\" | \"tile\" | \"prop\" | ... (default sprite)", targetName: "string (optional)", context: "string (optional)" }, returns: "{ok, promoted: {assetId, targetPath, targetName, warnings}}" },
  { server: "bank", method: "POST", path: "/api/unpromote", summary: "Clear a promoted registry entry and return any live references; does not delete runtime files or edit manifests.", body: { assetId: "string (required)" }, returns: "{ok, removed, key, removedFile:null, stillReferencedBy}" },
  { server: "bank", method: "POST", path: "/api/reconcile", summary: "Apply runtime-promoted review/status backfill from runtime truth. Integrator-only after backing up _review.", returns: "{ok, driftCount, changedReviews, ingestedAssets, orphans}" },
  { server: "bank", method: "POST", path: "/api/asset/open-location", summary: "Open the asset's folder in the OS file explorer.", body: { id: "asset id (required)" }, returns: "{ok, path}" },
  { server: "bank", method: "POST", path: "/api/asset/remove-from-bank", summary: "Quarantine an asset to _deleted; blocked if promoted unless force:true.", body: { id: "asset id (required)", force: "boolean (optional)" }, returns: "{ok, removed, targetPath}" },
  { server: "bank", method: "POST", path: "/api/generate-promotion-plan", summary: "Generate a promotion plan from selected assets.", body: { name: "string (required)", assetIds: "string[] (required)", targetDir: "string (optional)" }, returns: "{ok, plan}" },
  { server: "bank", method: "POST", path: "/api/generate-promotion-pack", summary: "Generate an executable promotion pack from a plan.", body: { name: "string", planId: "string (optional)" }, returns: "{ok, packId, name}" },
  { server: "bank", method: "POST", path: "/api/related-groups", summary: "Save a related-asset group (alias of /api/related-group/save).", body: { id: "string (optional)", name: "string", assetIds: "string[]" }, returns: "{ok, group}" },
  { server: "bank", method: "POST", path: "/api/related-group/save", summary: "Save or update a related-asset group.", body: { id: "string (optional)", name: "string", assetIds: "string[]" }, returns: "{ok, group}" },
  { server: "bank", method: "POST", path: "/api/related-groups/delete", summary: "Delete a related-asset group (alias of /api/related-group/delete).", body: { id: "string (required)" }, returns: "{ok}" },
  { server: "bank", method: "POST", path: "/api/related-group/delete", summary: "Delete a related-asset group.", body: { id: "string (required)" }, returns: "{ok}" },
  { server: "bank", method: "POST", path: "/api/entity-profile/save", summary: "Save or update an NPC/monster entity profile.", body: { id: "string (optional)", type: "\"npc\" | \"monster\"", gameId: "string (optional)", label: "string (optional)", slots: "Record<slot, {assetId, status}> (optional)" }, returns: "{ok, entity}" },
  { server: "bank", method: "POST", path: "/api/entity-profile/bind", summary: "Bind an asset to an entity profile slot; audio slots with runtimeTargetPath intentionally copy the source over that fixed runtime target.", body: { entityId: "string (required)", slot: "string (required)", assetId: "string (required)" }, returns: "{ok, entity, audioPromotion?}" },
  { server: "bank", method: "POST", path: "/api/entity-profile/unbind", summary: "Unbind an entity profile slot.", body: { entityId: "string (required)", slot: "string (required)" }, returns: "{ok, entity}" },
  { server: "bank", method: "POST", path: "/api/entity-profile/delete", summary: "Delete an entity profile.", body: { id: "string (required)" }, returns: "{ok}" },
  { server: "bank", method: "POST", path: "/api/zone-pack/save", summary: "Save or update a zone pack.", body: { id: "string (optional)", label: "string", mapIds: "string[]", layers: "Record<layer, string[]> (optional)" }, returns: "{ok, zone}" },
  { server: "bank", method: "POST", path: "/api/zone-pack/delete", summary: "Delete a zone pack (e.g. retired zones).", body: { id: "string (required)" }, returns: "{ok, deleted}" },
  { server: "bank", method: "POST", path: "/api/zone-pack/add-asset", summary: "Add an asset to a zone pack layer.", body: { zoneId: "string (required)", layer: "string (required)", assetId: "string (required)" }, returns: "{ok, zone}" },
  { server: "bank", method: "POST", path: "/api/zone-pack/remove-asset", summary: "Remove an asset from a zone pack layer.", body: { zoneId: "string (required)", layer: "string (required)", assetId: "string (required)" }, returns: "{ok, zone}" },
  { server: "bank", method: "POST", path: "/api/collection/save", summary: "Save or update an asset collection.", body: { id: "string (optional)", name: "string", description: "string (optional)", assetIds: "string[] (optional)" }, returns: "{ok, collection}" },
  { server: "bank", method: "POST", path: "/api/collection/add-asset", summary: "Add an asset to a collection.", body: { collectionId: "string (required)", assetId: "string (required)" }, returns: "{ok, collection}" },
  { server: "bank", method: "POST", path: "/api/collection/bind", summary: "Bind a collection to a zone pack or entity for coordinated workflows.", body: { collectionId: "string (required)", targetId: "string (required)", targetType: "\"zone-pack\" | \"entity\" | ... (required)" }, returns: "{ok, collection}" },
];

// Routes handled outside the route Maps (documented, but not verified against a Map).
export const SPECIAL_ROUTES: { server: RouteServer; method: string; path: string; auth: string; summary: string }[] = [
  { server: "devkit", method: "GET", path: "/api/session-token", auth: "same-origin only", summary: "The invisible token for POSTs. DevKit's own pages fetch this; CLI callers read tools/devkit/.session-token instead." },
  { server: "devkit", method: "GET", path: "/runtime-asset/*", auth: "loopback", summary: "Serve a runtime asset file from client/public/assets." },
  { server: "devkit", method: "GET", path: "/capture-file/*", auth: "loopback", summary: "Serve a capture PNG from the capture folders." },
  { server: "devkit", method: "GET", path: "/assets-file/*", auth: "loopback", summary: "Serve a file from the assets root (Z:/Assets)." },
  { server: "devkit", method: "GET", path: "/<page>.html, /tokens.css", auth: "loopback", summary: "Static DevKit pages (index, zone-editor, api-docs) and the shared design tokens." },
  { server: "bank", method: "GET", path: "/api/session-token", auth: "same-origin only", summary: "The invisible token for POSTs. DevKit-spawned bank shares DevKit's token; standalone bank mints its own fallback. Bank pages fetch this; scripts read <metadata-root>/_review/.session-token." },
  { server: "bank", method: "GET", path: "/, /_review/asset-review-server.html, /tokens.css, /assets/fonts/*", auth: "loopback", summary: "The review UI page, shared tokens, and fonts." },
];

/**
 * Fail-closed drift gate: every key in the live route Map must be documented and
 * every doc for those servers must exist in the Map. Call at server startup;
 * throws (server refuses to boot) on any mismatch.
 */
export function verifyRouteDocs(servers: RouteServer[], routeKeys: Iterable<string>): void {
  const docs = API_DOCS.filter((d) => servers.includes(d.server));
  const docKeys = new Set(docs.map((d) => `${d.method} ${d.path}`));
  const liveKeys = new Set(routeKeys);
  const undocumented = [...liveKeys].filter((k) => !docKeys.has(k));
  const stale = [...docKeys].filter((k) => !liveKeys.has(k));
  if (undocumented.length || stale.length) {
    const parts: string[] = [];
    if (undocumented.length) parts.push(`undocumented routes (add to tools/src/api-docs.ts): ${undocumented.join(", ")}`);
    if (stale.length) parts.push(`documented but not registered (remove or fix): ${stale.join(", ")}`);
    throw new Error(`[api-docs] route table and API docs are out of sync — ${parts.join(" | ")}`);
  }
}

/** JSON payload for GET /api/docs (both servers serve the full shared reference). */
export function apiDocsPayload(): Record<string, unknown> {
  return {
    ok: true,
    generatedFrom: "live route tables (tools/src/api-docs.ts, verified at server startup — boot fails on drift)",
    auth: {
      model: "loopback-only servers with invisible-token POST auth",
      rules: [
        "non-loopback Origin -> 403",
        "GET -> loopback, no token",
        "POST with a browser Origin -> requires x-devkit-token header",
        "POST without Origin (local CLI) -> trusted; token files: tools/devkit/.session-token (devkit), <metadata-root>/_review/.session-token (bank; same token when launched by DevKit, standalone fallback otherwise)",
      ],
    },
    servers: SERVER_INFO,
    special: SPECIAL_ROUTES,
    routes: API_DOCS.map((d) => ({ ...d, auth: authFor(d) })),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch] as string);
}

function fieldsHtml(fields: Record<string, string> | undefined, kind: "query" | "body"): string {
  if (!fields || !Object.keys(fields).length) return "";
  const rows = Object.entries(fields)
    .map(([name, desc]) => `<div class="field"><code>${escapeHtml(name)}</code> ${escapeHtml(desc)}</div>`)
    .join("");
  return `<div class="fields"><span class="fields-label">${kind}</span>${rows}</div>`;
}

/** One rendered reference page for hub + bank + devkit routes (dark theme, shared tokens). */
export function renderApiDocsHtml(): string {
  const order: RouteServer[] = ["hub", "devkit", "bank"];
  const methodBadgeClass = (method: string) => method === "POST" ? "lm-badge--warn" : "lm-badge--info";
  const sections = order
    .map((server) => {
      const docs = API_DOCS.filter((d) => d.server === server);
      const rows = docs
        .map(
          (d) => `
<tr id="${escapeHtml(`${d.server}-${d.method}-${d.path.replace(/[^a-z0-9]+/gi, "-")}`)}">
  <td><span class="lm-badge ${methodBadgeClass(d.method)}">${d.method}</span></td>
  <td class="path"><code>${escapeHtml(d.path)}</code></td>
  <td class="auth">${escapeHtml(authFor(d))}</td>
  <td class="detail">${escapeHtml(d.summary)}${fieldsHtml(d.query, "query")}${fieldsHtml(d.body, "body")}${d.returns ? `<div class="returns">returns <code>${escapeHtml(d.returns)}</code></div>` : ""}</td>
</tr>`,
        )
        .join("");
      return `
<section>
<h2>${escapeHtml(SERVER_INFO[server].title)} <span class="base">${escapeHtml(SERVER_INFO[server].base)}</span> <span class="count">${docs.length} routes</span></h2>
<div class="table-wrap lm-scroll"><table class="lm-table"><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description · payload</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
    })
    .join("");

  const special = SPECIAL_ROUTES.map(
    (s) => `<tr><td><span class="lm-badge ${methodBadgeClass(s.method)}">${escapeHtml(s.method)}</span></td><td class="path"><code>${escapeHtml(s.path)}</code></td><td class="auth">${escapeHtml(s.auth)}</td><td class="detail">${escapeHtml(s.summary)} <span class="base">(${escapeHtml(SERVER_INFO[s.server].base)})</span></td></tr>`,
  ).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>GameKit Tool API Reference</title>
<link rel="stylesheet" href="/tokens.css">
<style>
:root{color-scheme:dark}
body{margin:0;background:var(--lm-bg);color:var(--lm-text);font:var(--lm-fw-regular) var(--lm-fs-400)/var(--lm-lh-normal) var(--lm-font-ui);padding:0 0 60px}
header{padding:18px 24px;border-bottom:1px solid var(--lm-border-cool);background:var(--lm-surface-solid);position:sticky;top:0;z-index:var(--lm-z-hud)}
h1{margin:0;font:var(--lm-fw-bold) var(--lm-fs-700)/var(--lm-lh-tight) var(--lm-font-display);color:var(--lm-text-gold)}
.sub{color:var(--lm-text-muted);font-size:var(--lm-fs-200);margin-top:4px}
main{padding:12px 24px;max-width:1200px}
h2{font-size:var(--lm-fs-500);color:var(--lm-accent);margin:28px 0 8px}
.table-wrap{max-width:100%;overflow-x:auto}
.table-wrap .lm-table{min-width:860px;table-layout:fixed}
.table-wrap th:nth-child(1),.table-wrap td:nth-child(1){width:86px}
.table-wrap th:nth-child(2),.table-wrap td:nth-child(2){width:230px}
.table-wrap th:nth-child(3),.table-wrap td:nth-child(3){width:170px}
.base{font-weight:var(--lm-fw-regular);font-size:var(--lm-fs-200);color:var(--lm-text-muted)}
.count{font-weight:var(--lm-fw-regular);font-size:var(--lm-fs-200);color:var(--lm-text-muted);border:1px solid var(--lm-border-cool);border-radius:var(--lm-radius-pill);padding:1px 8px}
.path code{color:var(--lm-text);white-space:normal;overflow-wrap:anywhere}
.auth{font-size:var(--lm-fs-200);color:var(--lm-text-muted);white-space:normal;overflow-wrap:anywhere}
.detail{overflow-wrap:anywhere}
code{background:var(--lm-surface-sunken);border:1px solid var(--lm-border-cool);border-radius:var(--lm-radius-xs);padding:1px 5px;font-size:var(--lm-fs-200)}
.fields{margin-top:6px}
.fields-label{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:var(--lm-tracking-label);color:var(--lm-accent);margin-right:6px}
.field{margin:2px 0 2px 12px;font-size:var(--lm-fs-200);color:var(--lm-text-muted)}
.returns{margin-top:6px;font-size:var(--lm-fs-200);color:var(--lm-text-muted)}
.note{padding:12px 14px;font-size:var(--lm-fs-300);margin:14px 0}
input#flt{width:340px;max-width:90%;margin-top:10px}
</style>
</head>
<body>
<header>
<h1>GameKit Tool API Reference</h1>
<div class="sub">Generated from the live route tables; servers refuse to boot if this page drifts. Machine-readable: <code>GET /api/docs</code> on :8787 and :8765.</div>
<input class="lm-input" id="flt" placeholder="Filter routes... ( / to focus )" autocomplete="off">
</header>
<main>
<div class="lm-card note"><strong>Auth model (invisible token):</strong> both servers bind loopback only and reject non-loopback Origins.
GETs need no token. POSTs from a browser page require the <code>x-devkit-token</code> header — pages fetch it from
<code>GET /api/session-token</code> (same-origin only); CLI/AI callers read the token file
(<code>tools/devkit/.session-token</code> for :8787, <code>&lt;metadata-root&gt;/_review/.session-token</code> for :8765;
same token when the bank is launched by DevKit, standalone fallback otherwise)
and send it, or omit the Origin header entirely (no-Origin local calls are trusted).</div>
${sections}
<section>
<h2>Special / file routes <span class="count">not in the route Maps</span></h2>
<div class="table-wrap lm-scroll"><table class="lm-table"><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead><tbody>${special}</tbody></table></div>
</section>
</main>
<script>
const flt=document.getElementById('flt');
function apply(){const q=flt.value.trim().toLowerCase();document.querySelectorAll('tbody tr').forEach(tr=>{tr.style.display=!q||tr.textContent.toLowerCase().includes(q)?'':'none'})}
flt.addEventListener('input',apply);
document.addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==flt){e.preventDefault();flt.focus()}});
</script>
</body>
</html>`;
}

function toolMapRows(server: RouteServer): string {
  return API_DOCS.filter((doc) => doc.server === server)
    .map((doc) => {
      const href = doc.method === "GET" && !doc.path.includes("{") && !doc.path.includes(":") ? doc.path : "";
      return `<tr><td><span class="lm-badge ${doc.method === "POST" ? "lm-badge--warn" : "lm-badge--info"}">${doc.method}</span></td><td>${href ? `<a href="${escapeHtml(href)}"><code>${escapeHtml(doc.path)}</code></a>` : `<code>${escapeHtml(doc.path)}</code>`}</td><td>${escapeHtml(doc.summary)}</td></tr>`;
    })
    .join("");
}

/** Product-facing one-page tool inventory generated from the same route docs as /api-docs.html. */
export function renderToolMapHtml(): string {
  const servers: RouteServer[] = ["hub", "devkit", "bank"];
  const sections = servers.map((server) => `
<section>
  <h2>${escapeHtml(SERVER_INFO[server].title)} <span class="count">${API_DOCS.filter((doc) => doc.server === server).length} routes</span></h2>
  <div class="table-wrap lm-scroll"><table class="lm-table"><thead><tr><th>Method</th><th>Route</th><th>Use</th></tr></thead><tbody>${toolMapRows(server)}</tbody></table></div>
</section>`).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>GameKit DevKit Tool Map</title>
<link rel="stylesheet" href="/tokens.css">
<style>
:root{color-scheme:dark}
body{margin:0;background:var(--lm-bg);color:var(--lm-text);font:var(--lm-fw-regular) var(--lm-fs-400)/var(--lm-lh-normal) var(--lm-font-ui);padding:0 0 48px}
header{padding:18px 24px;border-bottom:1px solid var(--lm-border-cool);background:var(--lm-surface-solid);position:sticky;top:0;z-index:var(--lm-z-hud)}
h1{margin:0;font:var(--lm-fw-bold) var(--lm-fs-700)/var(--lm-lh-tight) var(--lm-font-display);color:var(--lm-text-gold)}
h2{font-size:var(--lm-fs-500);color:var(--lm-accent);margin:28px 0 8px}
main{padding:12px 24px;max-width:1180px}
.sub,.count{color:var(--lm-text-muted);font-size:var(--lm-fs-200)}
.count{border:1px solid var(--lm-border-cool);border-radius:var(--lm-radius-pill);padding:1px 8px}
.table-wrap{max-width:100%;overflow-x:auto}
.lm-table{min-width:820px;table-layout:fixed}
th:nth-child(1),td:nth-child(1){width:86px}
th:nth-child(2),td:nth-child(2){width:260px}
td{vertical-align:top}
code{background:var(--lm-surface-sunken);border:1px solid var(--lm-border-cool);border-radius:var(--lm-radius-xs);padding:1px 5px;font-size:var(--lm-fs-200)}
a{color:var(--lm-text-gold);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1>GameKit DevKit Tool Map</h1>
  <div class="sub">Generated from <code>tools/src/api-docs.ts</code>; server startup verifies this route data against live route maps.</div>
</header>
<main>${sections}</main>
</body>
</html>`;
}
