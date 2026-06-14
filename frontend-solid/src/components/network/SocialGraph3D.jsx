// 3D follow-network visualization. Rendering approach (custom shader
// materials, additive-blended points, screen-space sizing, raycast picking)
// repurposed from the DT project's ThreeGraph.svelte, ported to SolidJS and
// stripped to the social-graph essentials.

import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createNodeMaterial, createEdgeMaterial } from '../../lib/graphMaterials';
import { computeForceLayout3d } from '../../lib/forceLayout3d';

const NODE_BASE_SIZE = 7;
const NODE_SIZE_PER_FOLLOWER = 2.2;
const NODE_MAX_SIZE = 26;

// Color by forecasting accuracy: grey (unknown) -> blue (low) -> green (high).
const nodeColor = (accuracy) => {
  if (accuracy == null) return new THREE.Color(0x8899aa);
  const t = Math.max(0, Math.min(1, accuracy / 100));
  return new THREE.Color().setHSL(0.55 - 0.25 * t, 0.85, 0.55);
};

export default function SocialGraph3D(props) {
  let container;
  let labelEl;
  let renderer;
  let scene;
  let camera;
  let controls;
  let points;
  let lines;
  let raycaster;
  let frame = 0;
  let resizeObserver;
  let hoveredIndex = null;
  let disposed = false;
  let onPointerMove = null;
  let onClick = null;
  let pointerActive = false;

  const pointer = new THREE.Vector2(2, 2);
  const nodes = () => props.nodes || [];
  const edges = () => props.edges || [];

  const [sceneReady, setSceneReady] = createSignal(false);

  const disposeGraphObjects = () => {
    for (const obj of [points, lines]) {
      if (!obj) continue;
      scene.remove(obj);
      obj.geometry?.dispose?.();
      obj.material?.dispose?.();
    }
    points = null;
    lines = null;
    hoveredIndex = null;
  };

  const rebuildGraph = () => {
    if (!scene) return;
    disposeGraphObjects();
    buildScene();
  };

  const buildScene = () => {
    const nodeList = nodes();
    if (!container || nodeList.length === 0) return;

    const positions = computeForceLayout3d(nodeList, edges());
    const colors = new Float32Array(nodeList.length * 3);
    const sizes = new Float32Array(nodeList.length);
    const alphas = new Float32Array(nodeList.length);

    nodeList.forEach((node, index) => {
      const color = nodeColor(node.accuracy_percent);
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
      sizes[index] = Math.min(NODE_MAX_SIZE, NODE_BASE_SIZE + NODE_SIZE_PER_FOLLOWER * Math.sqrt(node.followers || 0));
      alphas[index] = 0.95;
    });

    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pointGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pointGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    pointGeometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    points = new THREE.Points(pointGeometry, createNodeMaterial(THREE, window.devicePixelRatio || 1));
    scene.add(points);

    const indexById = new Map(nodeList.map((node, index) => [Number(node.id), index]));
    const edgePositions = [];
    const edgeAlphas = [];
    for (const [a, b] of edges()) {
      const source = indexById.get(Number(a));
      const target = indexById.get(Number(b));
      if (source === undefined || target === undefined) continue;
      for (const idx of [source, target]) {
        edgePositions.push(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]);
        edgeAlphas.push(0.35);
      }
    }
    if (edgePositions.length > 0) {
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
      edgeGeometry.setAttribute('alpha', new THREE.Float32BufferAttribute(edgeAlphas, 1));
      const edgeColors = new Float32Array(edgeAlphas.length * 3).fill(0.55);
      edgeGeometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));
      lines = new THREE.LineSegments(edgeGeometry, createEdgeMaterial(THREE));
      scene.add(lines);
    }
  };

  const pick = () => {
    // NDC (2,2) - the initial sentinel - still casts a valid ray that can hit
    // nodes; only pick once the pointer has actually entered the canvas.
    if (!points || !pointerActive) return null;
    raycaster.setFromCamera(pointer, camera);
    raycaster.params.Points.threshold = 1.6;
    const hits = raycaster.intersectObject(points);
    return hits.length > 0 ? hits[0].index : null;
  };

  const updateLabel = () => {
    if (!labelEl) return;
    if (hoveredIndex == null || !nodes()[hoveredIndex]) {
      labelEl.style.display = 'none';
      return;
    }
    const node = nodes()[hoveredIndex];
    const attr = points.geometry.getAttribute('position');
    const world = new THREE.Vector3(attr.getX(hoveredIndex), attr.getY(hoveredIndex), attr.getZ(hoveredIndex));
    world.project(camera);
    const rect = container.getBoundingClientRect();
    labelEl.style.display = 'block';
    labelEl.style.left = `${((world.x + 1) / 2) * rect.width}px`;
    labelEl.style.top = `${((1 - world.y) / 2) * rect.height}px`;
    labelEl.textContent = node.username;
  };

  onMount(() => {
    try {
      initScene();
    } catch (err) {
      console.warn('[Network] WebGL unavailable:', err?.message || err);
      if (container) {
        container.innerHTML = '<p class="network-hint" style="padding:1rem">3D view unavailable on this device (WebGL required).</p>';
      }
    }
  });

  const initScene = () => {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
    camera.position.set(0, 12, 95);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;

    raycaster = new THREE.Raycaster();

    let lastWidth = 0;
    let lastHeight = 0;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(Math.round(rect.width), 1);
      const height = Math.max(Math.round(rect.height), 1);
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    onPointerMove = (event) => {
      pointerActive = true;
      const rect = container.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    };
    onClick = () => {
      if (hoveredIndex != null && props.onSelect) {
        props.onSelect(nodes()[hoveredIndex]);
      }
    };
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('click', onClick);

    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      controls.autoRotate = hoveredIndex == null;
      controls.update();
      const picked = pick();
      if (picked !== hoveredIndex) {
        hoveredIndex = picked;
        container.style.cursor = picked == null ? 'grab' : 'pointer';
      }
      updateLabel();
      renderer.render(scene, camera);
    };
    animate();

    setSceneReady(true);
  };

  onCleanup(() => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      if (onPointerMove) container.removeEventListener('pointermove', onPointerMove);
      if (onClick) container.removeEventListener('click', onClick);
      controls?.dispose();
      scene?.traverse((obj) => {
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
      });
      renderer?.dispose();
      renderer?.domElement?.remove();
  });

  // Rebuild graph objects whenever the (filtered) node/edge props change.
  createEffect(() => {
    nodes();
    edges();
    if (!sceneReady()) return;
    rebuildGraph();
  });

  // Focus the camera on a node when focusNodeId is set, and select it.
  createEffect(() => {
    const id = props.focusNodeId;
    if (id == null || !sceneReady() || !points) return;
    const list = nodes();
    const idx = list.findIndex((n) => String(n.id) === String(id));
    if (idx < 0) return;
    const attr = points.geometry.getAttribute('position');
    const target = new THREE.Vector3(attr.getX(idx), attr.getY(idx), attr.getZ(idx));
    controls.target.copy(target);
    camera.position.set(target.x, target.y + 8, target.z + 40);
    controls.update();
    props.onSelect?.(list[idx]);
  });

  // Reset the camera to default framing when resetSignal changes.
  createEffect(() => {
    props.resetSignal;
    if (!sceneReady() || !controls) return;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 12, 95);
    controls.update();
  });

  return (
    <div class="social-graph-container" ref={container}>
      <div class="social-graph-label" ref={labelEl} />
    </div>
  );
}
