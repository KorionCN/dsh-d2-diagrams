/**
* dsh-d2-diagrams — browser half.
*
* Two surfaces share one interactive D2 block (chart / code / split views
* with live re-rendering and light-dark theme tracking):
*
*   1. A `.d2` document renderer for the right Sidebar preview.
*   2. A `d2_render` Tool call view, so a diagram the agent draws appears
*      inline in the conversation as an interactive card.
*
* Rendering runs on the Host through the authenticated `/d2/render` route
* (lib/index.js), which compiles the source with the local `d2` CLI.
* @module
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegmentedControl, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import DOMPurify from "dompurify";

/** Document body id shared by the metadata registration and the slot entry. */
const BODY_ID = "dsh-d2-diagrams/d2";
/** Wire name of the Host-registered Tool this plugin renders a card for. */
const TOOL_NAME = "d2_render";
/** Locale namespace this plugin registers. */
const NS = "d2Diagrams";
/** Host render route (see lib/index.js). */
const RENDER_ROUTE = "/d2/render";
/** Debounce between the last edit and a render request. */
const RENDER_DEBOUNCE_MS = 450;

/** Chinese labels. */
const zh = {
	"viewer.title": "D2",
	"view.label": "展示内容",
	"view.chart": "仅展示图表",
	"view.code": "仅展示代码",
	"view.split": "代码和图表",
	"status.rendering": "渲染中…",
	"status.failed": "渲染失败",
	"action.copy": "复制代码",
	"action.copied": "已复制",
	"action.download": "下载 SVG",
	"error.title": "D2 渲染失败",
	"error.missing": "未找到 d2 命令，请在主机上安装 d2（https://d2lang.com）后重试",
	"error.args": "无法读取这次调用的 D2 源码",
	"empty.chart": "输入 D2 代码后此处将实时渲染图表",
	"editor.aria": "D2 源代码编辑器",
	"hint.unsaved": "编辑仅用于实时预览，不会写入文件",
	"tool.title": "D2 图表",
	"zoom.in": "放大",
	"zoom.out": "缩小",
	"zoom.fit": "适应宽度",
	"zoom.fitShort": "适应"
};

/** English labels, paired with the Chinese key set. */
const en = {
	"viewer.title": "D2",
	"view.label": "Block content",
	"view.chart": "Diagram only",
	"view.code": "Code only",
	"view.split": "Code and diagram",
	"status.rendering": "Rendering…",
	"status.failed": "Render failed",
	"action.copy": "Copy code",
	"action.copied": "Copied",
	"action.download": "Download SVG",
	"error.title": "D2 render failed",
	"error.missing": "The d2 executable was not found on this host; install d2 from https://d2lang.com and retry",
	"error.args": "The D2 source of this call could not be read",
	"empty.chart": "Type D2 code and the diagram renders here live",
	"editor.aria": "D2 source editor",
	"hint.unsaved": "Edits preview live and are not written back to the file",
	"tool.title": "D2 diagram",
	"zoom.in": "Zoom in",
	"zoom.out": "Zoom out",
	"zoom.fit": "Fit to width",
	"zoom.fitShort": "Fit"
};

/** Stylesheet text, injected once per plugin materialization. */
const CSS = `
.d2d-root{display:flex;flex-direction:column;height:100%;min-height:0;font-family:var(--dsw-font,inherit);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.d2d-root[data-surface="card"]{height:auto;max-height:560px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.d2d-toolbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.d2d-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);flex:none}
.d2d-spacer{flex:1 1 auto}
.d2d-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.d2d-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.d2d-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:12px;line-height:22px;padding:0 10px;cursor:pointer;white-space:nowrap;font-family:inherit}
.d2d-button:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.d2d-button:disabled{opacity:.5;cursor:default}
.d2d-body{flex:1 1 auto;display:flex;min-height:0}
.d2d-root[data-surface="card"] .d2d-body{min-height:180px}
.d2d-code{flex:1 1 0;min-width:0;display:flex;border-right:1px solid var(--dsw-alias-border-l1)}
.d2d-body[data-view="code"] .d2d-code{border-right:none}
.d2d-editor{flex:1 1 auto;min-width:0;resize:none;border:none;outline:none;padding:10px 12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace);font-size:12.5px;line-height:20px;tab-size:2;white-space:pre-wrap;overflow-wrap:anywhere}
.d2d-root[data-surface="card"] .d2d-editor{max-height:420px}
.d2d-chart{flex:1 1 auto;min-width:0;overflow:auto;padding:12px;position:relative}
.d2d-root[data-surface="card"] .d2d-chart{max-height:420px}
.d2d-chart-wrap{flex:1 1 0;min-width:0;position:relative;display:flex;min-height:0}
.d2d-chart-inner{display:flex;justify-content:center;min-width:min-content}
.d2d-chart-inner svg{max-width:100%;height:auto;display:block}
.d2d-chart-inner[data-zoomed="true"]{display:block;min-width:0}
.d2d-chart-inner[data-zoomed="true"] svg{width:100%;max-width:none;height:auto}
.d2d-zoom{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:2px;padding:2px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-shadow:0 2px 8px #0000001f;z-index:2}
.d2d-zoom-button,.d2d-zoom-level{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:13px;line-height:22px;min-width:28px;padding:0 6px;cursor:pointer;font-family:inherit;text-align:center}
.d2d-zoom-level{font-size:11.5px;min-width:44px}
.d2d-zoom-button:hover,.d2d-zoom-level:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.d2d-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.d2d-error{margin:8px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.d2d-error-title{font-weight:600;margin-bottom:4px}
.d2d-hint{flex:none;padding:4px 10px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.d2d-running{display:inline-flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
`;

