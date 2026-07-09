import type { IncomingMessage, ServerResponse } from "node:http";

type RunRepoCommand = (command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
type ReadRequestJson = (request: IncomingMessage) => Promise<Record<string, unknown>>;
type SendJson = (response: ServerResponse, statusCode: number, payload: unknown) => void;

export function createZoneCommandHandlers(context: {
  runRepoCommand: RunRepoCommand;
  readRequestJson: ReadRequestJson;
  sendJson: SendJson;
}): {
  handleZoneValidate(response: ServerResponse): Promise<void>;
  handleZoneExport(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleBuildClient(response: ServerResponse): Promise<void>;
} {
  const { runRepoCommand, readRequestJson, sendJson } = context;

  async function handleZoneValidate(response: ServerResponse): Promise<void> {
    const result = await runRepoCommand("pnpm zone:validate", 15000);
    sendJson(response, 200, { ok: result.ok, output: result.output });
  }

  async function handleZoneExport(response: ServerResponse, request: IncomingMessage): Promise<void> {
    const payload = await readRequestJson(request);
    const mapId = payload.mapId as string | undefined;
    const dryRun = payload.dryRun === true;
    // mapId is interpolated into a shell command below; restrict it to the content-ID
    // grammar so a request body cannot inject arbitrary shell (e.g. "map_x; rm -rf ...").
    if (mapId !== undefined && !/^map_[a-z0-9_]+$/.test(mapId)) {
      sendJson(response, 400, { ok: false, error: `Invalid mapId: ${JSON.stringify(mapId)}` });
      return;
    }
    const cmd = [mapId ? `pnpm zone:export --zone=${mapId}` : "pnpm zone:export", dryRun ? "--dry-run" : ""]
      .filter(Boolean)
      .join(" ");
    const result = await runRepoCommand(cmd, 15000);
    sendJson(response, 200, { ok: result.ok, output: result.output });
  }

  async function handleBuildClient(response: ServerResponse): Promise<void> {
    const result = await runRepoCommand("pnpm build:client", 120000);
    sendJson(response, 200, { ok: result.ok, output: result.output });
  }

  return { handleZoneValidate, handleZoneExport, handleBuildClient };
}
