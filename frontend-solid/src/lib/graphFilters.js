// Pure, dependency-free filters over a social graph { nodes, edges }.
// nodes: [{ id, followers, accuracy_percent, username }], edges: [[fromId, toId]].
// All functions return a new { nodes, edges } and never mutate the input.

const endpoints = (edge) => [Number(edge[0]), Number(edge[1])];

const pruneEdges = (edges, keepIds) =>
  edges.filter((e) => {
    const [a, b] = endpoints(e);
    return keepIds.has(a) && keepIds.has(b);
  });

export function hideIsolates(graph) {
  const degree = new Map();
  for (const e of graph.edges) {
    const [a, b] = endpoints(e);
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
  }
  const nodes = graph.nodes.filter((n) => (degree.get(Number(n.id)) || 0) > 0);
  const keep = new Set(nodes.map((n) => Number(n.id)));
  return { nodes, edges: pruneEdges(graph.edges, keep) };
}

export function largestCluster(graph) {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };
  const parent = new Map(graph.nodes.map((n) => [Number(n.id), Number(n.id)]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const e of graph.edges) {
    const [a, b] = endpoints(e);
    union(a, b);
  }
  const groups = new Map();
  for (const n of graph.nodes) {
    const r = find(Number(n.id));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  }
  let best = null;
  for (const [root, group] of groups) {
    if (
      !best ||
      group.length > best.group.length ||
      (group.length === best.group.length && root < best.root)
    ) {
      best = { root, group };
    }
  }
  const keep = new Set(best.group.map((n) => Number(n.id)));
  return { nodes: best.group, edges: pruneEdges(graph.edges, keep) };
}

export function capNodes(graph, max) {
  if (max == null || graph.nodes.length <= max) return { nodes: graph.nodes, edges: graph.edges };
  const sorted = [...graph.nodes].sort(
    (a, b) => (b.followers || 0) - (a.followers || 0) || Number(a.id) - Number(b.id)
  );
  const nodes = sorted.slice(0, max);
  const keep = new Set(nodes.map((n) => Number(n.id)));
  return { nodes, edges: pruneEdges(graph.edges, keep) };
}

export function applyGraphFilters(graph, opts = {}) {
  let g = { nodes: graph?.nodes || [], edges: graph?.edges || [] };
  if (opts.largestClusterOnly) g = largestCluster(g);
  if (opts.hideIsolates) g = hideIsolates(g);
  if (opts.maxNodes != null) g = capNodes(g, opts.maxNodes);
  return g;
}
