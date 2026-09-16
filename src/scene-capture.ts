// Taking the 3D scene itself, so the rebuild renders it rather than replaying pictures of it.
//
// A frame sequence is a fallback and behaves like one: it is fixed at the size it was
// photographed, it crops instead of re-rendering when the window changes, and it cannot
// react to a pointer or a scroll. For a page whose hero is a real scene, the thing worth
// taking is the scene.
//
// Both of the engines people actually use can hand over their own state:
//
//   three.js  publishes every renderer and scene it creates to `window.__THREE_DEVTOOLS__`
//             if something has put an EventTarget there first — which is what the devtools
//             extension does, and what this does before the page loads. `Scene.toJSON()` is
//             then the library's own serializer: geometries, materials, shader uniforms,
//             lights, camera, the lot.
//   babylon   keeps its scenes on the engine, and `BABYLON.SceneSerializer.Serialize` is the
//             equivalent.
//
// What comes back is data — geometry, colours, GLSL — not the page's code, and it is
// replayed by the library itself, fetched once at capture time and stored beside the
// rebuild so that viewing it needs no network and no CDN in anyone's content policy.
//
// When this works the copy is a real renderer: it resizes properly, it runs at the viewer's
// frame rate, and its uniforms can be driven. When it does not — an engine nobody has heard
// of, a scene too large to keep, a serializer that throws on a custom material — the frame
// sequence is still there, and the capture says which one it fell back to and why.

/** Past this a scene is mostly baked textures, and keeping it helps nobody. */
const MAX_SCENE_BYTES = 12 * 1024 * 1024;

export interface SceneCapture {
	ok: boolean;
	engine: "three" | "babylon" | "";
	/** The library's own version string, so the right build is vendored to replay it. */
	version: string;
	/** The serialized scene, as the library wrote it. */
	scene: string;
	camera: string;
	/** Renderer settings that change how it looks: tone mapping, colour space, alpha. */
	renderer: Record<string, unknown>;
	note: string;
}

/**
 * Installed before the page's scripts, like the WebGL hook.
 *
 * The devtools channel is the whole trick for three.js: the library checks for that global
 * and dispatches to it, so being there first is the difference between having the scene and
 * having a canvas. Babylon has no such channel, so it is found afterwards through its own
 * global instead.
 */
export const SCENE_HOOK_SCRIPT = String.raw`(() => {
	if (window.__brainScene) return;
	const found = { renderers: [], scenes: [], engine: "" };
	window.__brainScene = found;
	try {
		const channel = new EventTarget();
		channel.addEventListener("observe", (event) => {
			const object = event.detail;
			if (!object) return;
			// A renderer has a domElement; a scene has children. Nothing else three.js
			// announces is of any use here.
			if (object.domElement && object.render) found.renderers.push(object);
			else if (object.isScene || (object.type === "Scene" && object.children)) found.scenes.push(object);
			found.engine = "three";
		});
		Object.defineProperty(window, "__THREE_DEVTOOLS__", {
			value: channel,
			configurable: true,
			writable: true,
		});
	} catch (e) {
		found.engine = "";
	}
})()`;

/**
 * Read the scene back out, after the page has built it.
 *
 * Serialization is the library's, not ours: three.js and babylon both know how to write
 * their own state, including the GLSL of a custom material and the uniforms driving it.
 * Reimplementing that would be a second, worse serializer that breaks on the first unusual
 * material it meets.
 */
