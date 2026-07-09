export type SmokeState = {
  sceneKey: string;
  isActive: boolean;
  childCount: number;
  statusText: string | null;
  hasRoom: boolean;
  localSessionId: string | null;
  players: Array<{
    sessionId: string;
    mapId: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    xp: number;
    level: number;
    classId: string;
    jobXp: number;
    jobLevel: number;
    skillPoints: number;
    attributePoints: number;
    allocatedAttributes: Record<string, number>;
    selectedTargetId: string;
    inventory: Array<{ itemId: string; quantity: number }>;
    quests: Array<{ questId: string; status: string; progress: number; required: number; rewardXp: number; rewardGold: number }>;
  }>;
  parties: Array<{ partyId: string; leaderId: string; memberIds: string[] }>;
  monsters: Array<{
    monsterId: string;
    mapId: string;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    targetId: string;
  }>;
  loot: Array<{ lootId: string; itemId: string; quantity: number; mapId: string; x: number; y: number }>;
  npcs: Array<{
    npcId: string;
    mapId: string;
    x: number;
    y: number;
    questId: string;
    questMarkerState?: "plain" | "available" | "active" | "ready";
    shopItems: Array<{ itemId: string; buyPrice: number; sellPrice: number }>;
  }>;
  chests: Array<{ chestId: string; mapId: string; x: number; y: number; radius: number; opened: boolean }>;
  renderedCount: number;
  renderedMonsterCount: number;
  renderedLootCount: number;
  camera: { scrollX: number; scrollY: number; zoom: number } | null;
  fps: number;
};

export type JoinedSmokeState = SmokeState & { localSessionId: string };

export type QuestStatus = {
  questId: string;
  status: string;
  progress: number;
  required: number;
};

export type MonsterTarget = {
  monsterId: string;
  x: number;
  y: number;
};

export type SmokeCollection<T> = {
  get(id: string | undefined): T;
  has(id: string): boolean;
  forEach(callback: (value: T, id: string) => void): void;
  size: number;
};

export type SmokeStringCollection = {
  get(id: string | undefined): string | undefined;
  has(id: string): boolean;
  forEach(callback: (value: string, id: string) => void): void;
  size: number;
};

export type SmokeNumberCollection = {
  get(id: string | undefined): number | undefined;
  has(id: string): boolean;
  forEach(callback: (value: number, id: string) => void): void;
  size: number;
};

export type SmokeInventoryItem = {
  itemId: string;
  quantity: number;
};

export type SmokeQuest = {
  questId: string;
  status: string;
  progress: number;
  required: number;
  rewardXp: number;
  rewardGold: number;
};

export type SmokePlayer = {
  mapId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  xp: number;
  level: number;
  classId: string;
  jobXp: number;
  jobLevel: number;
  skillPoints: number;
  skillLevels?: SmokeNumberCollection;
  attributePoints: number;
  allocatedAttributes?: SmokeNumberCollection;
  def: number;
  mdef: number;
  selectedTargetId: string;
  inventory: SmokeCollection<SmokeInventoryItem>;
  equipped: SmokeStringCollection;
  quests: SmokeCollection<SmokeQuest>;
};

export type SmokeMonster = {
  monsterId?: string;
  mapId: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  targetId: string;
};

export type SmokeLoot = {
  itemId: string;
  quantity: number;
  mapId: string;
  x: number;
  y: number;
};

export type SmokeNpc = {
  mapId: string;
  x: number;
  y: number;
  questId: string;
  shopItems?: SmokeCollection<{ itemId: string; buyPrice: number; sellPrice: number }>;
};

export type SmokeChest = {
  id: string;
  mapId: string;
  x: number;
  y: number;
  radius: number;
  assetKey: string;
  scale: number;
  opened: boolean;
};

export type SmokeRoom = {
  state: {
    players: SmokeCollection<SmokePlayer>;
    monsters: SmokeCollection<SmokeMonster>;
    loot: SmokeCollection<SmokeLoot>;
    npcs: SmokeCollection<SmokeNpc>;
    chests?: SmokeCollection<SmokeChest>;
    parties: SmokeCollection<{ id: string; leaderId: string; memberIds: string[] }>;
  };
  send(type: "intent", payload: Record<string, unknown>): void;
  onMessage(type: "combat", callback: (event: SmokeCombatEvent) => void): void;
  onMessage(type: "party", callback: (event: Record<string, unknown>) => void): void;
  onMessage(type: "error", callback: (event: SmokeServerError) => void): void;
};

export type SmokeCombatEvent = {
  type?: string;
  skillId?: string;
  sourceId?: string;
  targetId?: string;
  amount?: number;
  killed?: boolean;
  effect?: { type?: string; durationMs?: number };
  x?: number;
  y?: number;
  serverTimeMs?: number;
};

