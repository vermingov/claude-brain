// An example behaviour: raycast.com's hero, as its own code drives it.
//
// Kept in the package as the reference for what a ported behaviour looks like — the contract
// with the replay engine, and the level of fidelity the port is held to. It is handed to the
// model that ports another site's scene as an example of the job, never as that site's code.
//
// The ripped frame says what is drawn. This says how it moves, and it is a port rather than a
// model: every rule below was read out of raycast.com's scene chunk and the libraries it
// bundles, and checked against a frame-by-frame recording of the real page. Samples of a
// moving scene cannot be replayed faithfully here, because the page's own motion depends on
// the viewer's frame rate — the glass distortion grows by a fixed step per frame, so it
// arrives twice as fast on a 120 Hz screen — and only the logic reproduces that.
//
// Sources, in the order the page runs them each frame:
//   @react-three/fiber   the loop: clock.getDelta(), then every useFrame in mount order,
//                        then one render. setFrameloop() stops and zeroes the clock.
//   drei                 PerformanceMonitor (drops pixel ratio and the transmission buffer
//                        when the frame rate sags), MeshTransmissionMaterial (renders the
//                        scene behind the glass into a 1024² half-float buffer first).
//   raycast              the glass group (distortion creeps to 15, the loop stops at 200 s),
//                        the backdrop cube (springs up from scale 0, tilts toward the mouse).
//   maath/easing         damp, dampAngle, damp3, dampE — SmoothDamp with a cubic
//                        approximation of the exponential.
//
// The engine calls createBehaviour(scene, env). `scene` owns the GPU side; `env` is the
// clock, frame scheduler, timers and observers, injected so the same file runs in a test.

