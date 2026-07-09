import { readFile } from "node:fs/promises";
import { promoteEntry, unpromoteEntry, readRegistryStrict, type PromoteInput } from "./promoted-registry.js";

/**
 * CLI face of the canonical promoted-registry writer, for non-Node hosts
 * (the Python asset-bank server shells out to this instead of writing
 * promoted-registry.json itself). Prints a single JSON result on stdout.
 *
 *   tsx tools/src/promoted-registry-cli.ts promote --payload-file <path-to-json>
 *   tsx tools/src/promoted-registry-cli.ts unpromote --key <registryKey-or-targetName>
 *   tsx tools/src/promoted-registry-cli.ts read
 */

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "promote") {
    const payloadFile = argValue("--payload-file");
    if (!payloadFile) throw new Error("--payload-file required");
    const payload = JSON.parse(await readFile(payloadFile, "utf8")) as PromoteInput;
    const result = await promoteEntry(payload);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
    return;
  }
  if (command === "unpromote") {
    const key = argValue("--key");
    if (!key) throw new Error("--key required");
    const removed = await unpromoteEntry(key);
    process.stdout.write(JSON.stringify({ ok: true, removed }) + "\n");
    return;
  }
  if (command === "read") {
    const registry = await readRegistryStrict();
    process.stdout.write(JSON.stringify({ ok: true, registry }) + "\n");
    return;
  }
  throw new Error(`unknown command: ${command ?? "(none)"} (expected promote|unpromote|read)`);
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
  process.exitCode = 1;
});
