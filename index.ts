/**
 * pi-mermaid — render ```mermaid fences as Unicode box-drawing diagrams.
 *
 * The layout/drawing engine is xai-org/grok-build's terminal Mermaid renderer
 * (crates/codegen/xai-grok-markdown/src/mermaid.rs, Apache-2.0), vendored
 * unmodified in ./rust and compiled to WebAssembly (./pi-mermaid.wasm) so no
 * native toolchain, Node canvas, or browser is needed at runtime. It supports
 * graph/flowchart, sequenceDiagram, stateDiagram, classDiagram, and erDiagram;
 * other diagram types fall back to the source in a framed box.
 *
 * Behavior:
 *  - Every completed Mermaid code block remains visible as source and gets a
 *    width-aware `◇ rendered` preview immediately below it, in source order.
 *    This is a display-only Markdown renderer patch: session/model context is
 *    unchanged. Incomplete streaming fences remain ordinary code until closed.
 *  - If pi's internal Markdown token hook is unavailable, automatic rendering
 *    falls back to display-only transcript entries after the assistant message.
 *  - `/mermaid` re-renders fences from the latest assistant message, or takes
 *    inline source / a file path (.mmd or markdown with fences) as argument.
 *
 * Art uses only bold/dim/italic SGR attributes, so it respects any terminal
 * theme.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// WASM engine
// ---------------------------------------------------------------------------

interface WasmExports {
	memory: WebAssembly.Memory;
	wasm_alloc(len: number): number;
	wasm_free(ptr: number, len: number): void;
	/** Packed (ptr << 32) | len as u64; 0n means "nothing rendered". */
	render_mermaid(srcPtr: number, srcLen: number, maxWidth: number, ansi: number): bigint;
}

/**
 * Synchronous wrapper around pi-mermaid.wasm with trap recovery: the Rust
 * side builds with panic=abort, so a panic surfaces as a RuntimeError trap
 * that may leave allocator state corrupted — after any throw we drop the
 * instance and re-instantiate from the compiled module (cheap).
 */
export class MermaidEngine {
	private module: WebAssembly.Module;
	private exports: WasmExports;

