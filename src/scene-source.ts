// Where a page's scene is written: the part of its JavaScript that drives the shaders we ripped.
//
// The ripped frame says what is drawn. How it moves — an entrance, a pointer that tilts
// something, a value that creeps up every frame — lives in the page's own code, and that code is
// on the page to be read. Finding it is a search, and the ripped shaders are the search terms:
// the names a scene's authors chose for their uniforms and functions appear in the GLSL and,
// somewhere, in the JavaScript that sets them.
//
// Frequency does the sorting. A name that appears in only one or two of the page's scripts is a
// fingerprint; a name every three.js chunk contains is not. The scripts that hold the most rare
// names are the scene, and the windows around those names are where its logic sits. Helpers it
// calls from other modules — an easing function, a spring — are followed to their definitions
// one level deep, and configuration handed down in the page's HTML is picked up by the property
// names the code reads off it.
//
// None of this is trusted as instructions. It is somebody else's code, handed to a model as
// material to port, with the page's own recording as the only judge of whether the port is right.

import type { RippedFrame } from "./webgl-ripper";
import { type FetchLimits, guardedFetch } from "./url-guard";

const MAX_SCRIPTS = 80;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const SCRIPT_LIMITS: FetchLimits = { maxBytes: MAX_SCRIPT_BYTES, timeoutMs: 20_000, stallMs: 10_000, accept: ["javascript", "ecmascript", "text/plain", "application/octet-stream"] };
/** A whole scene module is worth more than windows into it, up to this size. */
const WHOLE_CHUNK_BYTES = 160_000;
const WINDOW = 3_000;
const MAX_EXCERPT = 180_000;

export interface SceneSource {
	/** Every script's text, for callers that search it again (class names, say). */
	scriptText: string;
	chunks: Array<{ url: string; score: number; bytes: number }>;
	/** The scene's code, as excerpts with their sources marked. */
	excerpt: string;
	/** Configuration the code reads, found in the page's HTML. */
	config: string;
}

/** Names three.js and GLSL use everywhere; never a fingerprint of one scene. */
const COMMON = new Set([
	"main", "position", "normal", "color", "uv", "time", "float", "vec2", "vec3", "vec4", "mat3", "mat4", "texture", "sampler2D",
	"modelMatrix", "modelViewMatrix", "projectionMatrix", "viewMatrix", "normalMatrix", "cameraPosition", "isOrthographic",
	"precision", "highp", "mediump", "lowp", "uniform", "varying", "attribute", "return", "gl_FragColor", "gl_Position",
	"diffuse", "emissive", "opacity", "roughness", "metalness", "resolution", "value", "length", "normalize", "smoothstep",
]);

