/**
* Build the browser bundle: esbuild bundles src/client.jsx (JSX, DOMPurify,
* and every non-baseline dependency) into one CJS body, wrapped in the
* ModuleLoader factory the dsh web client expects. Baseline modules the web
* shell seeds (React, Cordis, the static UI libraries) stay external and
* resolve against the shared instances at runtime.
*/
import { build } from "esbuild";

const PACKAGE_ID = "dsh-d2-diagrams";

/** Modules the shell's static table already owns; never bundle these. */
const EXTERNALS = [
	"react",
	"react-dom",
	"react/jsx-runtime",
	"@deepseek-ai/cordis",
	"@deepseek-ai/dsh-client-store",
	"@deepseek-ai/dsh-client-ui-dockkit",
	"@deepseek-ai/dsh-client-ui-primitives",
	"@deepseek-ai/dsh-client-ui-slots"
];

await build({
	entryPoints: ["src/client.jsx"],
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: ["chrome120"],
	jsx: "automatic",
	external: EXTERNALS,
	outfile: "lib/client.js",
	banner: {
		js: `window.__ModuleLoader__.load({
	id: ${JSON.stringify(PACKAGE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`
	},
	footer: {
		js: `		return module.exports;
	}
});`
	}
});

console.log("built lib/client.js");
