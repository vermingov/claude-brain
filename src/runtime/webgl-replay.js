// The engine that draws a ripped WebGL frame again.
//
// Read at generation time and written out as the rebuild's hero script, wrapped in an IIFE
// that defines HERO: { dataHref, debug, freeze, frame }. `frame` is set when the capture is
// carried inline, and fetched from dataHref when it is not. It is a plain file rather than a
// template string so it can be read, linted and debugged as the code it is.
//
// Two halves, deliberately apart:
//
//   the scene      everything the page uploaded — buffers, textures, programs, render
//                  targets — recreated as it was, and a render() that issues the recorded
//                  passes in the recorded order with whatever uniform values are current.
//   a behaviour    what moves, and when a frame is drawn. A site-specific behaviour ported
//                  from the page's own code registers itself as window.__heroBehaviour and
//                  gets the scene and an environment; without one, the generic model below
//                  drives the uniforms from the samples the capture took.
//
// The split is what makes a faithful rebuild possible at all. A sampled model can only ever
// approximate motion that depends on frame rate, pointer history or a clock that the page
// resets; a behaviour that runs the page's rules against this scene reproduces it.

function heroMain() {
	bindInViewClasses();
	const canvas = document.querySelector("canvas[data-hero-scene]");
	if (!canvas) return;
	if (HERO.frame) {
		start(canvas, HERO.frame);
		return;
	}
	fetch(HERO.dataHref)
		.then((res) => res.json())
		.then((frame) => start(canvas, frame))
		.catch((err) => console.warn("[hero] the captured frame could not be loaded:", err));
}

function start(canvas, frame) {
	const scene = createScene(canvas, frame);
	if (!scene) return;
	window.__heroScene = scene;
	// A harness drives the scene itself: it sets uniforms and calls render() when it wants.
	if (window.__heroManual) return;
	const env = browserEnv(canvas);
	const behaviour = typeof window.__heroBehaviour === "function" ? window.__heroBehaviour : defaultBehaviour;
	scene.behaviour = behaviour(scene, env, frame);
}

// A class the page toggled while an element was in view — the React `useInView` pattern, where
// an animation runs only while its element can be seen. The rebuild carries no script of its
// own, so the markup names the class and the element to watch, and this does the toggling:
// data-inview-class="<class>" on the element, data-inview-observe="parent" when the page
// observed its container instead.
function bindInViewClasses() {
	if (typeof IntersectionObserver === "undefined") return;
	for (const element of document.querySelectorAll("[data-inview-class]")) {
		const name = element.getAttribute("data-inview-class");
		if (!name) continue;
		const watched = element.getAttribute("data-inview-observe") === "parent" && element.parentElement ? element.parentElement : element;
		new IntersectionObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last) element.classList.toggle(name, last.isIntersecting);
		}, { threshold: 0 }).observe(watched);
	}
}

// ---- the scene ----------------------------------------------------------------------------

