# Orrery — UI Implementation Plan (Tier 1: the visible universe)

This plan turns the agreed "every reader is a galaxy" concept into concrete, ordered UI work.
Scope is deliberately frontend-only:

- **Fake auth.** A gate screen that accepts any username/password and stores a session in
  `localStorage`. No backend auth, no tokens, no user tables. The gate exists to make the
  *experience* real; the security is theater and that is fine for now.
- **Single-user backend, untouched.** All data still comes from the existing endpoints
  (`/api/papers`, `/api/tree`, `/api/similarity`, …). "Other galaxies" on the universe map are
  hardcoded fakes. A non-owner login sees an empty galaxy; only `omar` (and observers visiting
  Omar's galaxy) see real data.
- **Everything else is real:** the universe map, the warp, star states, constellation lines,
  the plaque, observer mode, the autopilot tour.

Terminology used below matches the agreed vocabulary: ignited star = read paper, protostar =
to-read paper, constellation = leaf cluster, comet = recently ingested paper, rogue star =
Misc/unclustered paper, galaxy = one user's library, universe = all galaxies.

---

## 0. The cleanliness contract

Omar's one non-negotiable: the space objects must look *really clean*. Cleanliness is enforceable
only if it's numeric, so every phase below is bound by this budget. Any change that violates a
line here is wrong even if it "looks cool":

| Rule | Budget |
|---|---|
| Constellation lines | 1px (world-space, so 1×k on screen), alpha ≤ 0.25, per-leaf MST only — never all-pairs |
| Cluster hues | Existing 4-color `PALETTE` only; no new hues. Rogue stars use desaturated gray `#8b94a8` |
| Nebula auras | Keep existing radial auras; alpha stays ≤ 0.055 (L1) / 0.032 (L2) — do not increase |
| Star cores | Ignited: solid core, radius ≤ 2.5px world. Protostar: hollow 1px ring, no solid core |
| Halos | One radial gradient per star, no stacked glows. Ignited alpha ≤ 0.30, protostar ≤ 0.12 |
| Twinkle | Background starfield only (already exists). Paper-stars do NOT twinkle — they idle-drift only |
| Comet trails | One line per comet, ≤ 26px world length, alpha ≤ 0.35, fades to 0 over 7 days |
| Text on canvas | Existing LOD ramps only (`titleFade` k≥1.8, `metaFade` k≥3.0). Constellation labels ≤ 11px equivalent, alpha ≤ 0.4 |
| Animation counts | ≤ 1 shooting star on screen at a time (already true); warp ≤ 900ms; tour dwell ≥ 3s per stop |
| New DOM chrome | Reuse the existing `glass` panel style. No new panel styles, no new fonts |

The testing section (§10) turns each of these into a checkable item.

---

## 1. Current state (what we build on)

Verified in code, so the plan is grounded:

- [frontend/src/components/PaperGraph.tsx](frontend/src/components/PaperGraph.tsx) — canvas
  renderer with: pan/zoom `ViewTransform` (`viewRef`), 600ms eased camera glides
  (`glideToClusterPath`, exposed as `focusCluster(path | null)` on the imperative handle),
  3-layer parallax starfield with twinkle, ambient shooting stars, depth-graded all-pairs
  edges (`edgesRef`, to be replaced), similarity edges on hover, LOD title/meta labels,
  cluster auras + ghost labels, **meteors for uploads** (`spawnMeteor` → drift → `arrive(clusterPath)`
  → landing ripple) and citation pulses.
- [frontend/src/App.tsx](frontend/src/App.tsx) — single-scene app. Desktop: full-bleed graph +
  floating glass panels (sidebar, `AgentPortal` omnibar, `ReadNext`, `HoverBar`, `ClusterLegend`,
  PDF reader overlay). Mobile: 3-tab shell. Header brand string: `"The Library"`.
- [frontend/src/api/client.ts](frontend/src/api/client.ts) — `PaperRecord` already carries
  `status: "read" | "toread"`, `cluster_path`, `ingested_at`, `summary`. Everything the star
  states need is already in the payload. **No API changes required.**
- No router installed. We will NOT add one — a scene state machine in `App.tsx` is smaller,
  easier to animate between, and easier to test.
- No test infra exists in the frontend. §10 adds Vitest.

---

## 2. Architecture overview

### 2.1 Scene machine (no router)

```
                 ┌────────────┐   "Visit as observer"  ┌──────┐
  first load ──▶ │  universe  │ ──────────────────────▶│ warp │──▶ ┌────────┐
                 │   (map)    │   or login via Gate     └──────┘    │ galaxy │
                 └────────────┘ ◀───────────────────────────────── └────────┘
                       ▲                "Exit to universe" (reverse warp)
                       │
                 Gate modal (fake login / sign-up) floats OVER the universe scene
```

```ts
// App.tsx — new top-level state
type GalaxyId = string; // "omar" | any fake/visitor username

type Scene =
  | { name: "universe" }
  | { name: "warp"; to: GalaxyId; reverse?: boolean }
  | { name: "galaxy"; galaxy: GalaxyId };
```

- The **current App desktop/mobile layout moves wholesale into a `GalaxyScene` component**
  (mechanical extraction, no behavior change). `App.tsx` becomes a thin scene switcher.
- `mode` is derived, never stored:

```ts
type GalaxyMode = "owner" | "observer";
const mode: GalaxyMode =
  session?.isOwner && scene.galaxy === OWNER_USERNAME ? "owner" : "observer";
```

- Dev ergonomics: persist the last scene in `sessionStorage` (`orrery.scene`) and restore it on
  load, so Vite hot-reloads don't replay the warp every save. A `?reset` query param clears it.

### 2.2 New files

```
frontend/src/
  auth/session.ts            fake session store (login/logout/getSession)
  scenes/UniverseScene.tsx   universe map (landing page)
  scenes/WarpOverlay.tsx     star-streak transition canvas
  scenes/GalaxyScene.tsx     extracted current App layout + mode gating
  components/Gate.tsx        fake login/sign-up modal
  components/GalaxyPlaque.tsx observer stats card
  components/StarCard.tsx    selected-paper glass card (evolves HoverBar)
  components/TourController.tsx  autopilot tour engine + caption chrome
  lib/galaxy.ts              pure helpers: stats, comet age, fake galaxy list
  lib/constellation.ts       pure helper: per-leaf MST edge builder
```

Pure logic goes in `lib/` so it is unit-testable without a canvas.

---

## 3. Phase 1 — Session + Gate (fake auth)

### 3.1 `auth/session.ts`

```ts
export const OWNER_USERNAME = "omar";
const KEY = "orrery.session";

export interface Session {
  username: string;
  isOwner: boolean;
  createdAt: string;
}

export function login(username: string, _password: string): Session {
  // Fake auth: any non-empty username/password pair is accepted.
  const u = username.trim().toLowerCase();
  const session: Session = {
    username: u,
    isOwner: u === OWNER_USERNAME,
    createdAt: new Date().toISOString(),
  };
  localStorage.setItem(KEY, JSON.stringify(session));
  return session;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function logout(): void {
  localStorage.removeItem(KEY);
}
```

### 3.2 `components/Gate.tsx`

A glass modal over the universe scene (NOT a separate page — the stars stay visible behind it,
which is the whole point). Two entry variants driven by a prop:

- `variant="login"` — heading "Return to your galaxy", fields username + password, submit
  button "Warp home".
- `variant="signup"` — heading "Ignite a new universe", same fields, submit button "Ignite".

Both call `login()` (fake auth accepts anything), close the modal, and fire
`onEnter(session.username)` which the App turns into `{ name: "warp", to: username }`.

Validation: only that both fields are non-empty. Error copy: "Every traveler needs a name."
Keep the form to ~60 lines; reuse the sidebar's input styling (`border-rim bg-bg/60` pattern
from `SidebarBody`'s search box).

Small print at the bottom of the modal, muted, honest:
`"Auth is in preview — any credentials work for now."` — this protects the resume demo from
looking accidentally broken when a recruiter types garbage and gets in.

### 3.3 Acceptance

- Any non-empty user/pass → session persisted → warp fires.
- `omar` / anything → `isOwner: true`. Anything else → `isOwner: false`.
- Refresh keeps you in your galaxy (session + scene restore).
- Logout ("Leave galaxy" in the sidebar header) → reverse warp → universe map, session cleared.

---

## 4. Phase 2 — UniverseScene (the landing page)

Full-viewport dark scene. Layers:

1. **Starfield canvas** — extract the existing starfield drawing from `PaperGraph` into a tiny
   reusable component `components/StarfieldCanvas.tsx` (the `mkLayer`/`drawStars`/shooting-star
   code, ~90 lines, minus pan parallax). Both `PaperGraph` and `UniverseScene` render it. Do
   this as a pure extraction — same visuals, one source of truth.
2. **Galaxy glyphs** — DOM, not canvas (hover/focus/a11y for free). A glyph is 2–3 concentric
   `border-radius: 50%` rings + a core dot + 4–5 hue dots sampled from the owner's L1 palette —
   exactly the agreed mock. Omar's glyph is ~150px, fakes are ~60px at 70% opacity.

```ts
// lib/galaxy.ts
export interface GalaxyGlyph {
  username: string;
  displayName: string;   // "Omar's galaxy"
  stars: number;
  ignited: number;
  constellations: number;
  isOpen: boolean;       // open to visitors
  isFake: boolean;
}

export const FAKE_GALAXIES: GalaxyGlyph[] = [
  { username: "m.chen",  displayName: "m. chen's galaxy", stars: 34, ignited: 12,
    constellations: 5, isOpen: false, isFake: true },
  { username: "vega-7",  displayName: "vega-7's galaxy",  stars: 61, ignited: 40,
    constellations: 8, isOpen: false, isFake: true },
];

export function computeGalaxyStats(papers: PaperRecord[]): {
  stars: number; ignited: number; constellations: number; latestCometAt: string | null;
} {
  const leafPaths = new Set(papers.map(p => p.cluster_path ?? "Unclustered"));
  const ingested = papers.map(p => p.ingested_at).filter(Boolean).sort();
  return {
    stars: papers.length,
    ignited: papers.filter(p => p.status === "read").length,
    constellations: leafPaths.size,
    latestCometAt: ingested.at(-1) ?? null,
  };
}
```

- On mount, `UniverseScene` calls `listPapers()` once to fill Omar's real stats (`142 stars ·
  89 ignited · 12 constellations` style line). If the fetch fails, show the glyph with
  "signal lost" instead of numbers — never a blank crash on the landing page.
- Omar's glyph: label, stats line, `open to visitors` pill, **"Visit as observer"** button →
  warp to `omar` with no session required.
- Fake glyphs: lock icon + "private". Clicking one wiggles it (200ms translate shake) and
  shows a toast: "This galaxy is sealed." They exist to make the universe feel inhabited.
- Bottom-center: "Return to your galaxy" (opens Gate login) and "Ignite a new universe"
  (opens Gate signup). Top-left wordmark: `orrery`, lowercase, tracking-widest, muted.
- If a session already exists, add a third quiet button: "Continue as {username}".

Mobile note: below `lg`, the universe map renders as a simple stacked list of galaxy cards
(same data, no absolute positioning). The warp overlay is skipped on mobile. Do not sink time
into mobile theatrics — the resume demo is desktop.

### Acceptance

- Landing on `/` with no session shows the universe map with real Omar stats within one fetch.
- "Visit as observer" reaches Omar's galaxy with **zero** auth interaction — count the clicks: 1.

---

## 5. Phase 3 — WarpOverlay

A fullscreen fixed canvas that plays over the scene switch. Timeline (total ≤ 900ms):

```
0ms      universe scene still visible; overlay fades in (black, 120ms)
120ms    star streaks: ~90 lines radiating from center, length/velocity ease-in (accelerate)
650ms    streaks peak; underlying scene swaps universe → galaxy behind the overlay
650–900  overlay fades out revealing GalaxyScene, whose camera starts at k=0.55 and
         glides to k=1 via the EXISTING cameraAnimRef mechanism (arrival dolly)
```

```ts
// scenes/WarpOverlay.tsx — core draw, ~50 lines
interface Streak { angle: number; dist0: number; speed: number; len: number }
// 90 streaks, angle random, dist0 20..120px from center, speed eases in with t²
// draw: line from polar(dist) to polar(dist + len * t), stroke rgba(220,230,255, a)
// a ramps 0→0.8→0 with the overall fade envelope
```

Implementation notes:

- The overlay owns its own rAF loop and calls `onDone()` once; App swaps `scene` at the 650ms
  mark via a `onSwap()` callback so the reveal shows the destination already rendered.
- `reverse: true` (exit to universe) plays the same animation — it reads fine in both
  directions; don't build a second variant.
- Arrival dolly: add an optional `initialView` prop to `PaperGraph`
  (`{ k: 0.55 }` → on first build, set `viewRef` to a zoomed-out framing and immediately
  enqueue `cameraAnimRef` toward `{k:1, tx:0, ty:0}` with duration 600ms). ~10 lines inside
  `buildGraph`/mount effect.
- Respect `prefers-reduced-motion`: skip the overlay entirely, hard-cut scenes.

### Acceptance

- Universe → galaxy feels like one continuous camera move (overlay covers the swap; no white
  flash, no layout pop).
- Warp never exceeds 900ms and cannot be triggered twice concurrently (guard on scene name).

---

## 6. Phase 4 — Star states in PaperGraph (the core visual change)

All changes are inside the node-draw loop (currently lines ~756–838) plus small helpers.
Current rendering draws every node identically: glow + translucent fill + ring + core dot.
Replace with status-driven rendering:

```ts
// inside the node loop, after computing renderX/renderY
const isRead  = n.paper.status === "read";
const isRogue = n.l1 === "Misc" || n.l1 === "Unclustered";
const col     = isRogue ? ROGUE_COLOR : PALETTE[n.colorIdx % PALETTE.length];

if (isRead) {
  // ── Ignited star: single halo + solid warm-white core ──
  const glowR = r * (isHov ? 5.5 : 3.5);
  const grd = ctx.createRadialGradient(renderX, renderY, r * 0.1, renderX, renderY, glowR);
  grd.addColorStop(0, col.glow + ((isHov ? 0.5 : 0.3) * nodeDim).toFixed(3) + ")");
  grd.addColorStop(1, "transparent");
  ctx.beginPath(); ctx.arc(renderX, renderY, glowR, 0, Math.PI * 2);
  ctx.fillStyle = grd; ctx.fill();

  ctx.beginPath(); ctx.arc(renderX, renderY, isHov ? 3.2 : 2.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(240,246,255,${(0.95 * nodeDim).toFixed(3)})`;
  ctx.fill();
} else {
  // ── Protostar: hollow ring in the cluster hue, faint halo, no core ──
  const glowR = r * 2.2;
  const grd = ctx.createRadialGradient(renderX, renderY, r * 0.1, renderX, renderY, glowR);
  grd.addColorStop(0, col.glow + ((isHov ? 0.22 : 0.10) * nodeDim).toFixed(3) + ")");
  grd.addColorStop(1, "transparent");
  ctx.beginPath(); ctx.arc(renderX, renderY, glowR, 0, Math.PI * 2);
  ctx.fillStyle = grd; ctx.fill();

  ctx.beginPath(); ctx.arc(renderX, renderY, isHov ? 4.5 : 3.5, 0, Math.PI * 2);
  ctx.strokeStyle = col.stroke + (isHov ? "dd" : "88");
  ctx.lineWidth = 1;
  ctx.stroke();
}
```

Notes:

- The old translucent fill + colored ring + colored core dot are **removed** — that's three
  concentric shapes per node and is exactly the busyness the cleanliness contract kills.
- `ROGUE_COLOR = { stroke: "#8b94a8", glow: "rgba(139,148,168,", dot: "rgba(139,148,168,0.8)" }`.
  Rogue stars additionally get `nodeDim * 0.7` and are **excluded from constellation edges**
  (§7) — they drift untethered, which is the entire point of them.
- Hover ring: keep a subtle enlarged treatment (values above) — hover feedback must survive.

### 6.1 Ignition flare (status toggle)

When `status` flips toread→read, play a one-shot flare at the node. Mechanism mirrors the
existing landing ripple (meteor `landed` branch, lines ~884–902):

```ts
// new ref: ignitionsRef = useRef<{ x: number; y: number; start: number }[]>([]);
// new imperative method:
igniteStar(paperId: string) {
  const n = nodesRef.current.find(n => n.id === paperId);
  if (n) ignitionsRef.current.push({ x: n.x, y: n.y, start: performance.now() });
}
// draw loop: 500ms — expanding 1px ring (4→34px, easeOutCubic) + brief core overshoot
```

`App.toggleStatus` already updates state optimistically; add
`if (newStatus === "read") graphRef.current?.igniteStar(paper.id)` there. (De-igniting to
to-read gets no animation — stars go out quietly.)

### 6.2 Comet trails (recency)

Papers ingested within the last 7 days get a short trail:

```ts
// lib/galaxy.ts
export function cometStrength(ingestedAt: string | null, now = Date.now()): number {
  if (!ingestedAt) return 0;
  const days = (now - Date.parse(ingestedAt)) / 86_400_000;
  return days < 0 || days > 7 ? 0 : 1 - days / 7;   // 1 fresh → 0 at 7 days
}
```

Draw (inside node loop, before the star itself): a single line from the node toward
upper-right at a fixed angle (−35°), length `26 * strength`, `strokeStyle`
`rgba(235,242,255, 0.35 * strength)`, 1px. Fixed shared angle is deliberate — parallel comet
tails read as a coherent weather system; random angles read as noise. Compute `strength`
once per node per build (not per frame): stash it on `GNode` as `comet: number` in `buildGraph`.

### Acceptance

- In a screenshot at k=1, read vs to-read status is decodable **without any labels or legend**.
- Node draw calls per star: ignited = 2 shapes, protostar = 2 shapes (was 4). Verify by reading
  the loop, not by trusting this doc.
- Toggling a paper to read in the HoverBar/StarCard fires a visible flare at the correct node.

---

## 7. Phase 5 — Constellation lines (replace the all-pairs hairball)

Current `edgesRef` holds **all pairs** of nodes sharing any cluster prefix — O(n²) edges drawn
at near-invisible alpha. Replace with a per-leaf-cluster minimum spanning tree: each
constellation becomes a clean, acyclic line figure, which is both the look we want and an
O(n²)→O(n) render win.

```ts
// lib/constellation.ts
export interface Pt { id: string; x: number; y: number; leaf: string }

/** Prim's MST per leaf group. Returns index pairs into the input array. */
export function buildConstellationEdges(pts: Pt[]): [number, number][] {
  const byLeaf = new Map<string, number[]>();
  pts.forEach((p, i) => {
    if (p.leaf === "Misc" || p.leaf === "Unclustered") return; // rogues stay untethered
    (byLeaf.get(p.leaf) ?? byLeaf.set(p.leaf, []).get(p.leaf)!).push(i);
  });
  const edges: [number, number][] = [];
  for (const members of byLeaf.values()) {
    if (members.length < 2) continue;
    const inTree = new Set<number>([members[0]]);
    while (inTree.size < members.length) {
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const a of inTree) for (const b of members) {
        if (inTree.has(b)) continue;
        const d = (pts[a].x - pts[b].x) ** 2 + (pts[a].y - pts[b].y) ** 2;
        if (d < bestD) { bestD = d; best = [a, b]; }
      }
      edges.push(best!);
      inTree.add(best![1]);
    }
  }
  return edges;
}
```

Integration in `PaperGraph`:

- Delete the all-pairs edge build in `buildGraph` (lines ~352–362) and the depth-graded edge
  draw block (lines ~690–709). `EDGE_MAX_ALPHA`, `edgeMaxAlpha`, and the `Edge` depth field go
  with them. (`sharedPathDepth` stays — physics still uses cluster paths via centers.)
- New ref `constellationEdgesRef = useRef<[number, number][]>([])`, computed **once at settle**
  (positions are meaningless before the physics rests):

```ts
// in the loop, right after tickRef.current++ :
if (tickRef.current === SETTLE_AT) {
  constellationEdgesRef.current = buildConstellationEdges(
    nodes.map(n => ({ id: n.id, x: n.x, y: n.y,
                      leaf: n.paper.cluster_path ?? "Unclustered" })));
}
```

- Draw (replacing the old edge block): 1px, cluster hue, alpha 0.22, with the existing
  `dimFactor` applied during similarity-hover. Lines connect the *idle-drifted* render
  positions — recompute endpoints from the same wobble math the nodes use (extract the wobble
  into `driftOffset(id, idleT)` so nodes and edges share it and lines stay pinned to stars).
- Constellation name labels: the existing ghost-label block already does this for L1. Add leaf
  labels — 11px, cluster hue at alpha `0.4 * labelFade`, positioned at the leaf's center,
  only when `view.k` is in the mid range (reuse `triangleFade(view.k, 0.6, 1.2, 2.6)`).
  Cap: only label leaves with ≥ 3 members to avoid confetti.

### Acceptance

- Edge count equals `Σ(members−1)` per leaf — assert in a unit test (§10.1).
- Hovering still shows the white similarity edges exactly as today (untouched code path).
- Visual: each cluster reads as a *figure* (tree of lines), not a mesh blob.

---

## 8. Phase 6 — Galaxy chrome: plaque, star card, observer mode, empty galaxy

### 8.1 GalaxyPlaque

Glass card, top-left of the graph (below the collapsed-sidebar toggle in observer mode where
the sidebar is hidden — see 8.3). Content from `computeGalaxyStats(papers)`:

```
Omar's galaxy
142 stars · 89 ignited · 12 constellations
◔ observer mode · read-only        ← only when mode === "observer"
```

Fades in 400ms after the warp completes (arrival choreography: galaxy first, numbers second).
In owner mode it shows without the observer line and sits under the existing sidebar (or:
merge the stats line into `SidebarBody`'s footer, replacing the current read/to-read counts —
prefer this to avoid two competing cards; keep the standalone plaque for observer mode only).

### 8.2 StarCard (evolves HoverBar)

Interaction model (per the approved mock):

- **Hover** star → StarCard appears, right side, `absolute right-5 top-24`, glass, ~230px:
  title, author · year, constellation pill (cluster hue), status line
  ("ignited · read" / "protostar · to-read"), 2-line `summary`, buttons **Open PDF** and
  **Ask Oracle**. This replaces `HoverBar` on desktop — delete `HoverBar` usage there.
- **Click** star → pins the card (hover-away no longer hides it) AND, as today, a second
  affordance: the card's "Open PDF" opens the reader. Direct click-to-open changes to
  click-to-pin; opening the reader from the card is one more click but makes observer mode
  far less jumpy. (Mobile keeps the old HoverBar — smaller surface, no hover.)
- "Ask Oracle" pre-fills the AgentPortal omnibar with `About "{title}": ` and focuses it —
  wire via a new optional prop on `AgentPortal` (`prefill?: string` + focus signal).
- In observer mode the status-toggle button in the card is hidden (not disabled — hidden).

### 8.3 Observer mode gating (`GalaxyScene`)

`mode` prop threads down. When `"observer"`:

- Hidden: upload affordances (drop-zone + omnibar upload), reindex button, status toggles
  (StarCard + TreeView rows), `ReadNext` panel (it's a personal queue — meaningless to guests).
- Shown: plaque (with observer line), tour button, search, tree (read-only), StarCard,
  PDF reader, Oracle chat (it answers from the indexed corpus — the single best flex).
- Sidebar header: brand becomes `orrery` (replacing "The Library" in `SidebarHeader`), and
  gains "Exit to universe" (replaces logout for observers; owners get both "Leave galaxy"
  (logout) and "Exit to universe" (keep session, go to map)).
- Enforcement is client-side only. Note it in code once:
  `// Observer gating is cosmetic until real auth lands — the API remains open.`

### 8.4 Empty galaxy (non-owner session in their own galaxy)

A non-owner login lands in `{ name: "galaxy", galaxy: session.username }` where `papers = []`
(skip the fetch entirely when `galaxy !== OWNER_USERNAME`). Replace `GraphEmptyState` copy for
this case:

```
Your galaxy is dark.
Ignite your first star — uploads open soon for new universes.
[ Visit Omar's galaxy → ]     ← warps them to the real content
```

The starfield + auroras still render, so "dark galaxy" is atmospheric, not broken-looking.
No upload affordance for non-owners (backend is single-user; don't fake what would corrupt
real data).

### Acceptance

- Observer sees no mutating control anywhere (checklist: upload, reindex, status toggle ×2 places).
- Owner flow is pixel-identical to today except: brand string, StarCard replacing HoverBar,
  plaque stats in the sidebar footer.
- New-user flow: sign up as `nova` → dark galaxy with the two-line empty state → the CTA warps
  to Omar's galaxy in observer mode.

---

## 9. Phase 7 — Autopilot tour

### 9.1 Engine

Pure sequencing around the existing `focusCluster` — no new camera code:

```ts
// components/TourController.tsx
interface TourStop { path: string; label: string; count: number }

export function buildTourStops(papers: PaperRecord[], max = 5): TourStop[] {
  const counts = new Map<string, number>();
  for (const p of papers) {
    const l1 = p.cluster_path?.split("/")[0];
    if (l1 && l1 !== "Misc") counts.set(l1, (counts.get(l1) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([path, count]) => ({ path, label: path, count }));
}
```

State machine: `idle → flying(stop i) → dwelling(stop i) → … → returning → idle`.

- `flying`: call `graphRef.focusCluster(stop.path)`; the existing 600ms glide runs.
- `dwelling`: 3500ms timer. Caption chrome shows.
- After the last stop: `focusCluster(null)` (zoom-to-fit — already supported), then `idle`.
- **Abort on any user intent**: wheel, mousedown on canvas, or Escape → `focusCluster(null)`
  is NOT called (leave the camera where the user grabbed it), timers cleared, chrome fades.
  Wire by having `GalaxyScene` listen during an active tour and call `tour.stop()`.

### 9.2 Chrome

- Bottom-center pill during the tour: `constellation 2 of 5 · diffusion models · 23 stars`
  plus a thin progress bar segment per stop and a `skip` label ("esc or scroll to explore").
- Start affordances: a "Take the tour" glass button bottom-center of the galaxy
  (both modes; hide while the omnibar sheet or reader is open). For observers arriving via
  warp, auto-suggest: pulse the button once ~2s after arrival. **Do not auto-start** — hijacked
  cameras feel broken; an invitation feels intentional.
- During the tour, temporarily boost the focused cluster's leaf-label alpha (pass a
  `highlightPath` prop into `PaperGraph`, mirroring the existing `focusPath` sidebar pattern).

### Acceptance

- Tour visits ≤ 5 stops, ~4.1s each (0.6 fly + 3.5 dwell) → full tour ≈ 20–25s. The "recruiter
  30 seconds" budget from the concept holds.
- Any scroll/click/Escape kills it instantly (< 1 frame of fighting the user's input).
- Tour with 1 cluster or 0 papers: button hidden.

---

## 10. Testing — making sure the vision actually ships

Three layers: unit tests for every pure decision, component tests for gating/flows, and a
scripted visual QA protocol for the things only eyes can judge. The canvas is deliberately
kept out of unit tests — extracting logic into `lib/` is what makes that honest.

### 10.1 Unit tests (Vitest — new dev deps: `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`)

Add `"test": "vitest run"` to package.json; config in `vite.config.ts` (`test: { environment: "jsdom" }`).

| Module | Cases |
|---|---|
| `auth/session` | accepts any non-empty creds; `omar` → `isOwner`; case/whitespace normalization (`"  Omar "` → owner); round-trips through localStorage; corrupt JSON in storage → `null`, not a throw |
| `lib/constellation` | MST edge count = `members − 1` per leaf; rogues (`Misc`, `Unclustered`) produce zero edges; single-member leaf → zero edges; deterministic for identical input; two leaves never share an edge |
| `lib/galaxy` `computeGalaxyStats` | counts stars/ignited/constellations; `latestCometAt` picks max; empty list → zeros + null |
| `lib/galaxy` `cometStrength` | fresh = ~1; 3.5 days = ~0.5; > 7 days = 0; null / future / garbage timestamp = 0 |
| `buildTourStops` | sorts by member count desc; excludes `Misc`; caps at 5; ties stable |
| `WarpOverlay` timing helpers (if extracted) | envelope alpha is 0 at t=0 and t=1, peaks mid |

### 10.2 Component tests (Testing Library, jsdom — mock `api/client`)

**Note:** `PaperGraph` renders `<canvas>`; jsdom has no 2D context. In `GalaxyScene` tests,
mock `PaperGraph` with a stub that records props (`vi.mock`). We are testing *gating and
flow*, not pixels.

1. **Gate:** submit with empty username → error, no session. Submit `nova`/`x` → `onEnter("nova")`
   fired, session stored, `isOwner === false`.
2. **Scene flow:** App renders universe scene by default; "Visit as observer" → warp → galaxy
   with `mode="observer"` (assert via stubbed scene props); `sessionStorage` restore skips
   straight to galaxy on remount.
3. **Observer gating:** with `mode="observer"`, assert **absence** of: upload dropzone, reindex
   button, status toggle in StarCard, status toggle in TreeView, ReadNext. Assert presence of:
   plaque with "observer mode", tour button, search input.
4. **Owner gating:** with owner session in `omar` galaxy, all of the above present again.
5. **Empty galaxy:** session `nova` → papers fetch NOT called, "Your galaxy is dark" rendered,
   CTA fires warp to `omar`.
6. **StarCard:** renders title/author/pill/status from a `PaperRecord`; observer variant hides
   toggle; "Ask Oracle" calls the prefill callback with the title.
7. **TourController:** fake timers — `start()` calls `focusCluster` with the top cluster,
   advances through stops on timer, `stop()` mid-dwell clears pending timers (no further
   `focusCluster` calls after stop — this is the regression that *will* happen otherwise).
8. **Ignition wiring:** toggling status to read calls `graphRef.igniteStar(paperId)` (stub ref).

### 10.3 Visual QA protocol (the vision checklist)

Automated tests cannot judge "clean." This is a scripted human pass — run it after Phase 4/5
land, after Phase 7, and once before calling Tier 1 done. Use a seeded state: the real library,
`?reset`, desktop 1440×900, dark room brightness.

**A. Screenshot ladder.** Capture at k≈0.5 (post-warp wide), k=1 (default), k≈2 (titles on),
k≈3.5 (meta on). For each, check against the cleanliness contract (§0):

- [ ] A1 — At k=1, read vs to-read is decodable in ≤ 3 seconds by someone who has never seen
      the app (test on one human who isn't you).
- [ ] A2 — No star renders more than 2 shapes (halo + core, or halo + ring). No double glows.
- [ ] A3 — Constellation lines form trees (no triangles/cycles — cycles mean the MST is buggy).
- [ ] A4 — Zoomed out (k=0.5), the galaxy reads as *shape* (arms/groups), not uniform soup.
- [ ] A5 — Rogue stars are visibly gray, unconnected, and near the rim.
- [ ] A6 — Comet trails all point the same direction; count of trails = papers ingested < 7 days.
- [ ] A7 — Nothing on the paper-star layer twinkles; only the background starfield does.
- [ ] A8 — At k=3.5, labels don't collide into mush for the densest cluster (worst-case check).

**B. Motion pass** (screen-record 30s, watch it back at 0.5×):

- [ ] B1 — Warp: no flash, no pop, destination already alive when revealed; total ≤ 900ms.
- [ ] B2 — Ignition flare: visible, single, ≤ 500ms, at the right star, no residue.
- [ ] B3 — Upload meteor (existing) still lands correctly with constellation edges present
      (regression: the new settle-time MST must rebuild after `load()` refreshes papers —
      new paper = new `buildGraph` = new MST; verify the landed star gets a line).
- [ ] B4 — Tour: camera never fights user input; captions match the cluster on screen.
- [ ] B5 — Idle for 60s: shooting stars stay occasional (≥ 2s apart), drift stays subtle.

**C. The recruiter script** (end-to-end, stopwatch, incognito window so no session):

1. Open the app fresh → universe map with real stats — **target < 2s to interactive**.
2. Click "Visit as observer" → warp → arrival dolly → plaque fades in. One click total.
3. Wait for tour-button pulse → "Take the tour" → watch all 5 stops (~25s), captions correct.
4. Scroll mid-tour → tour dies instantly, camera obeys.
5. Hover 3 stars across clusters → StarCard correct each time; click one → pinned → Open PDF
   → reader works → close.
6. Ask Oracle a question about a visible paper → streamed answer, citation pulse fires.
7. Attempt to find ANY mutating control as an observer → there must be none (fail = ship-blocker).
8. Exit to universe → reverse warp → click "Return to your galaxy" → log in as `omar` →
   owner chrome intact (upload, reindex, toggles all back).
9. Sign up as a new name → dark galaxy empty state → CTA back to Omar's.

Total happy path ≤ 90 seconds. If any step needs explanation to a bystander, that step fails.

**D. Performance budget** (Chrome DevTools performance panel, current library size and a
synthetic 3× dataset via a temporary `papers = [...p, ...p, ...p]` hack in `load()`):

- [ ] D1 — Steady-state ≥ 55 fps at k=1 with the sidebar open (M-series baseline).
- [ ] D2 — Edge draw count printed once at settle in dev (`console.debug`) equals the §7 formula.
      The MST change should *reduce* frame cost vs. today — verify, don't assume.
- [ ] D3 — Warp overlay while galaxy builds behind it: no long task > 120ms during the swap.
- [ ] D4 — No per-frame allocations in the node loop introduced by star states (spot-check
      with the allocation profiler; `createRadialGradient` per star per frame is pre-existing,
      but do not add more — comet strength and drift offsets must be precomputed/cheap).

### 10.4 Regression inventory (what must NOT change)

Upload meteor lifecycle, citation pulses, similarity hover edges + % labels, cluster-aura
click-to-glide, `0` key reset, double-click reset, sidebar tree search + focus flash, reindex
stream UI, PDF reader, mobile 3-tab shell (with old HoverBar). Run each once per phase merge —
they share the render loop we are editing, and the render loop has no tests.

---

## 11. Build order, sizing, and phase gates

| # | Phase | Size | Depends on | Gate to merge |
|---|---|---|---|---|
| 1 | Session + Gate | S | — | §3 acceptance + unit tests 10.1 (session) |
| 2 | Scene machine + GalaxyScene extraction | M | 1 | Owner flow pixel-identical; component tests 10.2 (2) |
| 3 | UniverseScene (+ StarfieldCanvas extraction) | M | 2 | §4 acceptance; landing < 2s |
| 4 | WarpOverlay + arrival dolly | S/M | 3 | B1; reduced-motion path |
| 5 | Star states + ignition + comets | M | 2 | A1/A2/A5/A6/A7 + 10.1 (galaxy) |
| 6 | Constellation MST + leaf labels | M | 5 | A3/A4 + D2 + 10.1 (constellation) |
| 7 | Plaque + StarCard + observer gating + empty galaxy | M/L | 2 | 10.2 (3–6) + C7 |
| 8 | Autopilot tour | M | 6,7 | B4 + 10.2 (7) + C3/C4 |
| 9 | Full visual QA + recruiter script + perf | S | all | §10.3 complete, D1–D4 pass |

Phases 5+6 are the heart ("really really really clean") — budget the most iteration time
there, and expect to tune alphas/radii live against the real library, not in the abstract.
Everything in this plan except those two phases is mechanical.

## 12. Explicit non-goals (Tier 2/3 — do not build now)

- Real authentication, passkeys, GitHub OAuth, sessions on the backend.
- Any backend change at all: no `owner_id`, no per-user Chroma collections, no public
  `/api/u/{handle}/*` endpoints, no `is_public` flag.
- Real multi-galaxy data, shared-star rings, cross-galaxy paper capture.
- Uploads/persistence for non-owner users.
- Mobile universe/warp polish beyond the stacked-card fallback.

When Tier 2 lands, `auth/session.ts` is the only file whose *interface* changes (real login
call); the scene machine, gating via `mode`, and all visuals carry over unchanged. That
boundary is deliberate — keep it.