(function (root) {
	// ---- configuration, as the page's server payload hands it to the scene ---------------

	const CONFIG = {
		scene: { cubeZ: -9, cubeY: 0, glassZ: 0, glassRotation: 0.73, cameraZ: 16.54, dpr: 2, monitorPerf: true },
		glass: { resolution: 1024, animateDistortion: true },
		cubeShader: { speed: 0.1, size: 0.99, color1: [244, 254, 255], color2: [255, 122, 152], color3: [184, 2, 50] },
		cubeInteraction: { enabled: true, rotationInfluence: 0.3 },
		camera: { fov: 35, near: 0.01, far: 100 },
	};

	// ---- maath/easing ---------------------------------------------------------------------

	const exp = (t) => 1 / (1 + t + 0.48 * t * t + 0.235 * t * t * t);
	const expoIn = (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10));

	function damp(current, prop, target, smoothTime = 0.25, delta = 0.01, maxSpeed = Infinity, easing = exp, eps = 0.001) {
		const vel = "velocity_" + prop;
		if (current.__damp === undefined) current.__damp = {};
		if (current.__damp[vel] === undefined) current.__damp[vel] = 0;
		if (Math.abs(current[prop] - target) <= eps) {
			current[prop] = target;
			return false;
		}
		smoothTime = Math.max(0.0001, smoothTime);
		const omega = 2 / smoothTime;
		const t = easing(omega * delta);
		let change = current[prop] - target;
		const originalTo = target;
		const maxChange = maxSpeed * smoothTime;
		change = Math.min(Math.max(change, -maxChange), maxChange);
		target = current[prop] - change;
		const temp = (current.__damp[vel] + omega * change) * delta;
		current.__damp[vel] = (current.__damp[vel] - omega * temp) * t;
		let output = target + (change + temp) * t;
		if (originalTo - current[prop] > 0 === output > originalTo) {
			output = originalTo;
			current.__damp[vel] = (output - originalTo) / delta;
		}
		current[prop] = output;
		return true;
	}

	function deltaAngle(current, target) {
		const turn = 2 * Math.PI;
		const n = target - current;
		let a = Math.max(0, Math.min(turn, n - Math.floor(n / turn) * turn));
		if (a > Math.PI) a -= turn;
		return a;
	}

	const dampAngle = (current, prop, target, smoothTime, delta, maxSpeed, easing, eps) =>
		damp(current, prop, current[prop] + deltaAngle(current[prop], target), smoothTime, delta, maxSpeed, easing, eps);

	function damp3(vector, target, smoothTime, delta, maxSpeed, easing, eps) {
		const x = damp(vector, "x", target[0], smoothTime, delta, maxSpeed, easing, eps);
		const y = damp(vector, "y", target[1], smoothTime, delta, maxSpeed, easing, eps);
		const z = damp(vector, "z", target[2], smoothTime, delta, maxSpeed, easing, eps);
		return x || y || z;
	}

	function dampE(euler, target, smoothTime, delta, maxSpeed, easing, eps) {
		const x = dampAngle(euler, "x", target[0], smoothTime, delta, maxSpeed, easing, eps);
		const y = dampAngle(euler, "y", target[1], smoothTime, delta, maxSpeed, easing, eps);
		const z = dampAngle(euler, "z", target[2], smoothTime, delta, maxSpeed, easing, eps);
		return x || y || z;
	}

	// ---- three.js Clock -----------------------------------------------------------------------

	function createClock(now) {
		const clock = { autoStart: true, startTime: 0, oldTime: 0, elapsedTime: 0, running: false };
		clock.start = () => {
			clock.startTime = now();
			clock.oldTime = clock.startTime;
			clock.elapsedTime = 0;
			clock.running = true;
		};
		clock.getDelta = () => {
			let diff = 0;
			if (clock.autoStart && !clock.running) {
				clock.start();
				return 0;
			}
			if (clock.running) {
				const newTime = now();
				diff = (newTime - clock.oldTime) / 1000;
				clock.oldTime = newTime;
				clock.elapsedTime += diff;
			}
			return diff;
		};
		clock.getElapsedTime = () => {
			clock.getDelta();
			return clock.elapsedTime;
		};
		clock.stop = () => {
			clock.getElapsedTime();
			clock.running = false;
			clock.autoStart = false;
		};
		return clock;
	}

	// ---- three.js matrix arithmetic, column-major -----------------------------------------

	function compose(position, rotation, scale) {
		// Quaternion.setFromEuler, order XYZ.
		const c1 = Math.cos(rotation.x / 2), c2 = Math.cos(rotation.y / 2), c3 = Math.cos(rotation.z / 2);
		const s1 = Math.sin(rotation.x / 2), s2 = Math.sin(rotation.y / 2), s3 = Math.sin(rotation.z / 2);
		const qx = s1 * c2 * c3 + c1 * s2 * s3;
		const qy = c1 * s2 * c3 - s1 * c2 * s3;
		const qz = c1 * c2 * s3 + s1 * s2 * c3;
		const qw = c1 * c2 * c3 - s1 * s2 * s3;
		// Matrix4.compose.
		const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
		const xx = qx * x2, xy = qx * y2, xz = qx * z2;
		const yy = qy * y2, yz = qy * z2, zz = qz * z2;
		const wx = qw * x2, wy = qw * y2, wz = qw * z2;
		const sx = scale.x, sy = scale.y, sz = scale.z;
		return [
			(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
			(xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
			(xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
			position.x, position.y, position.z, 1,
		];
	}

	function multiply(a, b) {
		const out = new Array(16);
		for (let col = 0; col < 4; col++) {
			for (let row = 0; row < 4; row++) {
				out[col * 4 + row] =
					a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
			}
		}
		return out;
	}

	// Matrix3.getNormalMatrix: the inverse transpose of the upper 3×3.
	function normalMatrix(m) {
		const n11 = m[0], n21 = m[1], n31 = m[2];
		const n12 = m[4], n22 = m[5], n32 = m[6];
		const n13 = m[8], n23 = m[9], n33 = m[10];
		const t11 = n33 * n22 - n32 * n23, t12 = n32 * n13 - n33 * n12, t13 = n23 * n12 - n22 * n13;
		const det = n11 * t11 + n21 * t12 + n31 * t13;
		if (det === 0) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
		const id = 1 / det;
		const inv = [
			t11 * id, (n31 * n23 - n33 * n21) * id, (n32 * n21 - n31 * n22) * id,
			t12 * id, (n33 * n11 - n31 * n13) * id, (n31 * n12 - n32 * n11) * id,
			t13 * id, (n21 * n13 - n23 * n11) * id, (n22 * n11 - n21 * n12) * id,
		];
		return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
	}

	// PerspectiveCamera.updateProjectionMatrix → Matrix4.makePerspective.
	function perspective(fov, aspect, near, far) {
		const top = near * Math.tan((Math.PI / 180) * 0.5 * fov);
		const height = 2 * top;
		const width = aspect * height;
		const left = -0.5 * width;
		const right = left + width, bottom = top - height;
		const x = (2 * near) / (right - left), y = (2 * near) / (top - bottom);
		const a = (right + left) / (right - left), b = (top + bottom) / (top - bottom);
		const c = -(far + near) / (far - near), d = (-2 * far * near) / (far - near);
		return [x, 0, 0, 0, 0, y, 0, 0, a, b, c, -1, 0, 0, d, 0];
	}

	// ---- the scene ------------------------------------------------------------------------

	function createBehaviour(scene, env) {
		const { scene: sceneConfig, glass: glassConfig, cubeShader, cubeInteraction, camera } = CONFIG;

		// Which recorded draw is which, found by what each program declares rather than by
		// position, so a recapture that orders the passes differently still lines up.
		const find = (predicate) => scene.draws.findIndex(predicate);
		const has = (draw, name) => draw.uniforms.has(name);
		const cubeBehind = find((d) => has(d, "uTime") && d.target !== 0);
		const cubeOnScreen = find((d) => has(d, "uTime") && d.target === 0);
		const glass = find((d) => has(d, "distortion"));
		const transmissionTarget = glass >= 0 ? scene.draws[cubeBehind].target : 0;

		const clock = createClock(env.now);
		let frameloop = "always";
		let size = env.size();
		let dpr = sceneConfig.dpr;
		let resolution = glassConfig.resolution;

		// R3F's setFrameloop, including what it does to the clock, which is the part that
		// shows: the frame the loop stops on renders the backdrop at time zero.
		const setFrameloop = (next) => {
			clock.stop();
			clock.elapsedTime = 0;
			if (next !== "never") {
				clock.start();
				clock.elapsedTime = 0;
			}
			frameloop = next;
		};

		const viewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -sceneConfig.cameraZ, 1];
		let projection = perspective(camera.fov, size.width / size.height, camera.near, camera.far);

		// The mouse, as the cube reads it: normalised against the window, not the canvas.
		const mouse = { x: 0, y: 0 };
		env.onMouseMove((clientX, clientY, innerWidth, innerHeight) => {
			mouse.x = (clientX / innerWidth) * 2 - 1;
			mouse.y = -(2 * (clientY / innerHeight)) + 1;
		});

		// ---- drei PerformanceMonitor, configured the way the page configures it -------------
		const perf = { fps: 0, index: 0, factor: 1, flipped: 0, refreshrate: 0, frames: [], averages: [], last: 0 };
		const ITERATIONS = 10, WINDOW_MS = 250, THRESHOLD = 0.75, STEP = 0.25;
		const monitorFrame = () => {
			if (perf.averages.length >= ITERATIONS) return;
			perf.frames.push(env.now());
			const passed = perf.frames[perf.frames.length - 1] - perf.frames[0];
			if (passed < WINDOW_MS) return;
			perf.fps = Math.round((perf.frames.length / passed) * 1000) / 1;
			perf.refreshrate = Math.max(perf.refreshrate, perf.fps);
			perf.averages[perf.index++ % ITERATIONS] = perf.fps;
			if (perf.averages.length === ITERATIONS) {
				const lower = 0.75 * perf.refreshrate, upper = perf.refreshrate;
				const above = perf.averages.filter((v) => v >= upper).length;
				const below = perf.averages.filter((v) => v < lower).length;
				if (above > ITERATIONS * THRESHOLD) { perf.factor = Math.min(1, perf.factor + STEP); perf.flipped++; }
				if (below > ITERATIONS * THRESHOLD) { perf.factor = Math.max(0, perf.factor - STEP); perf.flipped++; }
				if (perf.last !== perf.factor) {
					perf.last = perf.factor;
					// onChange: pixel ratio between 1.5 and 2, transmission buffer between a
					// quarter of its size and all of it, both rounded to a tenth.
					const mapLinear = (v, a1, a2, b1, b2) => b1 + ((v - a1) * (b2 - b1)) / (a2 - a1);
					resolution = Math.round(10 * mapLinear(perf.factor, 0, 1, glassConfig.resolution / 4, glassConfig.resolution)) / 10;
					dpr = Math.round(10 * mapLinear(perf.factor, 0, 1, 1.5, 2)) / 10;
					pendingConfigure = true;
				}
				perf.averages = [];
			}
			perf.frames = [];
		};

		// ---- mounting: the page remounts the scene whenever it scrolls back into view ----------
		let inView = false;
		let remounts = 0;
		let mounted = null;
		let pendingConfigure = true;

		const mount = () => ({
			cube: {
				position: { x: 0, y: sceneConfig.cubeY, z: sceneConfig.cubeZ },
				rotation: { x: 0, y: 0, z: 0 },
				scale: { x: 0, y: 0, z: 0 },
				uTime: 0,
				uResolution: [0, 0],
			},
			glass: { time: 0, distortion: { value: 0 }, temporalDistortion: { value: 0 } },
		});

		const bumpRemounts = () => {
			if (!sceneConfig.monitorPerf) return;
			remounts++;
			env.setTimeout(() => { remounts++; reconcile(); }, 100);
			reconcile();
		};
		// React's view of it: rendered when in view and the remount counter is even.
		const reconcile = () => {
			const wanted = inView && remounts % 2 === 0;
			if (wanted && !mounted) mounted = mount();
			if (!wanted && mounted) mounted = null;
			pendingConfigure = true;
			schedule();
		};
		// Canvas re-renders run configure(): a frameloop prop that differs from the state resets
		// the clock, and a pixel ratio or buffer size change is applied.
		const configure = () => {
			pendingConfigure = false;
			const wantedLoop = inView ? "always" : "demand";
			if (frameloop !== wantedLoop) setFrameloop(wantedLoop);
			scene.setPixelRatio(dpr);
			if (transmissionTarget) scene.setTargetSize(transmissionTarget, resolution, resolution);
		};

		// ---- one frame, in the order the page runs it -----------------------------------------
		const cubeMatrix = (cube) => multiply(viewMatrix, compose(cube.position, cube.rotation, cube.scale));
		const colour = (rgb) => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];

		const writeCube = (index, cube) => {
			scene.set(index, "modelViewMatrix", cubeMatrix(cube));
			scene.set(index, "projectionMatrix", projection);
			scene.set(index, "uTime", cube.uTime);
			scene.set(index, "uResolution", cube.uResolution);
			scene.set(index, "uSpeed", cubeShader.speed);
			scene.set(index, "uSize", cubeShader.size);
			scene.set(index, "uColor1", colour(cubeShader.color1));
			scene.set(index, "uColor2", colour(cubeShader.color2));
			scene.set(index, "uColor3", colour(cubeShader.color3));
		};

		const glassModel = compose({ x: 0, y: 0, z: sceneConfig.glassZ }, { x: 0, y: 0, z: sceneConfig.glassRotation }, { x: 1, y: 1, z: 1 });
		const writeGlass = (state) => {
			const modelView = multiply(viewMatrix, glassModel);
			scene.set(glass, "modelMatrix", glassModel);
			scene.set(glass, "viewMatrix", viewMatrix);
			scene.set(glass, "modelViewMatrix", modelView);
			scene.set(glass, "normalMatrix", normalMatrix(modelView));
			scene.set(glass, "projectionMatrix", projection);
			scene.set(glass, "cameraPosition", [0, 0, sceneConfig.cameraZ]);
			scene.set(glass, "time", state.time);
			scene.set(glass, "distortion", state.distortion.value);
			scene.set(glass, "temporalDistortion", state.temporalDistortion.value);
		};

		const renderFrame = () => {
			if (pendingConfigure) configure();
			const delta = clock.getDelta();
			if (sceneConfig.monitorPerf) monitorFrame();
			if (!mounted) {
				// The canvas with nothing mounted in it: three.js clears to transparent black,
				// and the page's own background shows through.
				scene.clearScreen(0, 0, 0, 0);
				return frameloop === "always";
			}
			const { cube, glass: glassState } = mounted;

			// MeshTransmissionMaterial's useFrame renders the scene behind the glass before the
			// cube has updated, so that pass sees last frame's cube.
			glassState.time = clock.elapsedTime;
			if (cubeBehind >= 0) writeCube(cubeBehind, cube);

			// The glass group.
			const viewportWidth = size.width / size.height * 2 * sceneConfig.cameraZ * Math.tan((Math.PI / 180) * camera.fov / 2);
			if (viewportWidth > 7.3 && glassConfig.animateDistortion) {
				damp(glassState.distortion, "value", 15, 30, delta, 0.0002, expoIn);
				damp(glassState.temporalDistortion, "value", 0.025, 10, delta, 0.0002, expoIn);
			}
			if (clock.getElapsedTime() > 200) setFrameloop("never");

			// The cube.
			cube.uTime = clock.getElapsedTime();
			cube.uResolution = [size.width, size.height];
			damp3(cube.scale, [1, 1, 1], 1, delta);
			if (cubeInteraction.enabled) {
				const target = [mouse.x * cubeInteraction.rotationInfluence, -mouse.y * cubeInteraction.rotationInfluence, cube.rotation.z];
				dampE(cube.rotation, target, 0.5, delta, undefined);
			}

			// The render.
			if (glass >= 0) writeGlass(glassState);
			if (cubeOnScreen >= 0) writeCube(cubeOnScreen, cube);
			scene.render();
			return frameloop === "always";
		};

		let scheduled = false;
		const schedule = () => {
			// A stopped loop still wakes for a Canvas re-render: configure() is what restarts it.
			if (scheduled || (frameloop === "never" && !pendingConfigure)) return;
			scheduled = true;
			env.requestAnimationFrame(tick);
		};
		const tick = () => {
			scheduled = false;
			if (renderFrame()) schedule();
		};

		env.onResize((next) => {
			size = next;
			projection = perspective(camera.fov, size.width / size.height, camera.near, camera.far);
			pendingConfigure = true;
			schedule();
		});
		env.onInView((visible) => {
			if (visible === inView) return;
			inView = visible;
			pendingConfigure = true;
			bumpRemounts();
		});

		// The first render of the Canvas: frameloop "demand" until the observer says otherwise,
		// and the mount effect's remount.
		configure();
		bumpRemounts();

		return { renderFrame, debug: () => ({ clock, mounted, frameloop, dpr, resolution, perf, inView, remounts }) };
	}

	root.__heroBehaviour = createBehaviour;
})(typeof window !== "undefined" ? window : globalThis);
