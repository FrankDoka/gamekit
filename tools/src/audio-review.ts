import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetsRoot } from "./toolkit-config.js";

const DEFAULT_ROOT = path.join(assetsRoot(), "audio", "generated");
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".webm", ".m4a", ".flac"]);

interface CliOptions {
  root: string;
  output: string;
}

interface AudioItem {
  fileName: string;
  relativePath: string;
  url: string;
  sizeBytes: number;
  category: string;
  family: string;
  type: string;
  relatedGroup: string;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm audio:review -- --root Z:/Assets/audio/generated",
      "",
      "Options:",
      "  --root <path>      Folder to scan. Default: Z:/Assets/audio/generated",
      "  --output <name>    HTML filename. Default: audio-review.html",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }

  let root = DEFAULT_ROOT;
  let output = "audio-review.html";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--root") {
      if (!next) {
        throw new Error("--root requires a path.");
      }
      root = next;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      if (!next || next.includes("/") || next.includes("\\")) {
        throw new Error("--output requires a filename only.");
      }
      output = next;
      i += 1;
      continue;
    }

    usage();
  }

  return { root: path.resolve(root), output };
}

async function walkAudioFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkAudioFiles(root, fullPath)));
      continue;
    }

    if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function classify(relativePath: string): Pick<AudioItem, "category" | "family" | "type"> {
  const parts = relativePath.split(/[\\/]/);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const fileStem = path.basename(relativePath, path.extname(relativePath));

  if (lowerParts[0] === "bgm" || lowerParts[0] === "music") {
    return {
      category: "BGM",
      family: titleCase(parts[1] ?? "General"),
      type: titleCase(parts.slice(2, -1).join(" ") || fileStem),
    };
  }

  if (lowerParts[0] === "stingers" || lowerParts[0] === "sting") {
    return {
      category: "Stingers",
      family: titleCase(parts[1] ?? "General"),
      type: titleCase(parts.slice(2, -1).join(" ") || fileStem),
    };
  }

  if (lowerParts[0] === "sfx") {
    if (lowerParts[1] === "player") {
      return {
        category: "Player SFX",
        family: "Player",
        type: titleCase(parts.slice(2, -1).join(" ") || fileStem.replace(/^player[-_]?/i, "")),
      };
    }

    if (lowerParts[1] === "monster") {
      return {
        category: "Monster SFX",
        family: titleCase(parts[2] ?? "Monster"),
        type: titleCase(parts.slice(3, -1).join(" ") || fileStem),
      };
    }

    const target = lowerParts[1] ?? "";
    if (target.startsWith("crystal_bloop")) {
      return {
        category: "Monster SFX",
        family: "Crystal Bloop",
        type: titleCase(target.replace(/^crystal_bloop_?/, "") || fileStem),
      };
    }

    if (target.startsWith("player")) {
      return {
        category: "Player SFX",
        family: "Player",
        type: titleCase(target.replace(/^player_?/, "") || fileStem),
      };
    }

    return {
      category: "Other SFX",
      family: titleCase(parts[1] ?? "General"),
      type: titleCase(parts.slice(2, -1).join(" ") || fileStem),
    };
  }

  return {
    category: "Other",
    family: titleCase(parts[0] ?? "General"),
    type: titleCase(parts.slice(1, -1).join(" ") || fileStem),
  };
}

function relatedGroupFor(item: Pick<AudioItem, "category" | "family" | "relativePath">): string {
  if (item.category !== "Monster SFX" && item.category !== "Other SFX") {
    return "";
  }
  const text = `${item.family} ${item.relativePath}`.toLowerCase().replace(/\\/g, "/");
  if (text.includes("crystal_bloop") || text.includes("crystal bloop")) return "crystal_bloop";
  if (text.includes("mossling")) return "mossling";
  if (text.includes("brambleling")) return "thorn_brambleling";
  if (text.includes("crystal_mite") || text.includes("crystal mite")) return "crystal_mite";
  if (text.includes("forest_wisp") || text.includes("forest wisp")) return "forest_wisp";
  if (text.includes("glow_bug") || text.includes("glow bug")) return "glow_bug";
  if (text.includes("gloombat")) return "gloombat";
  return "";
}

