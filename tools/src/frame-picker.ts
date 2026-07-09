import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const imageContentTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

type CandidateSnapshot = {
  candidateDir: string;
  sourceFrameDir: "frames/raw";
  frameCount: number;
  frames: string[];
  candidateRun: unknown | null;
  selection: unknown | null;
};

type SelectionPayload = {
  startIndex: number | null;
  endIndex: number | null;
  targetFrameCount: number;
  selectedFrameIndices: number[];
  selectedFrameNames: string[];
  selectionMode: string;
  loop: boolean;
  notes?: string;
};

type LoadCandidatePayload = {
  candidateDir?: string;
};

type ImportFramesPayload = {
  sourceDir?: string;
  targetName?: string;
};

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const initialCandidateArg = argValue("--candidate");
const port = Number(argValue("--port") ?? "5217");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "frame-picker");
const importRoot = path.resolve(argValue("--import-root") ?? "tmp/frame-picker/imports");
let candidateDir = path.resolve(initialCandidateArg ?? "tmp/frame-picker/empty-candidate");

function rawFrameDir(): string {
  return path.join(candidateDir, "frames", "raw");
}

function isImageName(name: string): boolean {
  return imageContentTypes.has(path.extname(name).toLowerCase());
}

function sanitizeName(value: string): string {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "frame-import";
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isSelectionPayload(value: unknown): value is SelectionPayload {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<SelectionPayload>;
  return (
    (typeof maybe.startIndex === "number" || maybe.startIndex === null) &&
    (typeof maybe.endIndex === "number" || maybe.endIndex === null) &&
    typeof maybe.targetFrameCount === "number" &&
    Array.isArray(maybe.selectedFrameIndices) &&
    maybe.selectedFrameIndices.every((index) => Number.isInteger(index) && index >= 0) &&
    Array.isArray(maybe.selectedFrameNames) &&
    maybe.selectedFrameNames.every((name) => typeof name === "string") &&
    typeof maybe.selectionMode === "string" &&
    typeof maybe.loop === "boolean"
  );
}

function isLoadCandidatePayload(value: unknown): value is LoadCandidatePayload {
  return !!value && typeof value === "object" && typeof (value as LoadCandidatePayload).candidateDir === "string";
}

function isImportFramesPayload(value: unknown): value is ImportFramesPayload {
  return !!value && typeof value === "object" && typeof (value as ImportFramesPayload).sourceDir === "string";
}

async function listImageFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter(isImageName).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function listRawFrames(): Promise<string[]> {
  return listImageFiles(rawFrameDir());
}

async function loadJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function candidateSnapshot(): Promise<CandidateSnapshot> {
  const frames = await listRawFrames();
  const candidateRun = await loadJsonIfExists(path.join(candidateDir, "candidate-run.json"));
  const selection = await loadJsonIfExists(path.join(candidateDir, "frame-selection.json"));
  return {
    candidateDir,
    sourceFrameDir: "frames/raw",
    frameCount: frames.length,
    frames,
    candidateRun,
    selection,
  };
}

async function assertCandidateFolder(nextCandidateDir: string): Promise<string> {
  const resolved = path.resolve(nextCandidateDir);
  const nextRawFrameDir = path.join(resolved, "frames", "raw");
  const info = await stat(nextRawFrameDir);
  if (!info.isDirectory()) {
    throw new Error(`Candidate folder must contain frames/raw: ${nextRawFrameDir}`);
  }
  const frames = await listImageFiles(nextRawFrameDir);
  if (frames.length === 0) {
    throw new Error(`No PNG, JPG, or WebP frames found in: ${nextRawFrameDir}`);
  }
  return resolved;
}

async function switchCandidate(nextCandidateDir: string): Promise<CandidateSnapshot> {
  candidateDir = await assertCandidateFolder(nextCandidateDir);
  return candidateSnapshot();
}

async function handleApiCandidate(response: ServerResponse): Promise<void> {
  try {
    sendJson(response, 200, await candidateSnapshot());
  } catch (error) {
    sendJson(response, 404, {
      error: error instanceof Error ? error.message : String(error),
      candidateDir,
      sourceFrameDir: "frames/raw",
      frameCount: 0,
      frames: [],
      candidateRun: null,
      selection: null,
    });
  }
}


let browseInFlight: Promise<string | null> | null = null;

async function browseForFolder(): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("Folder browsing is only wired for Windows in this local tool");
  }
  // Reuse the pending dialog if Browse is clicked again — stacked dialogs from a
  // background process are unfindable.
  if (browseInFlight) return browseInFlight;

  // The dialog is spawned from a background node process, so without an owner it
  // opens BEHIND the browser with no focus and looks like the button did nothing.
  // A topmost invisible owner form forces it to the foreground.
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a frame folder'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
`;
  browseInFlight = execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: false },
  )
    .then(({ stdout }) => {
      const selected = stdout.trim();
      return selected.length > 0 ? selected : null;
    })
    .finally(() => {
      browseInFlight = null;
    });
  return browseInFlight;
}

async function handleBrowseFolder(response: ServerResponse): Promise<void> {
  const selectedPath = await browseForFolder();
  sendJson(response, 200, { canceled: selectedPath === null, path: selectedPath });
}
async function handleLoadCandidate(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  if (!isLoadCandidatePayload(payload) || !payload.candidateDir) {
    sendJson(response, 400, { error: "Provide a candidate folder path" });
    return;
  }
  sendJson(response, 200, await switchCandidate(payload.candidateDir));
}

async function handleImportFrames(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  if (!isImportFramesPayload(payload) || !payload.sourceDir) {
    sendJson(response, 400, { error: "Provide a source image folder path" });
    return;
  }

  const sourceDir = path.resolve(payload.sourceDir);
  const sourceInfo = await stat(sourceDir);
  if (!sourceInfo.isDirectory()) {
    sendJson(response, 400, { error: "Source path is not a folder", sourceDir });
    return;
  }
  const sourceFrames = await listImageFiles(sourceDir);
  if (sourceFrames.length === 0) {
    sendJson(response, 400, { error: "No PNG, JPG, or WebP images found", sourceDir });
    return;
  }

  const slug = sanitizeName(payload.targetName || path.basename(sourceDir));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z");
  const importedCandidateDir = path.join(importRoot, `${slug}-${stamp}`);
  const importedRawDir = path.join(importedCandidateDir, "frames", "raw");
  await mkdir(importedRawDir, { recursive: true });

  const digits = Math.max(4, String(sourceFrames.length).length);
  const importedFrameNames: string[] = [];
  for (const [index, frame] of sourceFrames.entries()) {
    const ext = path.extname(frame).toLowerCase();
    const outputName = `frame-${String(index + 1).padStart(digits, "0")}${ext}`;
    await copyFile(path.join(sourceDir, frame), path.join(importedRawDir, outputName));
    importedFrameNames.push(outputName);
  }

  await writeFile(
    path.join(importedCandidateDir, "candidate-run.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source: "frame-picker-import",
        sourceDir,
        importedAt: new Date().toISOString(),
        frameCount: importedFrameNames.length,
        frames: importedFrameNames,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  candidateDir = importedCandidateDir;
  sendJson(response, 200, await candidateSnapshot());
}

async function handleSaveSelection(response: ServerResponse, request: IncomingMessage): Promise<void> {
  const payload = await readRequestJson(request);
  if (!isSelectionPayload(payload)) {
    sendJson(response, 400, { error: "Invalid frame selection payload" });
    return;
  }

  const frames = await listRawFrames();
  const outOfRange = payload.selectedFrameIndices.filter((index) => index >= frames.length);
  if (outOfRange.length > 0) {
    sendJson(response, 400, { error: "Selected frame index out of range", outOfRange });
    return;
  }

  const document = {
    schemaVersion: 1,
    sourceFrameDir: "frames/raw",
    savedAt: new Date().toISOString(),
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    targetFrameCount: payload.targetFrameCount,
    selectedFrameIndices: payload.selectedFrameIndices,
    selectedFrameNames: payload.selectedFrameNames,
    selectionMode: payload.selectionMode,
    loop: payload.loop,
    notes: payload.notes ?? "",
  };
  const outputPath = path.join(candidateDir, "frame-selection.json");
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  sendJson(response, 200, { saved: true, path: outputPath, selection: document });
}

async function serveStatic(response: ServerResponse, urlPath: string): Promise<void> {
  const requested = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const resolved = path.resolve(appDir, requested);
  if (!resolved.startsWith(appDir)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  const file = await readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  response.end(file);
}

async function serveFrame(response: ServerResponse, frameName: string): Promise<void> {
  const frames = await listRawFrames();
  if (!frames.includes(frameName)) {
    sendText(response, 404, "Frame not found");
    return;
  }
  const filePath = path.join(rawFrameDir(), frameName);
  const info = await stat(filePath);
  if (!info.isFile()) {
    sendText(response, 404, "Frame not found");
    return;
  }
  const contentType = imageContentTypes.get(path.extname(frameName).toLowerCase()) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  response.end(await readFile(filePath));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  void (async () => {
    try {
      if (request.method === "GET" && url.pathname === "/api/candidate") {
        await handleApiCandidate(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/browse-folder") {
        await handleBrowseFolder(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/candidate/load") {
        await handleLoadCandidate(response, request);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/import") {
        await handleImportFrames(response, request);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/selection") {
        await handleSaveSelection(response, request);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/frames/raw/")) {
        await serveFrame(response, decodeURIComponent(url.pathname.replace("/frames/raw/", "")));
        return;
      }
      if (request.method === "GET") {
        await serveStatic(response, url.pathname);
        return;
      }
      sendText(response, 405, "Method not allowed");
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

// Fail LOUD on a port clash instead of dying with an unhandled 'error' event (same
// silent-crash class as the Asset Bank server: a detached launch would just flash and vanish).
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Frame Picker could not start: port ${port} is already in use.`);
  } else {
    console.error(`Frame Picker server error: ${error.message}`);
  }
  process.exit(1);
});
server.listen(port, () => {
  console.log(`Frame Picker: http://localhost:${port}/`);
  console.log(`Candidate: ${candidateDir}`);
  console.log(`Import root: ${importRoot}`);
});
