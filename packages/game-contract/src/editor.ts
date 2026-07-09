// Editor inspector contract: which fields each layer exposes in the zone editor's inspector,
// with their kinds/ranges/defaults. Copied faithfully from the game's
// shared/src/editor-inspector-schema.ts. EDITOR_INSPECTOR_CONTRACT is a tuning constant
// (template default — a game tunes the field set/ranges); the toolkit's devkit-routes serves
// it to the editor client. No external imports; fully game-agnostic UI machinery.

export type EditorInspectorLayer =
  | "ground"
  | "decal"
  | "prop"
  | "npc"
  | "monsterSpawn"
  | "portal"
  | "spawnPoint";

export type EditorInspectorLayoutKey =
  | "ground"
  | "decals"
  | "props"
  | "npcs"
  | "monsterSpawns"
  | "portals"
  | "spawnPoints";

export type EditorInspectorFieldKind = "boolean" | "number" | "readonly" | "select" | "text";
export type EditorInspectorNumberDisplay = "degrees" | "radians" | "unit" | "percent";

export type EditorInspectorField = {
  key: string;
  label: string;
  kind: EditorInspectorFieldKind;
  editable: boolean;
  schemaPath: string;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number | string | boolean;
  options?: readonly string[];
  display?: EditorInspectorNumberDisplay;
  storage?: EditorInspectorNumberDisplay;
  group?: string;
  note?: string;
};

export type EditorInspectorLayerContract = {
  layer: EditorInspectorLayer;
  layoutKey: EditorInspectorLayoutKey;
  label: string;
  fields: readonly EditorInspectorField[];
};

const idField: EditorInspectorField = {
  key: "instanceId",
  label: "instanceId",
  kind: "readonly",
  editable: false,
  schemaPath: "instanceId",
  group: "Identity",
  note: "Display-only stable editor identity.",
};

const assetKeyField: EditorInspectorField = {
  key: "assetKey",
  label: "assetKey",
  kind: "text",
  editable: true,
  schemaPath: "assetKey",
  group: "Identity",
};

const xField: EditorInspectorField = {
  key: "x",
  label: "x",
  kind: "number",
  editable: true,
  schemaPath: "x",
  step: 1,
  group: "Position",
};

const yField: EditorInspectorField = {
  key: "y",
  label: "y",
  kind: "number",
  editable: true,
  schemaPath: "y",
  step: 1,
  group: "Position",
};

const zIndexField: EditorInspectorField = {
  key: "zIndex",
  label: "zIndex",
  kind: "number",
  editable: true,
  schemaPath: "zIndex",
  step: 1,
  group: "Transform",
  note: "Integer z-index only. DepthSpec is intentionally out of scope.",
};

const scaleField: EditorInspectorField = {
  key: "scale",
  label: "scale",
  kind: "number",
  editable: true,
  schemaPath: "scale",
  min: 0.01,
  step: 0.1,
  defaultValue: 1,
  group: "Transform",
};

const rotationField: EditorInspectorField = {
  key: "rotation",
  label: "rotation",
  kind: "number",
  editable: true,
  schemaPath: "rotation",
  step: 1,
  defaultValue: 0,
  display: "degrees",
  storage: "radians",
  group: "Transform",
};

const opacityField: EditorInspectorField = {
  key: "opacity",
  label: "opacity",
  kind: "number",
  editable: true,
  schemaPath: "opacity",
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue: 1,
  display: "unit",
  storage: "unit",
  group: "Transform",
};

const originXField: EditorInspectorField = {
  key: "origin.x",
  label: "origin x",
  kind: "number",
  editable: true,
  schemaPath: "origin.x",
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue: 0.5,
  display: "unit",
  storage: "unit",
  group: "Origin",
};

const propOriginYField: EditorInspectorField = {
  key: "origin.y",
  label: "origin y",
  kind: "number",
  editable: true,
  schemaPath: "origin.y",
  min: 0,
  max: 1,
  step: 0.05,
  defaultValue: 1,
  display: "unit",
  storage: "unit",
  group: "Origin",
};

const decalOriginYField: EditorInspectorField = {
  ...propOriginYField,
  defaultValue: 0.5,
};