export type SmokeServerError = {
  type?: "error";
  requestId?: string;
  code?: string;
  messageKey?: string;
  message?: string;
};

export type SmokeCamera = {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
  worldView: { x: number; y: number };
  stopFollow(): void;
  setZoom(zoom: number): void;
  centerOn(x: number, y: number): void;
  // card-vfx-flipbook-step: Phaser camera fade effect, read by the zone-transition proof to assert the
  // portal fade-out/in ran. Optional/readonly — the proof only inspects state.
  fadeEffect?: { readonly isRunning: boolean; readonly isComplete: boolean; readonly direction: boolean };
};

export type SmokeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SmokeRenderObject = {
  container: { visible: boolean; x: number; y: number };
  hitRect: { x: number; y: number; width: number; height: number };
};

export type SmokeScene = {
  scene: { key: string; isActive(): boolean };
  cameras: { main: SmokeCamera };
  textures: { exists(key: string): boolean };
  cache: { audio: { exists(key: string): boolean } };
  game: {
    canvas: { getBoundingClientRect(): SmokeRect };
    config: { width?: number | string; height?: number | string };
  };
  scale: { width?: number; height?: number };
  children?: { list?: unknown[] };
  statusText?: { text?: string };
  room: SmokeRoom;
  localSessionId: string;
  currentMapId?: string;
  playerObjects: SmokeCollection<SmokeRenderObject>;
  monsterObjects: SmokeCollection<SmokeRenderObject>;
  lootObjects: SmokeCollection<SmokeRenderObject>;
  npcObjects: SmokeCollection<SmokeRenderObject>;
  chatBubbles?: SmokeCollection<{ message: string; container?: { visible: boolean } }>;
  inputController?: {
    isPointerActive: () => boolean;
    clearHeldInput: () => void;
    targetMarkerVisible: boolean;
    targetMarkerDepth: number;
  };
  input?: { activePointer?: { isDown?: boolean }; enabled?: boolean; manager?: { enabled?: boolean; pointers?: unknown[] } };
  getCurrentMap(): { size: { width: number; height: number } };
  setVisualQaMapOverride?(mapId: string): void;
  getLoadingOverlayQaState?: () => { visible: boolean; mapId?: string; title?: string; progress: number };
  getBootAssetQaState?: () => {
    loadedTiers: string[];
    tier0LoadedAtMs?: number;
    tier1StartedAtMs?: number;
    tier1LoadedAtMs?: number;
    tier1Progress: number;
  };
  getEditorQaApi: () => EditorQaApi;
  // card-enhancement-v1 capture leg.
  openEnhancementForQa?: () => void;
  getEnhancementQaState?: () => {
    open: boolean;
    weaponItemId: string | null;
    level: number;
    nextSuccessPct: number;
    nextBreakPct: number;
    goldCost: number;
    canAttempt: boolean;
    lastResult: "success" | "break" | "fail" | null;
    lastResultLevel: number | null;
  };
  getVisualQaSnapshot?: () => SmokeVisualQaSnapshot;
  getLevelUpCelebrationQaState?: () => {
    active: Array<{ sessionId: string; label: string; local: boolean; x: number; y: number; expiresInMs: number }>;
    hudShineActive: boolean;
  };
  editableObjects?: EditorRuntimeObject[];
};

export type SmokeGame = {
  scene: { getScene(key: "game"): SmokeScene };
  loop?: { actualFps?: number };
};

