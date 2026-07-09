/**
 * @gamekit/inventory — a generic slot/stack inventory model.
 *
 * Pure TypeScript, no engine/DOM/framework dependencies, zero runtime deps,
 * fully deterministic (no I/O, no randomness). Usable for action loot, gacha
 * roster storage, crafting materials, etc.
 *
 * Model: a fixed-length array of slots, each either `null` (empty) or a stack
 * `{ itemId, qty }`. Each item id has a `maxStack` (supplied per-operation so a
 * single inventory can hold items with different stack limits).
 */

export interface ItemStack {
  itemId: string;
  qty: number;
}

/** A slot is either empty (`null`) or holds a stack. */
export type Slot = ItemStack | null;

export class Inventory {
  private slots: Slot[];
  /** Remembered maxStack per item id, so `move` can merge without a caller hint. */
  private maxStackById: Map<string, number>;

  /** @param capacity number of slots (must be >= 0). */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`capacity must be a non-negative integer, got ${capacity}`);
    }
    this.slots = new Array<Slot>(capacity).fill(null);
    this.maxStackById = new Map();
  }

  /** Total number of slots (filled or empty). */
  get capacity(): number {
    return this.slots.length;
  }

  private clampMaxStack(maxStack: number): number {
    if (!Number.isInteger(maxStack) || maxStack < 1) {
      throw new RangeError(`maxStack must be a positive integer, got ${maxStack}`);
    }
    return maxStack;
  }

  /**
   * Add `qty` of `itemId`, filling existing (non-full) stacks first, then empty
   * slots. Returns the OVERFLOW — the amount that did not fit (0 if all added).
   * `maxStack` is recorded for this item id for later `move` merges.
   */
  add(itemId: string, qty: number, maxStack: number): number {
    const cap = this.clampMaxStack(maxStack);
    this.maxStackById.set(itemId, cap);
    if (qty <= 0) return 0;
    let remaining = qty;

    // 1) Top up existing stacks of this item.
    for (const slot of this.slots) {
      if (remaining <= 0) break;
      if (slot && slot.itemId === itemId && slot.qty < cap) {
        const space = cap - slot.qty;
        const put = Math.min(space, remaining);
        slot.qty += put;
        remaining -= put;
      }
    }

    // 2) Spill into empty slots as new stacks.
    for (let i = 0; i < this.slots.length && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const put = Math.min(cap, remaining);
        this.slots[i] = { itemId, qty: put };
        remaining -= put;
      }
    }

    return remaining;
  }

  /**
   * Remove up to `qty` of `itemId` across stacks (lowest slot index first).
   * Returns the amount actually removed (may be less than `qty`).
   */
  remove(itemId: string, qty: number): number {
    if (qty <= 0) return 0;
    let toRemove = qty;
    let removed = 0;
    for (let i = 0; i < this.slots.length && toRemove > 0; i++) {
      const slot = this.slots[i];
      if (slot && slot.itemId === itemId) {
        const take = Math.min(slot.qty, toRemove);
        slot.qty -= take;
        toRemove -= take;
        removed += take;
        if (slot.qty === 0) this.slots[i] = null;
      }
    }
    return removed;
  }

  /** Total quantity of `itemId` across all slots. */
  count(itemId: string): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot && slot.itemId === itemId) total += slot.qty;
    }
    return total;
  }

  /** Whether at least `qty` of `itemId` is present. */
  has(itemId: string, qty = 1): boolean {
    return this.count(itemId) >= qty;
  }

  /** Total quantity of ALL items across all slots. */
  totalCount(): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot) total += slot.qty;
    }
    return total;
  }

  /** Read-only view of a single slot (a copy, so callers can't mutate internals). */
  getSlot(index: number): Slot {
    this.assertIndex(index);
    const slot = this.slots[index];
    return slot ? { ...slot } : null;
  }

  /** Iterate slots (copies) in order, yielding `[index, slot]`. */
  *entries(): IterableIterator<[number, Slot]> {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      yield [i, slot ? { ...slot } : null];
    }
  }

  /** Iterate slot values (copies) in order. */
  [Symbol.iterator](): IterableIterator<Slot> {
    return this.toArray()[Symbol.iterator]();
  }

  /** Snapshot copy of all slots. */
  toArray(): Slot[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  /**
   * Move the stack in `fromSlot` onto `toSlot`.
   *
   * - Empty destination: the stack is relocated.
   * - Same item id: merge up to that item's maxStack; any remainder stays in
   *   `fromSlot` (partial merge). If it all fits, `fromSlot` becomes empty.
   * - Different item ids (both non-empty): the two slots are SWAPPED.
   *
   * No-op (returns false) when `fromSlot === toSlot` or `fromSlot` is empty.
   * Throws on out-of-range indices.
   */
  move(fromSlot: number, toSlot: number): boolean {
    this.assertIndex(fromSlot);
    this.assertIndex(toSlot);
    if (fromSlot === toSlot) return false;

    const from = this.slots[fromSlot];
    if (from === null) return false;
    const to = this.slots[toSlot];

    if (to === null) {
      this.slots[toSlot] = from;
      this.slots[fromSlot] = null;
      return true;
    }

    if (to.itemId === from.itemId) {
      const cap = this.maxStackById.get(from.itemId) ?? Infinity;
      const space = cap - to.qty;
      if (space <= 0) {
        // Destination full: fall back to a swap.
        this.slots[fromSlot] = to;
        this.slots[toSlot] = from;
        return true;
      }
      const merged = Math.min(space, from.qty);
      to.qty += merged;
      from.qty -= merged;
      if (from.qty === 0) this.slots[fromSlot] = null;
      return true;
    }

    // Different items: swap.
    this.slots[fromSlot] = to;
    this.slots[toSlot] = from;
    return true;
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.slots.length) {
      throw new RangeError(`slot index out of range: ${index} (capacity ${this.slots.length})`);
    }
  }
}
