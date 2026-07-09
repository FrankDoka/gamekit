import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";

type SendText = (response: ServerResponse, statusCode: number, text: string) => void;

export type StaticHandlers = {
  serveStatic(response: ServerResponse, urlPath: string): Promise<void>;
  serveRuntimeAsset(response: ServerResponse, urlPath: string): Promise<void>;
  serveAssetFile(response: ServerResponse, urlPath: string): Promise<void>;
  serveCaptureFile(response: ServerResponse, urlPath: string): Promise<void>;
};

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createStaticHandlers(context: {
  repoRoot: string;
  devkitRoot: string;
  assetsRoot: string;
  sendText: SendText;
}): StaticHandlers {
  const { repoRoot, devkitRoot, assetsRoot, sendText } = context;
  const runtimeAssetsRoot = path.join(repoRoot, "client", "public", "assets");

  async function serveStatic(response: ServerResponse, urlPath: string): Promise<void> {
    // Design tokens are served live from their single home in client/src/ui — the tool
    // pages <link href="/tokens.css"> the SAME file the game imports, so palettes can't drift.
    if (urlPath === "/tokens.css") {
      const tokens = await readFile(path.join(repoRoot, "client", "src", "ui", "tokens.css"));
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(tokens);
      return;
    }
    // tokens.css @font-face uses /assets/fonts/* (client-origin paths); serve the same
    // files here so the tool pages get the shared typography too.
    if (urlPath.startsWith("/assets/fonts/")) {
      const fontsRoot = path.join(repoRoot, "client", "public", "assets", "fonts");
      const resolvedFont = path.resolve(fontsRoot, decodeURIComponent(urlPath.slice("/assets/fonts/".length)));
      if (!isInside(resolvedFont, fontsRoot)) {
        sendText(response, 403, "Forbidden");
        return;
      }
      try {
        const font = await readFile(resolvedFont);
        response.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=3600" });
        response.end(font);
      } catch {
        sendText(response, 404, "Not found");
      }
      return;
    }
    const requested = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const resolved = path.resolve(devkitRoot, requested);
    if (!isInside(resolved, devkitRoot)) {
      sendText(response, 403, "Forbidden");
      return;
    }
    const file = await readFile(resolved);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(resolved).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(file);
  }

  async function serveRuntimeAsset(response: ServerResponse, urlPath: string): Promise<void> {
    const relative = decodeURIComponent(urlPath.replace(/^\/runtime-asset\/?/, ""));
    const resolved = path.resolve(runtimeAssetsRoot, relative);
    if (!isInside(resolved, runtimeAssetsRoot)) {
      sendText(response, 403, "Forbidden");
      return;
    }
    try {
      const file = await readFile(resolved);
      response.writeHead(200, {
        "content-type": contentTypes.get(path.extname(resolved).toLowerCase()) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(file);
    } catch {
      sendText(response, 404, "Not found");
    }
  }

  async function serveAssetFile(response: ServerResponse, urlPath: string): Promise<void> {
    const relative = decodeURIComponent(urlPath.replace(/^\/assets-file\/?/, ""));
    const resolved = path.resolve(assetsRoot, relative);
    if (!isInside(resolved, assetsRoot)) {
      sendText(response, 403, "Forbidden");
      return;
    }
    const file = await readFile(resolved);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(resolved).toLowerCase()) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(file);
  }

  async function serveCaptureFile(response: ServerResponse, urlPath: string): Promise<void> {
    const parts = urlPath.split("/").filter(Boolean);
    const kind = parts[1];
    const rel = parts.slice(2).join("/");
    const root = kind === "editor" ? path.join(repoRoot, "tools", "_editor-captures") : path.join(repoRoot, "tools", "_capture");
    const resolved = path.resolve(root, rel);
    if (!isInside(resolved, root) || path.extname(resolved).toLowerCase() !== ".png") {
      sendText(response, 403, "Forbidden");
      return;
    }
    const file = await readFile(resolved);
    response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    response.end(file);
  }

  return { serveStatic, serveRuntimeAsset, serveAssetFile, serveCaptureFile };
}
