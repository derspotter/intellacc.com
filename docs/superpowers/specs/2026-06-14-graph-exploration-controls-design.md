# Social Graph Exploration Controls (#network) — Design

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan

**Part 1 of 3** of the social-graph UX work (this = graph controls; later =
follower/following list pages; later = repost surfacing). Each ships
independently.

## Goal

Turn the `#network` 3D follow-graph from a render-everything blob into a usable
exploration tool, with the DT-inspired control layer it currently lacks:
filter, search, reset, and live stats. All client-side (small scale).

## Current state

`NetworkPage.jsx` fetches the whole graph once (`api.network.getGraph()` →
`{nodes, edges}`, backend-capped at 2000 nodes / 20000 edges) and renders every
node via the three.js `SocialGraph3D` component. It has click-to-inspect (side
panel with username, followers, accuracy, View profile, Follow/Unfollow) and a
bare `N users · M follows` stat — but **no filters, no search, no reset**.

`SocialGraph3D.jsx` builds its three.js scene once `onMount` from `nodes`/`edges`
props; it does not currently react to prop changes.

## Approach

Client-side reactive filtering of the already-fetched graph. No backend change
(the existing endpoint and 2000-node cap are fine at current scale; revisit with
server-side params only if the user base outgrows it). Filtering is pure and
unit-tested; the page wires control signals to a derived filtered graph.

## Components

### 1. Pure filter module — `frontend-solid/src/lib/graphFilters.js`
Stateless functions over a `{ nodes, edges }` graph (`nodes`: objects with `id`,
`followers`, …; `edges`: `[fromId, toId]` pairs, matching the existing
`getNetworkGraph` shape):
- `hideIsolates(graph)` → graph with degree-0 nodes (and nothing referencing
  them) removed.
- `largestCluster(graph)` → graph reduced to the largest connected component
  (union-find over undirected edges; ties broken by lowest node id for
  determinism).
- `capNodes(graph, max)` → keep the top-`max` nodes by `followers` (ties by id),
  then drop edges whose endpoints were removed.
- `applyGraphFilters(graph, { hideIsolates = false, largestClusterOnly = false, maxNodes = null })`
  → composes in a fixed order: **largestCluster → hideIsolates → capNodes**, and
  returns `{ nodes, edges }`. (Order: cluster/isolate reductions first so the cap
  applies to the meaningful set.)

### 2. `NetworkPage.jsx`
- Control signals: `maxNodes` (default 200), `hideIsolates` (default false),
  `largestClusterOnly` (default false), `search` (string).
- `displayed = createMemo(() => applyGraphFilters(fullGraph(), opts()))` →
  passed to `SocialGraph3D`.
- **Stats panel**: `showing {displayed.nodes.length} / {full.nodes.length} users ·
  {displayed.edges.length} / {full.edges.length} follows`.
- **Reset view**: resets all control signals to defaults and triggers a camera
  reset.
- **Search (jump-to)**: on submit, find a node whose `username` matches
  (case-insensitive, exact-or-startsWith); if found, set it as the focus target
  (camera centers + node selected). No-match → inline "no user found" note.

### 3. `SocialGraph3D.jsx`
- Add a `createEffect` that **rebuilds the node/edge three.js objects when the
  `nodes`/`edges` props change**, disposing the previous geometry/materials to
  avoid leaks. The renderer/scene/camera/controls stay; only the graph objects
  rebuild.
- Add **`focusNodeId` prop**: when set, recenter the camera/controls target on
  that node and invoke `onSelect` for it.
- Add a **camera reset** path (e.g. a `resetSignal` prop or an exposed handle)
  used by Reset view to return the camera to the default framing.

### 4. Controls UI / layout
A DT-style control row above the graph; the existing side panel keeps stats +
selected-user card:
```
[ search user… ] [Go]   Max nodes [200]   ☐ Hide isolates   ☐ Largest cluster only   [Reset view]
┌──────────────── 3D graph ────────────────┐ ┌ stats / selected user ┐
```
Reuse existing classes/patterns; add `.network-controls` styling consistent with
the app.

## Testing

- **Unit tests** for `graphFilters` via **Node's built-in test runner**
  (`node:test` + `node:assert`, run with `node --test`) — `frontend-solid` has no
  unit-test framework and `graphFilters.js` is pure ESM with no Solid/DOM imports,
  so it imports cleanly under `node --test` with **zero new dependencies** (don't
  add vitest/jest for this). Test file `frontend-solid/src/lib/graphFilters.test.mjs`.
  Cases: isolates removed; largest-cluster selection on a multi-component fixture
  (incl. tie-break determinism); cap keeps top-N by followers and prunes dangling
  edges; `applyGraphFilters` composition + order.
- **Playwright smoke** (against `solid-local`, authed fixture user): load
  `#network`, toggle "Hide isolates" / "Largest cluster only", assert the stats
  "showing X / Y" count changes; assert Reset restores it. The 3D render itself
  stays out of the visual net (WebGL/animated, as established).

## Out of scope (v1)

- Intellacc-specific filters (min-accuracy, min-followers) — easy to add later.
- Server-side graph filtering / pagination — only if scale demands it.
- Follower/following list pages and repost surfacing — separate sub-projects.

## Success criteria

- Toggling each control reactively changes the rendered graph and the
  "showing X / Y" stats; Reset restores defaults + camera.
- Search focuses + selects a matching user; graceful no-match.
- `graphFilters` unit tests pass; the Playwright stats-smoke passes.
- No three.js object leaks across filter changes (rebuild disposes prior objects).
