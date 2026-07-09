import type { IncomingMessage, ServerResponse } from "node:http";
import { EDITOR_INSPECTOR_CONTRACT } from "@gamekit/game-contract";
import { apiDocsPayload, renderApiDocsHtml, renderToolMapHtml } from "./api-docs.js";

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>;

type SendJson = (response: ServerResponse, statusCode: number, payload: unknown) => void;

type DevkitRouteHandlers = {
  sendJson: SendJson;
  handleStatus(response: ServerResponse): Promise<void>;
  queueSummaries(): Promise<unknown[]>;
  framePickerCandidates(): Promise<unknown[]>;
  handleStartAssetBank(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleStartFramePicker(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleRefreshAudio(response: ServerResponse): Promise<void>;
  handleRuntimeAssets(response: ServerResponse): Promise<void>;
  handleRuntimeAssetsCategorized(response: ServerResponse): Promise<void>;
  handleBankAssets(response: ServerResponse): Promise<void>;
  handleBankContext(response: ServerResponse, mapId: string): Promise<void>;
  handleAssetPlacementDefaults(response: ServerResponse): Promise<void>;
  handleAssetPlacementDefaultsPreview(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleAssetPlacementDefaultsSave(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handlePromoteAsset(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleSyncPromoted(response: ServerResponse): Promise<void>;
  handlePromotedAssets(response: ServerResponse): Promise<void>;
  handleUnpromoteAsset(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleZoneLayouts(response: ServerResponse): Promise<void>;
  handleCaptureGallery(response: ServerResponse): Promise<void>;
  handleWorldDashboard(response: ServerResponse): Promise<void>;
  handlePipelineView(response: ServerResponse): Promise<void>;
  handleApplyStatus(response: ServerResponse): Promise<void>;
  handleZoneLoop(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleEditorCaptureSave(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleZoneLayoutSave(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleZoneLayoutInstanceOverrideSave(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleZoneValidate(response: ServerResponse): Promise<void>;
  handleZoneExport(response: ServerResponse, request: IncomingMessage): Promise<void>;
  handleBuildClient(response: ServerResponse): Promise<void>;
  handleMapManifests(response: ServerResponse): Promise<void>;
  handleAvailableAssetKeys(response: ServerResponse): Promise<void>;
  handleContentIds(response: ServerResponse): Promise<void>;
  handleWriteBridge(response: ServerResponse): Promise<void>;
  handleProcgenGenerate(response: ServerResponse, url: URL): Promise<void>;
};

export function createDevkitRoutes(handlers: DevkitRouteHandlers): Map<string, RouteHandler> {
  return new Map<string, RouteHandler>([
    ["GET /api/status", async (_request, response) => handlers.handleStatus(response)],
    ["GET /api/queues", async (_request, response) => handlers.sendJson(response, 200, { queues: await handlers.queueSummaries() })],
    [
      "GET /api/frame-picker-candidates",
      async (_request, response) => handlers.sendJson(response, 200, { candidates: await handlers.framePickerCandidates() }),
    ],
    ["POST /api/start-asset-bank", async (request, response) => handlers.handleStartAssetBank(response, request)],
    ["POST /api/start-frame-picker", async (request, response) => handlers.handleStartFramePicker(response, request)],
    ["POST /api/refresh-audio-review", async (_request, response) => handlers.handleRefreshAudio(response)],
    ["GET /api/runtime-assets", async (_request, response) => handlers.handleRuntimeAssets(response)],
    ["GET /api/runtime-assets-categorized", async (_request, response) => handlers.handleRuntimeAssetsCategorized(response)],
    ["GET /api/bank-assets", async (_request, response) => handlers.handleBankAssets(response)],
    [
      "GET /api/bank-context",
      async (_request, response, url) => handlers.handleBankContext(response, url.searchParams.get("mapId") ?? ""),
    ],
    ["GET /api/editor-inspector-schema", async (_request, response) => handlers.sendJson(response, 200, EDITOR_INSPECTOR_CONTRACT)],
    ["GET /api/asset-placement-defaults", async (_request, response) => handlers.handleAssetPlacementDefaults(response)],
    [
      "POST /api/asset-placement-defaults/preview",
      async (request, response) => handlers.handleAssetPlacementDefaultsPreview(response, request),
    ],
    [
      "POST /api/asset-placement-defaults/save",
      async (request, response) => handlers.handleAssetPlacementDefaultsSave(response, request),
    ],
    ["POST /api/promote-asset", async (request, response) => handlers.handlePromoteAsset(response, request)],
    ["POST /api/sync-promoted", async (_request, response) => handlers.handleSyncPromoted(response)],
    ["GET /api/promoted-assets", async (_request, response) => handlers.handlePromotedAssets(response)],
    ["POST /api/unpromote-asset", async (request, response) => handlers.handleUnpromoteAsset(response, request)],
    ["GET /api/zone-layouts", async (_request, response) => handlers.handleZoneLayouts(response)],
    ["GET /api/hub/captures", async (_request, response) => handlers.handleCaptureGallery(response)],
    ["GET /api/hub/world", async (_request, response) => handlers.handleWorldDashboard(response)],
    ["GET /api/hub/pipeline", async (_request, response) => handlers.handlePipelineView(response)],
    ["GET /api/hub/apply-status", async (_request, response) => handlers.handleApplyStatus(response)],
    ["POST /api/hub/zone-loop", async (request, response) => handlers.handleZoneLoop(response, request)],
    ["POST /api/editor-capture/save", async (request, response) => handlers.handleEditorCaptureSave(response, request)],
    ["POST /api/zone-layout/save", async (request, response) => handlers.handleZoneLayoutSave(response, request)],
    [
      "POST /api/zone-layout/instance-override/save",
      async (request, response) => handlers.handleZoneLayoutInstanceOverrideSave(response, request),
    ],
    ["POST /api/zone-validate", async (_request, response) => handlers.handleZoneValidate(response)],
    ["POST /api/zone-export", async (request, response) => handlers.handleZoneExport(response, request)],
    ["POST /api/build-client", async (_request, response) => handlers.handleBuildClient(response)],
    ["GET /api/map-manifests", async (_request, response) => handlers.handleMapManifests(response)],
    ["GET /api/available-asset-keys", async (_request, response) => handlers.handleAvailableAssetKeys(response)],
    ["GET /api/content-ids", async (_request, response) => handlers.handleContentIds(response)],
    ["POST /api/write-assets-bridge", async (_request, response) => handlers.handleWriteBridge(response)],
    ["GET /api/procgen/generate", async (_request, response, url) => handlers.handleProcgenGenerate(response, url)],
    ["GET /api/docs", async (_request, response) => handlers.sendJson(response, 200, apiDocsPayload())],
    [
      "GET /api-docs.html",
      async (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(renderApiDocsHtml());
      },
    ],
    [
      "GET /tool-map.html",
      async (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(renderToolMapHtml());
      },
    ],
  ]);
}
