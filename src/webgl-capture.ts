// Taking a page's shader, not a photograph of it.
//
// A still of a WebGL hero, drifted slowly with a CSS transform, is a decent impression and
// obviously not the thing: the real one is a fragment shader running every frame, and what
// it does over time is the design. A photograph cannot carry that and neither can a
// stylesheet, because the movement is not declared anywhere. It is compiled.
//
// So the shader is taken instead. Before the page's own scripts run, `shaderSource`,
// `createShader`, `linkProgram` and the `uniform*` family are wrapped, and everything they
// are handed is recorded: the vertex and fragment GLSL verbatim, which pair was linked, and
// which uniforms change from frame to frame — the last being how the time input is found
// without being told which name the author used (u_time, iTime, uTime, time…).
//
// Three things this is careful about:
//
//   It runs before the page. `Page.addScriptToEvaluateOnNewDocument` is the only hook that
//   beats a bundle to `getContext`, and a wrapper installed after the fact sees nothing —
//   the shaders were compiled during load and never compiled again.
//
//   It records, it does not interfere. Every wrapper calls through and returns what the
//   original returned. A capture that changes what the page draws is measuring itself.
//
//   GLSL is data, not code we run. It is compiled later by our own runtime, in the viewer's
//   browser, where a shader can draw pixels into one canvas and can do nothing else: no DOM,
//   no network, no storage. That is what makes shipping a stranger's shader reasonable when
//   shipping a stranger's JavaScript is not.

export interface CapturedShader {
	kind: "vertex" | "fragment" | "unknown";
	source: string;
}

export interface CapturedUniform {
	name: string;
	/** How many times it was set. A per-frame uniform is the animation's input. */
	writes: number;
	first: number[];
	last: number[];
	/** Rises steadily across frames, so almost certainly the clock. */
	looksLikeTime: boolean;
}

export interface WebglCapture {
	ok: boolean;
	/** The canvas it drew into, in page coordinates. */
	canvas: { width: number; height: number } | null;
	shaders: CapturedShader[];
	uniforms: CapturedUniform[];
	drawCalls: number;
	/** Set when the page uses WebGL in a shape this cannot reproduce. */
	note: string;
}

const MAX_SHADER_CHARS = 32_000;
/**
 * How a canvas is recorded.
 *
 * Not with MediaRecorder. It is present in headless Chromium, `isTypeSupported` answers
 * true for every WebM codec, the captured track reports itself live — and the recorder
 * emits a single zero-byte chunk, because there is no video encoder in that build. So the
 * frames are photographed one at a time through the debugging protocol instead, as JPEG so
 * that two dozen of them are hundreds of kilobytes rather than ten megabytes, and played
 * back by a loop this package ships.
 *
 * The spacing is deliberate: SwiftShader draws these scenes at roughly twelve frames a
 * second, so asking more often than this photographs the same frame twice.
 */
export const FRAME_COUNT = 20;
export const FRAME_INTERVAL_MS = 130;
/** Frames are captured at half size; a background is soft and nobody counts its pixels. */
export const FRAME_SCALE = 0.5;

/**
 * Installed before the page's own scripts. Everything it collects hangs off one global
 * whose name nothing else would choose, read back after the page has settled.
 */
