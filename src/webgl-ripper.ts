// Taking the draw calls themselves, so the rebuild renders the scene rather than replaying
// pictures of it.
//
// The three earlier attempts at this each failed for a reason worth keeping:
//
//   Recompile the shader.   Works for a single full-screen quad and nothing else. A real
//                           scene's shaders want geometry, normals, UVs and camera matrices
//                           that are nowhere in the GLSL.
//   Ask the engine.         three.js publishes its scenes to `__THREE_DEVTOOLS__` and
//                           babylon keeps them on a global. Raycast's bundle does neither:
//                           no global, no devtools dispatch, and the scene is closure-bound
//                           where even a walk of the React fiber tree cannot reach it.
//   Photograph the frames.  Works on anything, and is a picture: fixed size, crops instead
//                           of re-rendering, deaf to the pointer.
//
// What every one of them has in common is a layer underneath: whatever built the scene, it
// ends up calling `bufferData`, `texImage2D`, `uniformMatrix4fv` and `drawElements` on a
// context we can wrap. That boundary is engine-agnostic by construction — three.js, babylon,
// ogl, a hand-written loop, all of them come through it — and everything needed to draw the
// same frame again passes through it too.
//
// So this records a frame: every buffer as it is uploaded, every texture, every linked
// program with its GLSL, the uniform values in force, and then one complete frame of draw
// calls with the exact attribute layout each one binds. The runtime re-uploads all of it and
// draws the same calls, every frame, at whatever size the canvas happens to be.
//
// The approach is WebGLRipper's, which does this to export meshes. Replaying is a different
// job from exporting and a simpler one: nothing has to be de-interleaved into an OBJ, so the
// buffers are kept exactly as the page uploaded them and handed back verbatim.
//
// Known limits, stated because a capture that overclaims is worse than one that fails:
// render-to-texture passes are recorded as ordinary draws and replayed against the default
// framebuffer, so a multi-pass effect (a transmission material sampling the scene behind it)
// will look flatter than the original; instanced draws are recorded but replayed as single
// draws; and a texture uploaded from a video is frozen at the frame it was taken.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Ceilings. A hero scene is a few megabytes; anything past this is a game. */
const MAX_TOTAL_BUFFER_BYTES = 24 * 1024 * 1024;
const MAX_TEXTURES = 12;
const MAX_TEXTURE_EDGE = 2048;
const MAX_DRAW_CALLS = 160;
/**
 * How many frames the scene must have DRAWN before the one that is kept.
 *
 * Counted in frames that actually issued draws, not in animation-frame ticks. The
 * difference is the whole bug it fixes: a page's rAF loop starts long before its scene
 * does, so "record after four ticks" captured the very first frame three.js ever rendered —
 * the one where the backdrop still had an all-zero model matrix and a resolution of 0×0,
 * because the material had not been updated yet. Everything downstream then looked broken
 * for reasons that were not there: a backdrop that projected to two pixels, glass with
 * nothing to refract, and a black canvas with no failing call in sight.
 *
 * Each drawing frame replaces the last, so what survives is the most recent complete one.
 */
const SETTLE_DRAW_FRAMES = 5;
/**
 * And how long after the scene's first draw before any frame is kept.
 *
 * Frames alone are not enough. A hero like this plays an intro — the backdrop springs up
 * from nothing over a second or two — so the fifth drawn frame catches it at three per cent
 * of its final size, and the replay faithfully reproduces a scene caught mid-animation.
 * Software rasterisation runs at a few frames a second, so the two conditions measure
 * different things and both have to hold.
 */
const SETTLE_MS = 6_000;
/**
 * How many settled frames are kept after the first.
 *
 * One frame is a photograph. A page's scene moves in ways its shaders do not: on this hero
 * the backdrop's scale creeps (0.131 → 0.136 → 0.144 over four seconds) and the glass's
 * distortion and temporalDistortion climb with it. Replaying one frame's transforms with
 * only the shader clock running gives a scene that shimmers in place instead of drifting.
 * Several frames give each uniform a short history, which the replay extends.
 */
const TIMELINE_FRAMES = 24;
/**
 * Each phase is bounded by time as well as by frames, because the frame rate is not ours to
 * predict: software rasterisation renders this scene about twice a second, so twenty-four
 * timeline samples is fifty seconds — longer than the read is willing to wait, and the whole
 * capture came back as a failure with nothing to say for itself.
 */
const TIMELINE_MS = 12_000;
/**
 * Samples kept from before the scene settles — the entrance.
 *
 * These pages play an intro: the backdrop springs up from nothing over a second or two and
 * then settles into a slow loop. Every frame before settling used to be discarded, which is
 * why the replay opened already in its resting state and the arrival was missing. They are
 * kept now and played once, before the loop takes over.
 */
const INTRO_SAMPLES = 60;
/**
 * How much the page's own clock is slowed while the entrance plays.
 *
 * Software rasterisation renders these scenes at about one frame a second, so an intro that
 * lasts a second and a half is captured in one or two samples — which is why the replayed
 * arrival looked nothing like the real one. The page's clock is slowed instead, so the same
 * slow capture takes many samples per second of animation. Everything is recorded against
 * that clock, so the replay plays the entrance back at its true speed.
 */
const INTRO_TIME_RATE = 0.12;
const STREAM_MS = 8_000;
/**
 * How many frames of the raw command stream are recorded.
 *
 * Sampling state — one frame, plus a few uniform values over time — models a scene. Recording
 * the calls reproduces it. Whatever the engine did between two frames arrives as the calls it
 * actually made: a morphed buffer, a camera that moved, a pass that only runs every other
 * frame. That is the difference between replaying a scene we understood and replaying one we
 * did not have to.
 */
const STREAM_FRAMES = 12;
/** Per-frame buffer re-uploads are the expensive part; this caps what the stream may carry. */
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
/** How long the read waits for a frame to be recorded, in real time rather than frames. */
/**
 * How long the read waits for the capture to finish.
 *
 * Generous because the entrance is deliberately stretched: slowing the page's clock to
 * capture it densely means the settle, which is measured in the page's own seconds, takes
 * several times that in real ones.
 */
const READ_WAIT_MS = 150_000;

