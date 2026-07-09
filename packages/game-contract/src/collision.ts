import type { MapManifest } from "./manifests";

// Generic static-collision resolver over a dense blocked-tile grid. Game-agnostic algorithm
// copied faithfully from the game's shared/src/static-collision.ts. The capture/smoke tools use
// it to answer "is this world point/rect blocked?" against a compiled map's collision grid.

export type CollisionRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type StaticCollisionResolver = {
  readonly tileSize: number;
  readonly blockedCount: number;
  isPointBlocked: (x: number, y: number) => boolean;
  isRectBlocked: (rect: CollisionRect) => boolean;
};

const RECT_EDGE_EPSILON = 1e-9;

export function createStaticCollisionResolver(map: Pick<MapManifest, "collision">): StaticCollisionResolver {
  const tileSize = map.collision.tileSize;
  const blocked = new Set<string>();
  for (const [tileX, tileY] of map.collision.blocked) {
    blocked.add(tileKey(tileX, tileY));
  }

  function isTileBlocked(tileX: number, tileY: number): boolean {
    return blocked.has(tileKey(tileX, tileY));
  }

  return {
    tileSize,
    blockedCount: blocked.size,
    isPointBlocked(x, y) {
      return isTileBlocked(Math.floor(x / tileSize), Math.floor(y / tileSize));
    },
    isRectBlocked(rect) {
      if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
      const leftTile = Math.floor(rect.left / tileSize);
      const rightTile = Math.floor((rect.right - RECT_EDGE_EPSILON) / tileSize);
      const topTile = Math.floor(rect.top / tileSize);
      const bottomTile = Math.floor((rect.bottom - RECT_EDGE_EPSILON) / tileSize);
      for (let tileY = topTile; tileY <= bottomTile; tileY += 1) {
        for (let tileX = leftTile; tileX <= rightTile; tileX += 1) {
          if (isTileBlocked(tileX, tileY)) return true;
        }
      }
      return false;
    },
  };
}

function tileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}