export const SCENE_READ_SCRIPT = String.raw`(() => {
	const empty = { ok: false, engine: "", version: "", scene: "", camera: "", renderer: {}, note: "" };
	const found = window.__brainScene;

	// three.js, through the devtools channel the hook installed.
	if (found && found.scenes.length) {
		try {
			const scene = found.scenes[found.scenes.length - 1];
			const renderer = found.renderers[found.renderers.length - 1];
			const json = JSON.stringify(scene.toJSON());
			if (json.length > ${MAX_SCENE_BYTES}) {
				return { ...empty, engine: "three", note: "the scene serializes to " + Math.round(json.length / 1048576) + " MB, which is too much to keep" };
			}
			let camera = "";
			// The camera is not part of the scene graph unless the author added it, so it is
			// taken off the renderer's last render call where possible.
			try {
				const cam = renderer && renderer.__brainCamera ? renderer.__brainCamera : null;
				if (cam && cam.toJSON) camera = JSON.stringify(cam.toJSON());
			} catch (e) { /* no camera to be had */ }
			return {
				ok: true,
				engine: "three",
				version: (window.THREE && window.THREE.REVISION) || (renderer && renderer.info && renderer.info.render ? "" : "") || "",
				scene: json,
				camera: camera,
				renderer: renderer ? {
					alpha: !!(renderer.getContext && renderer.getContext().getContextAttributes && renderer.getContext().getContextAttributes().alpha),
					toneMapping: renderer.toneMapping,
					toneMappingExposure: renderer.toneMappingExposure,
					outputColorSpace: renderer.outputColorSpace || renderer.outputEncoding,
					clearColor: (() => { try { return "#" + renderer.getClearColor(new window.THREE.Color()).getHexString(); } catch (e) { return ""; } })(),
					clearAlpha: (() => { try { return renderer.getClearAlpha(); } catch (e) { return 1; } })(),
					pixelRatio: renderer.getPixelRatio ? renderer.getPixelRatio() : 1,
				} : {},
				note: "",
			};
		} catch (e) {
			return { ...empty, engine: "three", note: "three.js refused to serialize its scene: " + String(e && e.message || e) };
		}
	}

	// babylon, through its own global.
	try {
		const B = window.BABYLON;
		if (B && B.Engine && B.Engine.Instances && B.Engine.Instances.length) {
			const engine = B.Engine.Instances[B.Engine.Instances.length - 1];
			const scene = engine.scenes && engine.scenes[engine.scenes.length - 1];
			if (scene && B.SceneSerializer) {
				const json = JSON.stringify(B.SceneSerializer.Serialize(scene));
				if (json.length > ${MAX_SCENE_BYTES}) {
					return { ...empty, engine: "babylon", note: "the scene is too large to keep" };
				}
				return { ok: true, engine: "babylon", version: B.Engine.Version || "", scene: json, camera: "", renderer: {}, note: "" };
			}
		}
	} catch (e) {
		return { ...empty, engine: "babylon", note: "babylon refused to serialize its scene: " + String(e && e.message || e) };
	}

	return { ...empty, note: found && found.engine ? "an engine was seen but published no scene" : "" };
})()`;

/** Where the library itself is fetched from, pinned by the version the page reported. */
export function libraryUrl(capture: SceneCapture): string | null {
	if (capture.engine === "three") {
		const revision = String(capture.version || "").replace(/[^0-9]/g, "");
		// A revision we could not read means we cannot promise the same build, and a scene
		// replayed by the wrong major version of three.js is worse than a frame sequence.
		if (!revision) return null;
		return `https://cdnjs.cloudflare.com/ajax/libs/three.js/r${revision}/three.min.js`;
	}
	if (capture.engine === "babylon") {
		return "https://cdn.babylonjs.com/babylon.js";
	}
	return null;
}

/**
 * The runtime that renders the captured scene. Ours, as always: the page's own code is
 * never shipped, and what the library is handed is a description of a scene.
 */
