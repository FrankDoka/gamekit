// Client/server message contracts (the subset the toolkit reads). Copied faithfully from the
// game's shared/src/messages.ts. Only the types the tools consume are recreated here — the
// full intent union + runtime validator live in the game. `ChatEvent` is used by the
// gm-command/gm-panel proof tools to assert on world/system chat lines.

export type EntityId = string;

export type ChatEvent =
  | {
      type: "message";
      senderSessionId: EntityId;
      senderCharacterId: string;
      senderName: string;
      text: string;
      channel: "world";
      mapId: string;
      serverTimeMs: number;
    }
  | {
      type: "system";
      text: string;
      channel: "system";
      serverTimeMs: number;
    };