const shadowFields: readonly EditorInspectorField[] = [
  {
    key: "shadow.mode",
    label: "shadow mode",
    kind: "select",
    editable: true,
    schemaPath: "shadow.mode",
    options: ["none", "auto", "custom"],
    defaultValue: "auto",
    group: "Shadow",
  },
  { key: "shadow.offsetX", label: "shadow offset x", kind: "number", editable: true, schemaPath: "shadow.offsetX", step: 1, group: "Shadow" },
  { key: "shadow.offsetY", label: "shadow offset y", kind: "number", editable: true, schemaPath: "shadow.offsetY", step: 1, group: "Shadow" },
  {
    key: "shadow.wPct",
    label: "shadow width %",
    kind: "number",
    editable: true,
    schemaPath: "shadow.wPct",
    min: 0,
    max: 300,
    step: 5,
    defaultValue: 100,
    display: "percent",
    storage: "percent",
    group: "Shadow",
  },
  {
    key: "shadow.hPct",
    label: "shadow height %",
    kind: "number",
    editable: true,
    schemaPath: "shadow.hPct",
    min: 0,
    max: 300,
    step: 5,
    defaultValue: 100,
    display: "percent",
    storage: "percent",
    group: "Shadow",
  },
  {
    key: "shadow.alpha",
    label: "shadow alpha",
    kind: "number",
    editable: true,
    schemaPath: "shadow.alpha",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 0.34,
    display: "unit",
    storage: "unit",
    group: "Shadow",
  },
  {
    key: "shadow.blur",
    label: "shadow blur",
    kind: "number",
    editable: true,
    schemaPath: "shadow.blur",
    min: 0,
    max: 24,
    step: 1,
    defaultValue: 8,
    group: "Shadow",
  },
  { ...rotationField, key: "shadow.rotation", label: "shadow rotation", schemaPath: "shadow.rotation", group: "Shadow" },
];

const reflectionFields: readonly EditorInspectorField[] = [
  {
    key: "reflection.enabled",
    label: "water reflection",
    kind: "boolean",
    editable: true,
    schemaPath: "reflection.enabled",
    defaultValue: false,
    group: "Reflection",
  },
  {
    key: "reflection.offsetY",
    label: "reflection y",
    kind: "number",
    editable: true,
    schemaPath: "reflection.offsetY",
    step: 1,
    defaultValue: 12,
    group: "Reflection",
  },
  {
    key: "reflection.heightPct",
    label: "reflection height %",
    kind: "number",
    editable: true,
    schemaPath: "reflection.heightPct",
    min: 0,
    max: 300,
    step: 5,
    defaultValue: 58,
    display: "percent",
    storage: "percent",
    group: "Reflection",
  },
  {
    key: "reflection.alpha",
    label: "reflection alpha",
    kind: "number",
    editable: true,
    schemaPath: "reflection.alpha",
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 0.24,
    display: "unit",
    storage: "unit",
    group: "Reflection",
  },
  {
    key: "reflection.wavePct",
    label: "reflection wave %",
    kind: "number",
    editable: true,
    schemaPath: "reflection.wavePct",
    min: 0,
    max: 100,
    step: 5,
    defaultValue: 8,
    display: "percent",
    storage: "percent",
    group: "Reflection",
  },
];

const collisionFields: readonly EditorInspectorField[] = [
  {
    key: "collision.mode",
    label: "collision mode",
    kind: "select",
    editable: true,
    schemaPath: "collision.mode",
    options: ["none", "box"],
    defaultValue: "none",
    group: "Collision",
  },
  {
    key: "collision.xPct",
    label: "collision x %",
    kind: "number",
    editable: true,
    schemaPath: "collision.xPct",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 0,
    display: "percent",
    storage: "percent",
    group: "Collision",
  },
  {
    key: "collision.yPct",
    label: "collision y %",
    kind: "number",
    editable: true,
    schemaPath: "collision.yPct",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 0,
    display: "percent",
    storage: "percent",
    group: "Collision",
  },
  {
    key: "collision.wPct",
    label: "collision width %",
    kind: "number",
    editable: true,
    schemaPath: "collision.wPct",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 100,
    display: "percent",
    storage: "percent",
    group: "Collision",
  },
  {
    key: "collision.hPct",
    label: "collision height %",
    kind: "number",
    editable: true,
    schemaPath: "collision.hPct",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 100,
    display: "percent",
    storage: "percent",
    group: "Collision",
  },
  {
    key: "collision.blocksMovement",
    label: "blocks movement",
    kind: "boolean",
    editable: true,
    schemaPath: "collision.blocksMovement",
    defaultValue: false,
    group: "Collision",
  },
  {
    key: "collision.blocksPlayers",
    label: "blocks players",
    kind: "boolean",
    editable: true,
    schemaPath: "collision.blocksPlayers",
    defaultValue: false,
    group: "Collision",
  },
  {
    key: "collision.blocksMonsters",
    label: "blocks monsters",
    kind: "boolean",
    editable: true,
    schemaPath: "collision.blocksMonsters",
    defaultValue: false,
    group: "Collision",
  },
  {
    key: "legacyPixelCollision",
    label: "legacy pixel collision",
    kind: "readonly",
    editable: false,
    schemaPath: "legacyPixelCollision",
    group: "Collision",
    note: "Read-only migration display for old pixel collision boxes.",
  },
];