function toFileUrl(relativePath: string): string {
  return relativePath
    .split(/[\\/]/)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function buildIndex(root: string): Promise<AudioItem[]> {
  const files = await walkAudioFiles(root);
  const items: AudioItem[] = [];

  for (const filePath of files) {
    const relativePath = path.relative(root, filePath);
    const fileStat = await stat(filePath);
    const classified = classify(relativePath);
    items.push({
      fileName: path.basename(filePath),
      relativePath,
      url: toFileUrl(relativePath),
      sizeBytes: fileStat.size,
      ...classified,
      relatedGroup: relatedGroupFor({ ...classified, relativePath }),
    });
  }

  return items.sort((a, b) =>
    [a.category, a.family, a.type, a.fileName].join("|").localeCompare([b.category, b.family, b.type, b.fileName].join("|")),
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderHtml(root: string, items: AudioItem[]): string {
  const generatedAt = new Date().toISOString();
  const categories = Array.from(new Set(items.map((item) => item.category)));
  const categoryCounts = new Map<string, number>();
  const typeCountsByCategory = new Map<string, Map<string, number>>();
  for (const item of items) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
    const typeCounts = typeCountsByCategory.get(item.category) ?? new Map<string, number>();
    typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
    typeCountsByCategory.set(item.category, typeCounts);
  }
  const rows = items
    .map(
      (item) => `
        <article class="card" data-path="${escapeHtml(item.relativePath)}" data-category="${escapeHtml(item.category)}" data-family="${escapeHtml(item.family)}" data-type="${escapeHtml(item.type)}" data-related-group="${escapeHtml(item.relatedGroup)}">
          <div class="meta">
            <span class="pill">${escapeHtml(item.category)}</span>
            <span class="pill muted">${escapeHtml(item.family)}</span>
            <span class="pill muted">${escapeHtml(item.type)}</span>
            ${item.relatedGroup ? `<span class="pill related">Group: ${escapeHtml(item.relatedGroup)}</span>` : ""}
          </div>
          <h3>${escapeHtml(item.fileName)}</h3>
          <p>${escapeHtml(item.relativePath)} · ${formatBytes(item.sizeBytes)} · <span class="duration">duration loading</span></p>
          <audio preload="metadata" controls src="${item.url}"></audio>
          <div class="review-row">
            <label>Status
              <select class="status">
                <option value="">Unreviewed</option>
                <option value="shortlist">Shortlist</option>
                <option value="maybe">Maybe</option>
                <option value="reject">Reject</option>
              </select>
            </label>
            <div class="button-pair">
              <a class="open-link" href="${item.url}" target="_blank" rel="noreferrer">Open</a>
              ${item.relatedGroup ? `<a class="open-link" href="http://127.0.0.1:8765/_review/asset-review-server.html?group=${encodeURIComponent(item.relatedGroup)}" target="_blank" rel="noreferrer">Related</a>` : ""}
              <button class="copy-path" type="button">Copy Path</button>
            </div>
          </div>
          <details class="move-box">
            <summary>Move / Reclassify</summary>
            <div class="move-grid">
              <label>Category
                <select class="move-category">
                  <option value="sfx/player">Player SFX</option>
                  <option value="sfx/monster">Monster SFX</option>
                  <option value="sfx/skill">Skill SFX</option>
                  <option value="sfx/ui">UI SFX</option>
                  <option value="sfx/stinger">Stingers</option>
                  <option value="bgm">BGM</option>
                  <option value="unassigned">Unassigned Pool</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>Family
                <input class="move-family" type="text" placeholder="crystal_bloop, player, spark_shot">
              </label>
              <label>Type
                <input class="move-type" type="text" placeholder="attack, damage, move">
              </label>
            </div>
            <label class="move-label">Move to folder
              <input class="move-destination" type="text" placeholder="sfx/monster/crystal_bloop/move">
            </label>
          </details>
          <textarea class="notes" rows="2" placeholder="Notes: too harsh, good tail, best so far..."></textarea>
        </article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GameKit Audio Review</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, system-ui, sans-serif; background: #111317; color: #eceff4; --panel: #181d26; --panel-2: #151a22; --line: #2f3745; --text-dim: #aeb6c2; --accent: #6aa4ff; }
    body { margin: 0; }
    header { position: sticky; top: 0; z-index: 2; padding: 18px 24px; background: rgba(17, 19, 23, 0.95); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); }
    h1 { margin: 0 0 8px; font-size: 24px; font-weight: 700; }
    header p { margin: 0; color: var(--text-dim); font-size: 13px; overflow-wrap: anywhere; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .stat { border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; background: #171c25; font-size: 12px; color: #d9e1ec; }
    .stat strong { display: inline-block; margin-left: 5px; color: #fff; }
    main { display: grid; grid-template-columns: 230px 1fr; min-height: calc(100vh - 80px); }
    nav { padding: 18px; border-right: 1px solid var(--line); background: var(--panel-2); }
    button, .open-link { border: 1px solid #343b48; border-radius: 6px; padding: 10px 12px; background: #202632; color: #f3f6fb; cursor: pointer; text-decoration: none; font: inherit; }
    nav button { width: 100%; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; text-align: left; }
    button.active, button:hover, .open-link:hover { border-color: var(--accent); background: #25314a; }
    .count { color: var(--text-dim); font-size: 12px; }
    details.type-group { margin: 10px 0 12px; border: 1px solid #28313f; border-radius: 6px; background: #111720; }
    details.type-group summary { cursor: pointer; padding: 10px 12px; color: #dce8ff; font-size: 13px; }
    .type-group button { margin: 0; border: 0; border-top: 1px solid #28313f; border-radius: 0; background: transparent; font-size: 12px; }
    .type-group button.active { background: #25314a; }
    .content { padding: 18px 24px 40px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
    .toolbar input { flex: 1; min-width: 210px; border: 1px solid #343b48; border-radius: 6px; padding: 10px 12px; background: #171b23; color: #f3f6fb; }
    .toolbar select { min-width: 150px; }
    .toolbar button { width: auto; min-width: 120px; text-align: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
    .card { border: 1px solid #2e3542; border-radius: 8px; padding: 14px; background: var(--panel); box-shadow: 0 10px 24px rgba(0,0,0,0.16); }
    .card h3 { margin: 10px 0 6px; font-size: 15px; overflow-wrap: anywhere; }
    .card p { margin: 0 0 12px; color: var(--text-dim); font-size: 12px; overflow-wrap: anywhere; }
    audio { width: 100%; height: 36px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { display: inline-flex; border: 1px solid #496086; border-radius: 999px; padding: 3px 8px; font-size: 11px; color: #dce8ff; background: #22304a; }
    .pill.muted { border-color: #3a414e; color: #b8c0cc; background: #202633; }
    .pill.related { border-color: #8b7040; color: #ffe2a0; background: #2c2415; }
    .review-row { display: grid; grid-template-columns: minmax(150px, 1fr) auto; gap: 10px; align-items: end; margin-top: 10px; }
    .button-pair { display: flex; gap: 8px; align-items: end; }
    .button-pair button, .button-pair .open-link { min-height: 34px; padding: 7px 10px; font-size: 12px; }
    label { display: grid; gap: 5px; color: var(--text-dim); font-size: 12px; }
    select, textarea, .move-destination, .move-family, .move-type { border: 1px solid #343b48; border-radius: 6px; background: #121720; color: #f3f6fb; }
    select { min-height: 34px; padding: 6px 8px; }
    .move-box { margin-top: 10px; border: 1px solid #29313e; border-radius: 6px; padding: 8px 10px; background: #151b25; }
    .move-box summary { cursor: pointer; color: #dce8ff; font-size: 12px; }
    .move-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
    .move-label { margin-top: 8px; }
    .move-destination, .move-family, .move-type { min-height: 34px; padding: 6px 8px; font: inherit; font-size: 12px; box-sizing: border-box; width: 100%; }
    textarea { box-sizing: border-box; width: 100%; margin-top: 10px; padding: 8px 10px; resize: vertical; font: inherit; font-size: 12px; }
    .card[data-status="shortlist"] { border-color: #77d990; background: #17241f; }
    .card[data-status="maybe"] { border-color: #d7c46c; background: #242214; }
    .card[data-move-category="unassigned"] { border-color: #8aa0bd; }
    .card[data-status="reject"] { opacity: 0.55; }
    .export-panel { margin-top: 18px; border: 1px solid var(--line); border-radius: 8px; background: #141923; padding: 14px; }
    .export-panel h2 { margin: 0 0 8px; font-size: 16px; }
    .export-panel p { color: var(--text-dim); font-size: 12px; margin: 0 0 10px; }
    .export-panel textarea { min-height: 170px; margin-top: 8px; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; } nav { position: sticky; top: 79px; z-index: 1; border-right: 0; border-bottom: 1px solid #2c313a; } .move-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>GameKit Audio Review</h1>
    <p>Root: ${escapeHtml(root)} · ${items.length} audio files · generated ${generatedAt}</p>
    <div class="stats">
      <span class="stat">Visible<strong id="visibleCount">${items.length}</strong></span>
      <span class="stat">Shortlist<strong id="shortlistCount">0</strong></span>
      <span class="stat">Maybe<strong id="maybeCount">0</strong></span>
      <span class="stat">Unassigned Pool<strong id="unassignedCount">0</strong></span>
      <span class="stat">Reject<strong id="rejectCount">0</strong></span>
      <span class="stat">Unreviewed<strong id="unreviewedCount">${items.length}</strong></span>
    </div>
  </header>
  <main>
    <nav>
      <button class="category-filter active" data-filter="all"><span>All</span><span class="count">${items.length}</span></button>
      ${categories
        .map((category) => `<button class="category-filter" data-filter="${escapeHtml(category)}"><span>${escapeHtml(category)}</span><span class="count">${categoryCounts.get(category) ?? 0}</span></button>`)
        .join("\n")}
      ${categories
        .map((category) => {
          if (category !== "Monster SFX" && category !== "Player SFX") return "";
          const typeCounts = Array.from(typeCountsByCategory.get(category)?.entries() ?? []).sort((a, b) => a[0].localeCompare(b[0]));
          if (typeCounts.length === 0) return "";
          return `<details class="type-group" open>
            <summary>${escapeHtml(category)} Types</summary>
            ${typeCounts
              .map(
                ([type, count]) =>
                  `<button class="type-filter" data-filter-category="${escapeHtml(category)}" data-filter-type="${escapeHtml(type)}"><span>${escapeHtml(type)}</span><span class="count">${count}</span></button>`,
              )
              .join("\n")}
          </details>`;
        })
        .join("\n")}
    </nav>
    <section class="content">
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search filename, family, type...">
        <select id="familyFilter">
          <option value="all">All families</option>
        </select>
        <select id="statusFilter">
          <option value="all">All statuses</option>
          <option value="">Unreviewed</option>
          <option value="shortlist">Shortlist</option>
          <option value="maybe">Maybe</option>
          <option value="reject">Reject</option>
        </select>
        <button id="shortlist">Shortlist Only</button>
        <button id="copyShortlist">Copy Shortlist</button>
        <button id="exportMarkdown">Output MD</button>
        <button id="exportMovePlan">Output Move Plan</button>
        <button id="clearFilter">Clear Filters</button>
        <button id="stop">Stop Audio</button>
      </div>
      <div class="grid" id="grid">${rows}</div>
      <div class="export-panel">
        <h2>Review Output</h2>
        <p>Use Output MD for handoff back to Codex. Use Output Move Plan, save it as <code>audio-move-plan.json</code> in the root, then run <code>pnpm audio:move -- --root ...</code>.</p>
        <textarea id="exportOutput" spellcheck="false" placeholder="Generated review output appears here."></textarea>
      </div>
    </section>
  </main>
  <script>
    const categoryButtons = Array.from(document.querySelectorAll(".category-filter"));
    const cards = Array.from(document.querySelectorAll(".card"));
    const search = document.getElementById("search");
    const stop = document.getElementById("stop");
    const shortlist = document.getElementById("shortlist");
    const copyShortlist = document.getElementById("copyShortlist");
    const exportMarkdown = document.getElementById("exportMarkdown");
    const exportMovePlan = document.getElementById("exportMovePlan");
    const exportOutput = document.getElementById("exportOutput");
    const clearFilter = document.getElementById("clearFilter");
    const statusFilter = document.getElementById("statusFilter");
    const familyFilter = document.getElementById("familyFilter");
    const visibleCount = document.getElementById("visibleCount");
    const shortlistCount = document.getElementById("shortlistCount");
    const maybeCount = document.getElementById("maybeCount");
    const unassignedCount = document.getElementById("unassignedCount");
    const rejectCount = document.getElementById("rejectCount");
    const unreviewedCount = document.getElementById("unreviewedCount");
    let activeFilter = "all";
    let activeTypeFilter = "";
    let shortlistOnly = false;

    function storageKey(card, suffix) {
      return "gamekit-audio-review:" + card.dataset.path + ":" + suffix;
    }

    function hydrateReviewState() {
      for (const card of cards) {
        const status = localStorage.getItem(storageKey(card, "status")) || "";
        const notes = localStorage.getItem(storageKey(card, "notes")) || "";
        const statusInput = card.querySelector(".status");
        const notesInput = card.querySelector(".notes");
        const moveInput = card.querySelector(".move-destination");
        const categoryInput = card.querySelector(".move-category");
        const familyInput = card.querySelector(".move-family");
        const typeInput = card.querySelector(".move-type");
        const moveTo = localStorage.getItem(storageKey(card, "moveTo")) || defaultMoveDestination(card);
        const moveParts = parseMoveDestination(moveTo, card);
        statusInput.value = status;
        notesInput.value = notes;
        moveInput.value = moveTo;
        categoryInput.value = moveParts.category;
        familyInput.value = moveParts.family;
        typeInput.value = moveParts.type;
        card.dataset.status = status;
        card.dataset.moveCategory = moveParts.category;

        statusInput.addEventListener("change", () => {
          card.dataset.status = statusInput.value;
          localStorage.setItem(storageKey(card, "status"), statusInput.value);
          applyFilters();
        });

        notesInput.addEventListener("input", () => {
          localStorage.setItem(storageKey(card, "notes"), notesInput.value);
        });

        moveInput.addEventListener("input", () => {
          localStorage.setItem(storageKey(card, "moveTo"), moveInput.value);
          const parsed = parseMoveDestination(moveInput.value, card);
          categoryInput.value = parsed.category;
          familyInput.value = parsed.family;
          typeInput.value = parsed.type;
          card.dataset.moveCategory = parsed.category;
          applyFilters();
        });

        for (const input of [categoryInput, familyInput, typeInput]) {
          input.addEventListener("input", () => {
            const next = buildMoveDestination(categoryInput.value, familyInput.value, typeInput.value);
            moveInput.value = next;
            localStorage.setItem(storageKey(card, "moveTo"), next);
            card.dataset.moveCategory = categoryInput.value;
            applyFilters();
          });
          input.addEventListener("change", () => {
            const next = buildMoveDestination(categoryInput.value, familyInput.value, typeInput.value);
            moveInput.value = next;
            localStorage.setItem(storageKey(card, "moveTo"), next);
            card.dataset.moveCategory = categoryInput.value;
            applyFilters();
          });
        }

        card.querySelector(".copy-path").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(card.dataset.path);
          } catch {
            window.prompt("Copy path", card.dataset.path);
          }
        });
      }
    }

    function populateFamilyFilter() {
      const families = Array.from(new Set(cards.map((card) => card.dataset.family))).sort((a, b) => a.localeCompare(b));
      for (const family of families) {
        const option = document.createElement("option");
        option.value = family;
        option.textContent = family;
        familyFilter.appendChild(option);
      }
    }

    function defaultMoveDestination(card) {
      const source = card.dataset.path.split(/[\\\\/]/);
      source.pop();
      return source.join("/");
    }

    function slugifyPart(value) {
      return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }

    function buildMoveDestination(category, family, type) {
      if (category === "unassigned") {
        return "unassigned";
      }
      const cleanCategory = category === "custom" ? "" : category;
      const parts = [cleanCategory, slugifyPart(family), slugifyPart(type)].filter(Boolean);
      return parts.join("/");
    }

    function parseMoveDestination(value, card) {
      const parts = value.replace(/\\\\/g, "/").split("/").filter(Boolean);
      if (parts[0] === "sfx" && parts[1] === "player") {
        return { category: "sfx/player", family: parts[2] || "player", type: parts[3] || card.dataset.type.toLowerCase().replace(/\\s+/g, "_") };
      }
      if (parts[0] === "sfx" && parts[1] === "monster") {
        return { category: "sfx/monster", family: parts[2] || card.dataset.family.toLowerCase().replace(/\\s+/g, "_"), type: parts[3] || card.dataset.type.toLowerCase().replace(/\\s+/g, "_") };
      }
      if (parts[0] === "sfx" && parts[1] === "skill") {
        return { category: "sfx/skill", family: parts[2] || "skill", type: parts[3] || "cast" };
      }
      if (parts[0] === "sfx" && parts[1] === "ui") {
        return { category: "sfx/ui", family: parts[2] || "ui", type: parts[3] || "confirm" };
      }
      if (parts[0] === "sfx" && parts[1] === "stinger") {
        return { category: "sfx/stinger", family: parts[2] || "general", type: parts[3] || "sting" };
      }
      if (parts[0] === "bgm") {
        return { category: "bgm", family: parts[1] || "general", type: parts[2] || "loop" };
      }
      if (parts[0] === "unassigned") {
        return { category: "unassigned", family: parts[1] || "", type: parts[2] || "" };
      }
      return { category: "custom", family: parts.at(-2) || "", type: parts.at(-1) || "" };
    }

    function updateStats() {
      let visible = 0;
      let shortlists = 0;
      let maybes = 0;
      let unassignedPool = 0;
      let rejects = 0;
      let unreviewed = 0;

      for (const card of cards) {
        if (card.style.display !== "none") visible += 1;
        if (card.dataset.moveCategory === "unassigned") unassignedPool += 1;
        if (card.dataset.status === "shortlist") shortlists += 1;
        else if (card.dataset.status === "maybe") maybes += 1;
        else if (card.dataset.status === "reject") rejects += 1;
        else unreviewed += 1;
      }

      visibleCount.textContent = String(visible);
      shortlistCount.textContent = String(shortlists);
      maybeCount.textContent = String(maybes);
      unassignedCount.textContent = String(unassignedPool);
      rejectCount.textContent = String(rejects);
      unreviewedCount.textContent = String(unreviewed);
    }

    function applyFilters() {
      const needle = search.value.trim().toLowerCase();
      for (const card of cards) {
        const matchesCategory = activeFilter === "all" || card.dataset.category === activeFilter;
        const matchesType = !activeTypeFilter || card.dataset.type === activeTypeFilter;
        const matchesShortlist = !shortlistOnly || card.dataset.status === "shortlist";
        const matchesStatus = statusFilter.value === "all" || card.dataset.status === statusFilter.value;
        const matchesFamily = familyFilter.value === "all" || card.dataset.family === familyFilter.value;
        const text = card.innerText.toLowerCase();
        card.style.display = matchesCategory && matchesType && matchesShortlist && matchesStatus && matchesFamily && text.includes(needle) ? "" : "none";
      }
      updateStats();
    }

    for (const button of categoryButtons) {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter;
        activeTypeFilter = "";
        for (const item of categoryButtons) item.classList.toggle("active", item === button);
        for (const item of document.querySelectorAll(".type-filter")) item.classList.remove("active");
        applyFilters();
      });
    }

    for (const button of document.querySelectorAll(".type-filter")) {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filterCategory;
        activeTypeFilter = button.dataset.filterType;
        for (const item of categoryButtons) item.classList.toggle("active", item.dataset.filter === activeFilter);
        for (const item of document.querySelectorAll(".type-filter")) item.classList.toggle("active", item === button);
        applyFilters();
      });
    }

    search.addEventListener("input", applyFilters);
    statusFilter.addEventListener("change", applyFilters);
    familyFilter.addEventListener("change", applyFilters);
    shortlist.addEventListener("click", () => {
      shortlistOnly = !shortlistOnly;
      shortlist.classList.toggle("active", shortlistOnly);
      applyFilters();
    });
    copyShortlist.addEventListener("click", async () => {
      const selected = cards.filter((card) => card.dataset.status === "shortlist");
      const lines = selected.map((card) => {
        const notes = card.querySelector(".notes").value.trim();
        return notes ? card.dataset.path + " | " + notes : card.dataset.path;
      });
      const text = lines.join("\\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        window.prompt("Copy shortlist", text);
      }
    });
    exportMarkdown.addEventListener("click", async () => {
      const lines = [
        "# GameKit Audio Review Output",
        "",
        "- Root: ${escapeHtml(root).replace(/`/g, "\\`")}",
        "- Exported: " + new Date().toISOString(),
        "",
        "## Reviewed Files",
        "",
      ];

      for (const card of cards) {
        const status = card.dataset.status || "unreviewed";
        const notes = card.querySelector(".notes").value.trim();
        const moveTo = card.querySelector(".move-destination").value.trim();
        if (status === "unreviewed" && !notes && moveTo === defaultMoveDestination(card)) continue;
        lines.push("- " + card.dataset.path);
        lines.push("  - Status: " + status);
        lines.push("  - Category: " + card.dataset.category);
        lines.push("  - Family: " + card.dataset.family);
        lines.push("  - Type: " + card.dataset.type);
        lines.push("  - Move to: " + moveTo);
        if (notes) lines.push("  - Notes: " + notes.replace(/\\n/g, " "));
        lines.push("");
      }

      exportOutput.value = lines.join("\\n");
      await copyText(exportOutput.value, "Copy markdown output");
    });
    exportMovePlan.addEventListener("click", async () => {
      const moves = [];
      for (const card of cards) {
        const moveTo = card.querySelector(".move-destination").value.trim().replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
        const originalDir = defaultMoveDestination(card);
        if (!moveTo || moveTo === originalDir) continue;
        const fileName = card.dataset.path.split(/[\\\\/]/).pop();
        moves.push({ source: card.dataset.path, destination: moveTo + "/" + fileName });
      }
      const payload = JSON.stringify({ moves }, null, 2);
      exportOutput.value = payload;
      await copyText(payload, "Copy move plan JSON");
    });
    clearFilter.addEventListener("click", () => {
      activeFilter = "all";
      activeTypeFilter = "";
      shortlistOnly = false;
      search.value = "";
      statusFilter.value = "all";
      familyFilter.value = "all";
      for (const item of categoryButtons) item.classList.toggle("active", item.dataset.filter === "all");
      for (const item of document.querySelectorAll(".type-filter")) item.classList.remove("active");
      shortlist.classList.remove("active");
      applyFilters();
    });
    stop.addEventListener("click", () => {
      for (const audio of document.querySelectorAll("audio")) {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    for (const audio of document.querySelectorAll("audio")) {
      audio.addEventListener("loadedmetadata", () => {
        const duration = audio.closest(".card").querySelector(".duration");
        duration.textContent = Number.isFinite(audio.duration) ? audio.duration.toFixed(2) + "s" : "duration unknown";
      });
      audio.addEventListener("play", () => {
        for (const other of document.querySelectorAll("audio")) {
          if (other !== audio) other.pause();
        }
      });
    }

    async function copyText(text, promptLabel) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        window.prompt(promptLabel, text);
      }
    }

    populateFamilyFilter();
    hydrateReviewState();
    applyFilters();
  </script>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const items = await buildIndex(options.root);
  const outputPath = path.join(options.root, options.output);
  await writeFile(outputPath, renderHtml(options.root, items), "utf8");
  console.log(`Indexed ${items.length} audio file(s).`);
  console.log(`Review page: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
