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
 *  - After every assistant message, mermaid fences found in its text are
 *    rendered as display-only transcript entries (never sent to the LLM).
 *  - `/mermaid` re-renders fences from the latest assistant message, or takes
 *    inline source / a file path (.mmd or markdown with fences) as argument.
 *
 * Diagrams re-render width-aware on terminal resize; art uses only bold/dim/
 * italic SGR attributes, so it respects any terminal theme.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

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
// Mermaid fence extraction
// ---------------------------------------------------------------------------

/** Extract the contents of ```mermaid fenced blocks (indentation stripped). */
export function extractMermaidBlocks(text: string): string[] {
	const blocks: string[] = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const open = lines[i].match(/^(\s*)(`{3,})\s*mermaid\s*$/i);
		if (!open) {
			i++;
			continue;
		}
		const indent = open[1];
		const fence = open[2];
		const body: string[] = [];
		let closed = false;
		for (i++; i < lines.length; i++) {
			const close = lines[i].match(/^\s*(`{3,})\s*$/);
			if (close && close[1].length >= fence.length) {
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
		// 1-column left indent; keep a sane minimum so tiny panes still render.
		const artWidth = Math.max(24, width - 2);
		const art = this.engine.render(this.source, artWidth, true);
		const body =
			art !== null
				? art.split("\n").map((line) => ` ${line}`)
				: this.source.split("\n").map((line) => ` ${this.dim(line)}`);
		const lines = ["", this.dim(" ◇ mermaid"), ...body, ""];
		this.cache.set(width, lines);
		return lines;
	}
}

export default function piMermaid(pi: ExtensionAPI) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const engine = new MermaidEngine(path.join(here, "pi-mermaid.wasm.br"));

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

	// Sources already rendered during the current prompt cycle, so a retried/
	// replaced assistant message does not duplicate its diagrams.
	let seenThisPrompt = new Set<string>();
	pi.on("agent_start", async () => {
		seenThisPrompt = new Set();
	});

	// turn_end (not message_end): it fires after pi has committed the assistant
	// message, so the diagram entry lands *below* the message in the transcript.
	pi.on("turn_end", async (event) => {
		const message = event.message as { role?: unknown; content?: unknown };
		if (message.role !== "assistant") return;
		const fresh = extractMermaidBlocks(textOfContent(message.content)).filter(
			(source) => !seenThisPrompt.has(source),
		);
		for (const source of fresh) seenThisPrompt.add(source);
		appendDiagrams(fresh);
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