function createScene(canvas, frame) {
	const say = HERO.debug ? (m) => (window.__report = window.__report || []).push(String(m)) : () => {};
	// The page's own context attributes. Antialiasing changes every edge, and a page that
	// preserves its drawing buffer can be read back — both are part of what it looks like.
	const attributes = Object.assign(
		{ alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false },
		frame.contextAttributes || {},
	);
	const gl = (frame.webgl2 && canvas.getContext("webgl2", attributes)) || canvas.getContext("webgl", attributes);
	if (!gl) return null;
	const WEBGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;

	for (const name of frame.extensions || []) {
		try { gl.getExtension(name); } catch (e) { /* not available in this browser */ }
	}
	const vaoExt = WEBGL2 ? null : gl.getExtension("OES_vertex_array_object");
	const instancedExt = WEBGL2 ? null : gl.getExtension("ANGLE_instanced_arrays");
	const createVertexArray = () => (WEBGL2 ? gl.createVertexArray() : vaoExt ? vaoExt.createVertexArrayOES() : null);
	const bindVertexArray = (vao) => (WEBGL2 ? gl.bindVertexArray(vao) : vaoExt ? vaoExt.bindVertexArrayOES(vao) : null);
	const vertexAttribDivisor = (slot, divisor) =>
		WEBGL2 ? gl.vertexAttribDivisor(slot, divisor) : instancedExt ? instancedExt.vertexAttribDivisorANGLE(slot, divisor) : null;

	const decode = (base64) => {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	};
	// Float and half-float uploads have to arrive in the matching typed array, or the call is
	// an INVALID_OPERATION however correct the bytes are.
	const asPixels = (bytes, pixelType) => {
		if (pixelType === 0x1406) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
		if (pixelType === 0x140b || pixelType === 0x8d61) return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
		if (pixelType === 0x1405) return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
		if (pixelType === 0x1403) return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
		return bytes;
	};
	const asNumber = (x) => (typeof x === "number" ? x : x === "Infinity" ? Infinity : x === "-Infinity" ? -Infinity : Number.NaN);

	// Buffers. A WebGL buffer binds to one target for life, so each one's target is decided
	// from how the frame uses it before anything is uploaded.
	const targetOf = new Map();
	for (const draw of frame.draws) {
		if (draw.indexBuffer) targetOf.set(draw.indexBuffer, gl.ELEMENT_ARRAY_BUFFER);
		for (const ubo of draw.ubos || []) if (!targetOf.has(ubo.buffer)) targetOf.set(ubo.buffer, gl.UNIFORM_BUFFER);
		for (const attrib of draw.attribs) if (!targetOf.has(attrib.buffer)) targetOf.set(attrib.buffer, gl.ARRAY_BUFFER);
	}
	const buffers = new Map();
	for (const entry of frame.buffers) {
		const target = targetOf.get(entry.id) || gl.ARRAY_BUFFER;
		if (target === gl.UNIFORM_BUFFER && !WEBGL2) continue;
		const buffer = gl.createBuffer();
		gl.bindBuffer(target, buffer);
		gl.bufferData(target, decode(entry.data), target === gl.UNIFORM_BUFFER ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
		buffers.set(entry.id, buffer);
	}
	gl.bindBuffer(gl.ARRAY_BUFFER, null);

	// Textures, straight back as they were uploaded and allocated the way they were allocated.
	const textures = new Map();
	for (const entry of frame.textures) {
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		textures.set(entry.id, texture);
		const wrapS = entry.wrapS || gl.CLAMP_TO_EDGE;
		const wrapT = entry.wrapT || gl.CLAMP_TO_EDGE;
		if (entry.data) {
			const pixels = asPixels(decode(entry.data), entry.pixelType);
			if (entry.storage && WEBGL2) {
				gl.texStorage2D(gl.TEXTURE_2D, 1, entry.internalFormat, entry.width, entry.height);
				gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, entry.width, entry.height, entry.format || gl.RGBA, entry.pixelType || gl.UNSIGNED_BYTE, pixels);
			} else {
				gl.texImage2D(gl.TEXTURE_2D, 0, entry.internalFormat || gl.RGBA, entry.width, entry.height, 0, entry.format || gl.RGBA, entry.pixelType || gl.UNSIGNED_BYTE, pixels);
			}
			const isFloat = entry.pixelType === 0x1406 || entry.pixelType === 0x140b || entry.pixelType === 0x8d61;
			const filter = isFloat && !WEBGL2 && !gl.getExtension("OES_texture_float_linear") ? gl.NEAREST : gl.LINEAR;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, entry.minFilter === gl.NEAREST ? gl.NEAREST : filter);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, entry.minFilter === gl.NEAREST ? gl.NEAREST : filter);
			continue;
		}
		// One opaque pixel until the image decodes, so the first frames are not black.
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
		const image = new Image();
		image.onload = () => {
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!entry.flipY);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		};
		image.src = entry.source;
	}
	// Bound where a sampler would otherwise read the target it is drawing into.
	const placeholder = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, placeholder);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

	// Programs.
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
	if (programs.size === 0) return null;

	// Locations are fixed for the life of a program; asking the driver again every frame is
	// tens of thousands of synchronous queries a second.
	const lookups = new WeakMap();
	const lookup = (program, kind, name, resolve) => {
		let store = lookups.get(program);
		if (!store) { store = { uniform: new Map(), attrib: new Map(), block: new Map() }; lookups.set(program, store); }
		if (!store[kind].has(name)) store[kind].set(name, resolve());
		return store[kind].get(name);
	};
	const uniformLocation = (program, name) => lookup(program, "uniform", name, () => gl.getUniformLocation(program, name));
	const attribLocation = (program, name) => lookup(program, "attrib", name, () => gl.getAttribLocation(program, name));
	const blockIndex = (program, name) => lookup(program, "block", name, () => gl.getUniformBlockIndex(program, name));

	// Render targets, allocated in the page's own format. A half-float buffer holds the dark
	// end of a gradient that eight bits band, and a pass that samples it shows the difference.
	const firstViewport = new Map();
	for (const call of frame.draws) {
		const vp = call.state && call.state.viewport;
		if (call.target && vp && vp[2] && vp[3] && !firstViewport.has(call.target)) firstViewport.set(call.target, { width: vp[2], height: vp[3] });
	}
	const targets = new Map();
	const allocateTarget = (target, width, height) => {
		if (target.texture) gl.deleteTexture(target.texture);
		const texture = gl.createTexture();
		const f = target.format || {};
		gl.bindTexture(gl.TEXTURE_2D, texture);
		if (WEBGL2 && f.storage && f.internalFormat) {
			gl.texStorage2D(gl.TEXTURE_2D, 1, f.internalFormat, width, height);
		} else {
			gl.texImage2D(gl.TEXTURE_2D, 0, f.internalFormat || gl.RGBA, width, height, 0, f.format || gl.RGBA, f.pixelType || gl.UNSIGNED_BYTE, null);
		}
		const min = f.minFilter === gl.NEAREST ? gl.NEAREST : gl.LINEAR;
		const mag = f.magFilter === gl.NEAREST ? gl.NEAREST : gl.LINEAR;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, f.wrapS || gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, f.wrapT || gl.CLAMP_TO_EDGE);
		gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		if (target.depthFormat !== 0) {
			if (!target.depth) target.depth = gl.createRenderbuffer();
			const depthFormat = target.depthFormat || gl.DEPTH_COMPONENT16;
			gl.bindRenderbuffer(gl.RENDERBUFFER, target.depth);
			gl.renderbufferStorage(gl.RENDERBUFFER, depthFormat, width, height);
			const attachment = depthFormat === gl.DEPTH_STENCIL || depthFormat === 0x88f0 /* DEPTH24_STENCIL8 */ ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, target.depth);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		target.texture = texture;
		target.width = width;
		target.height = height;
		textures.set(target.colour, texture);
	};
	for (const entry of frame.framebuffers) {
		const size = firstViewport.get(entry.id) || { width: 1, height: 1 };
		const target = { id: entry.id, colour: entry.colour, format: entry.colourFormat || null, depthFormat: entry.depthFormat, fbo: gl.createFramebuffer(), texture: null, depth: null, width: 0, height: 0 };
		allocateTarget(target, size.width, size.height);
		targets.set(entry.id, target);
	}

	// The draws, each with its own table of uniform values that a behaviour writes into.
	const draws = frame.draws.map((call, index) => {
		const uniforms = new Map();
		for (const u of call.uniforms) {
			uniforms.set(u.name, { name: u.name, kind: u.kind, sampler: !!u.texture, value: u.value.map(asNumber) });
		}
		return { index, target: call.target, program: call.program, uniforms, call, vao: null };
	});

	// Uploads are skipped when a location already holds the value: two draws that share a
	// program share its uniforms, so the cache is per location, not per draw.
	const uploaded = new WeakMap();
	const sameValues = (a, b) => {
		if (!a || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	};
	const upload = (location, entry) => {
		const values = entry.value;
		if (sameValues(uploaded.get(location), values)) return;
		uploaded.set(location, values.slice());
		const kind = entry.kind;
		if (kind.startsWith("uniformMatrix")) {
			gl[kind](location, false, new Float32Array(values));
			return;
		}
		const count = Number(kind.charAt(7)) || values.length || 1;
		if (kind.endsWith("i")) gl["uniform" + count + "iv"](location, new Int32Array(values.slice(0, count)));
		else gl["uniform" + count + "fv"](location, new Float32Array(values.slice(0, count)));
	};

	const buildVertexArray = (draw, program) => {
		const vao = createVertexArray();
		if (!vao) return null;
		bindVertexArray(vao);
		bindAttributes(draw, program);
		bindVertexArray(null);
		return vao;
	};
	const bindAttributes = (draw, program) => {
		for (const attrib of draw.call.attribs) {
			const buffer = buffers.get(attrib.buffer);
			if (!buffer) continue;
			const location = attribLocation(program, attrib.name);
			if (location < 0) continue;
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			// A matrix attribute occupies one location per column.
			const columns = attrib.glslType === 35676 ? 4 : attrib.glslType === 35675 ? 3 : attrib.glslType === 35674 ? 2 : 1;
			const size = columns > 1 ? columns : attrib.size;
			for (let column = 0; column < columns; column++) {
				const slot = location + column;
				gl.enableVertexAttribArray(slot);
				gl.vertexAttribPointer(slot, size, attrib.type, attrib.normalized, attrib.stride, attrib.offset + column * size * 4);
				vertexAttribDivisor(slot, attrib.divisor || 0);
			}
		}
		if (draw.call.indexBuffer && buffers.get(draw.call.indexBuffer)) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.get(draw.call.indexBuffer));
	};

	// ---- sizing, the way three.js does it: the buffer is floored, the viewport rounded ------
	let pixelRatio = frame.canvas && frame.canvasCss && frame.canvasCss.width ? frame.canvas.width / frame.canvasCss.width : Math.min(window.devicePixelRatio || 1, 2);
	const screen = { width: 1, height: 1 };
	const applySize = () => {
		const rect = canvas.getBoundingClientRect();
		const width = Math.max(1, Math.floor(rect.width * pixelRatio));
		const height = Math.max(1, Math.floor(rect.height * pixelRatio));
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		screen.width = Math.max(1, Math.round(rect.width * pixelRatio));
		screen.height = Math.max(1, Math.round(rect.height * pixelRatio));
	};

	const applyState = (state) => {
		if (state.depthTest) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
		gl.depthMask(state.depthMask !== false);
		if (state.depthFunc) gl.depthFunc(state.depthFunc);
		if (state.blend) {
			gl.enable(gl.BLEND);
			if (state.blendSrcAlpha !== undefined) gl.blendFuncSeparate(state.blendSrc, state.blendDst, state.blendSrcAlpha, state.blendDstAlpha);
			else gl.blendFunc(state.blendSrc, state.blendDst);
			if (state.blendEquation) gl.blendEquation(state.blendEquation);
		} else gl.disable(gl.BLEND);
		if (state.cullFace) {
			gl.enable(gl.CULL_FACE);
			if (state.cullMode) gl.cullFace(state.cullMode);
			if (state.frontFace) gl.frontFace(state.frontFace);
		} else gl.disable(gl.CULL_FACE);
		if (state.colorMask && state.colorMask.length === 4) gl.colorMask(state.colorMask[0], state.colorMask[1], state.colorMask[2], state.colorMask[3]);
	};

	const render = () => {
		applySize();
		const cleared = new Set();
		for (const draw of draws) {
			const program = programs.get(draw.program);
			if (!program) continue;
			const target = draw.target ? targets.get(draw.target) : null;
			if (draw.target && !target) continue;
			const state = draw.call.state;

			gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
			if (target) gl.viewport(0, 0, target.width, target.height);
			else gl.viewport(0, 0, screen.width, screen.height);
			// Each target is cleared once per frame, with the colour the page cleared it to,
			// the first time a pass draws into it — which is what three.js's render() does.
			if (!cleared.has(draw.target)) {
				cleared.add(draw.target);
				const c = state.clearColor || [0, 0, 0, 0];
				gl.colorMask(true, true, true, true);
				gl.depthMask(true);
				gl.clearColor(c[0], c[1], c[2], c[3]);
				gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
			}

			gl.useProgram(program);
			// Samplers read the texture the page had in their unit — except a render target
			// being drawn into, which would be a feedback loop.
			for (const entry of draw.uniforms.values()) {
				if (!entry.sampler) continue;
				const unit = entry.value[0] || 0;
				const slot = (draw.call.units || []).find((s) => s.unit === unit);
				let texture = slot ? textures.get(slot.texture) : null;
				if (target && texture === target.texture) texture = placeholder;
				gl.activeTexture(gl.TEXTURE0 + unit);
				gl.bindTexture(gl.TEXTURE_2D, texture || placeholder);
			}

			if (WEBGL2) {
				for (const ubo of draw.call.ubos || []) {
					const buffer = buffers.get(ubo.buffer);
					if (!buffer) continue;
					if (ubo.size) gl.bindBufferRange(gl.UNIFORM_BUFFER, ubo.binding, buffer, ubo.offset, ubo.size);
					else gl.bindBufferBase(gl.UNIFORM_BUFFER, ubo.binding, buffer);
				}
				for (const block of draw.call.blocks || []) {
					let index = block.block;
					if (block.name) {
						const found = blockIndex(program, block.name);
						if (found !== gl.INVALID_INDEX) index = found;
					}
					try { gl.uniformBlockBinding(program, index, block.binding); } catch (e) { /* not this program's block */ }
				}
			}

			applyState(state);
			if (!draw.vao && draw.vao !== false) draw.vao = buildVertexArray(draw, program) || false;
			if (draw.vao) bindVertexArray(draw.vao);
			else bindAttributes(draw, program);

			for (const entry of draw.uniforms.values()) {
				const location = uniformLocation(program, entry.name);
				if (location) upload(location, entry);
			}

			const call = draw.call;
			const instanced = call.instances > 0 || call.attribs.some((a) => a.divisor > 0);
			const instances = call.instances > 0 ? call.instances : 1;
			if (call.indexBuffer) {
				if (instanced) {
					if (WEBGL2) gl.drawElementsInstanced(call.mode, call.count, call.indexType, call.offset, instances);
					else if (instancedExt) instancedExt.drawElementsInstancedANGLE(call.mode, call.count, call.indexType, call.offset, instances);
				} else gl.drawElements(call.mode, call.count, call.indexType, call.offset);
			} else if (instanced) {
				if (WEBGL2) gl.drawArraysInstanced(call.mode, call.offset, call.count, instances);
				else if (instancedExt) instancedExt.drawArraysInstancedANGLE(call.mode, call.offset, call.count, instances);
			} else gl.drawArrays(call.mode, call.offset, call.count);
			if (draw.vao) bindVertexArray(null);

			if (HERO.debug && !window.__reported) {
				const px = new Uint8Array(4);
				gl.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
				say("after p" + draw.program + " target" + draw.target + " centre=" + Array.from(px).join(",") + " err=" + gl.getError());
			}
		}
		if (HERO.debug) window.__reported = true;
	};

	return {
		canvas,
		gl,
		draws,
		/** Write a uniform for the next render. Names a draw does not declare are ignored. */
		set(index, name, value) {
			const draw = draws[index];
			const entry = draw && draw.uniforms.get(name);
			if (!entry) return;
			if (typeof value === "number" || typeof value === "boolean") entry.value = [Number(value)];
			else entry.value = Array.from(value, Number);
		},
		render,
		/** A frame with nothing in it: the canvas cleared and left to show what is behind it. */
		clearScreen(r, g, b, a) {
			applySize();
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, screen.width, screen.height);
			gl.colorMask(true, true, true, true);
			gl.depthMask(true);
			gl.clearColor(r, g, b, a);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
		},
		setPixelRatio(ratio) {
			if (ratio > 0) pixelRatio = ratio;
		},
		setTargetSize(id, width, height) {
			const target = targets.get(id);
			width = Math.max(1, Math.round(width));
			height = Math.max(1, Math.round(height));
			if (target && (target.width !== width || target.height !== height)) allocateTarget(target, width, height);
		},
		targetSize(id) {
			const target = targets.get(id);
			return target ? { width: target.width, height: target.height } : null;
		},
		pixelRatio: () => pixelRatio,
	};
}

