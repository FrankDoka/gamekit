// gacha-game client — a UI-heavy, menu-driven front end over the request/response
// HTTP server. This genre is ~70% UI, so the "engine" here is a tiny screen router
// that talks to the server via fetch. No Phaser: menus + a result reveal are honest
// as a DOM overlay. State that matters is authoritative on the server; the client
// only renders what /api/* returns and sends summon intents.
//
// Types come from the SAME pure package the server uses, so the two ends can never
// disagree about the banner/roster/rarity shapes.
import type { Banner, OwnedUnit, Rarity } from "@gacha/summon";

const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:2610";

// --- Wire shapes the server returns (mirrors server/src/index.ts publicState) --
type PublicState = {
  currency: number;
  pityCounter: number;
  hardPity5: number;
  roster: OwnedUnit[];
  pullCostX1: number;
  pullCostX10: number;
};
type PullResultView = { unitId: string; name: string; rarity: Rarity; pity: boolean };

type Screen = "home" | "summon" | "roster";

// --- Client session (mirrors the server session token) -----------------------
const session: {
  token: string;
  banner: Banner | null;
  state: PublicState | null;
  screen: Screen;
  lastResults: PullResultView[];
} = { token: "", banner: null, state: null, screen: "home", lastResults: [] };

// Inspectable global so the app is driveable/inspectable from a smoke harness or
// devtools — same spirit as the action starter's globalThis.__GAME.
(globalThis as { __GACHA?: unknown }).__GACHA = session;

const screenEl = () => document.getElementById("screen")!;
const currencyEl = () => document.getElementById("currency")!;

// Map a unitId to its placeholder art. Art files are named by unitId.
function unitArt(unitId: string): string {
  return `/assets/units/${unitId}.png`;
}
function stars(rarity: Rarity): string {
  return "★".repeat(rarity);
}

// Escape server-provided strings before interpolating them into innerHTML. The
// reference banner/unit names are safe constants, but this is fork-point code:
// the moment a fork sources names from user input, a CMS, or an untrusted server,
// unescaped interpolation is a stored/reflected XSS (and attribute-context XSS in
// alt="..."). Escaping here makes the pattern forks copy safe by default.
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- API calls ---------------------------------------------------------------
async function apiGuest(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`guest login failed: ${res.status}`);
  const data = await res.json();
  session.token = data.token;
  session.banner = data.banner;
  session.state = data.state;
}

async function apiSummon(count: 1 | 10): Promise<PullResultView[]> {
  const res = await fetch(`${API_BASE}/api/summon`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gacha-session": session.token },
    body: JSON.stringify({ count }),
  });
  if (res.status === 402) {
    alert("Not enough currency for this pull.");
    return [];
  }
  if (!res.ok) throw new Error(`summon failed: ${res.status}`);
  const data = await res.json();
  session.state = data.state;
  return data.results as PullResultView[];
}

// --- Rendering ---------------------------------------------------------------
function renderTopbar(): void {
  currencyEl().textContent = `✦ ${session.state?.currency ?? 0}`;
  for (const s of ["home", "summon", "roster"] as Screen[]) {
    const btn = document.getElementById(`nav-${s}`);
    btn?.classList.toggle("active", session.screen === s);
  }
}

function unitCardHtml(
  opts: { unitId: string; name: string; rarity: Rarity; count?: number; pity?: boolean },
): string {
  const r = `r${opts.rarity}`;
  const count = opts.count && opts.count > 1 ? `<div class="count">x${opts.count}</div>` : "";
  const pity = opts.pity ? `<div class="pity-tag">PITY</div>` : "";
  return `
    <div class="unit ${r}">
      ${pity}${count}
      <img src="${esc(unitArt(opts.unitId))}" alt="${esc(opts.name)}" />
      <div class="name">${esc(opts.name)}</div>
      <div class="stars ${r}">${stars(opts.rarity)}</div>
    </div>`;
}

