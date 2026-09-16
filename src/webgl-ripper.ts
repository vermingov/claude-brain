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
	/** Render targets: a pass draws into one, a later pass samples its colour attachment. */
	framebuffers: Array<{ id: number; handle: number; colour: number }>;
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
		note: "",
	};
	window.__brainRip = rip;

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
			"texStorage2D", "texSubImage2D", "getExtension"]) {
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
				}
			} catch (e) { /* ignore */ }
			return keep.framebufferTexture2D.apply(this, arguments);
		};
		proto.texImage2D = function () {
			const result = keep.texImage2D.apply(this, arguments);
			try {
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
					if (boundTexture && width * height <= 262144) {
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
	const realNow = performance.now.bind(performance);
	const startedReal = realNow();
	rip.rate = ${INTRO_TIME_RATE};
	rip.realNow = realNow;
	const dilate = (real) => startedReal + (real - startedReal) * rip.rate;
	try {
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
	const framebuffers = [];
	for (const entry of rip.framebuffers.values()) {
		if (!entry.colour) continue;
		framebuffers.push({ id: entry.id, handle: entry.handle || 0, colour: entry.colour });
	}

	return {
		ok: rip.draws.length > 0 && programs.length > 0 && buffers.length > 0,
		note: rip.note || (rip.draws.length === 0 ? "no frame was captured — the canvas may have stopped drawing" : ""),
		canvas: rip.canvas,
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

/**
 * The runtime that draws the captured frame again, every frame, at the canvas's real size.
 *
 * This is why ripping beats filming: the geometry and the shaders are here, so the scene is
 * rasterised at whatever resolution the viewer's window happens to be, and the uniforms that
 * drive it can keep moving. A projection matrix is corrected for the new aspect ratio rather
 * than being replayed at the aspect it was captured at, which is the difference between a
 * page that resizes and a picture that crops.
 */
export function replayRuntime(frame: RippedFrame, dataHref: string, debug = false, freeze = false, useStream = false): string {
	// A switch, not a second copy of the runtime. Debugging a replay against a harness that
	// only resembles the shipped code is how a bug gets fixed in the wrong place.
	const report = debug
		? `window.__report = window.__report || []; const say = (m) => window.__report.push(String(m));`
		: "const say = () => {};";
	const readback = debug
		? `if (!window.__reported) {
				const px = new Uint8Array(4);
				gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
				say("after p" + call.program + " target" + call.target + " centre=" + Array.from(px).join(",") + " err=" + gl.getError() + " fb=" + gl.checkFramebufferStatus(gl.FRAMEBUFFER));
			}`
		: "";
	return `// Written by claude-brain. The frame below was recorded from the captured page's own
// WebGL calls and is drawn again here: same geometry, same shaders, same uniforms.
(() => {
	const canvas = document.querySelector("canvas[data-hero-scene]");
	if (!canvas) return;

	fetch(${JSON.stringify(dataHref)})
		.then((res) => res.json())
		.then((frame) => run(frame))
		.catch((err) => console.warn("[hero] the captured frame could not be loaded:", err));

	function run(frame) {
		${report}
		const gl = (frame.webgl2 && canvas.getContext("webgl2", { alpha: true, antialias: true })) || canvas.getContext("webgl", { alpha: true, antialias: true });
		if (!gl) return;

		// Frozen: keep every uniform exactly as captured, including the clock, so this draws
		// the one instant the rip recorded. That is the only way to compare a moving scene
		// against a moving original and have the number mean something. Declared here because
		// the motion, pointer and stream setup below all consult it.
		const FREEZE = ${freeze ? "true" : "false"};

		for (const name of frame.extensions || []) {
			try { gl.getExtension(name); } catch (e) { /* not available in this browser */ }
		}
		// Float and half-float uploads have to arrive in the matching typed array, or the
		// call is an INVALID_OPERATION however correct the bytes are.
		const asPixels = (bytes, pixelType) => {
			if (pixelType === 0x1406 /* FLOAT */) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
			if (pixelType === 0x140B /* HALF_FLOAT */ || pixelType === 0x8D61 /* HALF_FLOAT_OES */) {
				return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
			}
			if (pixelType === 0x1405 /* UNSIGNED_INT */) return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
			if (pixelType === 0x1403 /* UNSIGNED_SHORT */) return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
			return bytes;
		};

		const decode = (base64) => {
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return bytes;
		};

		// Each buffer's target is decided before anything is uploaded, because a WebGL buffer
		// binds to one target for life: bind it to ARRAY_BUFFER and then to
		// ELEMENT_ARRAY_BUFFER and the second bind is an INVALID_OPERATION that poisons every
		// draw after it. Uploading everything as ARRAY_BUFFER first and "fixing up" the index
		// buffers afterwards is exactly that mistake, and it renders a perfectly captured
		// frame as a black rectangle with no failing call to point at.
		const targetOf = new Map();
		for (const draw of frame.draws) {
			if (draw.indexBuffer) targetOf.set(draw.indexBuffer, gl.ELEMENT_ARRAY_BUFFER);
			for (const ubo of draw.ubos || []) if (!targetOf.has(ubo.buffer)) targetOf.set(ubo.buffer, gl.UNIFORM_BUFFER);
			for (const attrib of draw.attribs) if (!targetOf.has(attrib.buffer)) targetOf.set(attrib.buffer, gl.ARRAY_BUFFER);
		}

		const buffers = new Map();
		for (const entry of frame.buffers) {
			const target = targetOf.get(entry.id) || gl.ARRAY_BUFFER;
			if (target === gl.UNIFORM_BUFFER && !gl.bindBufferBase) continue;
			const buffer = gl.createBuffer();
			gl.bindBuffer(target, buffer);
			gl.bufferData(target, decode(entry.data), target === gl.UNIFORM_BUFFER ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
			buffers.set(entry.id, buffer);
		}

		const textures = new Map();
		for (const entry of frame.textures) {
			const texture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, texture);
			if (entry.data) {
				// Straight back as it was uploaded, and allocated the way it was allocated:
				// a texture the page made immutable with texStorage2D cannot be respecified
				// with texImage2D.
				const pixels = asPixels(decode(entry.data), entry.pixelType);
				if (entry.storage && gl.texStorage2D) {
					gl.texStorage2D(gl.TEXTURE_2D, 1, entry.internalFormat, entry.width, entry.height);
					gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, entry.width, entry.height,
						entry.format || gl.RGBA, entry.pixelType || gl.UNSIGNED_BYTE, pixels);
				} else {
					gl.texImage2D(gl.TEXTURE_2D, 0, entry.internalFormat || gl.RGBA, entry.width, entry.height, 0,
						entry.format || gl.RGBA, entry.pixelType || gl.UNSIGNED_BYTE, pixels);
				}
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, entry.wrapS || gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, entry.wrapT || gl.CLAMP_TO_EDGE);
				// A float texture is only filterable where the extension says so.
				const isFloat = entry.pixelType === 0x1406 || entry.pixelType === 0x140B || entry.pixelType === 0x8D61;
				const filter = isFloat && !gl.getExtension("OES_texture_float_linear") ? gl.NEAREST : gl.LINEAR;
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
				textures.set(entry.id, texture);
				continue;
			}
			// One opaque pixel until the image decodes, so the first frames are not black.
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
			const image = new Image();
			image.onload = () => {
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, entry.wrapS || gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, entry.wrapT || gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			};
			image.src = entry.source;
			textures.set(entry.id, texture);
		}

		// Render targets, sized to the canvas and re-sized with it. A pass that drew into a
		// framebuffer draws into one here too, and the pass that sampled it finds the result
		// where it expects to.
		// Each target keeps the size the page rendered it at, taken from the viewport of the
		// pass that drew into it.
		const targetSize = new Map();
		for (const call of frame.draws) {
			if (!call.target) continue;
			const vp = call.state.viewport;
			if (vp && vp[2] && vp[3]) targetSize.set(call.target, { width: vp[2], height: vp[3] });
		}

		const targets = new Map();
		const sizeTargets = () => {
			for (const entry of frame.framebuffers) {
				let target = targets.get(entry.id);
				if (!target) {
					target = { fbo: gl.createFramebuffer(), tex: gl.createTexture() };
					targets.set(entry.id, target);
					textures.set(entry.colour, target.tex);
				}
				const size = targetSize.get(entry.id) || { width: canvas.width, height: canvas.height };
				// Scaled with the canvas, and for the same reason. These are the passes that
				// cost the most — a full-surface effect drawn at the size the capture happened
				// to run at — so leaving them pinned there means shrinking the canvas buys
				// almost nothing: measured at 1.6 MP against 0.27 MP, the frame rate moved by
				// less than a fifth because the offscreen work never changed.
				target.width = Math.max(1, Math.round(size.width * quality));
				target.height = Math.max(1, Math.round(size.height * quality));
				gl.bindTexture(gl.TEXTURE_2D, target.tex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, target.width, target.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
				gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
				// Depth, or the geometry pass draws itself in the wrong order.
				if (!target.depth) target.depth = gl.createRenderbuffer();
				gl.bindRenderbuffer(gl.RENDERBUFFER, target.depth);
				gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, target.width, target.height);
				gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, target.depth);
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		};

		const compile = (type, source) => {
			const shader = gl.createShader(type);
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				console.warn("[hero] shader:", gl.getShaderInfoLog(shader));
				return null;
			}
			return shader;
		};
		const programs = new Map();
		for (const entry of frame.programs) {
			const vs = compile(gl.VERTEX_SHADER, entry.vertex);
			const fs = compile(gl.FRAGMENT_SHADER, entry.fragment);
			if (!vs || !fs) continue;
			const program = gl.createProgram();
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				console.warn("[hero] link:", gl.getProgramInfoLog(program));
				continue;
			}
			programs.set(entry.id, program);
		}
		say("setup: buffers=" + buffers.size + " programs=" + programs.size + " err=" + gl.getError());
		if (programs.size === 0) return;

		let aspectScale = 1;
		// How much of the requested resolution this machine actually gets. A ripped scene is
		// somebody else's shader budget running on hardware it was never measured against, so
		// rather than pick a number, the loop times itself and settles where the frames land.
		let quality = 1;
		let sinceCheck = 0;
		let checkStart = 0;
		const adapt = (now) => {
			if (!checkStart) { checkStart = now; return; }
			sinceCheck++;
			// Judged on elapsed time, not a frame count. A fixed number of frames means the
			// machine that is struggling waits longest for help: at two frames a second a
			// thirty-frame window is fifteen seconds of the lag we are trying to fix.
			const elapsed = now - checkStart;
			if (elapsed < 500 || sinceCheck < 5) return;
			const fps = (sinceCheck * 1000) / elapsed;
			sinceCheck = 0;
			checkStart = now;
			// Hysteresis either side of the target, so a scene that lands near the boundary
			// settles instead of resizing every half second.
			const before = quality;
			if (fps < 40 && quality > 0.4) quality = Math.max(0.4, quality * 0.8);
			else if (fps > 56 && quality < 1) quality = Math.min(1, quality * 1.1);
			if (quality !== before) { fit(); sizeTargets(); }
		};
		const fit = () => {
			const rect = canvas.getBoundingClientRect();
			// Device pixel ratio is not the whole story. These scenes were captured from a hero
			// box a few hundred pixels tall and are mostly full-surface shader passes, so cost
			// is per pixel and the buffer is what decides whether this runs. Stretched to a
			// 2560-wide window at ratio 2 that is a 14.7 megapixel buffer — and the offscreen
			// targets are sized to match, so every pass pays it again. The original never draws
			// a tenth of that. So the ratio is capped, and then the whole buffer is held under
			// a pixel budget: a small canvas stays sharp, a full-screen one stops asking the
			// GPU for work nobody can see.
			const MAX_PIXELS = 2600000;
			let dpr = Math.min(window.devicePixelRatio || 1, 2);
			const wanted = rect.width * dpr * rect.height * dpr;
			if (wanted > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / wanted);
			// The budget above is a guess about a machine we cannot see. This is the part that
			// knows: quality is what the frame timer below has decided this GPU can hold, so a
			// scene that is too expensive here gets smaller until it runs instead of staying
			// sharp and dropping frames.
			dpr *= quality;
			canvas.width = Math.max(1, Math.round(rect.width * dpr));
			canvas.height = Math.max(1, Math.round(rect.height * dpr));
			gl.viewport(0, 0, canvas.width, canvas.height);
			// The projection matrix was captured at the page's aspect ratio, and it is rebuilt
			// for ours rather than scaled by a ratio. A perspective matrix holds f/aspect in
			// [0] and f in [5], so the exact correction is [0] = [5] / aspect — which is what
			// makes the scene compose the same way at any window shape instead of drifting.
			aspectScale = canvas.width / (canvas.height || 1);
		};
		window.addEventListener("resize", () => { fit(); sizeTargets(); });
		fit();
		sizeTargets();

		// --- the call stream -------------------------------------------------------
		// Whatever the engine did between frames arrives as the calls it made. The captured
		// frame establishes the state; the stream then applies the page's own per-frame
		// changes on top, which is how motion the sampler never modelled comes back.
		const handles = new Map();
		for (const entry of frame.buffers) if (entry.handle) handles.set(entry.handle, buffers.get(entry.id));
		for (const entry of frame.textures) if (entry.handle) handles.set(entry.handle, textures.get(entry.id));
		for (const entry of frame.framebuffers) {
			const target = targets.get(entry.id);
			if (entry.handle && target) handles.set(entry.handle, target.fbo);
		}
		for (const entry of frame.programs) if (entry.handle) handles.set(entry.handle, programs.get(entry.id));

		// A uniform location is per-program, so the stream's handle is resolved by looking the
		// name up again on the program this replay compiled.
		const locations = new Map();
		for (const entry of frame.locationNames || []) {
			const program = handles.get(entry.program);
			if (!program) continue;
			const location = gl.getUniformLocation(program, entry.name);
			if (location) locations.set(entry.handle, location);
		}

		// A uniform location, an attribute slot and a block index are all fixed for the life
		// of the program they belong to. The replay was asking the driver for them again for
		// every uniform of every draw of every frame — on a scene with a few dozen draws that
		// is tens of thousands of synchronous queries a second, and it is why a rebuilt hero
		// crawled on hardware that runs the original at sixty. Asked once, then remembered.
		const lookups = new WeakMap();
		const lookup = (program, kind, name, resolve) => {
			let store = lookups.get(program);
			if (!store) { store = { uniform: new Map(), attrib: new Map(), block: new Map() }; lookups.set(program, store); }
			const cached = store[kind];
			if (!cached.has(name)) cached.set(name, resolve());
			return cached.get(name);
		};
		const uniformLocation = (program, name) =>
			lookup(program, "uniform", name, () => gl.getUniformLocation(program, name));
		const attribLocation = (program, name) =>
			lookup(program, "attrib", name, () => gl.getAttribLocation(program, name));
		const blockIndex = (program, name) =>
			lookup(program, "block", name, () => gl.getUniformBlockIndex(program, name));

		const ARRAYS = {
			Float32Array: Float32Array, Uint8Array: Uint8Array, Uint16Array: Uint16Array,
			Uint32Array: Uint32Array, Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array,
		};
		const decodeArg = (arg) => {
			if (arg === null || typeof arg === "number" || typeof arg === "boolean") return arg;
			if (arg.drop) return null;
			if (arg.data !== undefined) {
				const bytes = decode(arg.data);
				const Ctor = ARRAYS[arg.kind] || Uint8Array;
				return Ctor === Uint8Array ? bytes : new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
			}
			if (arg.handle !== undefined) {
				// A location first — the two id spaces overlap and a uniform call always wants
				// a location, never a buffer.
				return locations.get(arg.handle) ?? handles.get(arg.handle) ?? null;
			}
			return null;
		};

		// The stream split into frames, so it can be played at the viewer's frame rate rather
		// than all at once.
		const streamFrames = [];
		// Off unless asked for. Replaying raw calls against state this runtime set up is a
		// sharper tool than it looks: one unresolved handle becomes a null argument, a null
		// argument to bindBuffer unbinds the geometry, and the next frame draws a flat
		// polygon where the scene was. It stays behind a switch until every call it makes can
		// be resolved.
		if (${useStream ? "true" : "false"} && !FREEZE && frame.stream && frame.stream.length) {
			let current = [];
			for (const call of frame.stream) {
				if (call.f === "__frame") {
					if (current.length) streamFrames.push(current);
					current = [];
					continue;
				}
				current.push(call);
			}
			if (current.length) streamFrames.push(current);
		}

		const playFrame = (calls) => {
			for (const call of calls) {
				const fn = gl[call.f];
				if (typeof fn !== "function") continue;
				// A call whose object this replay never created is skipped rather than made
				// with a null in place of it: passing null to bindBuffer or useProgram is a
				// valid call that unbinds, which corrupts everything drawn after it.
				let resolvable = true;
				for (const arg of call.a) {
					if (arg && typeof arg === "object" && arg.handle !== undefined) {
						if (!locations.has(arg.handle) && !handles.has(arg.handle)) resolvable = false;
					}
					if (arg && typeof arg === "object" && arg.drop) resolvable = false;
				}
				if (!resolvable) continue;
				const args = call.a.map(decodeArg);
				// A uniform or draw whose object went missing would throw; skipping it keeps
				// the rest of the frame.
				try { fn.apply(gl, args); } catch (e) { /* an argument this replay has no object for */ }
			}
		};

		const started = performance.now();
		const isClock = (name) => !FREEZE && /^(u_?)?(time|itime|elapsed|frame)$/i.test(name);
		const isResolution = (name) => /resolution|viewportsize|screensize/i.test(name);
		const isProjection = (name) => /projection/i.test(name);

		const asNumber = (x) => (typeof x === "number" ? x : x === "Infinity" ? Infinity : x === "-Infinity" ? -Infinity : Number.NaN);

		// What moves, and how. Every uniform is looked up across the captured samples; the
		// ones that actually change get a little function of time, and the rest are constants
		// set once. A value that only ever moves one way is extrapolated at the rate it was
		// moving — which is exactly right for a drift and close enough for an ease — while
		// anything that turns around is looped through its samples instead of being flung off
		// to infinity.
		// The entrance, then the loop. Each animated uniform gets the intro samples first and
		// the settled ones after, so the replay arrives the way the page arrives instead of
		// opening in its resting state.
		const intro = new Map();
		let introSpan = 0;
		if (!FREEZE && frame.intro && frame.intro.length > 1) {
			introSpan = frame.intro[frame.intro.length - 1].t || 0;
			for (let d = 0; d < frame.draws.length; d++) {
				for (const uniform of frame.draws[d].uniforms) {
					const samples = [];
					for (const entry of frame.intro) {
						const found = (entry.uniforms[d] || []).find((u) => u.name === uniform.name);
						if (found) samples.push({ t: entry.t, value: found.value.map(asNumber) });
					}
					if (samples.length < 2) continue;
					let moves = false;
					const first = samples[0].value;
					const last = samples[samples.length - 1].value;
					for (let i = 0; i < first.length; i++) if (Math.abs(last[i] - first[i]) > 1e-6) moves = true;
					if (moves) intro.set(d + ":" + uniform.name, samples);
				}
			}
		}

		const alongSamples = (samples, at) => {
			let index = 0;
			while (index < samples.length - 2 && samples[index + 1].t < at) index++;
			const a = samples[index];
			const b = samples[index + 1] || a;
			const gap = b.t - a.t || 1;
			const mix = Math.min(1, Math.max(0, (at - a.t) / gap));
			return a.value.map((v, i) => v + ((b.value[i] ?? v) - v) * mix);
		};

		const motion = new Map();
		// The page's own clock, as it was at each sample. Animation on these pages is a
		// function of that clock, not of wall time, so replaying against it is what makes the
		// motion line up rather than merely move.
		const clockAt = (uniformsForFrame) => {
			for (const draw of uniformsForFrame || []) {
				for (const u of draw || []) {
					if (/^(u_?)?(time|itime|elapsed)$/i.test(u.name) && u.value.length === 1) return asNumber(u.value[0]);
				}
			}
			return null;
		};
		if (!FREEZE && frame.timeline && frame.timeline.length > 1) {
			const span = frame.timeline[frame.timeline.length - 1].t || 1;
			for (let d = 0; d < frame.draws.length; d++) {
				for (const uniform of frame.draws[d].uniforms) {
					const samples = [];
					for (const entry of frame.timeline) {
						const found = (entry.uniforms[d] || []).find((u) => u.name === uniform.name);
						if (found) samples.push({ t: entry.t, value: found.value.map(asNumber) });
					}
					if (samples.length < 2) continue;
					const first = samples[0].value;
					const last = samples[samples.length - 1].value;
					let moves = false;
					for (let i = 0; i < first.length; i++) if (Math.abs(last[i] - first[i]) > 1e-6) moves = true;
					if (!moves) continue;
					// Monotonic in every component, or not.
					let monotonic = true;
					for (let i = 0; i < first.length && monotonic; i++) {
						let sign = 0;
						for (let k = 1; k < samples.length; k++) {
							const delta = samples[k].value[i] - samples[k - 1].value[i];
							if (Math.abs(delta) < 1e-9) continue;
							const s = delta > 0 ? 1 : -1;
							if (sign && s !== sign) { monotonic = false; break; }
							sign = s;
						}
					}
					motion.set(d + ":" + uniform.name, { samples, span, monotonic });
				}
			}
		}

		// What the pointer drives. A uniform counts as pointer-driven when it differs across
		// the cursor samples, which were all taken within a second of each other — so time
		// cannot explain the difference and the cursor can.
		const pointerMotion = new Map();
		if (!FREEZE && frame.pointer && frame.pointer.length > 2) {
			for (let d = 0; d < frame.draws.length; d++) {
				for (const uniform of frame.draws[d].uniforms) {
					const samples = [];
					for (const stop of frame.pointer) {
						const found = (stop.uniforms[d] || []).find((u) => u.name === uniform.name);
						if (found) samples.push({ x: stop.x, y: stop.y, value: found.value.map(asNumber) });
					}
					if (samples.length < 3) continue;
					let spread = 0;
					for (let i = 0; i < samples[0].value.length; i++) {
						let lo = Infinity;
						let hi = -Infinity;
						for (const sample of samples) {
							lo = Math.min(lo, sample.value[i]);
							hi = Math.max(hi, sample.value[i]);
						}
						spread = Math.max(spread, hi - lo);
					}
					if (spread > 1e-5) pointerMotion.set(d + ":" + uniform.name, samples);
				}
			}
		}

		// Where the viewer's cursor is, eased. The original follows the mouse with a spring;
		// snapping straight to the raw position reads as jitter rather than as following.
		const cursor = { x: 0.5, y: 0.5, toX: 0.5, toY: 0.5 };
		if (pointerMotion.size > 0) {
			window.addEventListener("pointermove", (event) => {
				const rect = canvas.getBoundingClientRect();
				if (!rect.width || !rect.height) return;
				cursor.toX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
				cursor.toY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
			});
		}

		// Inverse-distance weighting over the sampled stops, which needs no assumption about
		// how the cursor grid was laid out.
		const valueForCursor = (samples) => {
			let weightSum = 0;
			const out = new Array(samples[0].value.length).fill(0);
			for (const sample of samples) {
				const dx = sample.x - cursor.x;
				const dy = sample.y - cursor.y;
				const distance = Math.sqrt(dx * dx + dy * dy);
				if (distance < 1e-4) return sample.value.slice();
				const weight = 1 / (distance * distance);
				weightSum += weight;
				for (let i = 0; i < out.length; i++) out[i] += sample.value[i] * weight;
			}
			for (let i = 0; i < out.length; i++) out[i] /= weightSum || 1;
			return out;
		};

		const valueAt = (entry, seconds) => {
			const { samples, span } = entry;
			// Always within the range that was actually observed.
			//
			// Extrapolating a trend forwards seemed reasonable and is not: a value that was
			// creeping upwards during the capture keeps creeping for as long as the page is
			// open, so the backdrop's scale ran away until one flat polygon covered the
			// screen. These scenes have an intro and then a loop; the samples are a window
			// onto that, and running back and forth across the window stays inside values the
			// page really produced.
			const cycle = span || 1;
			const phase = (seconds % (cycle * 2)) / cycle;
			return alongSamples(samples, (phase <= 1 ? phase : 2 - phase) * cycle);
		};

		const setUniform = (program, uniform, seconds, drawIndex) => {
			const location = uniformLocation(program, uniform.name);
			if (!location) return;
			// The cursor wins where it has a say: those samples were taken at one moment, so
			// they describe the pointer's effect with time held still.
			const key = drawIndex + ":" + uniform.name;
			const arriving = seconds < introSpan ? intro.get(key) : null;
			const follows = pointerMotion.get(key);
			const moving = motion.get(key);
			const value = arriving
				? alongSamples(arriving, seconds)
				: follows
					? valueForCursor(follows)
					: moving
						? valueAt(moving, seconds - introSpan)
						: uniform.value.map(asNumber);
			if (isClock(uniform.name)) return gl.uniform1f(location, seconds);
			if (!FREEZE && isResolution(uniform.name) && value.length >= 2) {
				return value.length === 2
					? gl.uniform2f(location, canvas.width, canvas.height)
					: gl.uniform3f(location, canvas.width, canvas.height, 1);
			}
			// A sampler holds a texture unit, and the unit was bound before the draw from the
			// recorded unit map. Setting the integer is all that is left.
			if (uniform.texture) return gl.uniform1i(location, uniform.value[0] || 0);
			if (/^uniformMatrix/.test(uniform.kind)) {
				const matrix = value.slice();
				if (!FREEZE && isProjection(uniform.name) && matrix.length === 16 && matrix[5]) {
					// Perspective: [0] is f/aspect. Orthographic ([15] is 1 and [11] is 0) keeps
					// its half-width instead, scaled the same way.
					const orthographic = matrix[11] === 0 && matrix[15] === 1;
					matrix[0] = orthographic ? matrix[5] / aspectScale : matrix[5] / aspectScale;
				}
				const size = Math.sqrt(matrix.length) | 0;
				if (size === 4) return gl.uniformMatrix4fv(location, false, new Float32Array(matrix));
				if (size === 3) return gl.uniformMatrix3fv(location, false, new Float32Array(matrix));
				if (size === 2) return gl.uniformMatrix2fv(location, false, new Float32Array(matrix));
				return;
			}
			const integer = /i$|iv$/.test(uniform.kind);
			const setter = "uniform" + Math.min(Math.max(value.length, 1), 4) + (integer ? "i" : "f");
			if (typeof gl[setter] === "function") gl[setter].apply(gl, [location].concat(value.slice(0, 4)));
		};

		let streamCursor = 0;
		const draw = () => {
			const seconds = (performance.now() - started) / 1000;
			adapt(performance.now());
			// Ease towards the pointer rather than snapping to it.
			cursor.x += (cursor.toX - cursor.x) * 0.08;
			cursor.y += (cursor.toY - cursor.y) * 0.08;
			const first = frame.draws[0];
			if (first) {
				const clear = first.state.clearColor;
				gl.clearColor(clear[0] || 0, clear[1] || 0, clear[2] || 0, clear[3] === undefined ? 1 : clear[3]);
			}

			// Each target is cleared once, the first time a pass draws into it this frame.
			const cleared = new Set();
			for (let callIndex = 0; callIndex < frame.draws.length; callIndex++) {
				const call = frame.draws[callIndex];
				const program = programs.get(call.program);
				if (!program) continue;

				const target = call.target ? targets.get(call.target) : null;
				gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
				// A render target has its own size — three.js renders transmission into a
				// 1024×1024 buffer while the screen is 2400×1934 — so the viewport follows the
				// pass rather than the canvas.
				if (target) gl.viewport(0, 0, target.width, target.height);
				else gl.viewport(0, 0, canvas.width, canvas.height);
				if (!cleared.has(call.target)) {
					cleared.add(call.target);
					gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
				}

				// Put the textures back in the units the page had them in, so every sampler in
				// this program reads what it read originally — including the render target a
				// previous pass just wrote.
				for (const slot of call.units || []) {
					const texture = textures.get(slot.texture);
					if (!texture) continue;
					gl.activeTexture(gl.TEXTURE0 + slot.unit);
					gl.bindTexture(gl.TEXTURE_2D, texture);
				}

				gl.useProgram(program);

				// Uniform blocks first: on WebGL2 the camera matrices live here, and a draw
				// whose blocks are unbound is the difference between a scene and a black
				// rectangle.
				if (gl.bindBufferBase) {
					for (const ubo of call.ubos || []) {
						const buffer = buffers.get(ubo.buffer);
						if (!buffer) continue;
						if (ubo.size) gl.bindBufferRange(gl.UNIFORM_BUFFER, ubo.binding, buffer, ubo.offset, ubo.size);
						else gl.bindBufferBase(gl.UNIFORM_BUFFER, ubo.binding, buffer);
					}
					for (const block of call.blocks || []) {
						// The block index is only meaningful inside the program it came from,
						// so it is looked up again by name wherever the page gave us one.
						let index = block.block;
						if (block.name && gl.getUniformBlockIndex) {
							const found = blockIndex(program, block.name);
							if (found !== gl.INVALID_INDEX) index = found;
						}
						try { gl.uniformBlockBinding(program, index, block.binding); } catch (e) { /* not this program's block */ }
					}
				}

				if (call.state.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
				gl.depthMask(call.state.depthMask !== false);
				if (call.state.depthFunc) gl.depthFunc(call.state.depthFunc);
				if (call.state.blend) {
					gl.enable(gl.BLEND);
					if (call.state.blendSrcAlpha !== undefined) {
						gl.blendFuncSeparate(call.state.blendSrc, call.state.blendDst, call.state.blendSrcAlpha, call.state.blendDstAlpha);
					} else {
						gl.blendFunc(call.state.blendSrc, call.state.blendDst);
					}
					if (call.state.blendEquation) gl.blendEquation(call.state.blendEquation);
				} else gl.disable(gl.BLEND);
				if (call.state.cullFace) {
					gl.enable(gl.CULL_FACE);
					if (call.state.cullMode) gl.cullFace(call.state.cullMode);
					if (call.state.frontFace) gl.frontFace(call.state.frontFace);
				} else gl.disable(gl.CULL_FACE);
				if (call.state.colorMask && call.state.colorMask.length === 4) {
					gl.colorMask(call.state.colorMask[0], call.state.colorMask[1], call.state.colorMask[2], call.state.colorMask[3]);
				}

				for (const attrib of call.attribs) {
					const buffer = buffers.get(attrib.buffer);
					if (!buffer) continue;
					const location = attribLocation(program, attrib.name);
					if (location < 0) continue;
					gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
					gl.enableVertexAttribArray(location);
					// A matrix attribute occupies one location per column. 35674/35675/35676 are
					// FLOAT_MAT2/3/4; anything else is a plain vector in a single slot.
					const columns = attrib.glslType === 35676 ? 4 : attrib.glslType === 35675 ? 3 : attrib.glslType === 35674 ? 2 : 1;
					const size = columns > 1 ? columns : attrib.size;
					for (let column = 0; column < columns; column++) {
						const slot = location + column;
						gl.enableVertexAttribArray(slot);
						gl.vertexAttribPointer(slot, size, attrib.type, attrib.normalized, attrib.stride, attrib.offset + column * size * 4);
						if (gl.vertexAttribDivisor) gl.vertexAttribDivisor(slot, attrib.divisor || 0);
					}
				}
				for (const uniform of call.uniforms) setUniform(program, uniform, seconds, callIndex);

				const instanced = call.instances > 0 || call.attribs.some((a) => a.divisor > 0);
				const instances = call.instances > 0 ? call.instances : 1;
				if (call.indexBuffer) {
					const buffer = buffers.get(call.indexBuffer);
					if (!buffer) continue;
					gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
					if (instanced && gl.drawElementsInstanced) gl.drawElementsInstanced(call.mode, call.count, call.indexType, call.offset, instances);
					else gl.drawElements(call.mode, call.count, call.indexType, call.offset);
				} else if (instanced && gl.drawArraysInstanced) {
					gl.drawArraysInstanced(call.mode, call.offset, call.count, instances);
				} else {
					gl.drawArrays(call.mode, call.offset, call.count);
				}
				${readback}
			}
			// One frame of the page's own calls per rendered frame, looping. The reference
			// frame above put the state where the page had it; this moves it the way the page
			// moved it.
			if (streamFrames.length) {
				playFrame(streamFrames[streamCursor % streamFrames.length]);
				streamCursor++;
			}
			window.__reported = true;
			requestAnimationFrame(draw);
		};
		requestAnimationFrame(draw);
	}
})();
`;
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