export type SmokeVisualQaSnapshot = {
  currentMapId: string;
  canvas: { width: number; height: number; rect: { width: number; height: number } };
  camera: { scrollX: number; scrollY: number; zoom: number };
  players?: Array<{ visible: boolean; isLocal?: boolean; server?: { x: number; y: number } }>;
  monsters?: Array<{ visible: boolean }>;
  bossTelegraphs?: Array<{
    id: string;
    monsterInstanceId: string;
    world: { x: number; y: number; radius: number };
    remainingMs: number;
  }>;
  npcs: Array<{ id?: string; visible: boolean; questMarkerState?: "plain" | "available" | "active" | "ready" }>;
  portals: Array<{ visible: boolean }>;
  settings?: {
    open: boolean;
    masterVolume: number;
    uiVolume: number;
    uiMoveEnabled: boolean;
    hintsEnabled: boolean;
  };
  leaderboard?: {
    open: boolean;
    boardId: string;
    rowCount: number;
    ownRankVisible: boolean;
  };
  minimap?: {
    mapId: string | null;
    mapLabel: string;
    zoomPercent: number;
    terrainRendered: boolean;
    terrainRenderCount: number;
    playerMarkerCount: number;
    monsterMarkerCount: number;
    npcMarkerCount: number;
    portalMarkerCount: number;
    questPinCount: number;
    questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }>;
    viewportRendered: boolean;
    collapsed: boolean;
  };
  worldMap?: {
    open: boolean;
    mapId: string | null;
    mapLabel: string;
    zoom: number;
    pan: { x: number; y: number };
    artMode: "procedural" | "illustration";
    artSrc: string | null;
    playerWorld: { x: number; y: number; mapId: string } | null;
    playerCanvas: { x: number; y: number } | null;
    expectedPlayerCanvas: { x: number; y: number } | null;
    playerDeltaPx: number | null;
    playerMarkerVisible: boolean;
    otherPlayerMarkerCount: number;
    monsterMarkerCount: number;
    npcMarkerCount: number;
    portalMarkerCount: number;
    questPinCount: number;
    questPins: Array<{ questId: string; kind: string; mapId: string; x: number; y: number }>;
    viewportRendered: boolean;
  };
  questNav?: {
    targetCount: number;
    activeTarget: { questId: string; kind: string; mapId: string; x: number; y: number; label: string; resolvedFrom: string } | null;
    edgeArrow: { visible: boolean; x: number; y: number; angleDeg: number };
  };
  hudMutations?: { enabled: boolean; totalMutations: number; mutationsPerSecond: number; measuredForMs: number; lastResetAtMs: number };
  hub?: {
    open: boolean;
    activeTab: string;
    filter: string;
    search: string;
    compatibleOnly: boolean;
    gridCount: number;
    equipped: Record<string, string>;
    selectedCard: string | null;
    previewItem: string | null;
    contextActionsItem: string | null;
    detailItem: string | null;
    forgeDisabled: boolean;
    guidanceHint: string | null;
    guidanceFocusedSlot: string | null;
    skillsCategory: string;
    skillRowCount: number;
    selectedSkill: string | null;
    learnDisabledReason: string | null;
    gameplayInputBlocked: boolean;
  };
  action?: {
    slotCount: number;
    rowCount: number;
    bindings: Array<{ key: string; label: string; type: string | null; id: string | null }>;
    assignmentOpen: boolean;
    xpText: string;
    xpBadge: string;
    jobText: string;
    jobBadge: string;
  };
  questJournal?: {
    open: boolean;
    rowCount: number;
    selectedQuest: string | null;
    selectedStatus: string | null;
    trackedQuestIds: string[];
    trackerFollowsToggle: boolean;
    detailTitle: string | null;
  };
  input: {
    pointerDown?: boolean;
    keyboardFocus?: string | null;
    moveTarget?: { x: number; y: number } | null;
    predictionTarget?: { x: number; y: number } | null;
    attackHeld: boolean;
    groundSkillAim?: {
      skillId: string;
      x: number;
      y: number;
      radius: number;
      range: number;
      inRange: boolean;
    } | null;
  };
};

export type SmokeElement = {
  textContent?: string | null;
  disabled?: boolean;
  hidden?: boolean;
  className?: string;
  classList: { contains(className: string): boolean };
  value: string;
  checked?: boolean;
  open?: boolean;
  tagName?: string;
  dataset?: Record<string, string | undefined>;
  style?: Record<string, string>;
  click(): void;
  blur?(): void;
  contains(node: SmokeElement): boolean;
  querySelectorAll(selector: string): SmokeElement[];
  querySelector(selector: string): SmokeElement | null;
  scrollIntoView(options?: { block?: string }): void;
};

export type SmokeDocument = {
  activeElement?: SmokeElement | null;
  body: SmokeElement;
  querySelector(selector: string): SmokeElement | null;
  querySelectorAll(selector: string): SmokeElement[];
  getElementById(id: string): SmokeElement | null;
};

export type SmokeBrowserGlobal = typeof globalThis & {
  document: SmokeDocument;
  getComputedStyle(element: SmokeElement | null): { display: string };
  __GAME: SmokeGame;
  __GAMEKIT_QA__: {
    getVisualQaSnapshot: () => SmokeVisualQaSnapshot;
    openSettings?: () => void;
    openLeaderboards?: (event: unknown) => void;
    openReskinWindow?: (kind: "shop" | "journal" | "worldMap", npcId?: string) => void;
    showDialogue?: (event: unknown) => void;
  };
  __SMOKE_AGGRO_HIT__?: { hp: number; monsterId?: string; beforeHp?: number } | null;
  __SMOKE_COMBAT_TRACE_INSTALLED__?: boolean;
  __SMOKE_COMBAT_EVENTS__?: SmokeCombatEvent[];
  __SMOKE_ERROR_TRACE_INSTALLED__?: boolean;
  __SMOKE_SERVER_ERRORS__?: Array<SmokeServerError & { receivedAtMs: number }>;
  __GAMEKIT_HUD_MUTATIONS__?: {
    reset(): void;
    getSnapshot(): { enabled: boolean; totalMutations: number; mutationsPerSecond: number; measuredForMs: number; lastResetAtMs: number };
  };
};