function renderHome(): void {
  const st = session.state!;
  screenEl().innerHTML = `
    <div class="card">
      <h2>Home</h2>
      <p class="muted">Welcome, guest. Spend currency to summon units for the
        <strong>${esc(session.banner?.name ?? "")}</strong> banner.</p>
      <p>Currency: <strong style="color:var(--accent-2)">✦ ${st.currency}</strong></p>
      <p class="pity-bar muted">Pity: ${st.pityCounter} / ${st.hardPity5}
        pulls toward a guaranteed 5★.</p>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="go-summon">Summon</button>
        <button class="btn secondary" id="go-roster">Roster</button>
      </div>
    </div>`;
  document.getElementById("go-summon")!.addEventListener("click", () => show("summon"));
  document.getElementById("go-roster")!.addEventListener("click", () => show("roster"));
}

function renderSummon(): void {
  const st = session.state!;
  const b = session.banner!;
  const resultsHtml = session.lastResults.length
    ? `<h3>Results</h3><div class="grid">${session.lastResults
        .map((r) => unitCardHtml({ ...r }))
        .join("")}</div>`
    : `<p class="muted">Pull to reveal units.</p>`;
  screenEl().innerHTML = `
    <div class="card">
      <h2>Summon — ${esc(b.name)}</h2>
      <img class="banner-art" src="${esc(`/assets/banner/${b.bannerId}.png`)}" alt="${esc(b.name)}" />
      <p class="pity-bar muted">Pity: ${st.pityCounter} / ${st.hardPity5}. Rates:
        5★ ${(b.rates[5] * 100).toFixed(0)}% · 4★ ${(b.rates[4] * 100).toFixed(0)}% ·
        3★ ${(b.rates[3] * 100).toFixed(0)}%.</p>
      <div class="row">
        <button class="btn" id="pull1" ${st.currency < st.pullCostX1 ? "disabled" : ""}>
          Pull x1 (✦ ${st.pullCostX1})</button>
        <button class="btn" id="pull10" ${st.currency < st.pullCostX10 ? "disabled" : ""}>
          Pull x10 (✦ ${st.pullCostX10})</button>
      </div>
      <div id="results" style="margin-top:18px">${resultsHtml}</div>
    </div>`;
  document.getElementById("pull1")!.addEventListener("click", () => doPull(1));
  document.getElementById("pull10")!.addEventListener("click", () => doPull(10));
}

function renderRoster(): void {
  const roster = session.state!.roster;
  const total = roster.reduce((n, u) => n + u.count, 0);
  const grid = roster.length
    ? `<div class="grid">${roster
        .map((u) => unitCardHtml({ ...u }))
        .join("")}</div>`
    : `<p class="muted">No units yet — go summon some!</p>`;
  screenEl().innerHTML = `
    <div class="card">
      <h2>Roster</h2>
      <p class="muted">${roster.length} unique units · ${total} total copies.</p>
      ${grid}
    </div>`;
}

async function doPull(count: 1 | 10): Promise<void> {
  const results = await apiSummon(count);
  if (results.length) session.lastResults = results;
  renderTopbar();
  renderSummon();
}

function show(screen: Screen): void {
  session.screen = screen;
  renderTopbar();
  if (screen === "home") renderHome();
  else if (screen === "summon") renderSummon();
  else renderRoster();
}

// --- Boot on guest login -----------------------------------------------------
function wireNav(): void {
  document.getElementById("nav-home")!.addEventListener("click", () => show("home"));
  document.getElementById("nav-summon")!.addEventListener("click", () => show("summon"));
  document.getElementById("nav-roster")!.addEventListener("click", () => show("roster"));
}

const guestButton = document.getElementById("auth-guest");
const authOverlay = document.getElementById("auth");
const topbar = document.getElementById("topbar");
const screen = document.getElementById("screen");

guestButton?.addEventListener("click", async () => {
  try {
    await apiGuest();
  } catch (err) {
    alert(`Could not start guest session. Is the server running?\n${String(err)}`);
    return;
  }
  if (authOverlay) authOverlay.style.display = "none";
  if (topbar) topbar.style.display = "flex";
  if (screen) screen.style.display = "block";
  wireNav();
  show("home");
});
