import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideIsolates, largestCluster, capNodes, applyGraphFilters } from './graphFilters.js';

const g = {
  nodes: [
    { id: 1, username: 'a', followers: 10 },
    { id: 2, username: 'b', followers: 5 },
    { id: 3, username: 'c', followers: 1 }, // isolate (no edges)
    { id: 4, username: 'd', followers: 8 }, // separate 2-node cluster with 5
    { id: 5, username: 'e', followers: 2 }
  ],
  edges: [[1, 2], [4, 5]]
};

test('hideIsolates drops degree-0 nodes and dangling edges', () => {
  const r = hideIsolates(g);
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), [1, 2, 4, 5]);
  assert.equal(r.edges.length, 2);
});

test('largestCluster keeps the biggest connected component', () => {
  // components: {1,2}, {4,5}, {3}. Largest is size 2; tie → lowest root id (1).
  const r = largestCluster(g);
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), [1, 2]);
  assert.deepEqual(r.edges, [[1, 2]]);
});

test('capNodes keeps top-N by followers and prunes dangling edges', () => {
  const r = capNodes(g, 2); // top-2 followers: id1(10), id4(8) → edge [4,5] dropped (5 gone)
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), [1, 4]);
  assert.equal(r.edges.length, 0);
});

test('applyGraphFilters composes largestCluster → hideIsolates → cap', () => {
  const r = applyGraphFilters(g, { largestClusterOnly: true, hideIsolates: true, maxNodes: 10 });
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), [1, 2]);
});

test('applyGraphFilters with no opts returns all', () => {
  const r = applyGraphFilters(g, {});
  assert.equal(r.nodes.length, 5);
  assert.equal(r.edges.length, 2);
});

test('handles empty graph', () => {
  assert.deepEqual(applyGraphFilters({ nodes: [], edges: [] }, { largestClusterOnly: true }), { nodes: [], edges: [] });
});