/** Track the application dark mode (`body[data-ds-dark-theme]`). */
function useDarkMode() {
	const read = () => typeof document !== "undefined" && document.body !== null && document.body.hasAttribute("data-ds-dark-theme");
	const [dark, setDark] = useState(read);
	useEffect(() => {
		const observer = new MutationObserver(() => setDark(read()));
		observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
		return () => observer.disconnect();
	}, []);
	return dark;
}

/** Post one render request; returns `{ ok, svg?, error? }`. */
async function requestRender(source, dark, signal) {
	const response = await fetch(RENDER_ROUTE, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, dark }),
		signal
	});
	try {
		return await response.json();
	} catch {
		return { ok: false, error: { code: "bad-response", message: `render route answered HTTP ${String(response.status)}` } };
	}
}

/** File basename from a `dsh-resource://file/...` address, for downloads. */
function baseNameOf(resourceAddress) {
	try {
		const path = decodeURIComponent(resourceAddress.split("/").pop() ?? "");
		return path.replace(/\.d2$/u, "") || "diagram";
	} catch {
		return "diagram";
	}
}

/** Last-resort label resolver when no locale binding arrives. */
const tFallback = (key) => key;

/**
* Render-error boundary: a thrown card must explain itself inline instead
* of disappearing behind the slot renderer's supervision channel.
*/
class D2ErrorBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	render() {
		if (this.state.error !== null) {
			return (
				<div className="d2d-error" role="alert">
					<div className="d2d-error-title">d2-diagrams card error</div>
					{String(this.state.error?.stack ?? this.state.error)}
				</div>
			);
		}
		return this.props.children;
	}
}