/** Identifiers the scene's authors chose: uniforms, varyings, functions, defines. */
export function shaderNames(frame: Pick<RippedFrame, "programs" | "draws">): string[] {
	const names = new Set<string>();
	for (const program of frame.programs) {
		for (const source of [program.vertex, program.fragment]) {
			for (const m of source.matchAll(/\b(?:uniform|varying|attribute|in|out)\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)) names.add(m[1]!);
			for (const m of source.matchAll(/\b(?:void|float|int|bool|[ibu]?vec[234]|mat[234])\s+(\w+)\s*\(/g)) names.add(m[1]!);
			for (const m of source.matchAll(/#define\s+(\w+)/g)) names.add(m[1]!);
		}
	}
	for (const draw of frame.draws) for (const u of draw.uniforms) names.add(u.name);
	return [...names].filter((n) => n.length >= 4 && !COMMON.has(n) && !/^(gl_|webgl_|_)/.test(n));
}

async function fetchScripts(urls: string[]): Promise<Array<{ url: string; text: string }>> {
	const out: Array<{ url: string; text: string }> = [];
	let total = 0;
	for (const url of urls.slice(0, MAX_SCRIPTS)) {
		if (total >= MAX_TOTAL_BYTES) break;
		const res = await guardedFetch(url, SCRIPT_LIMITS);
		if ("reject" in res) continue;
		total += res.bytes.length;
		out.push({ url, text: new TextDecoder().decode(res.bytes) });
	}
	return out;
}

function windowsAround(text: string, positions: number[], size: number): Array<[number, number]> {
	const spans = positions
		.sort((a, b) => a - b)
		.map((p) => [Math.max(0, p - size), Math.min(text.length, p + size)] as [number, number]);
	const merged: Array<[number, number]> = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
		else merged.push([...span]);
	}
	return merged;
}

/** Everywhere any of `names` occurs in `text`, as whole identifiers. */
function occurrences(text: string, names: string[], limit = 400): number[] {
	const found: number[] = [];
	for (const name of names) {
		const pattern = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");
		for (const m of text.matchAll(pattern)) {
			found.push(m.index!);
			if (found.length >= limit) return found;
		}
	}
	return found;
}

export async function findSceneSource(
	frame: Pick<RippedFrame, "programs" | "draws">,
	scriptUrls: string[],
	inlineScripts: string,
	html: string,
): Promise<SceneSource> {
	const scripts = await fetchScripts(scriptUrls);
	if (inlineScripts) scripts.push({ url: "(inline scripts)", text: inlineScripts });
	const scriptText = scripts.map((s) => s.text).join("\n");
	const names = shaderNames(frame);
	const uniformNames = new Set(frame.draws.flatMap((d) => d.uniforms.map((u) => u.name)));

	// The renderer itself holds nearly every identifier of a compiled program, because the
	// program is mostly its chunks expanded. A scene's own module holds a few of them and the
	// uniforms it sets. So the scripts carrying most of the GLSL names are set aside as the
	// library, unless nothing else carries any — a page that bundles everything into one file.
	const glslNames = names.filter((n) => !uniformNames.has(n));
	const counts = scripts.map((script) => glslNames.filter((n) => script.text.includes(n)).length);
	const libraryFloor = Math.max(8, glslNames.length * 0.6);
	const isLibrary = scripts.map((_, i) => counts[i]! >= libraryFloor);
	const candidates = scripts.filter((_, i) => !isLibrary[i]);
	const pool = candidates.some((c) => names.some((n) => c.text.includes(n))) ? candidates : scripts;

	// Rarity within that pool: a name found in one or two scripts is a fingerprint. Uniform
	// names count double — they are what the scene's code writes, not what a shader declares.
	const presence = new Map<string, number>();
	for (const name of names) presence.set(name, pool.filter((s) => s.text.includes(name)).length);
	const rare = names.filter((n) => {
		const count = presence.get(n) ?? 0;
		return count >= 1 && count <= 2;
	});
	// Where JavaScript sets a uniform — uniforms.x, x: { value }, .x.value — is the scene's own
	// code. A library that merely spells the same name inside a shader string is not, so a
	// name used that way is what the ranking rests on.
	const setsUniform = (text: string, name: string) =>
		new RegExp(`(?:uniforms\\s*\\.\\s*${name}\\b|\\b${name}\\s*:\\s*\\{\\s*value\\b|\\.${name}\\s*\\.\\s*value\\b|\\[["']${name}["']\\])`).test(text);
	// Mentions only break ties: three.js core spells a hundred and forty of a program's names in
	// its shader chunks and sets almost none of its uniforms, where raycast.com's scene module
	// spells half as many and sets twenty.
	const scoreOf = (text: string) =>
		rare.reduce((sum, n) => {
			if (!text.includes(n)) return sum;
			const rarity = 1 / (presence.get(n) ?? 1);
			if (uniformNames.has(n)) return sum + (setsUniform(text, n) ? 3 : 0.2) * rarity;
			return sum + 0.05 * rarity;
		}, 0);
	const scored = pool
		.map((s) => ({ ...s, score: scoreOf(s.text) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	const best = scored[0]?.score ?? 0;
	const chosen = scored.filter((s) => s.score >= best * 0.3).slice(0, 3);

	const parts: string[] = [];
	let budget = MAX_EXCERPT;
	const totalScore = chosen.reduce((sum, c) => sum + c.score, 0) || 1;
	for (const chunk of chosen) {
		if (budget <= 0) break;
		// Shared by score, so a large chunk that scored second cannot starve the one that won.
		const share = Math.max(30_000, Math.floor((MAX_EXCERPT * 0.75 * chunk.score) / totalScore));
		let body: string;
		if (chunk.text.length <= WHOLE_CHUNK_BYTES) {
			body = chunk.text;
		} else {
			const spans = windowsAround(chunk.text, occurrences(chunk.text, rare), WINDOW);
			body = spans.map(([a, b]) => `/* … ${a} … */\n${chunk.text.slice(a, b)}`).join("\n");
		}
		body = body.slice(0, Math.min(budget, share));
		budget -= body.length;
		parts.push(`// ===== ${chunk.url} (${Math.round(chunk.text.length / 1024)} KB, score ${chunk.score.toFixed(1)}) =====\n${body}`);
	}

	// Helpers the scene calls from elsewhere: `(0, x.damp)(…)`, `x.lerp(…)`. Followed once, to the
	// module that defines them, because their exact arithmetic is part of the motion.
	// Ranked by how close each call sits to a uniform being written: the helper that computes a
	// value is next to where the value is set, and a DOM call or a constructor is not a helper.
	const writes: number[] = [];
	const called = new Map<string, number>();
	for (const part of parts) {
		for (const name of uniformNames) {
			for (const m of part.matchAll(new RegExp(`(?:uniforms\\s*\\.\\s*${name}\\b|\\.${name}\\s*\\.\\s*value\\b|\\b${name}\\s*:\\s*\\{\\s*value)`, "g"))) writes.push(m.index!);
		}
		for (const m of part.matchAll(/\b(?:rotation|scale|position|quaternion)\b/g)) writes.push(m.index!);
		for (const m of part.matchAll(/\.\s*([a-z_$][\w$]{3,})\s*\)?\s*\(/g)) {
			const distance = writes.length ? Math.min(...writes.map((w) => Math.abs(w - m.index!))) : 1e9;
			const name = m[1]!;
			called.set(name, Math.min(called.get(name) ?? Number.POSITIVE_INFINITY, distance));
		}
	}
	const STOP = /^(push|forEach|filter|reduce|slice|splice|concat|join|split|replace|includes|indexOf|toFixed|toString|apply|call|bind|then|catch|keys|values|entries|assign|freeze|create|from|isArray|floor|ceil|round|abs|min|max|pow|sqrt|sin|cos|atan2|random|now|log|warn|error|set|get|has|delete|clear|copy|clone|add|sub|multiply|multiplyScalar|normalize|length|dispose|render|update|setSize|createElement|jsx|jsxs|default|use[A-Z]\w*|forwardRef|getElementById|querySelector|querySelectorAll|addEventListener|removeEventListener|appendChild|removeChild|remove|contains|requestAnimationFrame|cancelAnimationFrame|setTimeout|clearTimeout|setInterval|clearInterval|onChange|getContext|toArray|fromArray|sort|resolve|reject|emit|on|off|subscribe|dispatch)$/;
	const helpers: string[] = [];
	const definitionOf = (text: string, name: string): number => {
		const direct = new RegExp(`(?:function\\s+${name}\\s*\\(|["']${name}["']\\s*,\\s*\\(\\)\\s*=>|\\b${name}\\s*:\\s*(?:function\\b|\\()|\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:function|\\())`).exec(text);
		if (direct) return direct.index;
		// Bundlers export through an alias — { damp: z } or ["damp", () => z] — so one more
		// hop finds the function the alias names.
		const alias = new RegExp(`(?:\\b${name}\\s*:\\s*|["']${name}["']\\s*,\\s*(?:\\(\\)\\s*=>\\s*)?(?:0\\s*,\\s*)?)([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)?)\\b`).exec(text);
		if (!alias) return -1;
		const target = alias[1]!.split(".").pop()!;
		const aliased = new RegExp(`function\\s+${target.replace(/\$/g, "\\$")}\\s*\\(|\\b(?:const|let|var)\\s+${target.replace(/\$/g, "\\$")}\\s*=\\s*(?:function|\\()`).exec(text);
		return aliased ? aliased.index : -1;
	};
	const ranked = [...called].filter(([n]) => !STOP.test(n)).sort((a, b) => a[1] - b[1]).map(([n]) => n);
	for (const name of ranked.slice(0, 40)) {
		if (budget <= 0) break;
		for (const script of scripts) {
			if (chosen.some((c) => c.url === script.url)) continue;
			const at = definitionOf(script.text, name);
			if (at < 0) continue;
			const snippet = script.text.slice(Math.max(0, at - 200), at + 2_000).slice(0, budget);
			budget -= snippet.length;
			helpers.push(`// ----- ${name}, defined in ${script.url} -----\n${snippet}`);
			break;
		}
	}
	if (helpers.length) parts.push(`// ===== helpers the scene calls =====\n${helpers.join("\n")}`);

	// Configuration: the property names the code reads, where the page's HTML spells them as keys.
	const readNames = new Set<string>();
	for (const part of parts.slice(0, chosen.length)) for (const m of part.matchAll(/\.([a-z][A-Za-z0-9]{4,})\b/g)) readNames.add(m[1]!);
	let config = "";
	let bestHits = 0;
	const keyPattern = (name: string) => new RegExp(`\\\\?"${name}\\\\?"\\s*:`, "g");
	for (const [label, source] of [["html", html], ["inline scripts", inlineScripts]] as const) {
		// A key spelled all over the payload (children, className) says nothing about where the
		// scene's configuration is; one spelled once or twice does. Weighted accordingly.
		const rarity = new Map<string, number>();
		for (const name of readNames) {
			const count = (source.match(keyPattern(name)) ?? []).length;
			if (count > 0 && count <= 3) rarity.set(name, 1 / count);
		}
		for (const name of rarity.keys()) {
			const m = new RegExp(keyPattern(name).source).exec(source);
			if (!m) continue;
			const window = source.slice(Math.max(0, m.index - 1_500), m.index + 2_500);
			let hits = 0;
			for (const [other, w] of rarity) if (new RegExp(keyPattern(other).source).test(window)) hits += w;
			if (hits > bestHits) {
				bestHits = hits;
				config = `// from the page's ${label}: keys the scene's code reads\n${window}`;
			}
		}
	}

	return {
		scriptText,
		chunks: chosen.map((c) => ({ url: c.url, score: c.score, bytes: c.text.length })),
		excerpt: parts.join("\n\n"),
		config: bestHits >= 3 ? config : "",
	};
}
