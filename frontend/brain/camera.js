// Orbit camera with free flight and glides to a note. It never moves on its own: the
// view holds exactly where it was left, and every frame here is a few vector operations.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

const FLY_SPEED = 130; // units per second; Shift multiplies

export function createCamera(scene, canvas, isActive) {
	const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.15, 1600, Vector3.Zero(), scene);
	// noPreventDefault must stay false — otherwise the browser keeps wheel events and zoom dies.
	camera.attachControl(canvas, false);
	// Right-drag rotates too — the context menu would otherwise swallow button 2.
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());
	camera.minZ = 1;
	camera.maxZ = 8000;
	camera.wheelDeltaPercentage = 0.05;
	camera.pinchDeltaPercentage = 0.01;
	camera.panningSensibility = 0;
	camera.lowerRadiusLimit = 15;
	camera.upperRadiusLimit = 4000;

	let glide = null;
	let held = false;
	const flyKeys = new Set();
	const typing = () => {
		const a = document.activeElement;
		return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
	};
	document.addEventListener("keydown", (e) => {
		if (isActive() && !typing()) flyKeys.add(e.code);
	});
	document.addEventListener("keyup", (e) => flyKeys.delete(e.code));
	window.addEventListener("blur", () => flyKeys.clear());

	// WASD flies camera and orbit pivot together (QE / Space+C vertical), Shift is afterburner.
	function fly(dt) {
		if (flyKeys.size === 0) return false;
		const forward = camera.target.subtract(camera.position).normalize();
		const right = Vector3.Cross(camera.upVector, forward).normalize();
		const move = Vector3.Zero();
		if (flyKeys.has("KeyW")) move.addInPlace(forward);
		if (flyKeys.has("KeyS")) move.subtractInPlace(forward);
		if (flyKeys.has("KeyD")) move.addInPlace(right);
		if (flyKeys.has("KeyA")) move.subtractInPlace(right);
		if (flyKeys.has("KeyE") || flyKeys.has("Space")) move.addInPlace(camera.upVector);
		if (flyKeys.has("KeyQ") || flyKeys.has("KeyC")) move.subtractInPlace(camera.upVector);
		if (move.lengthSquared() === 0) return false;
		move.normalize().scaleInPlace(FLY_SPEED * (flyKeys.has("ShiftLeft") || flyKeys.has("ShiftRight") ? 4 : 1) * dt);
		camera.target.addInPlace(move);
		camera.position.addInPlace(move);
		return true;
	}

	function glideTo(target, radius, ms) {
		if (held) return;
		glide = { fromTarget: camera.target.clone(), toTarget: target, fromRadius: camera.radius, toRadius: radius, start: performance.now(), ms };
	}

	/** Per frame: flight, and a glide if one is running. Nothing else ever moves the camera. */
	function update(dt, now) {
		if (fly(dt)) glide = null;
		if (!glide) return;
		const t = Math.min((now - glide.start) / glide.ms, 1);
		const e = 1 - (1 - t) ** 3;
		camera.setTarget(Vector3.Lerp(glide.fromTarget, glide.toTarget, e));
		camera.radius = glide.fromRadius + (glide.toRadius - glide.fromRadius) * e;
		if (t >= 1) glide = null;
	}

	/** Harness hook: refuse every automatic move, so a frame can be compared with itself. */
	function hold(on) {
		held = on;
		if (on) glide = null;
	}

	return { camera, glideTo, update, hold };
}
