// The 3D brain: notes as lit discs, halos and travelling sparks drawn as GPU-billboarded
// sprites (one draw call per layer), synapses as one line system, layout served by the
// daemon. Per frame the CPU updates a time uniform and the camera; everything that scales
// with the size of the vault happens on the GPU or once, on a change.

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointsCloudSystem } from "@babylonjs/core/Particles/pointsCloudSystem";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { createCamera } from "./camera.js";
import { createEdgeLayer } from "./edges.js";
import { createEmphasis, DIM_CORE } from "./emphasis.js";
import { createLabels } from "./labels.js";
import { createLegend } from "./legend.js";
import { createPanel } from "./panel.js";
import { createPicker } from "./picking.js";
import { createSearch } from "./search.js";
import { createSparks } from "./sparks.js";
import { createSpriteLayer } from "./sprites.js";

const BACKGROUND = new Color4(1 / 255, 1 / 255, 2 / 255, 1);
const PICK_INTERVAL_MS = 50;
const HALO_SCALE = 5;
/** Below this, after the fly-in has settled, the post-processing steps down once. */
const LOW_FPS = 40;
const QUALITY_CHECK_MS = 6000;

const SEARCH_ICON =
	'<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.1"/><path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

function createPipeline(scene, camera) {
	// HDR-style bloom is what makes the neurons read as light sources; FXAA smooths lines;
	// grain and vignette give the void some texture. One pipeline, GPU-side.
	const pipeline = new DefaultRenderingPipeline("brainFx", true, scene, [camera]);
	pipeline.fxaaEnabled = true;
	pipeline.bloomEnabled = true;
	pipeline.bloomThreshold = 0.45;
	pipeline.bloomWeight = 0.6;
	pipeline.bloomKernel = 64;
	pipeline.bloomScale = 0.5;
	pipeline.imageProcessingEnabled = true;
	pipeline.imageProcessing.vignetteEnabled = true;
	pipeline.imageProcessing.vignetteWeight = 1.6;
	pipeline.imageProcessing.contrast = 1.08;
	pipeline.grainEnabled = true;
	pipeline.grain.intensity = 3.5;
	pipeline.grain.animated = true;
	return {
		/** A smaller, coarser bloom and no grain: most of the look for a third of the fill cost. */
		lighten() {
			pipeline.bloomKernel = 32;
			pipeline.bloomScale = 0.25;
			pipeline.grainEnabled = false;
		},
	};
}

function createStarfield(scene) {
	const stars = new PointsCloudSystem("stars", 1.6, scene);
	const tintA = Color3.FromHexString("#5b6b9e");
	const tintB = Color3.FromHexString("#8b95c9");
	stars.addPoints(1400, (p) => {
		const r = 700 + Math.random() * 1200;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		p.position = new Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
		const c = Math.random() < 0.5 ? tintA : tintB;
		const jitter = 0.6 * (0.6 + Math.random() * 0.4);
		p.color = new Color4(c.r * jitter, c.g * jitter, c.b * jitter, 0.5);
	});
	stars.buildMeshAsync().then((mesh) => {
		mesh.isPickable = false;
		if (mesh.material) mesh.material.fogEnabled = false;
	});
}