export const WEBGL_HOOK_SCRIPT = String.raw`(() => {
	if (window.__brainGl) return;
	// A WebGL canvas throws its pixels away after each frame unless asked not to, and
	// toDataURL on one comes back blank. The capture needs to read what the canvas drew —
	// photographing the rectangle instead catches everything the page put on top of it, which
	// is how a hero ended up with the site's own headline baked into its background. Asking
	// for it here, before the page makes its context, is the only moment it can be asked.
	const getContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, attributes) {
		if (/webgl/i.test(String(type))) {
			return getContext.call(this, type, Object.assign({}, attributes || {}, { preserveDrawingBuffer: true }));
		}
		return getContext.apply(this, arguments);
	};
	const rec = {
		shaders: [],
		uniforms: new Map(),
		draws: 0,
		canvas: null,
		frames: 0,
		note: "",
	};
	window.__brainGl = rec;

	const kinds = new WeakMap();
	const names = new WeakMap();

	const cap = (s) => (s == null ? "" : String(s).slice(0, ${MAX_SHADER_CHARS}));

	const wrapContext = (proto, constants) => {
		if (!proto || proto.__brainWrapped) return;
		proto.__brainWrapped = true;

		const createShader = proto.createShader;
		proto.createShader = function (type) {
			const shader = createShader.call(this, type);
			if (shader) kinds.set(shader, type === constants.VERTEX_SHADER ? "vertex" : type === constants.FRAGMENT_SHADER ? "fragment" : "unknown");
			return shader;
		};

		const shaderSource = proto.shaderSource;
		proto.shaderSource = function (shader, source) {
			try {
				rec.shaders.push({ kind: kinds.get(shader) || "unknown", source: cap(source) });
			} catch (e) { /* a page that froze its own objects */ }
			return shaderSource.call(this, shader, source);
		};

		const getUniformLocation = proto.getUniformLocation;
		proto.getUniformLocation = function (program, name) {
			const location = getUniformLocation.call(this, program, name);
			if (location) names.set(location, String(name));
			return location;
		};

		// Every uniform setter, recorded the same way: which name, how often, and what it
		// went from and to. A value that climbs every frame is the clock.
		for (const method of ["uniform1f", "uniform2f", "uniform3f", "uniform4f", "uniform1i", "uniform2i", "uniform1fv", "uniform2fv", "uniform3fv", "uniform4fv"]) {
			const original = proto[method];
			if (!original) continue;
			proto[method] = function (location, ...args) {
				try {
					const name = names.get(location);
					if (name) {
						const value = args.length === 1 && args[0] && typeof args[0].length === "number"
							? Array.from(args[0]).slice(0, 4).map(Number)
							: args.slice(0, 4).map(Number);
						const seen = rec.uniforms.get(name);
						if (seen) { seen.writes++; seen.last = value; }
						else rec.uniforms.set(name, { name: name, writes: 1, first: value, last: value });
					}
				} catch (e) { /* never break the page's own draw */ }
				return original.apply(this, [location, ...args]);
			};
		}

		for (const method of ["drawArrays", "drawElements"]) {
			const original = proto[method];
			if (!original) continue;
			proto[method] = function (...args) {
				rec.draws++;
				if (this.canvas && !rec.canvas) rec.canvas = { width: this.canvas.width, height: this.canvas.height };
				return original.apply(this, args);
			};
		}
	};

	try {
		if (window.WebGLRenderingContext) wrapContext(WebGLRenderingContext.prototype, WebGLRenderingContext);
		if (window.WebGL2RenderingContext) wrapContext(WebGL2RenderingContext.prototype, WebGL2RenderingContext);
	} catch (e) {
		rec.note = "the page's WebGL objects could not be wrapped";
	}
})()`;

/** Read the recording back out of the page, after it has been running for a while. */
export const WEBGL_READ_SCRIPT = String.raw`(() => {
	const rec = window.__brainGl;
	if (!rec) return { ok: false, canvas: null, shaders: [], uniforms: [], drawCalls: 0, note: "the hook never ran" };
	const uniforms = Array.from(rec.uniforms.values()).map((u) => {
		// A single scalar that only ever went up, over many writes, is a clock.
		const rising = u.writes > 8 && u.first.length === 1 && u.last.length === 1 && u.last[0] > u.first[0];
		return { name: u.name, writes: u.writes, first: u.first, last: u.last, looksLikeTime: !!rising };
	}).sort((a, b) => b.writes - a.writes).slice(0, 16);
	return {
		ok: rec.shaders.length > 0,
		canvas: rec.canvas,
		shaders: rec.shaders.slice(0, 6),
		uniforms: uniforms,
		drawCalls: rec.draws,
		note: rec.note || (rec.draws === 0 ? "shaders were compiled but nothing was drawn" : ""),
	};
})()`;

/**
 * Can this shader be put back by compiling it, or does it need the whole engine?
 *
 * A background written as one full-screen quad — a gradient, a noise field, a plasma — is
 * two shaders and a couple of uniforms, and recompiling it reproduces the original exactly.
 * A Three.js scene is not: its shaders want geometry, normals, UVs, camera matrices and
 * textures, none of which are in the GLSL, and the largest of them do not even fit in what
 * we keep. Raycast's hero is the second kind, which is how this check earned its place.
 */
