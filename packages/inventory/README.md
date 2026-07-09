# @gamekit/inventory

A generic **slot/stack inventory** model. Pure TypeScript, no engine/DOM/framework
dependencies, zero runtime deps, fully deterministic (no I/O, no randomness).
Usable for action loot, gacha roster storage, crafting materials, etc.

## Model

An inventory is a fixed-length array of slots. Each slot is either `null` (empty)
or a stack `{ itemId, qty }`. Each item id has a `maxStack` supplied per-operation,
so one inventory can hold items with different stack limits.

## API

```ts
new Inventory(capacity: number)          // number of slots (>= 0)

inv.add(itemId, qty, maxStack): number   // fills existing stacks, then empty slots;
                                         //   returns overflow that did not fit
inv.remove(itemId, qty): number          // removes across stacks (low index first);
                                         //   returns amount actually removed
inv.count(itemId): number                // total qty of one item
inv.has(itemId, qty = 1): boolean        // at least qty present?
inv.totalCount(): number                 // total qty of all items
inv.move(fromSlot, toSlot): boolean      // relocate / merge / swap (see below)
inv.getSlot(index): Slot                 // copy of one slot (null if empty)
inv.toArray(): Slot[]                    // snapshot copy of all slots
inv.entries(): IterableIterator<[i, Slot]>
for (const slot of inv) { ... }          // iterate slot values (copies)
inv.capacity: number
```

### `move(fromSlot, toSlot)` semantics

- **Empty destination** — the stack is relocated.
- **Same item** — merge up to that item's `maxStack`; any remainder stays in
  `fromSlot` (partial merge). If the destination is already full, the two slots
  are swapped instead.
- **Different items** — the two slots are swapped.
- No-op (returns `false`) when `fromSlot === toSlot` or `fromSlot` is empty.
  Throws `RangeError` on out-of-range indices.

`maxStack` for merges is remembered from the most recent `add` of that item id.

## Usage

```ts
import { Inventory } from "@gamekit/inventory";

const inv = new Inventory(8);

const overflow = inv.add("potion", 25, 10); // -> [10, 10, 5, ...]; overflow 0
inv.count("potion");   // 25
inv.has("potion", 20); // true

inv.remove("potion", 12); // returns 12; drains slot 0 then slot 1

inv.add("herb", 3, 20);
inv.move(2, 3); // relocate/merge/swap depending on the destination
```