export function createBrainTab(container) {
	container.classList.add("brain-tab");
	const canvas = document.createElement("canvas");
	canvas.className = "brain-canvas";
	container.appendChild(canvas);

	const chrome = document.createElement("div");
	chrome.className = "brain-chrome";
	chrome.innerHTML =
		`<div class="brain-search">${SEARCH_ICON}<input class="brain-search-input" type="text" placeholder="Search memories" autocomplete="off" spellcheck="false" /><kbd>/</kbd><ul class="brain-results"></ul></div>` +
		'<div class="brain-stats"></div><div class="brain-legend"></div>' +
		'<div class="brain-loading"><svg class="ring" viewBox="25 25 50 50" aria-hidden="true"><circle r="20" cy="50" cx="50"></circle></svg><div class="loading-text">waking the cortex</div></div>';
	container.appendChild(chrome);

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let visible = false;
	let running = false;

	// MSAA off: the pipeline's FXAA is cheaper and bloom hides the difference. Rendering
	// above 1.25x device pixels buys nothing visible and multiplies every bloom pass.
	const engine = new Engine(canvas, false, { powerPreference: "high-performance" });
	engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.25));
	const scene = new Scene(engine);
	scene.clearColor = BACKGROUND;
	scene.fogMode = Scene.FOGMODE_EXP2;
	scene.fogDensity = 0.0004;
	scene.fogColor = new Color3(BACKGROUND.r, BACKGROUND.g, BACKGROUND.b);
	scene.skipPointerMovePicking = true;
	scene.autoClearDepthAndStencil = true;
	const view = createCamera(scene, canvas, () => visible);
	const quality = createPipeline(scene, view.camera);
	createStarfield(scene);
	// Test hook: the screenshot harness reads the camera through it.
	canvas.brainView = { camera: view.camera, engine };

	// Everything below exists once the graph has loaded.
	let graph = null;
	let emphasis = null;
	let layers = null;
	let picker = null;
	let panel = null;
	let search = null;
	let radii = [];
	let loadedAt = 0;
	let qualityChecked = false;

	function restyle() {
		if (!layers) return;
		const n = graph.nodes.length;
		const coreTints = new Float32Array(n * 4);
		const coreSizes = new Float32Array(n);
		const haloTints = new Float32Array(n * 4);
		const haloSizes = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const state = emphasis.nodeState(i);
			const base = emphasis.tintOf(graph.nodes[i]);
			const hidden = state === "hidden";
			coreSizes[i] = hidden ? 0 : radii[i];
			haloSizes[i] = hidden ? 0 : radii[i] * HALO_SCALE;
			if (state === "dim") {
				coreTints.set([DIM_CORE[0], DIM_CORE[1], DIM_CORE[2], 1], i * 4);
				haloTints.set([base[0], base[1], base[2], 0.03], i * 4);
			} else {
				coreTints.set([base[0], base[1], base[2], 1], i * 4);
				haloTints.set([base[0], base[1], base[2], state === "hi" ? 0.55 : 0.28], i * 4);
			}
		}
		layers.cores.setTints(coreTints);
		layers.cores.setSizes(coreSizes);
		layers.halos.setTints(haloTints);
		layers.halos.setSizes(haloSizes);
		layers.edges.restyle(emphasis.edgeState, emphasis.tintOf);
		layers.labels.restyle(emphasis.nodeState);
		layers.sparks.restyle(emphasis.edgeState);
	}

	function focusOn(index) {
		const node = graph.nodes[index];
		emphasis.state.selected = index;
		view.glideTo(new Vector3(node.x, node.y, node.z), 110, 1400);
		panel.open(index);
		restyle();
	}

	function closePanel() {
		panel.close();
		emphasis.state.selected = -1;
		restyle();
	}

	function build(data) {
		graph = data;
		emphasis = createEmphasis(graph);
		const n = graph.nodes.length;
		radii = graph.nodes.map((node) => 2.2 + Math.sqrt(node.connections + 1) * 0.9);
		const positions = new Float32Array(n * 3);
		const phases = new Float32Array(n);
		graph.nodes.forEach((node, i) => {
			positions.set([node.x, node.y, node.z], i * 3);
			phases[i] = (i % 32) / 5;
		});
		const cores = createSpriteLayer(scene, { name: "cores", count: n, vertex: "brainSprite", fragment: "brainCore", additive: false });
		const halos = createSpriteLayer(scene, { name: "halos", count: n, vertex: "brainSprite", fragment: "brainGlow", additive: true });
		for (const layer of [cores, halos]) {
			layer.setPositions(positions);
			layer.setPhases(phases);
		}
		halos.setPulse(reducedMotion ? 0 : 1);
		const categoryById = new Map(graph.categories.map((c) => [c.id, c]));
		layers = {
			cores,
			halos,
			edges: createEdgeLayer(scene, graph),
			labels: createLabels(scene, graph, radii, (node) => categoryById.get(node.category)?.color ?? "#94a3b8"),
			sparks: createSparks(scene, graph, emphasis.tintOf),
		};
		picker = createPicker(scene, engine, view.camera, graph, radii, emphasis.nodeVisible);
		panel = createPanel(container, graph, { onNavigate: focusOn, onClose: closePanel });
		search = createSearch(
			{ input: chrome.querySelector(".brain-search-input"), results: chrome.querySelector(".brain-results") },
			graph,
			{
				onMatches(set) {
					emphasis.state.matches = set;
					restyle();
				},
				onPick: focusOn,
			},
		);
		const legend = createLegend(chrome.querySelector(".brain-legend"), graph, {
			onCategory(id, on) {
				if (on) emphasis.state.hiddenCategories.delete(id);
				else emphasis.state.hiddenCategories.add(id);
				restyle();
			},
			onKind(kind, on) {
				if (on) emphasis.state.hiddenKinds.delete(kind);
				else emphasis.state.hiddenKinds.add(kind);
				restyle();
			},
		});
		for (const kind of legend.hiddenKinds) emphasis.state.hiddenKinds.add(kind);
		chrome.querySelector(".brain-stats").textContent = `${n} notes · ${graph.edges.length} synapses`;
		restyle();

		// Settle into a three-quarter profile: the brain silhouette reads best there. The
		// framing radius comes from where most notes are, so one stray note flung to the
		// edge cannot shrink the whole brain to a dot.
		const distances = graph.nodes.map((node) => Math.hypot(node.x, node.y, node.z)).sort((a, b) => a - b);
		const extent = distances[Math.floor(distances.length * 0.95)] ?? 0;
		view.camera.alpha = -Math.PI / 2 + 0.6;
		view.camera.beta = Math.PI / 2.4;
		view.glideTo(Vector3.Zero(), Math.max(extent * 2.1, 300), 2000);
		loadedAt = performance.now();

		const loading = chrome.querySelector(".brain-loading");
		loading.classList.add("done");
		setTimeout(() => loading.remove(), 700);
	}

	// Pointer: throttled screen-space picks.
	let lastPick = 0;
	canvas.addEventListener("pointermove", () => {
		if (!picker) return;
		const now = performance.now();
		if (now - lastPick < PICK_INTERVAL_MS) return;
		lastPick = now;
		const index = picker.pick(scene.pointerX, scene.pointerY);
		if (index !== emphasis.state.hovered) {
			emphasis.state.hovered = index;
			canvas.style.cursor = index === -1 ? "default" : "pointer";
			restyle();
		}
	});
	canvas.addEventListener("click", () => {
		if (!picker) return;
		const index = picker.pick(scene.pointerX, scene.pointerY);
		if (index !== -1) focusOn(index);
		else if (panel.isOpen()) closePanel();
	});
	document.addEventListener("keydown", (e) => {
		if (!visible || !search) return;
		if (e.key === "/" && !search.isFocused()) {
			e.preventDefault();
			search.focus();
		} else if (e.key === "Escape" && !search.isFocused() && panel.isOpen()) {
			closePanel();
		}
	});

	scene.onBeforeRenderObservable.add(() => {
		const now = performance.now();
		const dt = engine.getDeltaTime() / 1000;
		if (layers) {
			const seconds = now / 1000;
			layers.cores.setTime(seconds);
			layers.halos.setTime(seconds);
			layers.sparks.setTime(reducedMotion ? 0 : seconds);
			if (!reducedMotion) layers.sparks.tick(now);
			if (!qualityChecked && now - loadedAt > QUALITY_CHECK_MS) {
				qualityChecked = true;
				if (engine.getFps() < LOW_FPS) quality.lighten();
			}
		}
		const holdStill = emphasis !== null && (emphasis.state.selected !== -1 || emphasis.state.matches !== null);
		view.update(dt, now, holdStill, reducedMotion);
	});

	function startLoop() {
		if (running || !visible || document.hidden) return;
		running = true;
		engine.runRenderLoop(() => scene.render());
	}
	function stopLoop() {
		running = false;
		engine.stopRenderLoop();
	}
	document.addEventListener("visibilitychange", () => (document.hidden ? stopLoop() : startLoop()));
	const resize = () => engine.resize();
	new ResizeObserver(resize).observe(container);

	fetch("/api/graph")
		.then((r) => r.json())
		.then(build);

	return {
		show() {
			visible = true;
			resize();
			setTimeout(resize, 80);
			startLoop();
		},
		hide() {
			visible = false;
			stopLoop();
		},
	};
}
