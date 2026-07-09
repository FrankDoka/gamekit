// @gamekit/game-contract — the interface a game implements so the game-aware toolkit
// (capture/zone/smoke/devkit/validate/funnel) works against it. Types + generic reference
// algorithms + tunable template defaults; no game logic.
//
// A game either (a) points these accessors at its own modules, or (b) re-exports its real
// shared/client/server symbols through a package with this name. The toolkit imports ONLY from
// here, never from a specific game's source tree.

export * from "./ids";
export * from "./attributes";
export * from "./geometry";
export * from "./zone";
export * from "./manifests";
export * from "./stage-manifests";
export * from "./asset-placement";
export * from "./editor";
export * from "./economy-tuning";
export * from "./messages";
export * from "./collision";
export * from "./render-constants";
export * from "./asset-scale";
export * from "./animation-assets";
export * from "./map-assets";
export * from "./persistence";
export * from "./procgen/mulberry32";
export * from "./procgen/dungeon";
export * from "./procgen/emitter";
