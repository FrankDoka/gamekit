// The reference banner used by BOTH the server (authoritative pulls) and the
// client (display of the pool). Pure data — lives in the summon package so the
// two ends can never disagree about the drop table. A real game would load many
// banners; the reference ships one.

import type { Banner } from "./index";

export const REFERENCE_BANNER: Banner = {
  bannerId: "banner_dawnlight",
  name: "Dawnlight Beacon",
  // Standard-ish gacha rates: 5★ rare, 4★ uncommon, 3★ the bulk.
  rates: { 3: 0.79, 4: 0.18, 5: 0.03 },
  // Guaranteed 5★ by the 20th pull without one (kept low so the test/demo hits it).
  hardPity5: 20,
  units: [
    // 5★ (the chase units)
    { unitId: "u_sol", name: "Solara", rarity: 5 },
    { unitId: "u_umbra", name: "Umbra", rarity: 5 },
    // 4★
    { unitId: "u_wisp", name: "Wisp", rarity: 4 },
    { unitId: "u_ember", name: "Ember", rarity: 4 },
    { unitId: "u_brook", name: "Brook", rarity: 4 },
    // 3★ (the common pool)
    { unitId: "u_pip", name: "Pip", rarity: 3 },
    { unitId: "u_moss", name: "Moss", rarity: 3 },
    { unitId: "u_clay", name: "Clay", rarity: 3 },
    { unitId: "u_dot", name: "Dot", rarity: 3 },
  ],
};