// ---- the environment a behaviour runs in ------------------------------------------------------

function browserEnv(canvas) {
	const size = () => {
		const rect = canvas.getBoundingClientRect();
		return { width: rect.width, height: rect.height };
	};
	return {
		now: () => performance.now(),
		requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
		setTimeout: (callback, ms) => window.setTimeout(callback, ms),
		size,
		onMouseMove: (handler) => window.addEventListener("mousemove", (e) => handler(e.clientX, e.clientY, window.innerWidth, window.innerHeight)),
		onPointerMove: (handler) => window.addEventListener("pointermove", (e) => {
			const rect = canvas.getBoundingClientRect();
			if (rect.width && rect.height) handler((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
		}),
		onResize: (handler) => {
			if (typeof ResizeObserver === "undefined") {
				window.addEventListener("resize", () => handler(size()));
				return;
			}
			new ResizeObserver(() => handler(size())).observe(canvas);
		},
		onScroll: (handler) => window.addEventListener("scroll", () => handler(window.scrollX, window.scrollY), { passive: true }),
		onPointerDown: (handler) => window.addEventListener("pointerdown", (e) => handler(e.clientX, e.clientY, e.button)),
		onPointerUp: (handler) => window.addEventListener("pointerup", (e) => handler(e.clientX, e.clientY, e.button)),
		onInView: (handler) => {
			if (typeof IntersectionObserver === "undefined") {
				handler(true);
				return;
			}
			new IntersectionObserver((entries) => {
				const last = entries[entries.length - 1];
				if (last) handler(last.isIntersecting);
			}, { threshold: 0 }).observe(canvas);
		},
	};
}

// ---- the generic behaviour: motion modelled from the samples the capture took ---------------

function defaultBehaviour(scene, env, frame) {
	const FREEZE = !!HERO.freeze;
	const asNumber = (x) => (typeof x === "number" ? x : x === "Infinity" ? Infinity : x === "-Infinity" ? -Infinity : Number.NaN);
	const isClock = (name) => /^(u_?)?(time|itime|elapsed|frame)$/i.test(name);
	const isResolution = (name) => /resolution|viewportsize|screensize/i.test(name);
	const isProjection = (name) => /projection/i.test(name);

	// Whether a resolution uniform was in CSS pixels or buffer pixels, read off the capture
	// rather than assumed: the same shader written against the other one draws its pattern at
	// double or half the scale.
	const css = frame.canvasCss;
	const resolutionIn = (value) => {
		if (!css || !frame.canvas || value.length < 2) return "buffer";
		const toCss = Math.abs(value[0] - css.width) + Math.abs(value[1] - css.height);
		const toBuffer = Math.abs(value[0] - frame.canvas.width) + Math.abs(value[1] - frame.canvas.height);
		return toCss < toBuffer ? "css" : "buffer";
	};

	// Per uniform, the samples it moves through: the entrance, then the settled loop.
	const seriesFrom = (entries, drawIndex, name) => {
		const samples = [];
		for (const entry of entries || []) {
			const found = (entry.uniforms[drawIndex] || []).find((u) => u.name === name);
			if (found) samples.push({ t: entry.t, value: found.value.map(asNumber) });
		}
		return samples;
	};
	const moves = (samples) => {
		if (samples.length < 2) return false;
		const first = samples[0].value, last = samples[samples.length - 1].value;
		for (let i = 0; i < first.length; i++) if (Math.abs(last[i] - first[i]) > 1e-6) return true;
		return false;
	};
	const along = (samples, at) => {
		let index = 0;
		while (index < samples.length - 2 && samples[index + 1].t < at) index++;
		const a = samples[index], b = samples[index + 1] || a;
		const mix = Math.min(1, Math.max(0, (at - a.t) / (b.t - a.t || 1)));
		return a.value.map((v, i) => v + ((b.value[i] ?? v) - v) * mix);
	};

	const introSpan = !FREEZE && frame.intro && frame.intro.length > 1 ? frame.intro[frame.intro.length - 1].t || 0 : 0;
	const timelineSpan = frame.timeline && frame.timeline.length > 1 ? frame.timeline[frame.timeline.length - 1].t || 1 : 1;
	const plan = scene.draws.map((draw) => {
		const perUniform = new Map();
		if (FREEZE) return perUniform;
		for (const entry of draw.uniforms.values()) {
			const intro = seriesFrom(frame.intro, draw.index, entry.name);
			const timeline = seriesFrom(frame.timeline, draw.index, entry.name);
			perUniform.set(entry.name, {
				captured: entry.value.slice(),
				intro: moves(intro) ? intro : null,
				timeline: moves(timeline) ? timeline : null,
				resolution: isResolution(entry.name) ? resolutionIn(entry.value) : null,
			});
		}
		return perUniform;
	});

	// What the pointer drives: uniforms that differ across the cursor stops.
	const cursor = { x: 0.5, y: 0.5, toX: 0.5, toY: 0.5 };
	const pointerSamples = new Map();
	if (!FREEZE && frame.pointer && frame.pointer.length > 2) {
		for (const draw of scene.draws) {
			for (const entry of draw.uniforms.values()) {
				const samples = [];
				for (const stop of frame.pointer) {
					const found = (stop.uniforms[draw.index] || []).find((u) => u.name === entry.name);
					if (found) samples.push({ x: stop.x, y: stop.y, value: found.value.map(asNumber) });
				}
				if (samples.length < 3) continue;
				let spread = 0;
				for (let i = 0; i < samples[0].value.length; i++) {
					let lo = Infinity, hi = -Infinity;
					for (const s of samples) { lo = Math.min(lo, s.value[i]); hi = Math.max(hi, s.value[i]); }
					spread = Math.max(spread, hi - lo);
				}
				if (spread > 1e-5) pointerSamples.set(draw.index + ":" + entry.name, samples);
			}
		}
		if (pointerSamples.size) env.onPointerMove((x, y) => { cursor.toX = Math.min(1, Math.max(0, x)); cursor.toY = Math.min(1, Math.max(0, y)); });
	}
	const valueForCursor = (samples) => {
		let weightSum = 0;
		const out = new Array(samples[0].value.length).fill(0);
		for (const sample of samples) {
			const distance = Math.hypot(sample.x - cursor.x, sample.y - cursor.y);
			if (distance < 1e-4) return sample.value.slice();
			const weight = 1 / (distance * distance);
			weightSum += weight;
			for (let i = 0; i < out.length; i++) out[i] += sample.value[i] * weight;
		}
		return out.map((v) => v / (weightSum || 1));
	};

	const started = env.now();
	const tick = () => {
		const seconds = (env.now() - started) / 1000;
		cursor.x += (cursor.toX - cursor.x) * 0.08;
		cursor.y += (cursor.toY - cursor.y) * 0.08;
		const size = env.size();
		if (!FREEZE) {
			for (const draw of scene.draws) {
				for (const [name, p] of plan[draw.index]) {
					const follows = pointerSamples.get(draw.index + ":" + name);
					let value = seconds < introSpan && p.intro
						? along(p.intro, seconds)
						: follows
							? valueForCursor(follows)
							: p.timeline
								// Back and forth across the observed window, never extrapolated.
								? along(p.timeline, (((seconds - introSpan) % (timelineSpan * 2)) / timelineSpan <= 1 ? (seconds - introSpan) % (timelineSpan * 2) : timelineSpan * 2 - ((seconds - introSpan) % (timelineSpan * 2))))
								: p.captured;
					if (isClock(name) && value.length === 1) value = [seconds];
					if (p.resolution && value.length >= 2) {
						const ratio = scene.pixelRatio();
						const w = p.resolution === "css" ? size.width : Math.round(size.width * ratio);
						const h = p.resolution === "css" ? size.height : Math.round(size.height * ratio);
						value = value.length === 2 ? [w, h] : [w, h, value[2]];
					}
					if (isProjection(name) && value.length === 16 && value[5]) {
						value = value.slice();
						value[0] = value[5] / (size.width / (size.height || 1));
					}
					scene.set(draw.index, name, value);
				}
			}
		}
		scene.render();
		env.requestAnimationFrame(tick);
	};
	env.requestAnimationFrame(tick);
	return { tick };
}

heroMain();