export type EditorTransform = {
  [key: string]: unknown;
  x: number;
  y: number;
  scale: number;
  rotationDeg: number;
  opacity: number;
  originX: number;
  originY: number;
  zIndex: number;
  width: number;
  height: number;
  maxAlive: number;
  respawnMs: number;
  collisionMode: number;
  collisionXPct: number;
  collisionYPct: number;
  collisionWPct: number;
  collisionHPct: number;
  collisionBlocksMovement: number;
  shadowMode: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowWPct: number;
  shadowHPct: number;
  shadowAlpha: number;
  shadowBlur: number;
  shadowRotationDeg: number;
  reflectionEnabled: number;
  reflectionAlpha: number;
  reflectionHeightPct?: number;
  reflectionOffsetY: number;
  reflectionWavePct?: number;
};

export type EditorState = {
  [key: string]: unknown;
  active: boolean;
  mapId: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedInstanceId: string;
  selectedLayer: string;
  selectedPosition: { x: number; y: number };
  selectedValidation?: { ok: boolean; issues?: string[] };
  selectedTransform: EditorTransform;
  selectedAssetScope?: {
    assetKey: string;
    instanceCount: number;
    scope: "local override" | "global default";
    collisionSource: "instance" | "assetDefault" | "none";
    effectiveCollisionMode: "none" | "box";
  } | null;
  layerFilter: string | null;
  visibleObjectCount: number;
  hiddenObjectCount?: number;
  lockedObjectCount?: number;
  status: string;
  objectCount: number;
  showAllCollision?: boolean;
};

export type EditorSaveResult = { ok: boolean; error?: string; [key: string]: unknown };
export type EditorCaptureResult = { ok: boolean; file?: string; error?: string; [key: string]: unknown };
export type EditorFreshnessResult = { status: string; [key: string]: unknown };

export type EditorQaApi = {
  getState(): EditorState;
  setActive(active: boolean): Promise<void> | void;
  selectProp(propId: string): Promise<EditorState> | EditorState;
  selectObject(...args: string[]): Promise<EditorState> | EditorState;
  selectSimilar(instanceId?: string): EditorState;
  placeAsset(layer: string, assetKey: string): Promise<EditorState>;
  moveSelectedBy(dx: number, dy: number): EditorState;
  setSelectedTransform(transform: Partial<EditorTransform> | undefined): EditorState;
  undo(): EditorState;
  redo(): EditorState;
  save(): Promise<EditorSaveResult>;
  saveOverride(): Promise<EditorSaveResult>;
  saveDefaults(): Promise<EditorSaveResult>;
  refreshCompiledStatus(): Promise<EditorState>;
  applyDefaults(): EditorState;
  clearOverrides(): EditorState;
  deleteSelected(): EditorState;
  applyOriginPreset(preset?: string): EditorState;
  applyCollisionPreset(preset: string): EditorState;
  autoAdjustShadow(): EditorState;
  autoAdjustAllShadows(): EditorState;
  resetShadow(): EditorState;
  applyShadowPreset(preset?: string): EditorState;
  autoAdjustReflection(): EditorState;
  resetReflection(): EditorState;
  applyZOrderAction(action?: string): EditorState;
  resetScale(): EditorState;
  focusSelected(): EditorState;
  saveCameraBookmark(): EditorState;
  restoreCameraBookmark(): EditorState;
  toggleHidden(instanceId: string): EditorState;
  toggleLocked(instanceId: string): EditorState;
  placeNpc(npcId?: string): Promise<EditorState>;
  placePortal(portalId?: string): Promise<EditorState>;
  placeMonsterSpawn(monsterId?: string): Promise<EditorState>;
  moveSelectedTo(x: number, y: number): EditorState;
  clearObjectFilter(): EditorState;
  checkFileFreshness(): Promise<EditorFreshnessResult>;
  captureView(): Promise<EditorCaptureResult>;
  copySelectedObjectJson(): Promise<string>;
  copyViewportSummary(): Promise<string>;
  getObjectOrder(layer: string): string[];
  reorderObject(sourceInstanceId: string, targetInstanceId: string, position: "before" | "after"): EditorState;
  // card-lr2-editor-collision-overlay: map-wide collision overlay toggle.
  setShowAllCollision(on: boolean): EditorState;
};

export type EditorRuntimeObject = {
  instanceId: string;
  reflection?: { visible: boolean; y: number };
};

export type EditorSmokeScene = SmokeScene & {
  getEditorQaApi?: () => EditorQaApi;
  editableObjects?: EditorRuntimeObject[];
};