/**
* The shared interactive D2 block: header switcher, source editor, live
* chart. Controlled — the owner supplies `value`/`onChange`; `dirty`
* controls the preview-only hint line.
*/
function D2Block({ value, onChange, t, surface, downloadName }) {
	const [view, setView] = useState("split");
	const dark = useDarkMode();
	/** Render pipeline state: last good SVG plus the latest request outcome. */
	const [render, setRender] = useState({ status: "idle", message: "" });
	const [lastSvg, setLastSvg] = useState("");
	const [copied, setCopied] = useState(false);
	const [dirty, setDirty] = useState(false);
	const requestSeq = useRef(0);
	const copyTimer = useRef(null);
	const [debouncedSource, setDebouncedSource] = useState(value);

	useEffect(() => {
		if (debouncedSource === value) return;
		const handle = setTimeout(() => setDebouncedSource(value), RENDER_DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [value, debouncedSource]);

	useEffect(() => {
		const trimmed = debouncedSource.trim();
		if (trimmed === "") {
			requestSeq.current += 1;
			setRender({ status: "idle", message: "" });
			setLastSvg("");
			return;
		}
		const seq = ++requestSeq.current;
		const controller = new AbortController();
		setRender((previous) => ({ status: "loading", message: previous.message }));
		requestRender(debouncedSource, dark, controller.signal)
			.then((result) => {
				if (requestSeq.current !== seq) return;
				if (result.ok === true && typeof result.svg === "string") {
					setLastSvg(result.svg);
					setRender({ status: "ok", message: "" });
				} else {
					const code = result.error?.code;
					setRender({ status: "error", message: code === "d2-missing" ? t("error.missing") : result.error?.message ?? t("status.failed") });
				}
			})
			.catch((error) => {
				if (requestSeq.current !== seq || error?.name === "AbortError") return;
				setRender({ status: "error", message: String(error) });
			});
		return () => controller.abort();
	}, [debouncedSource, dark, t]);

	const sanitized = useMemo(
		() => lastSvg === "" ? "" : DOMPurify.sanitize(lastSvg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"] }),
		[lastSvg]
	);

	const edit = useCallback((next) => {
		setDirty(true);
		onChange(next);
	}, [onChange]);

	const onEditorKeyDown = useCallback((event) => {
		if (event.key !== "Tab") return;
		event.preventDefault();
		const element = event.currentTarget;
		const { selectionStart, selectionEnd, value: current } = element;
		const next = `${current.slice(0, selectionStart)}  ${current.slice(selectionEnd)}`;
		edit(next);
		requestAnimationFrame(() => {
			element.selectionStart = selectionStart + 2;
			element.selectionEnd = selectionStart + 2;
		});
	}, [edit]);

	const copyCode = useCallback(() => {
		navigator.clipboard?.writeText(value).then(() => {
			setCopied(true);
			clearTimeout(copyTimer.current);
			copyTimer.current = setTimeout(() => setCopied(false), 1500);
		}).catch(() => {});
	}, [value]);

	const downloadSvg = useCallback(() => {
		if (lastSvg === "") return;
		const blob = new Blob([lastSvg], { type: "image/svg+xml" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${downloadName}.svg`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	}, [lastSvg, downloadName]);

	useEffect(() => () => clearTimeout(copyTimer.current), []);

	const viewOptions = useMemo(() => [
		{ value: "split", label: t("view.split") },
		{ value: "code", label: t("view.code") },
		{ value: "chart", label: t("view.chart") }
	], [t]);

	const empty = value.trim() === "";
	const showCode = view !== "chart";
	const showChart = view !== "code";

	/** Chart zoom: "fit" follows the pane width; a number is an explicit ratio of it. */
	const [zoom, setZoom] = useState("fit");
	const chartRef = useRef(null);
	const zoomBy = useCallback((factor) => {
		setZoom((current) => {
			const base = current === "fit" ? 1 : current;
			return Math.min(5, Math.max(0.2, base * factor));
		});
	}, []);
	useEffect(() => {
		const element = chartRef.current;
		if (element === null) return;
		const onWheel = (event) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			zoomBy(Math.exp(-event.deltaY * 0.0018));
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [zoomBy, showChart]);

	return (
		<div className="d2d-root" data-surface={surface}>
			<div className="d2d-toolbar">
				{surface === "card" && <span className="d2d-title">{t("tool.title")}</span>}
				<SegmentedControl id={`d2d-view-${surface}`} value={view} options={viewOptions} onChange={setView} label={t("view.label")} />
				<span className="d2d-spacer" />
				{render.status === "loading" && (
					<span className="d2d-status"><StateDot state="ongoing" size={12} />{t("status.rendering")}</span>
				)}
				{render.status === "error" && (
					<span className="d2d-status" data-tone="error"><StateDot state="error" size={10} />{t("status.failed")}</span>
				)}
				<button type="button" className="d2d-button" onClick={copyCode} disabled={empty}>{copied ? t("action.copied") : t("action.copy")}</button>
				<button type="button" className="d2d-button" onClick={downloadSvg} disabled={sanitized === ""}>{t("action.download")}</button>
			</div>
			<div className="d2d-body" data-view={view}>
				{showCode && (
					<div className="d2d-code">
						<textarea
							className="d2d-editor"
							aria-label={t("editor.aria")}
							value={value}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							onChange={(event) => edit(event.target.value)}
							onKeyDown={onEditorKeyDown}
						/>
					</div>
				)}
				{showChart && (
					<div className="d2d-chart-wrap">
						<div className="d2d-chart" ref={chartRef}>
							{sanitized !== "" && (
								<div
									className="d2d-chart-inner"
									data-zoomed={zoom === "fit" ? "false" : "true"}
									style={zoom === "fit" ? void 0 : { width: `${zoom * 100}%` }}
									dangerouslySetInnerHTML={{ __html: sanitized }}
								/>
							)}
							{render.status === "error" && (
								<div className="d2d-error" role="alert">
									<div className="d2d-error-title">{t("error.title")}</div>
									{render.message}
								</div>
							)}
							{empty && render.status !== "error" && (
								<div className="d2d-placeholder">{t("empty.chart")}</div>
							)}
						</div>
						{sanitized !== "" && (
							<div className="d2d-zoom">
								<button type="button" className="d2d-zoom-button" onClick={() => zoomBy(1 / 1.25)} title={t("zoom.out")} aria-label={t("zoom.out")}>−</button>
								<button type="button" className="d2d-zoom-level" onClick={() => setZoom("fit")} title={t("zoom.fit")}>
									{zoom === "fit" ? t("zoom.fitShort") : `${Math.round(zoom * 100)}%`}
								</button>
								<button type="button" className="d2d-zoom-button" onClick={() => zoomBy(1.25)} title={t("zoom.in")} aria-label={t("zoom.in")}>+</button>
							</div>
						)}
					</div>
				)}
			</div>
			{dirty && <div className="d2d-hint">{t("hint.unsaved")}</div>}
		</div>
	);
}

/**
* The `.d2` document body: the shared block over the preview's accumulated
* file text; edits stay local until the file itself changes.
*/
function D2Body({ content, resourceAddress, t }) {
	const fileText = content.kind === "text" ? content.text : "";
	/** Local draft; null while the user has not diverged from the file. */
	const [draft, setDraft] = useState(null);
	return (
		<D2Block
			value={draft ?? fileText}
			onChange={setDraft}
			t={t}
			surface="document"
			downloadName={baseNameOf(resourceAddress)}
		/>
	);
}

/** Parse the frozen call head of a d2_render Tool block into its source. */
function toolSourceOf(block) {
	const settled = "kind" in block;
	const argsRaw = settled ? block.call?.argsRaw : block.argsRaw;
	if (typeof argsRaw !== "string" || argsRaw === "") return null;
	try {
		const args = JSON.parse(argsRaw);
		return typeof args === "object" && args !== null && typeof args.source === "string" ? args.source : null;
	} catch {
		return null;
	}
}

/** Concatenated text content of a settled Tool result. */
function toolResultText(block) {
	if (!("kind" in block) || !Array.isArray(block.content)) return "";
	return block.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

/**
* The conversation card for one d2_render call: a running row while the
* Host compiles, then the interactive block seeded with the call's frozen
* source. A compile failure reported by the Tool surfaces as an error row;
* the user can still edit the source in the card to iterate live.
*/
function D2ToolCard({ block, t = tFallback }) {
	const settled = "kind" in block;
	const source = useMemo(() => toolSourceOf(block), [block]);
	const [draft, setDraft] = useState(null);
	if (!settled) {
		return (
			<span className="d2d-running"><StateDot state="ongoing" size={14} />{t("status.rendering")}</span>
		);
	}
	if (source === null) {
		return (
			<div className="d2d-error" role="alert">
				<div className="d2d-error-title">{t("error.title")}</div>
				{t("error.args")}
			</div>
		);
	}
	const failed = block.isError === true || toolResultText(block).startsWith("D2 render failed:");
	return (
		<D2ErrorBoundary>
			{failed === true && draft === null && (
				<div className="d2d-error" role="alert">
					<div className="d2d-error-title">{t("error.title")}</div>
					{toolResultText(block).replace(/^D2 render failed:\s*/u, "")}
				</div>
			)}
			<D2Block
				value={draft ?? source}
				onChange={setDraft}
				t={t}
				surface="card"
				downloadName="diagram"
			/>
		</D2ErrorBoundary>
	);
}

/**
* Client plugin body: register dictionaries, the `.d2` renderer metadata,
* the document body, and the d2_render Tool call view.
* @param ctx - client root context carrying locale, documentPreviews, slots.
*/
export function apply(ctx) {
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "d2-diagrams: dictionaries");
	ctx.effect(() => ctx.documentPreviews.register({
		id: BODY_ID,
		extensions: ["d2"],
		title: () => t("viewer.title"),
		loading: "text-pages",
		wrap: false
	}), "d2-diagrams: metadata");
	ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
		name: "sidebar.right.tab.document",
		key: BODY_ID,
		locale: NS
	}, D2Body)), "d2-diagrams: body");
	ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: TOOL_NAME,
		locale: NS
	}, D2ToolCard)), "d2-diagrams: tool card");
	ctx.effect(() => {
		if (typeof document === "undefined") return () => {};
		if (document.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return () => {};
		const tag = document.createElement("style");
		tag.dataset.plugin = "dsh-d2-diagrams";
		tag.dataset.pluginCss = NS;
		tag.textContent = CSS;
		document.head.appendChild(tag);
		return () => tag.remove();
	}, "d2-diagrams: stylesheet");
}

/** Required client services: locale, the document renderer registry, slots. */
export const inject = ["locale", "documentPreviews", "slots"];
