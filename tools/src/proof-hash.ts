import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export type FileProof = { path: string; sha256: string };

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function proofForFiles(root: string, files: string[]): FileProof[] {
  return files
    .filter((file) => existsSync(join(root, file)))
    .sort()
    .map((file) => ({ path: file.replace(/\\/g, "/"), sha256: sha256File(join(root, file)) }));
}

export function visualProofFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`.replace(/\\/g, "/");
      if (entry.isDirectory()) walk(abs, rel);
      else files.push(rel);
    }
  };
  walk(join(root, "client", "src", "render"), "client/src/render");
  for (const file of ["grade", "constants", "animation-assets", "map-assets", "promoted-assets"]) {
    const rel = `client/src/config/${file}.ts`;
    if (existsSync(join(root, rel))) files.push(rel);
  }
  walk(join(root, "client", "public", "assets"), "client/public/assets");
  return files.sort();
}

export function listCaptureShots(captureDir: string): FileProof[] {
  const shots: FileProof[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(png|jpg|jpeg)$/i.test(entry.name)) {
        shots.push({ path: relative(captureDir, abs).replace(/\\/g, "/"), sha256: sha256File(abs) });
      }
    }
  };
  walk(captureDir);
  return shots.sort((a, b) => a.path.localeCompare(b.path));
}
