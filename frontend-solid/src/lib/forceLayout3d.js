// Simple 3D force-directed layout for small graphs (the follow network).
// O(n^2) repulsion per iteration - fine for up to a few thousand nodes.
// Returns a Float32Array of xyz positions matching the node order.

export function computeForceLayout3d(nodes, edges, {
  iterations = 250,
  repulsion = 220,
  springLength = 14,
  springStrength = 0.035,
  gravity = 0.015,
  maxStep = 4
} = {}) {
  const count = nodes.length;
  const positions = new Float32Array(count * 3);
  const velocity = new Float32Array(count * 3);

  // Deterministic-ish initial sphere scatter (seeded by index) so the layout
  // is stable across reloads of the same graph.
  for (let i = 0; i < count; i += 1) {
    const phi = Math.acos(1 - 2 * ((i + 0.5) / count));
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const radius = 22 + (i % 7);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }

  const indexById = new Map(nodes.map((node, index) => [Number(node.id), index]));
  const links = [];
  for (const [a, b] of edges) {
    const source = indexById.get(Number(a));
    const target = indexById.get(Number(b));
    if (source !== undefined && target !== undefined && source !== target) {
      links.push([source, target]);
    }
  }

  for (let step = 0; step < iterations; step += 1) {
    // Pairwise repulsion.
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = positions[i * 3] - positions[j * 3];
        let dy = positions[i * 3 + 1] - positions[j * 3 + 1];
        let dz = positions[i * 3 + 2] - positions[j * 3 + 2];
        let distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          dz = (Math.random() - 0.5) * 0.1;
          distSq = dx * dx + dy * dy + dz * dz;
        }
        const force = repulsion / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        velocity[i * 3] += fx; velocity[i * 3 + 1] += fy; velocity[i * 3 + 2] += fz;
        velocity[j * 3] -= fx; velocity[j * 3 + 1] -= fy; velocity[j * 3 + 2] -= fz;
      }
    }

    // Spring attraction along follow edges.
    for (const [source, target] of links) {
      const dx = positions[target * 3] - positions[source * 3];
      const dy = positions[target * 3 + 1] - positions[source * 3 + 1];
      const dz = positions[target * 3 + 2] - positions[source * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const force = (dist - springLength) * springStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      velocity[source * 3] += fx; velocity[source * 3 + 1] += fy; velocity[source * 3 + 2] += fz;
      velocity[target * 3] -= fx; velocity[target * 3 + 1] -= fy; velocity[target * 3 + 2] -= fz;
    }

    // Gravity toward origin + integrate with damping and a step cap.
    for (let i = 0; i < count; i += 1) {
      velocity[i * 3] -= positions[i * 3] * gravity;
      velocity[i * 3 + 1] -= positions[i * 3 + 1] * gravity;
      velocity[i * 3 + 2] -= positions[i * 3 + 2] * gravity;
      for (let axis = 0; axis < 3; axis += 1) {
        const idx = i * 3 + axis;
        velocity[idx] *= 0.85;
        const step3 = Math.max(-maxStep, Math.min(maxStep, velocity[idx]));
        positions[idx] += step3;
      }
    }
  }

  return positions;
}
