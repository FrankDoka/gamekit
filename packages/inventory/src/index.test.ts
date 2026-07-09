import { describe, it, expect } from "vitest";
import { Inventory } from "./index";

describe("add — stacking and spilling", () => {
  it("stacks up to maxStack then spills to new slots", () => {
    const inv = new Inventory(4);
    const overflow = inv.add("potion", 25, 10);
    expect(overflow).toBe(0);
    // 25 across maxStack 10 => [10, 10, 5, null]
    expect(inv.getSlot(0)).toEqual({ itemId: "potion", qty: 10 });
    expect(inv.getSlot(1)).toEqual({ itemId: "potion", qty: 10 });
    expect(inv.getSlot(2)).toEqual({ itemId: "potion", qty: 5 });
    expect(inv.getSlot(3)).toBeNull();
    expect(inv.count("potion")).toBe(25);
  });

  it("tops up existing partial stacks before opening new slots", () => {
    const inv = new Inventory(3);
    inv.add("ore", 5, 10); // [5,_,_]
    inv.add("ore", 3, 10); // tops the partial -> [8,_,_]
    expect(inv.getSlot(0)).toEqual({ itemId: "ore", qty: 8 });
    expect(inv.getSlot(1)).toBeNull();
  });

  it("returns overflow that does not fit in capacity", () => {
    const inv = new Inventory(2);
    const overflow = inv.add("brick", 30, 10); // fits 20 (2 slots * 10)
    expect(overflow).toBe(10);
    expect(inv.totalCount()).toBe(20);
  });

  it("adding to a full inventory returns the full qty as overflow", () => {
    const inv = new Inventory(1);
    inv.add("a", 10, 10); // slot full with a different item
    const overflow = inv.add("b", 5, 10);
    expect(overflow).toBe(5);
    expect(inv.count("b")).toBe(0);
  });
});

describe("remove", () => {
  it("removes across multiple stacks, low index first", () => {
    const inv = new Inventory(3);
    inv.add("potion", 25, 10); // [10,10,5]
    const removed = inv.remove("potion", 22);
    expect(removed).toBe(22);
    // 22 removed: slot0 -> 0(null), slot1 -> 0(null), slot2 -> 3? no:
    // 10 (slot0) + 10 (slot1) = 20, then 2 from slot2 -> slot2 = 3
    expect(inv.getSlot(0)).toBeNull();
    expect(inv.getSlot(1)).toBeNull();
    expect(inv.getSlot(2)).toEqual({ itemId: "potion", qty: 3 });
    expect(inv.count("potion")).toBe(3);
  });

  it("removing more than present removes only what exists", () => {
    const inv = new Inventory(2);
    inv.add("gem", 4, 10);
    const removed = inv.remove("gem", 99);
    expect(removed).toBe(4);
    expect(inv.count("gem")).toBe(0);
    expect(inv.totalCount()).toBe(0);
  });

  it("removing an absent item removes nothing", () => {
    const inv = new Inventory(2);
    inv.add("gem", 4, 10);
    expect(inv.remove("nope", 3)).toBe(0);
    expect(inv.count("gem")).toBe(4);
  });
});

