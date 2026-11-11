/**
* dsh-d2-diagrams — Host half.
*
* Serves two endpoints on the deployment's webServer behind the connection
* trust fence (the same guard every shipped route uses):
*
*   GET  /d2/render  — health/capability probe: whether a `d2` executable
*                      resolves on this host.
*   POST /d2/render  — body `{ source: string, dark?: boolean }`, compiles the
*                      D2 source with the local `d2` CLI and answers
*                      `{ ok: true, svg }` or `{ ok: false, error }`.
*
* The browser half lives in lib/client.js; the two share only this route
* path and payload shape.
* @module
*/

import { spawn } from "node:child_process";

/** Browser route shared with the client half. */
const RENDER_PATH = "/d2/render";

/** Render requests carry one D2 document; anything larger is hostile. */
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
/** A rendered SVG is a few hundred KB at most; cap to stay sane. */
const MAX_SVG_BYTES = 16 * 1024 * 1024;
/** Stderr carries one compile error line; cap it likewise. */
const MAX_STDERR_BYTES = 64 * 1024;

/** Service keys this plugin needs from the composition. */
export const inject = ["webServer", "connection", "subprocess", "tools"];

/**
* Normalize patch config; every field is optional.
* @param input - raw row config from the bundle patch.
* @returns resolved render configuration.
*/
function resolveConfig(input) {
	const cfg = typeof input === "object" && input !== null ? input : {};
	const text = (value, fallback) => typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
	const int = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
	const layout = text(cfg.layout, "elk");
	return {
		command: text(cfg.command, "d2"),
		layout: ["dagre", "elk", "tala"].includes(layout) ? layout : "elk",
		timeoutMs: int(cfg.timeoutMs, 20000, 1000, 120000),
		maxSourceBytes: int(cfg.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 1024, 8 * 1024 * 1024),
		lightTheme: int(cfg.lightTheme, 0, 0, 400),
		darkTheme: int(cfg.darkTheme, 200, 0, 400),
		pad: int(cfg.pad, 32, 0, 400)
	};
}

/** JSON response (no-store: render outcomes follow the source). */
function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

/** 405 with the route's supported methods. */
function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader("allow", allow);
	res.end();
}

/**
* Collect a bounded request body as UTF-8 text; null past the ceiling
* (the stream is drained so the connection can settle).
*/
async function readBoundedBody(req, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		size += buffer.byteLength;
		if (size > maxBytes) {
			req.resume();
			return null;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, size).toString("utf8");
}

/** Validate one render body at the wire. */
function parseRenderBody(text) {
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof body !== "object" || body === null) return null;
	const { source, dark } = body;
	if (typeof source !== "string" || source.length === 0) return null;
	return { source, dark: dark === true };
}

/**
* Present a d2 compile failure as one readable line: strip the CLI's own
* prefix and the `-` stdin name, keeping the `line:col` position.
*/
function presentCompileError(stderr) {
	const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
	return first
		.replace(/^err:\s*/u, "")
		.replace(/^failed to (?:compile|parse)[^:]*:\s*/u, "")
		.replace(/^-:/u, "")
		.trim();
}

/**
* Run `d2 --layout <layout> --theme <theme> --pad <pad> - -`: source on stdin,
* SVG on stdout, with a hard deadline and bounded output.
* @param executable - resolved d2 path.
* @param config - resolved render configuration.
* @param source - D2 document text.
* @param dark - render with the dark theme id when true.
* @param signal - optional cancellation; aborting kills the child process.
* @returns `{ ok: true, svg }` or `{ ok: false, error: { code, message } }`.
*/
function renderWithD2(executable, config, source, dark, signal) {
	return new Promise((resolvePromise) => {
		const args = [
			"--layout", config.layout,
			"--theme", String(dark ? config.darkTheme : config.lightTheme),
			"--pad", String(config.pad),
			"-", "-"
		];
		let child;
		try {
			child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			resolvePromise({ ok: false, error: { code: "spawn-failed", message: String(error) } });
			return;
		}
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};
		const kill = () => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		};
		const timer = setTimeout(() => {
			kill();
			finish({ ok: false, error: { code: "timeout", message: `d2 did not finish within ${config.timeoutMs} ms` } });
		}, config.timeoutMs);
		if (signal !== void 0) {
			if (signal.aborted === true) {
				kill();
				finish({ ok: false, error: { code: "aborted", message: "render cancelled" } });
				return;
			}
			signal.addEventListener("abort", () => {
				kill();
				finish({ ok: false, error: { code: "aborted", message: "render cancelled" } });
			}, { once: true });
		}
		child.stdout.on("data", (chunk) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > MAX_SVG_BYTES) {
				kill();
				finish({ ok: false, error: { code: "too-large", message: "rendered SVG exceeds the 16 MiB cap" } });
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
		});
		child.on("error", (error) => {
			finish({ ok: false, error: { code: "spawn-failed", message: String(error) } });
		});
		child.on("close", (code) => {
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				const svg = Buffer.concat(stdout).toString("utf8");
				if (!svg.includes("<svg")) {
					finish({ ok: false, error: { code: "empty", message: "d2 produced no SVG output" } });
					return;
				}
				finish({ ok: true, svg });
				return;
			}
			finish({
				ok: false,
				error: {
					code: "compile",
					message: presentCompileError(stderrText) || `d2 exited with code ${String(code)}`
				}
			});
		});
		child.stdin.on("error", () => {
			/* the child went away mid-write; close/error reports the outcome */
		});
		child.stdin.end(source, "utf8");
	});
}