	constructor(wasmPath: string) {
		let bytes: Buffer = fs.readFileSync(wasmPath);
		// The shipped module is brotli-compressed (~60 KB vs ~190 KB raw); accept
		// either form by sniffing the `\0asm` magic.
		if (!(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
			bytes = zlib.brotliDecompressSync(bytes);
		}
		// Copy into a plain Uint8Array<ArrayBuffer> (Buffer may be SharedArrayBuffer-backed per @types/node).
		this.module = new WebAssembly.Module(Uint8Array.from(bytes));
		this.exports = this.instantiate();
	}

	private instantiate(): WasmExports {
		return new WebAssembly.Instance(this.module, {}).exports as unknown as WasmExports;
	}

	/**
	 * Render mermaid source to diagram art, or null when the input is blank/
	 * oversized or the engine trapped. `maxWidth <= 0` means unlimited width.
	 */
	render(source: string, maxWidth: number, ansi: boolean): string | null {
		const ex = this.exports;
		const bytes = Buffer.from(source, "utf8");
		let inPtr = 0;
		try {
			inPtr = ex.wasm_alloc(bytes.length);
			if (bytes.length > 0 && inPtr === 0) return null;
			new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
			const packed = ex.render_mermaid(
				inPtr,
				bytes.length,
				maxWidth > 0 ? maxWidth : 0,
				ansi ? 1 : 0,
			);
			ex.wasm_free(inPtr, bytes.length);
			inPtr = 0;
			if (packed === 0n) return null;
			const outPtr = Number(packed >> 32n);
			const outLen = Number(packed & 0xffffffffn);
			const out = Buffer.from(ex.memory.buffer, outPtr, outLen).toString("utf8");
			ex.wasm_free(outPtr, outLen);
			return out;
		} catch {
			// Trap: allocator state is suspect; start over with a fresh instance.
			this.exports = this.instantiate();
			return null;
		}
	}
}

// ---------------------------------------------------------------------------
// Inline Markdown source + preview patch
// ---------------------------------------------------------------------------

export interface MermaidRenderer {
	render(source: string, maxWidth: number, ansi: boolean): string | null;
}

interface MarkdownCodeToken {
	type?: unknown;
	lang?: unknown;
	text?: unknown;
	raw?: unknown;
}

type RenderToken = (
	this: unknown,
	token: MarkdownCodeToken,
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

interface PatchableMarkdownPrototype {
	renderToken?: RenderToken;
	[key: symbol]: unknown;
}

interface InlinePatchRecord {
	original: RenderToken;
	wrapper: RenderToken;
	engine: MermaidRenderer;
	owners: number;
}

export interface InlinePatchHandle {
	installed: boolean;
	reason?: string;
	dispose(): void;
}

/** Shared across jiti reloads/module instances so the prototype is never wrapped twice. */
const INLINE_PATCH_KEY = Symbol.for("pi-mermaid.inline-source-preview.v1");

function mermaidLanguage(lang: unknown): boolean {
	if (typeof lang !== "string") return false;
	return lang.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

/** True only once a backtick/tilde fenced token contains its closing fence. */
export function hasClosingFence(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	const lines = raw.split("\n");
	const marker = /^\s*(`{3,}|~{3,})/.exec(lines[0])?.[1];
	if (!marker) return false;
	const markerChar = marker[0];
	for (let i = 1; i < lines.length; i++) {
		const candidate = lines[i].trim();
		if (candidate.length >= marker.length && [...candidate].every((char) => char === markerChar)) return true;
	}
	return false;
}

function previewLabel(receiver: unknown, text: string): string {
	const theme = (receiver as { theme?: { codeBlockBorder?: (value: string) => string } })?.theme;
	return theme?.codeBlockBorder?.(text) ?? text;
}

/** Exact grok-build fallback prose; never surface its unavailable image action. */
export const UPSTREAM_TOO_WIDE_HINT =
	"This diagram is too wide to display here — open the image to view it in full.";

export interface MermaidPreviewResult {
	kind: "rendered" | "reflowed" | "too-wide";
	label: string;
	/** Styled diagram lines; absent when no bounded preview can be shown. */
	lines?: string[];
	requiredWidth?: number;
	availableWidth: number;
}

export function isTooWideFallback(art: string): boolean {
	// Upstream wraps the hint to max_width and ANSI-styles each wrapped line,
	// so match normalized prose rather than one exact physical line.
	const normalized = art.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\s+/g, " ");
	return (
		normalized.includes("This diagram is too wide to display here") &&
		normalized.includes("open the image to view it in full.")
	);
}

/** Preview-only LR/RL → TD rewrite; the displayed source remains untouched. */
export function reflowHorizontalFlowchart(
	source: string,
): { source: string; from: "LR" | "RL" } | null {
	const match = /^(\s*(?:flowchart|graph)\s+)(LR|RL)(?=\s|;|$)/im.exec(source);
	if (!match) return null;
	const from = match[2].toUpperCase() as "LR" | "RL";
	return {
		source: `${source.slice(0, match.index)}${match[1]}TD${source.slice(match.index + match[0].length)}`,
		from,
	};
}

/**
 * Render within the available columns. Horizontal flowcharts get one vertical
 * preview retry; otherwise report natural required width without leaking the
 * upstream grok pager's nonexistent "open image" affordance.
 */
export function resolveMermaidPreview(
	engine: MermaidRenderer,
	source: string,
	availableWidth: number,
): MermaidPreviewResult | null {
	const width = Math.max(1, availableWidth);
	const bounded = engine.render(source, width, true);
	if (bounded === null) return null;
	if (!isTooWideFallback(bounded)) {
		return { kind: "rendered", label: "◇ rendered", lines: bounded.split("\n"), availableWidth: width };
	}

	const reflow = reflowHorizontalFlowchart(source);
	if (reflow !== null) {
		const vertical = engine.render(reflow.source, width, true);
		if (vertical !== null && !isTooWideFallback(vertical)) {
			return {
				kind: "reflowed",
				label: `◇ rendered — reflowed ${reflow.from}→TD to fit`,
				lines: vertical.split("\n"),
				availableWidth: width,
			};
		}
	}

	// Natural plain art gives an honest requirement for this exact diagram.
	const natural = engine.render(source, 0, false);
	const requiredWidth = natural === null
		? undefined
		: Math.max(0, ...natural.split("\n").map((line) => visibleWidth(line)));
	return {
		kind: "too-wide",
		label:
			requiredWidth && requiredWidth > 0
				? `◇ preview needs ${requiredWidth} columns; ${width} available`
				: `◇ preview is too wide for ${width} columns`,
		requiredWidth,
		availableWidth: width,
	};
}

/**
 * Install the inline source+preview renderer. The optional prototype exists
 * for unit tests; production patches the live pi-tui Markdown prototype (pi's
 * extension loader aliases @earendil-works/pi-tui to the running instance).
 *
 * This intentionally targets a private-but-named TypeScript method. Every
 * assumption is guarded: if its shape changes, activation succeeds in legacy
 * append mode instead of taking down pi.
 */
export function installInlineMarkdownPatch(
	engine: MermaidRenderer,
	prototype: PatchableMarkdownPrototype = Markdown.prototype as unknown as PatchableMarkdownPrototype,
): InlinePatchHandle {
	const existing = prototype[INLINE_PATCH_KEY] as InlinePatchRecord | undefined;
	if (existing?.wrapper && prototype.renderToken === existing.wrapper) {
		existing.owners++;
		existing.engine = engine;
		let disposed = false;
		return {
			installed: true,
			dispose() {
				if (disposed) return;
				disposed = true;
				existing.owners--;
				if (existing.owners === 0 && prototype.renderToken === existing.wrapper) {
					prototype.renderToken = existing.original;
					delete prototype[INLINE_PATCH_KEY];
				}
			},
		};
	}

	const original = prototype.renderToken;
	if (typeof original !== "function") {
		return { installed: false, reason: "pi-tui Markdown.renderToken is unavailable", dispose() {} };
	}

	const record: InlinePatchRecord = {
		original,
		engine,
		owners: 1,
		wrapper: undefined as unknown as RenderToken,
	};

	record.wrapper = function (token, width, nextTokenType, styleContext): string[] {
		const originalLines = record.original.call(this, token, width, nextTokenType, styleContext);
		if (
			token?.type !== "code" ||
			!mermaidLanguage(token.lang) ||
			typeof token.text !== "string" ||
			!hasClosingFence(token.raw)
		) {
			return originalLines;
		}

		const preview = resolveMermaidPreview(record.engine, token.text, width);
		if (preview === null) return originalLines;

		// Preserve pi's exact source rendering and trailing-spacing decision;
		// insert the preview/overflow notice before only the separator line.
		const result = originalLines.slice();
		const hadTrailingGap = result.at(-1) === "";
		if (hadTrailingGap) result.pop();
		result.push(previewLabel(this, preview.label), ...(preview.lines ?? []));
		if (hadTrailingGap) result.push("");
		return result;
	};

	prototype.renderToken = record.wrapper;
	prototype[INLINE_PATCH_KEY] = record;
	let disposed = false;
	return {
		installed: true,
		dispose() {
			if (disposed) return;
			disposed = true;
			record.owners--;
			if (record.owners === 0 && prototype.renderToken === record.wrapper) {
				prototype.renderToken = record.original;
				delete prototype[INLINE_PATCH_KEY];
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Mermaid fence extraction
// ---------------------------------------------------------------------------

/** Extract completed backtick/tilde Mermaid fences (indentation stripped). */
export function extractMermaidBlocks(text: string): string[] {
	const blocks: string[] = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*mermaid\s*$/i);
		if (!open) {
			i++;
			continue;
		}
		const indent = open[1];
		const fence = open[2];
		const fenceChar = fence[0];
		const body: string[] = [];
		let closed = false;
		for (i++; i < lines.length; i++) {
			const candidate = lines[i].trim();
			if (
				candidate.length >= fence.length &&
				[...candidate].every((char) => char === fenceChar)
			) {
				closed = true;
				i++;
				break;
			}
			body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i]);
		}
		// Unclosed fences (streaming truncation, malformed output) are skipped.
		if (closed && body.join("\n").trim().length > 0) {
			blocks.push(body.join("\n"));
		}
	}
	return blocks;
}

/** Concatenated text blocks of a message's content. */
export function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			const b = block as { type?: unknown; text?: unknown };
			return b?.type === "text" && typeof b.text === "string" ? [b.text] : [];
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface MermaidEntryData {
	source: string;
}

/** Width-aware transcript component: re-renders the diagram per width. */
class MermaidDiagramComponent implements Component {
	private cache = new Map<number, string[]>();

	constructor(
		private readonly source: string,
		private readonly engine: MermaidEngine,
		private readonly dim: (text: string) => string,
	) {}

	invalidate(): void {
		this.cache.clear();
	}

	render(width: number): string[] {
		const cached = this.cache.get(width);
		if (cached) return cached;
		const contentWidth = Math.max(1, width - 1);
		const preview = resolveMermaidPreview(this.engine, this.source, contentWidth);
		const label = preview?.label ?? "◇ Mermaid rendering failed";
		const labelLines = wrapTextWithAnsi(this.dim(` ${label}`), Math.max(1, width));
		const body = preview?.lines?.map((line) => ` ${line}`) ?? [];
		const lines = ["", ...labelLines, ...body, ""];
		this.cache.set(width, lines);
		return lines;
	}
}

export default function piMermaid(pi: ExtensionAPI) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const engine = new MermaidEngine(path.join(here, "pi-mermaid.wasm.br"));
	const inlinePatch = installInlineMarkdownPatch(engine);

	pi.registerEntryRenderer<MermaidEntryData>("mermaid-diagram", (entry, _options, theme) => {
		const source = entry.data?.source ?? "";
		if (!source.trim()) return new Text(theme.fg("dim", "(empty mermaid block)"), 1, 0);
		return new MermaidDiagramComponent(source, engine, (text) => theme.fg("dim", text));
	});

	/** Renders the source once (unbounded width) to validate before appending. */
	const appendDiagrams = (sources: string[]): number => {
		let appended = 0;
		for (const source of sources) {
			if (engine.render(source, 0, false) === null) continue;
			pi.appendEntry<MermaidEntryData>("mermaid-diagram", { source });
			appended++;
		}
		return appended;
	};

	// Compatibility fallback only: current pi exposes renderToken as a named
	// prototype method, but if a future release changes it, keep the old
	// post-message behavior rather than losing automatic rendering entirely.
	if (!inlinePatch.installed) {
		let seenThisPrompt = new Set<string>();
		pi.on("agent_start", async () => {
			seenThisPrompt = new Set();
		});
		pi.on("turn_end", async (event) => {
			const message = event.message as { role?: unknown; content?: unknown };
			if (message.role !== "assistant") return;
			const fresh = extractMermaidBlocks(textOfContent(message.content)).filter(
				(source) => !seenThisPrompt.has(source),
			);
			for (const source of fresh) seenThisPrompt.add(source);
			appendDiagrams(fresh);
		});
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(`${inlinePatch.reason}; using append fallback`, "warning");
		});
	}

	pi.on("session_shutdown", async () => {
		inlinePatch.dispose();
	});

	pi.registerCommand("mermaid", {
		description: "Render mermaid diagrams (no arg: last assistant message; or inline source / file path)",
		handler: async (args, ctx) => {
			const notify = (text: string, level: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(text, level);
			};
			const trimmed = (args ?? "").trim();
			let sources: string[] = [];
			if (!trimmed) {
				// Latest assistant message on the current branch.
				const branch = ctx.sessionManager.getBranch();
				for (let i = branch.length - 1; i >= 0; i--) {
					const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
					if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
					sources = extractMermaidBlocks(textOfContent(entry.message.content));
					if (sources.length > 0) break;
				}
				if (sources.length === 0) {
					notify("No mermaid fences found in recent assistant messages", "warning");
					return;
				}
			} else if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
				const fileText = fs.readFileSync(trimmed, "utf8");
				// Markdown files contribute their fences; anything else is raw source.
				const fences = extractMermaidBlocks(fileText);
				sources = fences.length > 0 ? fences : [fileText];
			} else {
				sources = [trimmed];
			}
			const appended = appendDiagrams(sources);
			if (appended === 0) {
				notify("Nothing rendered (blank or oversized mermaid source)", "warning");
			}
		},
	});
}