export function sceneRuntime(capture: SceneCapture, libraryHref: string, sceneHref: string): string {
	if (capture.engine === "babylon") {
		return `// Written by claude-brain. The scene below was serialized out of the captured page.
(() => {
	const canvas = document.querySelector("canvas[data-hero-scene]");
	if (!canvas) return;
	const load = (src) => new Promise((resolve, reject) => {
		const tag = document.createElement("script");
		tag.src = src;
		tag.onload = resolve;
		tag.onerror = reject;
		document.head.appendChild(tag);
	});
	load(${JSON.stringify(libraryHref)})
		.then(() => fetch(${JSON.stringify(sceneHref)}).then((r) => r.text()))
		.then((json) => {
			const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: false });
			BABYLON.SceneLoader.Load("", "data:" + json, engine, (scene) => {
				engine.runRenderLoop(() => scene.render());
				window.addEventListener("resize", () => engine.resize());
			});
		})
		.catch((err) => console.warn("[hero] the scene could not be replayed:", err));
})();
`;
	}

	const renderer = capture.renderer ?? {};
	return `// Written by claude-brain. The scene below was serialized out of the captured page
// by three.js itself, and is replayed here by the same version of three.js.
(() => {
	const canvas = document.querySelector("canvas[data-hero-scene]");
	if (!canvas) return;

	const load = (src) => new Promise((resolve, reject) => {
		const tag = document.createElement("script");
		tag.src = src;
		tag.onload = resolve;
		tag.onerror = reject;
		document.head.appendChild(tag);
	});

	load(${JSON.stringify(libraryHref)})
		.then(() => fetch(${JSON.stringify(sceneHref)}).then((r) => r.json()))
		.then((json) => {
			const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: ${renderer.alpha === false ? "false" : "true"} });
			renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
			${typeof renderer.toneMapping === "number" ? `renderer.toneMapping = ${renderer.toneMapping};` : ""}
			${typeof renderer.toneMappingExposure === "number" ? `renderer.toneMappingExposure = ${renderer.toneMappingExposure};` : ""}
			${renderer.clearColor ? `renderer.setClearColor(${JSON.stringify(renderer.clearColor)}, ${Number(renderer.clearAlpha ?? 1)});` : ""}

			const scene = new THREE.ObjectLoader().parse(json);
			// The captured page kept its camera outside the scene graph more often than not.
			// One inside it is used as found; otherwise a camera is made to frame the scene,
			// which is what makes this resize properly instead of cropping like a picture.
			let camera = null;
			scene.traverse((object) => { if (!camera && object.isCamera) camera = object; });
			if (!camera) camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);

			const fit = () => {
				const rect = canvas.getBoundingClientRect();
				const width = Math.max(1, rect.width);
				const height = Math.max(1, rect.height);
				renderer.setSize(width, height, false);
				if (camera.isPerspectiveCamera) {
					camera.aspect = width / height;
				} else if (camera.isOrthographicCamera) {
					const half = (camera.top - camera.bottom) / 2;
					camera.left = -half * (width / height);
					camera.right = half * (width / height);
				}
				camera.updateProjectionMatrix();
			};
			window.addEventListener("resize", fit);
			fit();

			// Anything the scene declared as a clock keeps ticking, so a shader that animates
			// on time animates here too rather than freezing on its first frame.
			const clocks = [];
			scene.traverse((object) => {
				const uniforms = object.material && object.material.uniforms;
				if (!uniforms) return;
				for (const name of Object.keys(uniforms)) {
					if (/^(u_?)?(time|iTime|elapsed)$/i.test(name)) clocks.push(uniforms[name]);
					if (/resolution/i.test(name) && uniforms[name].value && uniforms[name].value.set) {
						uniforms[name].value.set(canvas.width, canvas.height);
					}
				}
			});

			const started = performance.now();
			const frame = () => {
				const seconds = (performance.now() - started) / 1000;
				for (const clock of clocks) clock.value = seconds;
				renderer.render(scene, camera);
				requestAnimationFrame(frame);
			};
			requestAnimationFrame(frame);
		})
		.catch((err) => console.warn("[hero] the scene could not be replayed:", err));
})();
`;
}

/** What the model is told, when the scene itself was taken. */
export function renderSceneEvidence(capture: SceneCapture): string {
	if (!capture.ok) return "";
	const engine = capture.engine === "three" ? "three.js" : "babylon.js";
	return [
		"## The moving background is a 3D scene, and the scene itself has been taken",
		"",
		`The page renders it with ${engine}${capture.version ? ` ${capture.version}` : ""}. Not a picture of it and not a`,
		"frame sequence: the scene was serialized by the library's own serializer, the matching",
		"build of the library is stored beside this rebuild, and a runtime this brain wrote",
		"renders it again. That means it resizes properly at any window size and animates on its",
		"own clock, the way the original does.",
		"",
		"You write none of that. Put the canvas it looks for where the page had one:",
		"",
		"```html",
		"<canvas data-hero-scene></canvas>",
		"```",
		"",
		"Size and position it exactly as the captured canvas was. Give it no CSS animation, no",
		"filter, and no background image: it draws itself.",
	].join("\n");
}
