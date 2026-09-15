// The 3D brain. At rest it is translucent tissue: cells are membrane, synapses are faint
// threads, nothing emits light and nothing moves. It lights up only when the brain is
// actually used — the daemon streams every recall and traversal, and the notes involved
// fire, sending signals down their synapses to their neighbours and out.
//
// Everything that scales with the size of the vault happens on the GPU or once, on a
// change: per frame the CPU writes one time uniform and moves the camera.

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { PointsCloudSystem } from "@babylonjs/core/Particles/pointsCloudSystem";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { createCamera } from "./camera.js";
import { buildConduction, planRoute, planVolley } from "./cascade.js";
import { CELL_ALPHA, createEmphasis, HEAT_ALPHA } from "./emphasis.js";
import { createImpulseLayer } from "./impulses.js";
import { createLabels } from "./labels.js";
import { createLegend } from "./legend.js";
import { watchActivity } from "./live.js";
import { createPanel } from "./panel.js";
import { createPicker } from "./picking.js";
import { createSearch } from "./search.js";
import { createSpriteLayer } from "./sprites.js";
import { createSynapseLayer } from "./synapses.js";
import { arrivalRange, createArrivals } from "./arrivals.js";

const BACKGROUND = new Color4(2 / 255, 2 / 255, 4 / 255, 1);
const PICK_INTERVAL_MS = 50;
/** The flare around a firing cell, as a multiple of the cell's own radius. */
const FLARE_SCALE = 6;
/** Below this, after the fly-in has settled, the post-processing steps down once. */
const LOW_FPS = 40;
const QUALITY_CHECK_MS = 6000;
/** How long a fired note keeps its title, and the status line its sentence. */
const LABEL_HOLD_MS = 4000;
const STATUS_HOLD_MS = 6000;
/** Search hits that get a title; past this it is a wall of text, not a label. */
const MAX_SEARCH_LABELS = 12;
const NEVER = -1e9;

const VIA = { mcp: "MCP", cli: "CLI", hook: "session hook", ui: "dashboard" };
const ACTION = { recall: "recall", path: "path", explain: "explain", affected: "affected" };

const SEARCH_ICON =
	'<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.1"/><path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

function createPipeline(scene, camera) {
	const pipeline = new DefaultRenderingPipeline("brainFx", true, scene, [camera]);
	// Multisampling on the pipeline's own target is what smooths the synapse threads;
	// FXAA on top catches what MSAA leaves on the cells' rims.
	pipeline.samples = Math.min(4, scene.getEngine().getCaps().maxMSAASamples ?? 1);
	pipeline.fxaaEnabled = true;
	// Bloom is reserved for firing: resting tissue never reaches this threshold, so a
	// signal is the only thing in the view that throws light.
	pipeline.bloomEnabled = true;
	pipeline.bloomThreshold = 0.9;
	pipeline.bloomWeight = 0.7;
	pipeline.bloomKernel = 64;
	pipeline.bloomScale = 0.5;
	pipeline.imageProcessingEnabled = true;
	pipeline.imageProcessing.vignetteEnabled = true;
	pipeline.imageProcessing.vignetteWeight = 1.5;
	pipeline.imageProcessing.contrast = 1.05;
	// No grain: it is the one thing that would keep the resting picture moving, and over
	// a near-black ground it buys nothing.
	pipeline.grainEnabled = false;
	return {
		/** A smaller, coarser bloom and no grain: most of the look for a third of the fill cost. */
		lighten() {
			pipeline.bloomKernel = 32;
			pipeline.bloomScale = 0.25;
		},
	};
}