export interface RippedFrame {
	ok: boolean;
	/** Why there is nothing here, when there is nothing here. */
	note: string;
	canvas: { width: number; height: number } | null;
	webgl2: boolean;
	programs: Array<{ id: number; handle: number; vertex: string; fragment: string }>;
	buffers: Array<{ id: number; handle: number; data: string; byteLength: number }>;
	textures: Array<{
		id: number;
		handle: number;
		/** A PNG data URI, when the page uploaded an image. */
		source: string;
		/** Base64 pixels, when it uploaded a typed array. */
		data: string;
		width: number;
		height: number;
		internalFormat: number;
		format: number;
		pixelType: number;
		/** Allocated with texStorage2D, so the replay must allocate it the same way. */
		storage: boolean;
		wrapS: number;
		wrapT: number;
		minFilter: number;
	}>;
	/** The page was stopped on the captured frame, so its canvas still shows it. */
	frozen: boolean;
	/** The entrance: samples from before the scene settled, played once on load. */
	intro: Array<{ t: number; uniforms: Array<Array<{ name: string; kind: string; value: Array<number | string>; texture: number }>> }>;
	/**
	 * A few seconds of the scene's own motion: the same draws, sampled over consecutive
	 * frames, so the replay can move the way the page moves rather than sitting still.
	 */
	timeline: Array<{ t: number; uniforms: Array<Array<{ name: string; kind: string; value: Array<number | string>; texture: number }>> }>;
	/**
	 * What the pointer does to the scene. The cursor is driven across a grid during capture
	 * and the uniforms are read at each stop, so a scene that follows the mouse can follow
	 * the viewer's mouse instead of sitting at whatever position the capture happened to
	 * leave it in.
	 */
	pointer: Array<{ x: number; y: number; uniforms: Array<Array<{ name: string; kind: string; value: Array<number | string>; texture: number }>> }>;
	/**
	 * The raw call log: every state change, upload and draw the page made over a dozen
	 * frames, in order, with frame markers. Replaying this reproduces whatever the engine
	 * was doing rather than a model of it.
	 */
	stream: Array<{ f: string; a: Array<number | boolean | null | { handle?: number; data?: string; kind?: string; drop?: boolean }> }>;
	/** Uniform locations by name, so the replay can resolve them on its own programs. */
	locationNames: Array<{ handle: number; program: number; name: string }>;
	handles: number;
	/** Extensions the page enabled, which the replay has to enable too. */
	extensions: string[];
	/**
	 * Render targets: a pass draws into one, a later pass samples its colour attachment. The
	 * formats are the page's own — a half-float buffer replayed as eight bits bands.
	 */
	framebuffers: Array<{
		id: number;
		handle: number;
		colour: number;
		colourFormat?: {
			internalFormat: number;
			format: number;
			pixelType: number;
			storage: boolean;
			minFilter: number;
			magFilter: number;
			wrapS: number;
			wrapT: number;
		} | null;
		/** The depth attachment's internal format; 0 when the target had none. */
		depthFormat?: number;
	}>;
	/** What getContextAttributes() said: antialiasing, alpha, a preserved drawing buffer. */
	contextAttributes?: Record<string, unknown> | null;
	/** The canvas's CSS box at the kept frame, so pixel ratio and resolution uniforms are known. */
	canvasCss?: { width: number; height: number } | null;
	devicePixelRatio?: number;
	draws: Array<{
		/** Which recorded frame this draw belonged to; the earliest is setup. */
		frame: number;
		/** The framebuffer this pass drew into; 0 is the screen. */
		target: number;
		/** Which texture was in which unit when the pass ran. */
		units: Array<{ unit: number; texture: number }>;
		/** Uniform buffer bindings in force, and how this program maps blocks onto them. */
		ubos: Array<{ binding: number; buffer: number; offset: number; size: number }>;
		blocks: Array<{ block: number; name: string; binding: number }>;
		program: number;
		mode: number;
		count: number;
		indexType: number;
		offset: number;
		indexBuffer: number;
		instances: number;
		attribs: Array<{
			name: string;
			/** The GLSL type constant, so a mat4 attribute is bound as four columns. */
			glslType: number;
			location: number;
			buffer: number;
			size: number;
			type: number;
			stride: number;
			offset: number;
			normalized: boolean;
			divisor: number;
		}>;
		/** Values are numbers, or "Infinity" / "-Infinity" / "NaN" where JSON cannot carry them. */
		uniforms: Array<{ name: string; kind: string; value: Array<number | string>; texture: number }>;
		state: {
			depthTest: boolean;
			depthMask: boolean;
			depthFunc: number;
			blend: boolean;
			blendSrc: number;
			blendDst: number;
			blendSrcAlpha: number;
			blendDstAlpha: number;
			blendEquation: number;
			cullFace: boolean;
			cullMode: number;
			frontFace: number;
			colorMask: boolean[];
			viewport: number[];
			clearColor: number[];
		};
	}>;
	stats: {
		buffersSeen: number;
		texturesSeen: number;
		drawsInFrame: number;
		droppedBytes: number;
		/** Every draw the wrapper saw, recorded or not — the difference is the arming. */
		drawsSeen?: number;
		frames?: number;
		armed?: boolean;
		done?: boolean;
	};
}

/**
 * The hook. Installed before any of the page's scripts, it shadows every upload and then
 * records exactly one frame of draw calls once the scene has settled.
 *
 * Every wrapper calls through and returns what the original returned. A capture that changes
 * what the page draws is measuring itself.
 */