export function isQuadShader(capture: WebglCapture): boolean {
	if (!capture.ok) return false;
	const fragment = capture.shaders.find((s) => s.kind === "fragment");
	const vertex = capture.shaders.find((s) => s.kind === "vertex");
	if (!fragment || !vertex) return false;
	// More than one program means more than one thing being drawn.
	if (capture.shaders.length > 2) return false;
	const glsl = `${vertex.source}\n${fragment.source}`;
	// Anything that wants a scene rather than a rectangle.
	if (/\b(modelViewMatrix|projectionMatrix|normalMatrix|cameraPosition|sampler2D|samplerCube|texture2D|texture\s*\()/.test(glsl)) return false;
	return true;
}

/**
 * The runtime that puts the shader back. Written by this package, not by a model: the
 * rebuild places an empty `<canvas data-hero-shader>` and this compiles the captured GLSL
 * into it. The document therefore contains exactly one piece of executable code, and it is
 * ours, with the shader as its data.
 *
 * Deliberately forgiving. A shader lifted out of someone's bundle may want attributes or
 * textures that are not here; when compilation or linking fails the canvas is left
 * transparent and whatever the stylesheet put behind it — the photographed still — shows
 * through. A wrong-looking hero is a bad copy; a black hole where the hero was is a broken
 * page.
 */
/**
 * Play a captured frame sequence back where the canvas was.
 *
 * Ping-pong rather than a hard loop: twenty frames of a drifting scene do not join up at
 * the ends, and a jump every two and a half seconds is more noticeable than the slight
 * unnaturalness of running the sequence backwards. Preloaded before the first swap, so the
 * animation does not stutter its way through the first cycle.
 */
/** In-page: what the n-th canvas is showing, as a data URL, or "" when it cannot be read. */
export function canvasPixelsScript(index: number, type = "image/jpeg", quality = 0.74): string {
	return `(() => {
		try {
			const canvas = document.querySelectorAll("canvas")[${index}];
			if (!canvas || !canvas.width || !canvas.height) return "";
			return canvas.toDataURL(${JSON.stringify(type)}, ${quality});
		} catch (e) {
			// A canvas holding an image from somewhere else is tainted and will not be read.
			return "";
		}
	})()`;
}

export function framePlayerRuntime(frameHrefs: string[], intervalMs: number): string {
	return `// Written by claude-brain. These frames were photographed off the captured page.
(() => {
	const FRAMES = ${JSON.stringify(frameHrefs)};
	const INTERVAL = ${intervalMs};
	const target = document.querySelector("[data-hero-frames]");
	if (!target || FRAMES.length < 2) return;

	let loaded = 0;
	const images = FRAMES.map((src) => {
		const img = new Image();
		img.onload = () => { loaded++; };
		img.src = src;
		return img;
	});

	let index = 0;
	let step = 1;
	// One frame filling the element. Without this the browser's defaults apply — repeat, at
	// the image's own size — and a hero whose frames are smaller than it is comes out as a
	// mosaic of little copies of itself.
	target.style.backgroundRepeat = "no-repeat";
	target.style.backgroundSize = "100% 100%";
	target.style.backgroundPosition = "center";
	const paint = () => {
		target.style.backgroundImage = "url(" + FRAMES[index] + ")";
		index += step;
		if (index >= FRAMES.length - 1 || index <= 0) step = -step;
	};

	// Nothing moves until the whole sequence is in memory, and nothing moves at all for a
	// viewer who asked their system not to animate things.
	const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	paint();
	if (reduced) return;
	const start = () => { setInterval(paint, INTERVAL); };
	if (loaded >= FRAMES.length) start();
	else setTimeout(start, 1200);
})();
`;
}

export function heroRuntime(capture: WebglCapture): string {
	const vertex = capture.shaders.find((s) => s.kind === "vertex")?.source ?? "";
	const fragment = capture.shaders.find((s) => s.kind === "fragment")?.source ?? "";
	const timeUniform = capture.uniforms.find((u) => u.looksLikeTime)?.name ?? "";
	const resolutionUniform =
		capture.uniforms.find((u) => /resolution|viewport|size/i.test(u.name) && u.last.length >= 2)?.name ?? "";

	return `// Written by claude-brain. The shader below was read out of the captured page.
(() => {
	const VERTEX = ${JSON.stringify(vertex)};
	const FRAGMENT = ${JSON.stringify(fragment)};
	const TIME_UNIFORM = ${JSON.stringify(timeUniform)};
	const RESOLUTION_UNIFORM = ${JSON.stringify(resolutionUniform)};

	const canvas = document.querySelector("canvas[data-hero-shader]");
	if (!canvas || !VERTEX || !FRAGMENT) return;

	const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
	if (!gl) return;

	const compile = (type, source) => {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.warn("[hero] shader would not compile:", gl.getShaderInfoLog(shader));
			return null;
		}
		return shader;
	};

	const vs = compile(gl.VERTEX_SHADER, VERTEX);
	const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
	if (!vs || !fs) return;

	const program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		console.warn("[hero] shader would not link:", gl.getProgramInfoLog(program));
		return;
	}
	gl.useProgram(program);

	// A full-screen quad, which is what a background shader draws onto. Every attribute the
	// program declares is fed the same two triangles: a shader written for a quad uses one,
	// and one written for something else will look wrong rather than fail, which is the
	// better of the two outcomes.
	const quad = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const attributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
	for (let i = 0; i < attributes; i++) {
		const info = gl.getActiveAttrib(program, i);
		if (!info) continue;
		const location = gl.getAttribLocation(program, info.name);
		if (location < 0) continue;
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
	}

	const uniform = (name) => (name ? gl.getUniformLocation(program, name) : null);
	const timeLocation = uniform(TIME_UNIFORM);
	const resolutionLocation = uniform(RESOLUTION_UNIFORM);

	const resize = () => {
		const rect = canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.max(1, Math.round(rect.width * dpr));
		canvas.height = Math.max(1, Math.round(rect.height * dpr));
		gl.viewport(0, 0, canvas.width, canvas.height);
		if (resolutionLocation) gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
	};
	window.addEventListener("resize", resize);
	resize();

	const started = performance.now();
	const frame = () => {
		if (timeLocation) gl.uniform1f(timeLocation, (performance.now() - started) / 1000);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
})();
`;
}

/** What the model is told about the shader, so it places the canvas and leaves it alone. */
export function renderWebglEvidence(capture: WebglCapture, recordingHref?: string): string {
	if (!capture.ok) return "";
	const header = [
		"## The moving background is WebGL, and it has been taken",
		"",
		`The page draws it with ${capture.shaders.length} shaders and ${capture.drawCalls} draw calls` +
			`${capture.canvas ? `, into a ${capture.canvas.width}×${capture.canvas.height} canvas` : ""}.` +
			`${capture.note ? ` (${capture.note})` : ""}`,
		"",
	];
	const lines = isQuadShader(capture)
		? header.concat([
				"It is a single full-screen shader, so the GLSL itself has been saved and this brain",
				"ships a runtime that compiles it back. You write none of that. Put an empty canvas",
				"where the page had one:",
				"",
				"```html",
				"<canvas data-hero-shader></canvas>",
				"```",
				"",
				"Size and position it exactly as the captured canvas was, give it the photographed",
				"still as its CSS `background-image` so the area is right even if the shader cannot",
				"run, and put no CSS animation on it. The shader is the movement.",
			])
		: header.concat([
				"It is a whole scene rather than one shader — geometry, camera matrices and textures",
				"that are not in the GLSL — so recompiling it is not possible. It has been filmed",
				"instead: the assets below carry a sequence of frames photographed off the running",
				"canvas, and this brain ships a loop that plays them back at the speed they were",
				"taken. You write none of that. Put the element it looks for where the canvas was:",
				"",
				"```html",
				'<div data-hero-frames></div>',
				"```",
				"",
				"Size and position it exactly as the captured canvas was, give it the first frame as",
				`its CSS \`background-image\`${recordingHref ? ` (\`${recordingHref}\`)` : ""} with`,
				"`background-size: cover`, and add no animation of your own. The frames are the",
				"movement, and a CSS animation on top of them fights it.",
			]);
	if (capture.uniforms.length) {
		lines.push("", "Uniforms it drives, most written first:");
		for (const u of capture.uniforms.slice(0, 6)) {
			lines.push(`- \`${u.name}\` ×${u.writes}${u.looksLikeTime ? " (the clock)" : ""}`);
		}
	}
	return lines.join("\n");
}