function createStarfield(scene) {
	const stars = new PointsCloudSystem("stars", 1.4, scene);
	const tint = Color3.FromHexString("#4b5570");
	stars.addPoints(900, (p) => {
		const r = 700 + Math.random() * 1200;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		p.position = new Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
		const jitter = 0.5 + Math.random() * 0.5;
		p.color = new Color4(tint.r * jitter, tint.g * jitter, tint.b * jitter, 0.3);
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
		'<div class="brain-loading"><div class="loader" aria-hidden="true"></div><div class="loading-text">waking the cortex</div></div>';
	container.appendChild(chrome);
	const statsEl = chrome.querySelector(".brain-stats");

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	let visible = false;
	let running = false;

	// Rendering above 1.5x device pixels buys nothing visible and multiplies every bloom pass.
	const engine = new Engine(canvas, true, { powerPreference: "high-performance", stencil: false });
	engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
	const scene = new Scene(engine);
	scene.clearColor = BACKGROUND;
	scene.fogMode = Scene.FOGMODE_EXP2;
	scene.fogDensity = 0.00045;
	scene.fogColor = new Color3(BACKGROUND.r, BACKGROUND.g, BACKGROUND.b);
	scene.skipPointerMovePicking = true;
	const view = createCamera(scene, canvas, () => visible);
	const quality = createPipeline(scene, view.camera);
	createStarfield(scene);
	// Test hook: the harness reads the camera through this, and can play a volley without
	// a daemon behind it.
	canvas.brainView = {
		camera: view.camera,
		engine,
		simulate: (event) => onActivity(event),
		/** Harness hook: refuse automatic camera moves, so a resting frame can be compared. */
		freeze: (on) => view.hold(on),
		/** Harness hooks: where a note lands on screen, and what the pointer would hit there. */
		project: (index) => projectNode(index),
		pickAt: (x, y) => picker?.pick(x, y) ?? -1,
		/** Harness hook: play an arrival without waiting for the vault to change. */
		land: (indices) => layers && land(indices),
		/** Harness hook: one note's place in the brain, for aiming the camera at it. */
		nodeAt: (index) => {
			const node = graph?.nodes[index];
			return node ? { x: node.x, y: node.y, z: node.z, connections: node.connections } : null;
		},
	};

	// Everything below exists once the graph has loaded.
	let graph = null;
	let emphasis = null;
	let layers = null;
	let conduction = null;
	let picker = null;
	let panel = null;
	let search = null;
	let indexByPath = new Map();
	let radii = [];
	let excitability = null;
	let cellFireAt = null;
	let cellGain = null;
	let cellArriveAt = null;
	let arrivals = null;
	let firedLabels = new Set();
	let labelTimer = null;
	let statusTimer = null;
	let restingStatus = "";
	let loadedAt = 0;
	let qualityChecked = false;
	let stopWatching = () => {};

	/** A note's centre in pointer coordinates, and how big it is there. */
	function projectNode(index) {
		if (!graph) return null;
		const node = graph.nodes[index];
		const m = scene.getTransformMatrix().m;
		const depth = node.x * m[3] + node.y * m[7] + node.z * m[11] + m[15];
		if (depth <= 0) return null;
		const scaling = engine.getHardwareScalingLevel();
		const width = engine.getRenderWidth() * scaling;
		const height = engine.getRenderHeight() * scaling;
		const focal = view.camera.getProjectionMatrix().m[5];
		return {
			x: ((node.x * m[0] + node.y * m[4] + node.z * m[8] + m[12]) / depth + 1) * 0.5 * width,
			y: (1 - (node.x * m[1] + node.y * m[5] + node.z * m[9] + m[13]) / depth) * 0.5 * height,
			radius: (radii[index] * focal * height) / (2 * depth),
			depth,
		};
	}

	/** Titles are for what the viewer is touching and what just fired, nothing else. */
    function labelSet() {
		const wanted = new Set(firedLabels);
		if (emphasis.state.hovered !== -1) wanted.add(emphasis.state.hovered);
		if (emphasis.state.selected !== -1) wanted.add(emphasis.state.selected);
		if (emphasis.state.matches) {
			let taken = 0;
			for (const index of emphasis.state.matches) {
				if (taken++ >= MAX_SEARCH_LABELS) break;
				wanted.add(index);
			}
		}
		for (const index of wanted) if (!emphasis.nodeVisible(index)) wanted.delete(index);
		return wanted;
	}

	function restyle() {
		if (!layers) return;
		const n = graph.nodes.length;
		const cellTints = new Float32Array(n * 4);
		const cellSizes = new Float32Array(n);
		const flareTints = new Float32Array(n * 4);
		const flareSizes = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const node = graph.nodes[i];
			const state = emphasis.nodeState(i);
			const tint = emphasis.tintOf(node);
			if (state === "hidden") continue;
			const alpha = CELL_ALPHA[state] + (state === "normal" ? HEAT_ALPHA * (node.activation ?? 0) : 0);
			cellTints.set([tint[0], tint[1], tint[2], alpha], i * 4);
			cellSizes[i] = radii[i];
			// The flare carries the lobe's colour; the shader decides whether it is there.
			flareTints.set([tint[0], tint[1], tint[2], 0.85], i * 4);
			flareSizes[i] = radii[i] * FLARE_SCALE;
		}
		layers.cells.set("tint", cellTints);
		layers.cells.set("size", cellSizes);
		layers.flares.set("tint", flareTints);
		layers.flares.set("size", flareSizes);
		layers.synapses.restyle(emphasis.edgeState, emphasis.tintOf);
		layers.labels.show(labelSet());
	}

	function setStatus(text) {
		statsEl.textContent = text;
		clearTimeout(statusTimer);
		if (text !== restingStatus) statusTimer = setTimeout(() => (statsEl.textContent = restingStatus), STATUS_HOLD_MS);
	}

	/** Write a planned volley into the layers. One buffer upload each; the GPU runs it. */
	function play(plan) {
		if (plan.fires.length === 0) return;
		for (const fire of plan.fires) {
			cellFireAt[fire.node] = fire.at;
			cellGain[fire.node] = fire.gain;
		}
		layers.cells.set("fireAt", cellFireAt);
		layers.cells.set("fireGain", cellGain);
		layers.flares.set("fireAt", cellFireAt);
		layers.flares.set("fireGain", cellGain);
		layers.synapses.conduct(plan.impulses);
		layers.impulses.fire(plan.impulses);

		// The first few notes to fire name themselves, then the brain goes quiet again.
		firedLabels = new Set(plan.fires.slice(0, 6).map((fire) => fire.node));
		layers.labels.show(labelSet());
		clearTimeout(labelTimer);
		labelTimer = setTimeout(() => {
			firedLabels = new Set();
			layers.labels.show(labelSet());
		}, LABEL_HOLD_MS);
	}

	/**
	 * New notes arriving. Each one pops into place and shoves what is around it aside, and
	 * then fires the way anything else does, so the cells it is related to answer it. The
	 * shove is the shader's business: all that is handed over is where and when.
	 */
	function land(indices) {
		const now = performance.now() / 1000;
		for (const index of indices) {
			cellArriveAt[index] = now;
			arrivals.add(graph.nodes[index], now);
		}
		layers.cells.set("arriveAt", cellArriveAt);
		layers.flares.set("arriveAt", cellArriveAt);
		play(planVolley(conduction, indices.slice(0, 8), { now, passes: emphasis.edgeVisible, limit: 120 }));
		setStatus(`${indices.length} new note${indices.length === 1 ? "" : "s"} in the vault`);
	}

	function onActivity(event) {
		if (event.type === "graph") {
			void refreshGraph();
			return;
		}
		if (!layers || reducedMotion) return;
		const seeds = (event.paths ?? []).map((path) => indexByPath.get(path)).filter((index) => index !== undefined);
		const route = (event.route ?? []).map((path) => indexByPath.get(path)).filter((index) => index !== undefined);
		const now = performance.now() / 1000;
		const options = { now, passes: emphasis.edgeVisible, excitability, limit: 320 };
		if (route.length > 1) play(planRoute(conduction, route, options));
		else if (seeds.length > 0) play(planVolley(conduction, seeds, options));
		else return;
		const where = VIA[event.via] ?? "";
		const what = ACTION[event.type] ?? event.type;
		setStatus([where, what, event.query].filter(Boolean).join(" · "));
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

	/** Tear down everything that was built from the previous graph payload. */
	function unmount() {
		if (!layers) return;
		for (const layer of Object.values(layers)) layer.dispose?.();
		panel?.dispose();
		layers = null;
	}

	function mount(data) {
		const previous = graph ? new Set(graph.nodes.map((node) => node.id)) : null;
		const keepHidden = emphasis ? { categories: emphasis.state.hiddenCategories, kinds: emphasis.state.hiddenKinds } : null;
		const openPath = emphasis && emphasis.state.selected !== -1 ? graph.nodes[emphasis.state.selected].id : null;
		unmount();
		graph = data;
		emphasis = createEmphasis(graph);
		conduction = buildConduction(graph);
		const n = graph.nodes.length;
		radii = graph.nodes.map((node) => 2.4 + Math.sqrt(node.connections + 1) * 0.95);
		excitability = Float32Array.from(graph.nodes, (node) => node.activation ?? 0);
		cellFireAt = new Float32Array(n).fill(NEVER);
		cellGain = new Float32Array(n).fill(1);
		// Nothing has landed yet: a note that was already here must not pop on first sight.
		cellArriveAt = new Float32Array(n).fill(NEVER);
		arrivals = createArrivals();
		const spread = [...graph.nodes.map((node) => Math.hypot(node.x, node.y, node.z))].sort((a, b) => a - b);
		const reach = arrivalRange(spread[Math.floor(spread.length * 0.95)] ?? 0);
		indexByPath = new Map(graph.nodes.map((node, i) => [node.id, i]));
		const positions = new Float32Array(n * 3);
		graph.nodes.forEach((node, i) => positions.set([node.x, node.y, node.z], i * 3));

		const firing = [
			{ name: "fireAt", size: 1 },
			{ name: "fireGain", size: 1 },
			{ name: "arriveAt", size: 1 },
		];
		const cells = createSpriteLayer(scene, {
			name: "cells",
			count: n,
			vertex: "brainCell",
			fragment: "brainCell",
			blend: "alpha",
			attributes: firing,
			arrivalRange: reach,
			renderingGroup: 1,
		});
		const flares = createSpriteLayer(scene, {
			name: "flares",
			count: n,
			vertex: "brainFlare",
			fragment: "brainGlow",
			blend: "add",
			attributes: firing,
			arrivalRange: reach,
			renderingGroup: 2,
		});
		for (const layer of [cells, flares]) {
			layer.set("position", positions);
			layer.set("fireAt", cellFireAt);
			layer.set("fireGain", cellGain);
			layer.set("arriveAt", cellArriveAt);
		}
		layers = {
			synapses: createSynapseLayer(scene, graph, reach),
			cells,
			flares,
			impulses: createImpulseLayer(scene, graph, emphasis.tintOf),
			labels: createLabels(scene, graph, radii),
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
		layers.search = search;
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
		}, keepHidden);
		for (const id of legend.hiddenCategories) emphasis.state.hiddenCategories.add(id);
		for (const kind of legend.hiddenKinds) emphasis.state.hiddenKinds.add(kind);
		restingStatus = `${n.toLocaleString()} notes · ${graph.edges.length.toLocaleString()} synapses`;
		statsEl.textContent = restingStatus;
		if (openPath !== null) {
			const back = indexByPath.get(openPath);
			if (back !== undefined) emphasis.state.selected = back;
		}
		restyle();

		// A note that was not here a moment ago lands as you watch, so the vault changing is
		// something you see happen rather than something you find later.
		if (previous) {
			const arrived = graph.nodes.map((node, i) => (previous.has(node.id) ? -1 : i)).filter((i) => i !== -1);
			if (arrived.length > 0 && !reducedMotion) land(arrived);
		}
	}

	function build(data) {
		mount(data);
		stopWatching = watchActivity(onActivity);

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

	/** The vault changed and the daemon has finished placing it: take the new picture. */
	let refreshing = false;
	async function refreshGraph() {
		if (refreshing || !visible) return;
		refreshing = true;
		try {
			const data = await (await fetch("/api/graph")).json();
			search?.clear();
			mount(data);
		} finally {
			refreshing = false;
		}
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
			layers.cells.setTime(seconds);
			layers.flares.setTime(seconds);
			layers.impulses.setTime(seconds);
			layers.synapses.setTime(seconds);
			// One small uniform, and only while something is still settling.
			const settling = arrivals.pack(seconds);
			if (settling) {
				for (const layer of [layers.cells, layers.flares, layers.impulses, layers.synapses]) {
					layer.setArrivals(settling.data, settling.count);
				}
			}
			if (!qualityChecked && now - loadedAt > QUALITY_CHECK_MS) {
				qualityChecked = true;
				if (engine.getFps() < LOW_FPS) quality.lighten();
			}
		}
		view.update(dt, now);
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

	let pendingOpen = null;

	/** Open a note by vault path, from another tab. Waits for the graph if it is still loading. */
	function open(path) {
		const index = indexByPath.get(path);
		if (index !== undefined) focusOn(index);
		else if (!graph) pendingOpen = path;
	}

	const controller = {
		open,
		show() {
			visible = true;
			resize();
			setTimeout(resize, 80);
			startLoop();
			// Away from this tab, updates were skipped; take the current picture on return.
			if (graph) void refreshGraph();
		},
		hide() {
			visible = false;
			stopLoop();
		},
		dispose() {
			stopWatching();
		},
		onLoaded() {
			if (pendingOpen) {
				const path = pendingOpen;
				pendingOpen = null;
				open(path);
			}
		},
	};
	fetch("/api/graph")
		.then((r) => r.json())
		.then((data) => {
			build(data);
			controller.onLoaded();
		});
	return controller;
}