export const EDITOR_INSPECTOR_LAYER_CONTRACTS: readonly EditorInspectorLayerContract[] = [
  {
    layer: "ground",
    layoutKey: "ground",
    label: "Ground",
    fields: [
      idField,
      assetKeyField,
      xField,
      yField,
      { key: "width", label: "width", kind: "number", editable: true, schemaPath: "width", min: 0.01, step: 1, group: "Size" },
      { key: "height", label: "height", kind: "number", editable: true, schemaPath: "height", min: 0.01, step: 1, group: "Size" },
      zIndexField,
    ],
  },
  {
    layer: "decal",
    layoutKey: "decals",
    label: "Decal",
    fields: [idField, assetKeyField, xField, yField, scaleField, rotationField, zIndexField, originXField, decalOriginYField, opacityField],
  },
  {
    layer: "prop",
    layoutKey: "props",
    label: "Prop",
    fields: [
      idField,
      assetKeyField,
      xField,
      yField,
      scaleField,
      rotationField,
      zIndexField,
      originXField,
      propOriginYField,
      opacityField,
      ...shadowFields,
      ...reflectionFields,
      ...collisionFields,
    ],
  },
  {
    layer: "npc",
    layoutKey: "npcs",
    label: "NPC",
    fields: [
      idField,
      { key: "npcId", label: "npcId", kind: "select", editable: true, schemaPath: "npcId", group: "Identity" },
      xField,
      yField,
      { key: "radius", label: "radius", kind: "number", editable: true, schemaPath: "radius", min: 0.01, step: 1, group: "Size" },
      { key: "scale", label: "scale", kind: "number", editable: true, schemaPath: "scale", min: 0.25, max: 4, step: 0.05, group: "Size" },
    ],
  },
  {
    layer: "monsterSpawn",
    layoutKey: "monsterSpawns",
    label: "Monster Spawn",
    fields: [
      idField,
      { key: "monsterId", label: "monsterId", kind: "select", editable: true, schemaPath: "monsterId", group: "Identity" },
      xField,
      yField,
      { key: "width", label: "width", kind: "number", editable: true, schemaPath: "width", min: 0.01, step: 1, group: "Size" },
      { key: "height", label: "height", kind: "number", editable: true, schemaPath: "height", min: 0.01, step: 1, group: "Size" },
      { key: "maxAlive", label: "maxAlive", kind: "number", editable: true, schemaPath: "maxAlive", min: 1, step: 1, group: "Spawn" },
      { key: "respawnMs", label: "respawnMs", kind: "number", editable: true, schemaPath: "respawnMs", min: 0, step: 1, group: "Spawn" },
    ],
  },
  {
    layer: "portal",
    layoutKey: "portals",
    label: "Portal",
    fields: [
      idField,
      { key: "portalId", label: "portalId", kind: "select", editable: true, schemaPath: "portalId", group: "Identity" },
      { key: "shape.type", label: "shape type", kind: "select", editable: true, schemaPath: "shape.type", options: ["circle", "rect"], group: "Shape" },
      { key: "shape.x", label: "shape x", kind: "number", editable: true, schemaPath: "shape.x", step: 1, group: "Shape" },
      { key: "shape.y", label: "shape y", kind: "number", editable: true, schemaPath: "shape.y", step: 1, group: "Shape" },
      { key: "shape.radius", label: "shape radius", kind: "number", editable: true, schemaPath: "shape.radius", min: 0.01, step: 1, group: "Shape" },
      { key: "shape.width", label: "shape width", kind: "number", editable: true, schemaPath: "shape.width", min: 0.01, step: 1, group: "Shape" },
      { key: "shape.height", label: "shape height", kind: "number", editable: true, schemaPath: "shape.height", min: 0.01, step: 1, group: "Shape" },
    ],
  },
  {
    layer: "spawnPoint",
    layoutKey: "spawnPoints",
    label: "Spawn Point",
    fields: [
      idField,
      { key: "id", label: "id", kind: "text", editable: true, schemaPath: "id", group: "Identity" },
      xField,
      yField,
    ],
  },
];

export const EDITOR_INSPECTOR_CONTRACT = {
  version: 1,
  layers: EDITOR_INSPECTOR_LAYER_CONTRACTS,
} as const;

export function getEditorInspectorLayerContract(layoutKey: EditorInspectorLayoutKey): EditorInspectorLayerContract | undefined {
  return EDITOR_INSPECTOR_LAYER_CONTRACTS.find((contract) => contract.layoutKey === layoutKey);
}