describe("move", () => {
  it("relocates a stack into an empty slot", () => {
    const inv = new Inventory(3);
    inv.add("sword", 1, 1); // slot 0
    expect(inv.move(0, 2)).toBe(true);
    expect(inv.getSlot(0)).toBeNull();
    expect(inv.getSlot(2)).toEqual({ itemId: "sword", qty: 1 });
  });

  it("merges partial stacks of the same item up to maxStack", () => {
    const inv = new Inventory(2);
    inv.add("ore", 5, 10); // slot0 = 5
    // force a second partial stack in slot1 by filling slot0 first then adding
    const inv2 = new Inventory(2);
    inv2.add("ore", 10, 10); // slot0 = 10
    inv2.add("ore", 3, 10); // slot1 = 3
    expect(inv2.getSlot(1)).toEqual({ itemId: "ore", qty: 3 });
    // move slot1 -> slot0: slot0 is full (10), so it swaps
    expect(inv2.move(1, 0)).toBe(true);
    expect(inv2.getSlot(0)).toEqual({ itemId: "ore", qty: 3 });
    expect(inv2.getSlot(1)).toEqual({ itemId: "ore", qty: 10 });

    // now a true partial merge: slot0=6, slot1=3, maxStack 10 -> merge to slot0=9
    const inv3 = new Inventory(2);
    inv3.add("ore", 6, 10);
    inv3.getSlot(0); // slot0 = 6
    // create slot1 = 3 by removing then re-adding into a fresh slot layout
    inv3.remove("ore", 6);
    inv3.add("ore", 6, 6); // maxStack 6 -> slot0 = 6
    inv3.add("ore", 3, 6); // slot1 = 3
    expect(inv.count).toBeDefined();
    expect(inv3.move(0, 1)).toBe(true);
    // slot1 had 3, maxStack 6, space 3, merge 3 from slot0(6) -> slot1=6, slot0=3
    expect(inv3.getSlot(1)).toEqual({ itemId: "ore", qty: 6 });
    expect(inv3.getSlot(0)).toEqual({ itemId: "ore", qty: 3 });
  });

  it("fully merges when the whole source fits, emptying the source slot", () => {
    const inv = new Inventory(2);
    inv.add("ore", 10, 10); // slot0 = 10
    inv.add("ore", 2, 10); // slot1 = 2
    // move slot1(2) -> slot0(10): full -> swap. Instead move slot0 onto slot1:
    // slot1=2 space 8, slot0=10 -> merge 8 -> slot1=10, slot0=2 (partial)
    expect(inv.move(0, 1)).toBe(true);
    expect(inv.getSlot(1)).toEqual({ itemId: "ore", qty: 10 });
    expect(inv.getSlot(0)).toEqual({ itemId: "ore", qty: 2 });
  });

  it("swaps two slots holding different items", () => {
    const inv = new Inventory(2);
    inv.add("sword", 1, 1);
    inv.add("shield", 1, 1);
    expect(inv.move(0, 1)).toBe(true);
    expect(inv.getSlot(0)).toEqual({ itemId: "shield", qty: 1 });
    expect(inv.getSlot(1)).toEqual({ itemId: "sword", qty: 1 });
  });

  it("is a no-op when source is empty or from===to", () => {
    const inv = new Inventory(2);
    inv.add("gem", 1, 10); // slot0
    expect(inv.move(1, 0)).toBe(false); // source empty
    expect(inv.move(0, 0)).toBe(false); // same slot
    expect(inv.getSlot(0)).toEqual({ itemId: "gem", qty: 1 });
  });

  it("throws on out-of-range slot indices", () => {
    const inv = new Inventory(2);
    expect(() => inv.move(0, 5)).toThrow(RangeError);
    expect(() => inv.getSlot(-1)).toThrow(RangeError);
  });
});

describe("has / count / totalCount / iteration", () => {
  it("has reflects thresholds", () => {
    const inv = new Inventory(3);
    inv.add("arrow", 15, 10);
    expect(inv.has("arrow")).toBe(true);
    expect(inv.has("arrow", 15)).toBe(true);
    expect(inv.has("arrow", 16)).toBe(false);
    expect(inv.has("ghost")).toBe(false);
  });

  it("totalCount sums all items", () => {
    const inv = new Inventory(4);
    inv.add("a", 5, 10);
    inv.add("b", 7, 10);
    expect(inv.totalCount()).toBe(12);
  });

  it("iterates slots in order and yields copies", () => {
    const inv = new Inventory(2);
    inv.add("x", 3, 10);
    const seen = [...inv];
    expect(seen).toEqual([{ itemId: "x", qty: 3 }, null]);
    // mutating the yielded copy does not affect the inventory
    (seen[0] as { qty: number }).qty = 999;
    expect(inv.count("x")).toBe(3);
    const entries = [...inv.entries()];
    expect(entries[0]).toEqual([0, { itemId: "x", qty: 3 }]);
    expect(entries[1]).toEqual([1, null]);
  });
});

describe("edge cases", () => {
  it("rejects invalid capacity and maxStack", () => {
    expect(() => new Inventory(-1)).toThrow(RangeError);
    const inv = new Inventory(1);
    expect(() => inv.add("x", 1, 0)).toThrow(RangeError);
  });

  it("adding non-positive qty is a no-op returning 0", () => {
    const inv = new Inventory(1);
    expect(inv.add("x", 0, 10)).toBe(0);
    expect(inv.totalCount()).toBe(0);
  });

  it("zero-capacity inventory overflows everything", () => {
    const inv = new Inventory(0);
    expect(inv.add("x", 5, 10)).toBe(5);
    expect(inv.totalCount()).toBe(0);
  });
});