/** Model-facing description of the d2_render tool. */
const TOOL_DESCRIPTION = `Render a D2 (d2lang) diagram and display it inline in the conversation as an interactive block with switchable chart / code / split views and live re-rendering.

Use this tool whenever you draw a diagram with D2 instead of (or after) writing .d2 files, so the user sees the rendered chart directly in the chat. The source must be a complete, self-contained D2 document.

On invalid source the result carries the compiler error with its line:column position; fix the source and call again.`;

/** Canonical d2_render output: compact — the chat card re-renders from the call arguments. */
const TOOL_OUTPUT = {
	schema: {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			svgBytes: { type: "integer" },
			error: {
				type: "object",
				properties: {
					code: { type: "string" },
					message: { type: "string" }
				}
			}
		},
		required: ["ok"]
	},
	render: (_args, value) => [{
		type: "text",
		text: value.ok === true
			? `D2 diagram rendered (${String(value.svgBytes)} bytes of SVG); it is displayed inline in the conversation.`
			: `D2 render failed: ${value.error?.message ?? "unknown error"}`
	}]
};

/**
* Host plugin body: resolve the d2 executable lazily, register the render
* route behind the deployment's connection trust fence, and register the
* model-facing d2_render tool whose chat card the browser half renders.
* @param ctx - plugin context carrying webServer, connection, subprocess, tools.
* @param input - optional row config (see cordis.patch.yml).
*/
export function apply(ctx, input) {
	const config = resolveConfig(input);
	/** Lazily resolved once per plugin life; `null` marks a known-missing CLI. */
	let executable;
	const resolveD2 = async () => {
		if (executable === void 0) {
			try {
				executable = await ctx.subprocess.resolveExecutable(config.command);
			} catch {
				executable = null;
			}
		}
		return executable;
	};
	ctx.effect(() => ctx.tools.register({
		name: "d2_render",
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				source: {
					type: "string",
					description: "Complete, self-contained D2 diagram source code."
				}
			},
			required: ["source"],
			additionalProperties: false
		},
		output: TOOL_OUTPUT,
		timeoutMs: config.timeoutMs + 5000,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const source = typeof args === "object" && args !== null ? args.source : void 0;
			if (typeof source !== "string" || source.trim() === "") {
				return { ok: false, error: { code: "invalid-arguments", message: "a non-empty string 'source' is required" } };
			}
			if (Buffer.byteLength(source, "utf8") > config.maxSourceBytes) {
				return { ok: false, error: { code: "too-large", message: `source exceeds the ${String(config.maxSourceBytes)} byte cap` } };
			}
			const exe = await resolveD2();
			if (exe === null) {
				return { ok: false, error: { code: "d2-missing", message: `no '${config.command}' executable on this host's PATH; install d2 from https://d2lang.com` } };
			}
			const result = await renderWithD2(exe, config, source, false, exec.signal);
			if (!result.ok) return { ok: false, error: result.error };
			return { ok: true, svgBytes: Buffer.byteLength(result.svg, "utf8") };
		},
		presentCall: () => ({ card: "generic", title: "Render D2 diagram", kind: "other" })
	}), "d2-diagrams: d2_render tool");
	/** Answer an untrusted/unauthenticated request; true when it was rejected. */
	const rejected = (req, res) => {
		const rejection = ctx.connection.requestRejection(req);
		if (rejection === void 0) return false;
		res.statusCode = rejection;
		res.end();
		return true;
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: RENDER_PATH,
		handler: async (req, res) => {
			if (rejected(req, res)) return;
			if (req.method === "GET") {
				const exe = await resolveD2();
				if (exe === null) {
					sendJson(res, 200, { ok: false, error: { code: "d2-missing", message: `no '${config.command}' executable on this host's PATH` } });
					return;
				}
				sendJson(res, 200, { ok: true, executable: exe, layout: config.layout });
				return;
			}
			if (req.method !== "POST") {
				sendMethodNotAllowed(res, "GET, POST");
				return;
			}
			const text = await readBoundedBody(req, config.maxSourceBytes + 4096);
			const body = text === null ? null : parseRenderBody(text);
			if (body === null) {
				sendJson(res, 400, { ok: false, error: { code: "invalid-request", message: "expected a JSON body with a non-empty string 'source'" } });
				return;
			}
			if (Buffer.byteLength(body.source, "utf8") > config.maxSourceBytes) {
				sendJson(res, 413, { ok: false, error: { code: "too-large", message: `source exceeds the ${String(config.maxSourceBytes)} byte cap` } });
				return;
			}
			const exe = await resolveD2();
			if (exe === null) {
				sendJson(res, 503, { ok: false, error: { code: "d2-missing", message: `no '${config.command}' executable on this host's PATH; install d2 from https://d2lang.com` } });
				return;
			}
			const result = await renderWithD2(exe, config, body.source, body.dark);
			sendJson(res, 200, result);
		}
	}), `d2-diagrams: ${RENDER_PATH}`);
}