export const RIPPER_HOOK_SCRIPT = String.raw`(() => {
	if (window.__brainRip) return;

	const rip = {
		armed: false,
		done: false,
		frames: 0,
		buffers: new Map(),      // WebGLBuffer -> { id, bytes, byteLength }
		bufferIds: new Map(),
		textures: new Map(),     // WebGLTexture -> { id, source, width, height, ... }
		framebuffers: new Map(), // WebGLFramebuffer -> { id, colour: textureId, width, height }
		programs: new Map(),     // WebGLProgram -> { id, vertex, fragment }
		shaders: new WeakMap(),  // WebGLShader -> { kind, source }
		locations: new WeakMap(),
		locationNames: [],// WebGLUniformLocation -> name
		uniformState: new Map(), // program id -> Map(name -> { kind, value, texture })
		draws: [],
		canvas: null,
		webgl2: false,
		droppedBytes: 0,
		totalBytes: 0,
		drawsSeen: 0,
		drawFrames: 0,
		lastDrawFrame: -1,
		firstDrawAt: 0,
		frozen: false,
		collecting: false,
		intro: [],
		rate: 1,
		collectingSince: 0,
		streamingSince: 0,
		reference: null,
		timeline: [],
		// Pointer sampling: the driver moves the cursor and asks for the next frame's values.
		sampling: null,
		samples: [],
		// The raw call log, and how many bytes of buffer data it has swallowed.
		stream: [],
		nextHandle: 1,
		streamFrames: 0,
		streaming: false,
		streamBytes: 0,
		extensions: {},
		renderbuffers: new Map(), // WebGLRenderbuffer -> { internalFormat, samples }
		lastGl: null,
		contextAttributes: null,
		canvasCss: null,
		devicePixelRatio: 1,
		note: "",
	};
	window.__brainRip = rip;

	// The canvas as it is when a frame is kept: its buffer, its CSS box, the context it was
	// made with. Read at the kept frame rather than the first draw, when a page is often still
	// sizing itself.
	const canvasFacts = () => {
		try {
			const gl = rip.lastGl;
			if (!gl || !gl.canvas) return;
			rip.canvas = { width: gl.canvas.width, height: gl.canvas.height };
			if (gl.canvas.getBoundingClientRect) {
				const box = gl.canvas.getBoundingClientRect();
				rip.canvasCss = { width: box.width, height: box.height };
			}
			rip.devicePixelRatio = window.devicePixelRatio || 1;
			rip.contextAttributes = gl.getContextAttributes ? gl.getContextAttributes() : null;
		} catch (e) { /* a context that is gone */ }
	};

	let nextId = 1;
	// The setter family for a GLSL type, so the replay does not have to guess from the
	// length of the value array.
	const glslKind = (type) => {
		if (type === 35676) return "uniformMatrix4fv";
		if (type === 35675) return "uniformMatrix3fv";
		if (type === 35674) return "uniformMatrix2fv";
		if (type === 5124 || type === 35670 || (type >= 35678 && type <= 35682)) return "uniform1i";
		if (type === 35667) return "uniform2i";
		if (type === 35668) return "uniform3i";
		if (type === 35669) return "uniform4i";
		if (type === 5126) return "uniform1f";
		if (type === 35664) return "uniform2f";
		if (type === 35665) return "uniform3f";
		if (type === 35666) return "uniform4f";
		return "uniform1f";
	};

	const idOf = (map, key) => {
		let entry = map.get(key);
		// The handle is the name the call stream uses; the id is the name the frame capture
		// uses. Both are attached here so the replay can join them up.
		if (!entry) { entry = { id: nextId++, handle: handle(key) }; map.set(key, entry); }
		return entry;
	};

	const toBase64 = (view) => {
		const bytes = new Uint8Array(view.buffer ? view.buffer : view, view.byteOffset || 0, view.byteLength || view.length || 0);
		let binary = "";
		for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		return btoa(binary);
	};

	// Objects the page makes are given small integer ids so the stream can name them, and the
	// replay can map them onto the objects it makes.
	const handleIds = new WeakMap();
	let nextHandle = 1;
	const handle = (object) => {
		if (!object) return 0;
		let id = handleIds.get(object);
		if (!id) { id = nextHandle++; rip.nextHandle = nextHandle; handleIds.set(object, id); }
		return id;
	};
	// Arguments as the stream can carry them: handles for GL objects, plain numbers for the
	// rest, base64 for uploaded data.
	const streamArg = (value) => {
		if (value === null || value === undefined) return null;
		if (typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "object") {
			if (ArrayBuffer.isView(value)) {
				if (rip.streamBytes + value.byteLength > ${MAX_STREAM_BYTES}) return { drop: true };
				rip.streamBytes += value.byteLength;
				return { data: toBase64(value), kind: value.constructor ? value.constructor.name : "Uint8Array" };
			}
			return { handle: handle(value) };
		}
		return null;
	};
	const log = (fn, args) => {
		if (!rip.streaming || rip.stream.length > 20000) return;
		const encoded = [];
		for (const arg of args) encoded.push(streamArg(arg));
		rip.stream.push({ f: fn, a: encoded });
	};

	const wrap = (proto, isV2) => {
		if (!proto || proto.__brainRipped) return;
		proto.__brainRipped = true;

		const keep = {};
		for (const name of ["createShader", "shaderSource", "createProgram", "attachShader", "linkProgram",
			"useProgram", "bufferData", "bufferSubData", "bindBuffer", "texImage2D", "texParameteri",
			"bindTexture", "getUniformLocation", "drawArrays", "drawElements", "drawArraysInstanced",
			"drawElementsInstanced", "clear", "bindFramebuffer", "framebufferTexture2D", "createTexture",
			"activeTexture", "bindBufferBase", "bindBufferRange", "uniformBlockBinding",
			"texStorage2D", "texSubImage2D", "getExtension", "bindRenderbuffer", "renderbufferStorage",
			"renderbufferStorageMultisample", "framebufferRenderbuffer"]) {
			keep[name] = proto[name];
		}

		proto.createShader = function (type) {
			const shader = keep.createShader.call(this, type);
			if (shader) rip.shaders.set(shader, { kind: type === this.VERTEX_SHADER ? "vertex" : "fragment", source: "" });
			return shader;
		};
		proto.shaderSource = function (shader, source) {
			const entry = rip.shaders.get(shader);
			if (entry) entry.source = String(source);
			return keep.shaderSource.call(this, shader, source);
		};
		proto.attachShader = function (program, shader) {
			const entry = idOf(rip.programs, program);
			const shaderEntry = rip.shaders.get(shader);
			if (shaderEntry) entry[shaderEntry.kind] = shaderEntry.source;
			return keep.attachShader.call(this, program, shader);
		};

		// Buffers are shadowed on upload: WebGL1 cannot read a buffer back, and even in
		// WebGL2 getBufferSubData stalls the pipeline badly enough to change what we are
		// trying to measure.
		const remember = (target, data, offset) => {
			try {
				const buffer = this_bound_buffer(target);
				if (!buffer || !data || typeof data === "number") return;
				const entry = idOf(rip.buffers, buffer);
				const view = data.buffer ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength) : new Uint8Array(data);
				if (rip.totalBytes + view.byteLength > ${MAX_TOTAL_BUFFER_BYTES}) { rip.droppedBytes += view.byteLength; return; }
				if (offset && entry.bytes) {
					const merged = new Uint8Array(Math.max(entry.bytes.length, offset + view.byteLength));
					merged.set(entry.bytes);
					merged.set(view, offset);
					entry.bytes = merged;
				} else {
					entry.bytes = new Uint8Array(view);
					rip.totalBytes += view.byteLength;
				}
			} catch (e) { /* a page handing us something exotic */ }
		};
		let boundArray = null;
		let boundElement = null;
		const this_bound_buffer = (target) => (target === 34963 /* ELEMENT_ARRAY_BUFFER */ ? boundElement : boundArray);

		proto.bindBuffer = function (target, buffer) {
			if (target === 34963) boundElement = buffer; else boundArray = buffer;
			return keep.bindBuffer.call(this, target, buffer);
		};
		proto.bufferData = function (target, data, usage) {
			remember(target, data, 0);
			return keep.bufferData.apply(this, arguments);
		};
		proto.bufferSubData = function (target, offset, data) {
			remember(target, data, offset);
			return keep.bufferSubData.apply(this, arguments);
		};

		let boundTexture = null;
		proto.bindTexture = function (target, texture) {
			boundTexture = texture;
			return keep.bindTexture.call(this, target, texture);
		};

		// Render targets. A scene like this draws its geometry into a framebuffer and then
		// samples that as a texture from a full-screen quad; capture only the draws and the
		// quad samples nothing, which is exactly the black rectangle this fixes.
		let boundFramebuffer = null;
		proto.bindFramebuffer = function (target, framebuffer) {
			boundFramebuffer = framebuffer;
			return keep.bindFramebuffer.call(this, target, framebuffer);
		};
		proto.framebufferTexture2D = function (target, attachment, textarget, texture, level) {
			try {
				if (boundFramebuffer && texture) {
					const entry = idOf(rip.framebuffers, boundFramebuffer);
					// Colour attachment zero is the one a later pass samples.
					if (attachment === 36064 /* COLOR_ATTACHMENT0 */) entry.colour = idOf(rip.textures, texture).id;
					if (attachment === 36096 /* DEPTH_ATTACHMENT */ || attachment === 33306 /* DEPTH_STENCIL_ATTACHMENT */) {
						entry.depthTexture = idOf(rip.textures, texture).id;
					}
				}
			} catch (e) { /* ignore */ }
			return keep.framebufferTexture2D.apply(this, arguments);
		};
		let boundRenderbuffer = null;
		proto.bindRenderbuffer = function (target, renderbuffer) {
			boundRenderbuffer = renderbuffer;
			return keep.bindRenderbuffer.apply(this, arguments);
		};
		proto.renderbufferStorage = function (target, internalFormat) {
			try { if (boundRenderbuffer) rip.renderbuffers.set(boundRenderbuffer, { internalFormat: internalFormat, samples: 0 }); } catch (e) { /* ignore */ }
			return keep.renderbufferStorage.apply(this, arguments);
		};
		if (keep.renderbufferStorageMultisample) {
			proto.renderbufferStorageMultisample = function (target, samples, internalFormat) {
				try { if (boundRenderbuffer) rip.renderbuffers.set(boundRenderbuffer, { internalFormat: internalFormat, samples: samples }); } catch (e) { /* ignore */ }
				return keep.renderbufferStorageMultisample.apply(this, arguments);
			};
		}
		proto.framebufferRenderbuffer = function (target, attachment, renderbufferTarget, renderbuffer) {
			try {
				if (boundFramebuffer && renderbuffer && (attachment === 36096 || attachment === 33306)) {
					idOf(rip.framebuffers, boundFramebuffer).depthRenderbuffer = renderbuffer;
				}
			} catch (e) { /* ignore */ }
			return keep.framebufferRenderbuffer.apply(this, arguments);
		};
		proto.texImage2D = function () {
			const result = keep.texImage2D.apply(this, arguments);
			try {
				// An allocation with no pixels is a render target being made. Its format is the
				// only thing about it worth keeping, and a large one is still worth keeping.
				if (boundTexture && arguments.length >= 9 && arguments[8] === null) {
					const entry = idOf(rip.textures, boundTexture);
					entry.internalFormat = arguments[2];
					entry.width = arguments[3];
					entry.height = arguments[4];
					entry.format = arguments[6];
					entry.pixelType = arguments[7];
					return result;
				}
				if (!boundTexture || rip.textures.size >= ${MAX_TEXTURES}) return result;
				const source = arguments[arguments.length - 1];
				if (!source || typeof source !== "object") return result;

				// A typed array is a data texture: a lookup table, a noise field, a gradient
				// ramp. They carry no width of their own, so the call's own arguments are the
				// only description of them — and a material that samples one gets nothing at
				// all if they are skipped, which is how a glass shader renders black.
				if (ArrayBuffer.isView(source)) {
					const w = arguments[3], h = arguments[4];
					if (typeof w !== "number" || typeof h !== "number" || w * h > 262144) return result;
					const entry = idOf(rip.textures, boundTexture);
					entry.width = w;
					entry.height = h;
					entry.internalFormat = arguments[2];
					entry.format = arguments[6];
					entry.pixelType = arguments[7];
					entry.data = toBase64(source);
					return result;
				}
				const width = source.width || source.videoWidth || 0;
				const height = source.height || source.videoHeight || 0;
				if (!width || !height || width > ${MAX_TEXTURE_EDGE} || height > ${MAX_TEXTURE_EDGE}) return result;
				// Anything the 2D canvas can draw — an image, a canvas, a video frame, an
				// ImageBitmap — becomes a PNG. A raw typed array is left alone: it is usually
				// a lookup table, and re-encoding it would corrupt it.
				const scratch = document.createElement("canvas");
				scratch.width = width;
				scratch.height = height;
				const ctx = scratch.getContext("2d");
				ctx.drawImage(source, 0, 0);
				const entry = idOf(rip.textures, boundTexture);
				entry.source = scratch.toDataURL("image/png");
				entry.width = width;
				entry.height = height;
			} catch (e) { /* a tainted or unsupported source */ }
			return result;
		};
		// WebGL2's texture path. three.js allocates with texStorage2D and then fills with
		// texSubImage2D, so a hook that only knows texImage2D sees the page's real textures
		// as nothing at all — and a material that samples one renders black with no error.
		if (keep.texStorage2D) {
			proto.texStorage2D = function (target, levels, internalFormat, width, height) {
				try {
					// Every allocation's format, whatever its size: the pixels of a large texture
					// are not kept, but a render target is replayed in the format it was made in.
					if (boundTexture) {
						const entry = idOf(rip.textures, boundTexture);
						entry.width = width;
						entry.height = height;
						entry.internalFormat = internalFormat;
						entry.storage = true;
					}
				} catch (e) { /* ignore */ }
				return keep.texStorage2D.apply(this, arguments);
			};
		}
		if (keep.texSubImage2D) {
			proto.texSubImage2D = function () {
				const result = keep.texSubImage2D.apply(this, arguments);
				try {
					if (!boundTexture) return result;
					const entry = idOf(rip.textures, boundTexture);
					// Only the full-surface upload at level zero is worth keeping; a partial
					// update of an atlas is not something a replay can reassemble.
					const level = arguments[1];
					if (level !== 0) return result;
					const source = arguments[arguments.length - 1];
					if (ArrayBuffer.isView(source)) {
						const w = arguments[4], h = arguments[5];
						if (typeof w === "number" && typeof h === "number" && w * h <= 262144) {
							entry.width = entry.width || w;
							entry.height = entry.height || h;
							entry.subWidth = w;
							entry.subHeight = h;
							entry.format = arguments[6];
							entry.pixelType = arguments[7];
							entry.data = toBase64(source);
						}
					} else if (source && typeof source === "object" && (source.width || source.videoWidth)) {
						const width = source.width || source.videoWidth;
						const height = source.height || source.videoHeight;
						if (width && height && width <= ${MAX_TEXTURE_EDGE} && height <= ${MAX_TEXTURE_EDGE}) {
							const scratch = document.createElement("canvas");
							scratch.width = width;
							scratch.height = height;
							scratch.getContext("2d").drawImage(source, 0, 0);
							entry.source = scratch.toDataURL("image/png");
							entry.width = width;
							entry.height = height;
						}
					}
				} catch (e) { /* a tainted or unsupported source */ }
				return result;
			};
		}

		proto.texParameteri = function (target, pname, value) {
			try {
				if (boundTexture) {
					const entry = idOf(rip.textures, boundTexture);
					if (pname === 10242) entry.wrapS = value;
					if (pname === 10243) entry.wrapT = value;
					if (pname === 10241) entry.minFilter = value;
					if (pname === 10240) entry.magFilter = value;
				}
			} catch (e) { /* ignore */ }
			return keep.texParameteri.call(this, target, pname, value);
		};

		// Which extensions the page turned on. A half-float texture filtered with LINEAR needs
		// OES_texture_float_linear; without it the same upload that worked on the page is an
		// INVALID_OPERATION here.
		proto.getExtension = function (name) {
			const ext = keep.getExtension.call(this, name);
			if (ext) rip.extensions[String(name)] = true;
			return ext;
		};

		proto.getUniformLocation = function (program, name) {
			const location = keep.getUniformLocation.call(this, program, name);
			if (location) {
				rip.locations.set(location, String(name));
				// The replay looks a location up by name on its own program, so the stream
				// carries the pair rather than an opaque handle.
				rip.locationNames.push({ handle: handle(location), program: handle(program), name: String(name) });
			}
			return location;
		};

		// Uniform buffer objects. three.js on WebGL2 puts the camera matrices in one, so a
		// replay that only sets uniform* draws the geometry somewhere off-screen, or refuses
		// to draw at all with INVALID_OPERATION. The data itself is already shadowed by the
		// bufferData hook; what is missing is which buffer was bound to which binding point,
		// and which block each program maps onto it.
		const uboBindings = new Map();
		const blockBindings = new Map();
		if (keep.bindBufferBase) {
			proto.bindBufferBase = function (target, index, buffer) {
				if (target === 35345 /* UNIFORM_BUFFER */ && buffer) {
					uboBindings.set(index, { buffer: idOf(rip.buffers, buffer).id, offset: 0, size: 0 });
				}
				return keep.bindBufferBase.apply(this, arguments);
			};
		}
		if (keep.bindBufferRange) {
			proto.bindBufferRange = function (target, index, buffer, offset, size) {
				if (target === 35345 && buffer) {
					uboBindings.set(index, { buffer: idOf(rip.buffers, buffer).id, offset: offset || 0, size: size || 0 });
				}
				return keep.bindBufferRange.apply(this, arguments);
			};
		}
		if (keep.uniformBlockBinding) {
			proto.uniformBlockBinding = function (program, blockIndex, binding) {
				try {
					const programId = idOf(rip.programs, program).id;
					const list = blockBindings.get(programId) || [];
					let name = "";
					try { name = this.getActiveUniformBlockName(program, blockIndex) || ""; } catch (e) { name = ""; }
					list.push({ block: blockIndex, name: name, binding: binding });
					blockBindings.set(programId, list);
				} catch (e) { /* ignore */ }
				return keep.uniformBlockBinding.apply(this, arguments);
			};
		}

		let current = null;
		proto.useProgram = function (program) {
			current = program;
			return keep.useProgram.call(this, program);
		};

		// Which texture sits in which unit, so a sampler uniform holding "unit 3" can be
		// resolved to the texture the page actually had there.
		const units = new Map();
		let activeUnit = 0;
		proto.activeTexture = function (unit) {
			activeUnit = unit - 33984; /* TEXTURE0 */
			return keep.activeTexture.call(this, unit);
		};
		const bindTextureInner = proto.bindTexture;
		proto.bindTexture = function (target, texture) {
			if (texture) units.set(activeUnit, idOf(rip.textures, texture).id);
			return bindTextureInner.call(this, target, texture);
		};

		// Every uniform setter writes into the state of the program in force, so a draw call
		// can be recorded with the values it was actually made with.
		const record = (name, kind, value, texture) => {
			if (!current) return;
			const programId = idOf(rip.programs, current).id;
			let table = rip.uniformState.get(programId);
			if (!table) { table = new Map(); rip.uniformState.set(programId, table); }
			table.set(name, { kind: kind, value: value, texture: texture || 0 });
		};
		for (const method of Object.getOwnPropertyNames(proto)) {
			if (!/^uniform(Matrix)?[1-4](f|i|ui)?v?$/.test(method)) continue;
			const original = proto[method];
			if (typeof original !== "function") continue;
			proto[method] = function (location, ...args) {
				try {
					const name = rip.locations.get(location);
					if (name) {
						const raw = /Matrix/.test(method) ? args[1] : (args.length === 1 && args[0] && args[0].length !== undefined ? args[0] : args);
						const value = raw && raw.length !== undefined ? Array.from(raw).slice(0, 16).map(Number) : [Number(raw)];
						// A sampler is an integer naming a texture unit; the unit it points at
						// is resolved when the frame is read back.
						record(name, method, value, /uniform1i/.test(method) ? value[0] + 1 : 0);
					}
				} catch (e) { /* never break the page's own draw */ }
				return original.apply(this, [location, ...args]);
			};
		}

		const snapshotDraw = function (gl, mode, count, indexType, offset, instances) {
			rip.drawsSeen++;
			// After the frame is captured the recorder keeps working in one case: the driver
			// has moved the pointer and wants to know what that did to the uniforms.
			if (rip.done && !rip.sampling) return;
			if (!rip.done && rip.draws.length >= ${MAX_DRAW_CALLS}) return;
			try {
				const program = gl.getParameter(gl.CURRENT_PROGRAM);
				if (!program) return;
				const programId = idOf(rip.programs, program).id;
				const attribs = [];
				const count_ = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
				for (let i = 0; i < count_; i++) {
					const info = gl.getActiveAttrib(program, i);
					if (!info) continue;
					const location = gl.getAttribLocation(program, info.name);
					if (location < 0) continue;
					const buffer = gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
					if (!buffer) continue;
					attribs.push({
						name: info.name,
						// The GLSL type, which the buffer layout cannot tell you. A mat4
						// attribute reports size 4 from getVertexAttrib because each of its
						// four columns is a separate slot — bind it as one and an instanced
						// draw puts every instance on top of the first.
						glslType: info.type,
						location: location,
						buffer: idOf(rip.buffers, buffer).id,
						size: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_SIZE),
						type: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_TYPE),
						stride: gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
						offset: gl.getVertexAttribOffset(location, gl.VERTEX_ATTRIB_ARRAY_POINTER),
						normalized: !!gl.getVertexAttrib(location, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
						// Instanced attributes advance once per instance rather than per vertex.
						// Without the divisor an instanced draw replays as a single copy of the
						// mesh with every instance stacked on the first.
						divisor: (function () {
							try { return gl.getVertexAttrib(location, 0x88FE /* VERTEX_ATTRIB_ARRAY_DIVISOR */) || 0; } catch (e) { return 0; }
						})(),
					});
				}
				const indexBuffer = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
				// Read the uniforms off the GPU rather than from a shadow of the uploads.
				//
				// Shadowing looks right and is subtly wrong: three.js compiles ONE program per
				// distinct shader and shares it across every material that uses it, so a table
				// keyed by program conflates two objects' uniforms. The backdrop in this scene
				// came out with an all-zero model matrix and a resolution of 0×0 for exactly
				// that reason — values belonging to the other material that shared its program.
				// getUniform asks what the program actually holds at this draw, which is the
				// only thing that is true per pass.
				const uniforms = [];
				const activeUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
				for (let i = 0; i < activeUniforms; i++) {
					const info = gl.getActiveUniform(program, i);
					if (!info) continue;
					const name = info.name.replace(/\[0\]$/, "");
					const location = gl.getUniformLocation(program, name);
					if (!location) continue;
					let value;
					try { value = gl.getUniform(program, location); } catch (e) { continue; }
					if (value === null || value === undefined) continue;
					// Infinity survives WebGL and does not survive JSON: stringify turns it into
					// null, the replay reads null as zero, and a uniform like three.js's
					// attenuationDistance — Infinity by default — becomes a division by zero
					// that turns the whole transmission term into NaN. The material then
					// renders black with no error anywhere. Non-finite values travel as their
					// names and are read back on the other side.
					const keepFinite = (n) => (Number.isFinite(n) ? n : Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity");
					const array = typeof value === "number" || typeof value === "boolean"
						? [keepFinite(Number(value))]
						: Array.from(value).map((n) => keepFinite(Number(n)));
					// 35678..35680 are SAMPLER_2D/CUBE and friends: the integer is a texture unit.
					const sampler = info.type >= 35678 && info.type <= 35682;
					uniforms.push({ name: name, kind: glslKind(info.type), value: array.slice(0, 16), texture: sampler ? 1 : 0 });
				}
				rip.lastDrawFrame = rip.frames;
				rip.lastGl = gl;
				if (!rip.firstDrawAt) rip.firstDrawAt = performance.now();
				if (rip.sampling) {
					rip.sampling.draws.push(uniforms);
					return;
				}
				rip.draws.push({
					// Which frame this happened in. Frame zero is setup: the passes that run
					// once and are never issued again.
					frame: rip.frames,
					// Which framebuffer this pass drew into. Zero is the screen.
					target: boundFramebuffer ? idOf(rip.framebuffers, boundFramebuffer).id : 0,
					ubos: Array.from(uboBindings.entries()).map(([binding, entry]) => ({ binding: binding, buffer: entry.buffer, offset: entry.offset, size: entry.size })),
					blocks: blockBindings.get(programId) || [],
					units: Array.from(units.entries()).map(([unit, texture]) => ({ unit: unit, texture: texture })),
					program: programId,
					mode: mode,
					count: count,
					indexType: indexType,
					offset: offset,
					indexBuffer: indexBuffer ? idOf(rip.buffers, indexBuffer).id : 0,
					instances: instances || 0,
					attribs: attribs,
					uniforms: uniforms,
					state: {
						depthTest: gl.isEnabled(gl.DEPTH_TEST),
						depthMask: !!gl.getParameter(gl.DEPTH_WRITEMASK),
						// Which way the depth comparison goes, not just whether it happens.
						depthFunc: gl.getParameter(gl.DEPTH_FUNC),
						blend: gl.isEnabled(gl.BLEND),
						blendSrc: gl.getParameter(gl.BLEND_SRC_RGB),
						blendDst: gl.getParameter(gl.BLEND_DST_RGB),
						blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
						blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
						blendEquation: gl.getParameter(gl.BLEND_EQUATION_RGB),
						cullFace: gl.isEnabled(gl.CULL_FACE),
						// The mode and the winding matter as much as the switch. A material
						// drawn from the inside of its own geometry sets cullFace(FRONT); a
						// replay that leaves the default culls exactly the faces you can see,
						// draws nothing, and reports no error at all.
						cullMode: gl.getParameter(gl.CULL_FACE_MODE),
						frontFace: gl.getParameter(gl.FRONT_FACE),
						colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)).map(Boolean),
						viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
						clearColor: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
					},
				});
				if (!rip.canvas && gl.canvas) rip.canvas = { width: gl.canvas.width, height: gl.canvas.height };
				rip.webgl2 = !!isV2;
			} catch (e) { /* a context that will not answer a query */ }
		};

		proto.drawArrays = function (mode, first, count) {
			snapshotDraw(this, mode, count, 0, first, 0);
			return keep.drawArrays.apply(this, arguments);
		};
		proto.drawElements = function (mode, count, type, offset) {
			snapshotDraw(this, mode, count, type, offset, 0);
			return keep.drawElements.apply(this, arguments);
		};
		if (keep.drawArraysInstanced) {
			proto.drawArraysInstanced = function (mode, first, count, instances) {
				snapshotDraw(this, mode, count, 0, first, instances);
				return keep.drawArraysInstanced.apply(this, arguments);
			};
		}
		if (keep.drawElementsInstanced) {
			proto.drawElementsInstanced = function (mode, count, type, offset, instances) {
				snapshotDraw(this, mode, count, type, offset, instances);
				return keep.drawElementsInstanced.apply(this, arguments);
			};
		}
	};

	// Everything else that moves the pipeline. These are logged rather than interpreted:
	// the replay does not need to know what a page meant by them, only to make the same calls
	// in the same order.
	const STREAMED = [
		"useProgram", "bindBuffer", "bufferData", "bufferSubData", "vertexAttribPointer",
		"enableVertexAttribArray", "disableVertexAttribArray", "vertexAttribDivisor",
		"bindFramebuffer", "bindRenderbuffer", "viewport", "scissor", "clear", "clearColor",
		"clearDepth", "enable", "disable", "depthFunc", "depthMask", "blendFunc",
		"blendFuncSeparate", "blendEquation", "blendEquationSeparate", "cullFace", "frontFace",
		"colorMask", "activeTexture", "bindTexture", "bindVertexArray", "drawArrays",
		"drawElements", "drawArraysInstanced", "drawElementsInstanced", "bindBufferBase",
		"bindBufferRange", "uniformBlockBinding", "polygonOffset", "lineWidth", "pixelStorei",
		"stencilFunc", "stencilOp", "stencilMask", "drawBuffers",
	];
	const streamWrap = (proto) => {
		if (!proto || proto.__brainStreamed) return;
		proto.__brainStreamed = true;
		for (const name of STREAMED.concat(Object.getOwnPropertyNames(proto).filter((n) => /^uniform(Matrix)?[1-4]/.test(n)))) {
			const original = proto[name];
			if (typeof original !== "function") continue;
			proto[name] = function (...args) {
				log(name, args);
				return original.apply(this, args);
			};
		}
	};

	// Time dilation, for the entrance only. Both clocks and the frame timestamp are slowed
	// together — a page that reads any one of them sees a consistent, slower world — and put
	// back the moment the scene settles.
	//
	// Not under a virtual clock. There the page already sees exactly 1/60 s per frame however
	// slowly frames are drawn, which is what dilation was approximating; slowing that clock as
	// well would record an entrance eight times longer than the page's.
	const realNow = performance.now.bind(performance);
	const startedReal = realNow();
	rip.rate = window.__vclock ? 1 : ${INTRO_TIME_RATE};
	rip.realNow = realNow;
	const dilate = (real) => startedReal + (real - startedReal) * rip.rate;
	if (!window.__vclock) try {
		performance.now = () => dilate(realNow());
		// Date.now is deliberately left alone. Animation reads performance.now or the frame
		// timestamp; the capture's own deadlines read Date.now, and slowing that made every
		// wait eight times longer in real time than it asked for — the read gave up before
		// the page had finished, and the whole capture came back as a failure.
		const realRaf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) =>
			realRaf((timestamp) => callback(dilate(timestamp)));
	} catch (e) {
		rip.rate = 1;
	}

	try {
		if (window.WebGLRenderingContext) wrap(WebGLRenderingContext.prototype, false);
		if (window.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype, true);
		// Streaming wraps on top of the recording wrappers, so a call is logged and recorded
		// once each rather than twice.
		if (window.WebGLRenderingContext) streamWrap(WebGLRenderingContext.prototype);
		if (window.WebGL2RenderingContext) streamWrap(WebGL2RenderingContext.prototype);
	} catch (e) {
		rip.note = "the page's WebGL objects could not be wrapped";
	}

	// One frame, after the scene has settled. Arming on a frame boundary is what keeps the
	// recorded draws consistent with each other: half of one frame and half of the next
	// replays as a scene with pieces missing.
	// The driver's two controls: ask what the pointer did, and stop the page on the frame
	// that was captured.
	window.__brainSample = (x, y) => {
		rip.sampling = { x: x, y: y, draws: [] };
	};
	window.__brainTakeSample = () => {
		const pending = rip.sampling;
		if (!pending || pending.draws.length === 0) return null;
		rip.sampling = null;
		rip.samples.push({ x: pending.x, y: pending.y, uniforms: pending.draws });
		return rip.samples.length;
	};
	window.__brainFreeze = () => {
		try {
			window.requestAnimationFrame = () => 0;
			rip.frozen = true;
			return true;
		} catch (e) {
			return false;
		}
	};

	const tick = () => {
		rip.frames++;
		if (rip.streaming) {
			// One marker per frame, so the replay can pace itself the way the page did.
			rip.stream.push({ f: "__frame", a: [] });
			rip.streamFrames++;
			if (rip.streamFrames > ${STREAM_FRAMES} || performance.now() - rip.streamingSince >= ${STREAM_MS}) {
				rip.streaming = false;
				rip.streamDone = true;
			}
		}
		// A frame that drew something has just ended.
		if (rip.draws.length > 0 && rip.lastDrawFrame === rip.frames - 1) {
			rip.drawFrames++;
			const settled = rip.drawFrames >= ${SETTLE_DRAW_FRAMES} && performance.now() - rip.firstDrawAt >= ${SETTLE_MS};
			if (!rip.collecting && !settled) {
				// Not settled: this is the entrance. Keep its values, drop the rest of the
				// frame, and let the next one overwrite the reference.
				if (rip.intro.length < ${INTRO_SAMPLES}) {
					rip.intro.push({ at: performance.now(), uniforms: rip.draws.map((d) => d.uniforms) });
				}
				rip.draws = [];
			} else if (!rip.collecting) {
				// Settled. This frame is the reference — geometry, state, attribute layouts —
				// and the sampling of what moves starts from it.
				rip.collecting = true;
				// The entrance is captured; let the page run at its own speed again so the
				// loop and the pointer are sampled at the rate they really happen.
				rip.rate = 1;
				rip.collectingSince = performance.now();
				rip.reference = rip.draws;
				canvasFacts();
				rip.timeline.push({ at: performance.now(), uniforms: rip.draws.map((d) => d.uniforms) });
				rip.draws = [];
			} else {
				// Collecting: every frame contributes one sample of its uniforms and is then
				// discarded. Each sample has to be its own array, or every entry in the
				// timeline ends up pointing at the same values and nothing appears to move.
				rip.timeline.push({ at: performance.now(), uniforms: rip.draws.map((d) => d.uniforms) });
				// The newest frame is the reference: it is the one the page will be frozen on,
				// so a photograph of the canvas and the replay of this frame are the same
				// instant. Keeping the first instead put seventeen seconds between them.
				rip.reference = rip.draws;
				canvasFacts();
				rip.draws = [];
				const enough = rip.timeline.length >= ${TIMELINE_FRAMES} ||
					performance.now() - rip.collectingSince >= ${TIMELINE_MS};
				if (enough) {
					rip.draws = rip.reference;
					rip.done = true;
					// The sampled scene is in hand; now record the calls themselves.
					rip.streaming = true;
					rip.streamingSince = performance.now();
				}
			}
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

/**
 * Read the recorded frame out, with the buffers encoded for the trip.
 *
 * Waits for the recorder rather than assuming it has finished. Frame rate under software
 * rasterisation is not something the caller can predict, and the difference between "this
 * page has no scene" and "this page had not drawn yet" is the whole value of the capture.
 */
export const RIPPER_READ_SCRIPT = String.raw`(async () => {
	const rip = window.__brainRip;
	if (rip) {
		const deadline = Date.now() + ${READ_WAIT_MS};
		while (!(rip.done && rip.streamDone) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
	}
	const empty = { ok: false, note: "the ripper never ran", canvas: null, webgl2: false, programs: [], buffers: [], textures: [], extensions: [], framebuffers: [], draws: [], frozen: false, timeline: [], intro: [], pointer: [], stream: [], locationNames: [], handles: 0, stats: { buffersSeen: 0, texturesSeen: 0, drawsInFrame: 0, droppedBytes: 0, drawsSeen: 0, frames: 0, armed: false, done: false } };
	if (!rip) return empty;

	const toBase64 = (bytes) => {
		let binary = "";
		for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
		return btoa(binary);
	};

	// Only what the recorded frame actually touches. A page that uploads forty buffers and
	// draws with three should ship three.
	const wanted = new Set();
	for (const draw of rip.draws) {
		if (draw.indexBuffer) wanted.add(draw.indexBuffer);
		for (const attrib of draw.attribs) wanted.add(attrib.buffer);
		for (const ubo of draw.ubos || []) wanted.add(ubo.buffer);
	}
	const buffers = [];
	for (const entry of rip.buffers.values()) {
		if (!wanted.has(entry.id) || !entry.bytes) continue;
		buffers.push({ id: entry.id, handle: entry.handle || 0, data: toBase64(entry.bytes), byteLength: entry.bytes.byteLength });
	}
	const usedPrograms = new Set(rip.draws.map((d) => d.program));
	const programs = [];
	for (const entry of rip.programs.values()) {
		if (!usedPrograms.has(entry.id) || !entry.vertex || !entry.fragment) continue;
		programs.push({ id: entry.id, handle: entry.handle || 0, vertex: entry.vertex, fragment: entry.fragment });
	}
	const textures = [];
	for (const entry of rip.textures.values()) {
		if (!entry.source && !entry.data) continue;
		textures.push({ id: entry.id, handle: entry.handle || 0, source: entry.source || "", data: entry.data || "", width: entry.width || 0, height: entry.height || 0,
			internalFormat: entry.internalFormat || 0, format: entry.format || 0, pixelType: entry.pixelType || 0,
			storage: !!entry.storage,
			wrapS: entry.wrapS || 0, wrapT: entry.wrapT || 0, minFilter: entry.minFilter || 0 });
	}
	const textureById = new Map();
	for (const entry of rip.textures.values()) textureById.set(entry.id, entry);
	const framebuffers = [];
	for (const entry of rip.framebuffers.values()) {
		if (!entry.colour) continue;
		const colour = textureById.get(entry.colour) || {};
		const renderbuffer = entry.depthRenderbuffer ? rip.renderbuffers.get(entry.depthRenderbuffer) : null;
		const depthTexture = entry.depthTexture ? textureById.get(entry.depthTexture) : null;
		framebuffers.push({
			id: entry.id,
			handle: entry.handle || 0,
			colour: entry.colour,
			colourFormat: colour.internalFormat ? {
				internalFormat: colour.internalFormat, format: colour.format || 0, pixelType: colour.pixelType || 0,
				storage: !!colour.storage, minFilter: colour.minFilter || 0, magFilter: colour.magFilter || 0,
				wrapS: colour.wrapS || 0, wrapT: colour.wrapT || 0,
			} : null,
			depthFormat: renderbuffer ? renderbuffer.internalFormat : depthTexture ? (depthTexture.internalFormat || 33190) : 0,
		});
	}

	return {
		ok: rip.draws.length > 0 && programs.length > 0 && buffers.length > 0,
		note: rip.note || (rip.draws.length === 0 ? "no frame was captured — the canvas may have stopped drawing" : ""),
		canvas: rip.canvas,
		canvasCss: rip.canvasCss,
		devicePixelRatio: rip.devicePixelRatio,
		contextAttributes: rip.contextAttributes,
		webgl2: rip.webgl2,
		programs: programs,
		buffers: buffers,
		textures: textures,
		extensions: Object.keys(rip.extensions || {}),
		framebuffers: framebuffers,
		draws: rip.draws,
		frozen: !!rip.frozen,
		// Seconds from the first kept frame, and the uniform values at each sample.
		pointer: rip.samples.map((entry) => ({ x: entry.x, y: entry.y, uniforms: entry.uniforms })),
		intro: rip.intro.map((entry) => ({
			t: (entry.at - (rip.intro[0] ? rip.intro[0].at : entry.at)) / 1000,
			uniforms: entry.uniforms,
		})),
		stream: rip.stream,
		locationNames: rip.locationNames,
		handles: rip.nextHandle || 0,
		timeline: rip.timeline.map((entry) => ({
			t: (entry.at - (rip.timeline[0] ? rip.timeline[0].at : entry.at)) / 1000,
			uniforms: entry.uniforms,
		})),
		stats: { buffersSeen: rip.buffers.size, texturesSeen: rip.textures.size, drawsInFrame: rip.draws.length, droppedBytes: rip.droppedBytes, drawsSeen: rip.drawsSeen, frames: rip.frames, armed: rip.armed, done: rip.done },
	};
})()`;

/**
 * Stash the capture as a string on the page and say how long it is.
 *
 * A frame with a call stream in it is several megabytes, and `Runtime.evaluate` returning
 * that by value either times out or comes back as nothing at all — which reads exactly like
 * a page with no WebGL on it. The payload is built once, kept on the page, and collected in
 * slices.
 */
export const RIPPER_STASH_SCRIPT = `(async () => {
	const payload = await ${RIPPER_READ_SCRIPT};
	window.__brainPayload = JSON.stringify(payload);
	return window.__brainPayload.length;
})()`;

/** One slice of the stashed payload. */
export function ripperSliceScript(from: number, size: number): string {
	return `(window.__brainPayload || "").slice(${from}, ${from + size})`;
}

/** Options for the generated hero script. */
export interface ReplayOptions {
	/** Report what each pass left at the centre of the canvas, into window.__report. */
	debug?: boolean;
	/** Keep every uniform exactly as captured, clock included, for comparing one instant. */
	freeze?: boolean;
	/**
	 * A behaviour ported from the page's own code: a script that sets window.__heroBehaviour.
	 * Without one the runtime models the motion from the capture's samples.
	 */
	behaviour?: string;
	/**
	 * Carry the frame inside the script instead of fetching it. A rebuild served into a
	 * sandbox has an opaque origin, and a fetch from one is a CORS request the file route
	 * would refuse; a script tag is not.
	 */
	inline?: boolean;
}

/**
 * The part of a capture the replay draws from. The call stream and the uniform locations are
 * the capture's working notes, and a behaviour that drives the scene has no use for the
 * sampled motion either — together that is three quarters of the file.
 */
export function replayEssentials(frame: RippedFrame, keepSamples: boolean): Partial<RippedFrame> {
	const { stream: _stream, locationNames: _names, intro, timeline, pointer, ...scene } = frame;
	return keepSamples ? { ...scene, intro, timeline, pointer } : scene;
}

const RUNTIME_SOURCE = readFileSync(join(import.meta.dir, "runtime", "webgl-replay.js"), "utf-8");

/**
 * The script that draws the captured frame again, at the canvas's real size.
 *
 * The engine itself is src/runtime/webgl-replay.js, kept as a plain file so it reads as the
 * code it is. What is generated here is only the wrapper: where the frame data lives, the
 * switches, and the behaviour when there is one.
 */
export function replayRuntime(frame: RippedFrame, dataHref: string, options: ReplayOptions = {}): string {
	const config = {
		dataHref,
		debug: Boolean(options.debug),
		freeze: Boolean(options.freeze),
		frame: options.inline ? replayEssentials(frame, !options.behaviour) : null,
	};
	return [
		"// Written by claude-brain. The frame this draws was recorded from the captured page's own",
		"// WebGL calls: same geometry, same shaders, same uniforms, same render targets.",
		"(() => {",
		`const HERO = ${JSON.stringify(config)};`,
		options.behaviour ? `// ---- behaviour, ported from the page ----\n${options.behaviour}` : "",
		RUNTIME_SOURCE,
		"})();",
		"",
	].join("\n");
}

/** What the model is told when the frame was ripped. */
export function renderRipEvidence(frame: RippedFrame): string {
	if (!frame.ok) return "";
	return [
		"## The moving background is WebGL, and its draw calls have been taken",
		"",
		`One settled frame was recorded straight off the page's own WebGL calls: ` +
			`${frame.draws.length} draws, ${frame.programs.length} shader programs, ` +
			`${frame.buffers.length} geometry buffers${frame.textures.length ? `, ${frame.textures.length} textures` : ""}` +
			`${frame.canvas ? `, into a ${frame.canvas.width}×${frame.canvas.height} canvas` : ""}.`,
		"",
		"This is the scene itself, not a picture of it: a runtime this brain wrote re-uploads the",
		"geometry, recompiles the shaders and draws the same calls every frame. It therefore",
		"renders at whatever size the window is and keeps animating on its own clock.",
		"",
		"You write none of that. Put the canvas it looks for where the page had one:",
		"",
		"```html",
		"<canvas data-hero-scene></canvas>",
		"```",
		"",
		"Size and position it exactly as the captured canvas was. Give it no CSS animation, no",
		"filter and no background image: it draws itself.",
	].join("\n");
}
