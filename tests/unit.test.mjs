// Unit tests for pi-mermaid: fence extraction, WASM engine, and extension
// wiring (loaded via jiti, driven through a stub ExtensionAPI — see
// .pi/skills/pi-extension-dev/references/testing.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { createJiti } = require(
  require.resolve("jiti", { paths: [`${PKG}/node_modules/@earendil-works/pi-coding-agent`] }),
);
const jiti = createJiti(import.meta.url);

const mod = await jiti.import(path.join(PKG, "index.ts"));
const activate = mod.default?.default ?? mod.default;
const {
  extractMermaidBlocks,
  textOfContent,
  MermaidEngine,
  hasClosingFence,
  installInlineMarkdownPatch,
  resolveMermaidPreview,
  reflowHorizontalFlowchart,
  UPSTREAM_TOO_WIDE_HINT,
  isTooWideFallback,
} = mod;

const FLOW = "flowchart TD\n    A[Start] --> B{Works?}\n    B -->|Yes| C[Ship]\n    B -->|No| A";

function makeStubPi() {
  const state = { handlers: {}, commands: {}, renderers: {}, entries: [] };
  const pi = {
    on: (name, fn) => {
      (state.handlers[name] ??= []).push(fn);
    },
    registerCommand: (name, def) => {
      state.commands[name] = def;
    },
    registerEntryRenderer: (type, fn) => {
      state.renderers[type] = fn;
    },
    appendEntry: (type, data) => {
      state.entries.push({ type, data });
    },
  };
  return { pi, state };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:]*m/g, "");

// --- extractMermaidBlocks ---------------------------------------------------

test("extracts a plain mermaid fence", () => {
  const text = `intro\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\nafter`;
  assert.deepEqual(extractMermaidBlocks(text), [FLOW]);
});

test("strips indentation from list-nested fences", () => {
  const text = "- item\n  ```mermaid\n  graph TD\n    A --> B\n  ```\n";
  assert.deepEqual(extractMermaidBlocks(text), ["graph TD\n  A --> B"]);
});

test("skips unclosed fences and non-mermaid blocks", () => {
  assert.deepEqual(extractMermaidBlocks("```mermaid\ngraph TD\n  A --> B\n"), []);
  assert.deepEqual(extractMermaidBlocks("```rust\nfn main() {}\n```\n"), []);
});

test("handles longer backtick and tilde fences", () => {
  const text = "````mermaid\ngraph TD\n  A --> B\n````\n\n~~~mermaid\nA-->C\n~~~\n";
  assert.deepEqual(extractMermaidBlocks(text), ["graph TD\n  A --> B", "A-->C"]);
});

test("hasClosingFence recognizes complete backtick/tilde tokens only", () => {
  assert.equal(hasClosingFence("```mermaid\nA-->B\n```\n"), true);
  assert.equal(hasClosingFence("~~~~mermaid\nA-->B\n~~~~\n"), true);
  assert.equal(hasClosingFence("```mermaid\nA-->B\n``"), false);
  assert.equal(hasClosingFence("A-->B"), false);
});

test("textOfContent joins text blocks and ignores others", () => {
  assert.equal(textOfContent("plain"), "plain");
  assert.equal(
    textOfContent([
      { type: "text", text: "a" },
      { type: "toolCall", id: "x" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assert.equal(textOfContent(undefined), "");
});

// --- MermaidEngine (WASM) ---------------------------------------------------

const engine = new MermaidEngine(path.join(PKG, "pi-mermaid.wasm.br"));

test("wasm engine renders a flowchart", () => {
  const art = engine.render(FLOW, 80, false);
  assert.ok(art !== null);
  assert.match(art, /Start/);
  assert.match(art, /Ship/);
  assert.match(art, /[│─┌└]/);
});

test("wasm engine styled output carries SGR and plain does not", () => {
  assert.ok(engine.render(FLOW, 80, true).includes("\x1b["));
  assert.ok(!engine.render(FLOW, 80, false).includes("\x1b["));
});

test("wasm engine returns null for blank and oversized input", () => {
  assert.equal(engine.render("   \n ", 80, false), null);
  assert.equal(engine.render("flowchart TD\n".repeat(10000), 80, false), null);
});

test("wasm engine falls back to framed source for unsupported types", () => {
  const art = engine.render('pie title Pets\n  "Dogs" : 3', 80, false);
  assert.ok(art !== null);
  assert.match(art, /Dogs/);
});

// --- Width overflow resolution ----------------------------------------------

test("reflowHorizontalFlowchart changes only the preview direction", () => {
  assert.deepEqual(reflowHorizontalFlowchart("flowchart LR\nA-->B"), {
    source: "flowchart TD\nA-->B",
    from: "LR",
  });
  assert.deepEqual(reflowHorizontalFlowchart("%% note\ngraph RL; A-->B"), {
    source: "%% note\ngraph TD; A-->B",
    from: "RL",
  });
  assert.equal(reflowHorizontalFlowchart("sequenceDiagram\nA->>B: Hi"), null);
});

test("real wide LR flowchart is retried vertically and fits", () => {
  const source =
    "flowchart LR\n A[aaaaaaaaaaaaaaaaaaaa] --> B[bbbbbbbbbbbbbbbbbbbb] --> C[cccccccccccccccccccc]";
  const bounded = engine.render(source, 40, false);
  assert.ok(isTooWideFallback(bounded), "fixture must hit wrapped upstream width fallback");

  const preview = resolveMermaidPreview(engine, source, 40);
  assert.equal(preview.kind, "reflowed");
  assert.equal(preview.label, "◇ rendered — reflowed LR→TD to fit");
  assert.ok(preview.lines.some((line) => line.includes("aaaaaaaa")));
  assert.ok(!preview.lines.join("\n").includes("open the image"));
});

test("intrinsically wide diagram reports natural required/available width", () => {
  const warning = `BOX\n${UPSTREAM_TOO_WIDE_HINT}`;
  const calls = [];
  const fakeEngine = {
    render(source, width, ansi) {
      calls.push({ source, width, ansi });
      if (width > 0) return warning;
      // ANSI must not count toward required terminal width.
      return `\x1b[2m${"x".repeat(83)}\x1b[0m\nshort`;
    },
  };
  const source = "sequenceDiagram\nA->>B: Hi";
  const preview = resolveMermaidPreview(fakeEngine, source, 37);
  assert.deepEqual(preview, {
    kind: "too-wide",
    label: "◇ preview needs 83 columns; 37 available",
    requiredWidth: 83,
    availableWidth: 37,
  });
  assert.deepEqual(calls, [
    { source, width: 37, ansi: true },
    { source, width: 0, ansi: false },
  ]);
  assert.doesNotMatch(preview.label, /image/i);
});

test("overflow resolver retries LR once, then reports original natural width", () => {
  const warning = UPSTREAM_TOO_WIDE_HINT;
  const calls = [];
  const fakeEngine = {
    render(source, width, ansi) {
      calls.push({ source, width, ansi });
      return width === 0 ? "x".repeat(91) : warning;
    },
  };
  const source = "flowchart LR\nA-->B";
  const preview = resolveMermaidPreview(fakeEngine, source, 20);
  assert.equal(preview.kind, "too-wide");
  assert.equal(preview.requiredWidth, 91);
  assert.deepEqual(calls, [
    { source, width: 20, ansi: true },
    { source: "flowchart TD\nA-->B", width: 20, ansi: true },
    { source, width: 0, ansi: false },
  ]);
});

// --- Inline Markdown source + preview patch --------------------------------

test("inline patch preserves source then inserts preview before trailing gap", () => {
  const widths = [];
  const fakeEngine = {
    render: (source, width, ansi) => {
      widths.push({ source, width, ansi });
      return "ART 1\nART 2";
    },
  };
  const original = function (_token, _width, nextType) {
    return ["```mermaid", "  A-->B", "```", ...(nextType && nextType !== "space" ? [""] : [])];
  };
  const prototype = { renderToken: original };
  const patch = installInlineMarkdownPatch(fakeEngine, prototype);
  assert.equal(patch.installed, true);

  const receiver = { theme: { codeBlockBorder: (text) => `<dim>${text}</dim>` } };
  const token = { type: "code", lang: "Mermaid", text: "A-->B", raw: "```mermaid\nA-->B\n```\n" };
  assert.deepEqual(prototype.renderToken.call(receiver, token, 47, "paragraph"), [
    "```mermaid",
    "  A-->B",
    "```",
    "<dim>◇ rendered</dim>",
    "ART 1",
    "ART 2",
    "",
  ]);
  assert.deepEqual(widths, [{ source: "A-->B", width: 47, ansi: true }]);

  patch.dispose();
  assert.equal(prototype.renderToken, original, "dispose restores pi's original renderer");
  patch.dispose(); // idempotent
});

test("inline patch leaves incomplete, ordinary, and failed blocks untouched", () => {
  let calls = 0;
  const original = () => ["ORIGINAL"];
  const prototype = { renderToken: original };
  const patch = installInlineMarkdownPatch(
    { render: () => { calls++; return null; } },
    prototype,
  );
  const receiver = {};
  assert.deepEqual(
    prototype.renderToken.call(receiver, { type: "code", lang: "mermaid", text: "A", raw: "```mermaid\nA" }, 40),
    ["ORIGINAL"],
  );
  assert.deepEqual(
    prototype.renderToken.call(receiver, { type: "code", lang: "rust", text: "A", raw: "```rust\nA\n```" }, 40),
    ["ORIGINAL"],
  );
  assert.deepEqual(
    prototype.renderToken.call(receiver, { type: "code", lang: "mermaid", text: "A", raw: "```mermaid\nA\n```" }, 40),
    ["ORIGINAL"],
  );
  assert.equal(calls, 1, "only completed Mermaid source reaches WASM");
  patch.dispose();
});

test("inline patch is shared, reference-counted, and shape-guarded", () => {
  const original = () => ["ORIGINAL"];
  const prototype = { renderToken: original };
  const one = installInlineMarkdownPatch({ render: () => "ONE" }, prototype);
  const wrapper = prototype.renderToken;
  const two = installInlineMarkdownPatch({ render: () => "TWO" }, prototype);
  assert.equal(prototype.renderToken, wrapper, "second activation must not double-wrap");
  one.dispose();
  assert.equal(prototype.renderToken, wrapper, "remaining owner keeps patch installed");
  two.dispose();
  assert.equal(prototype.renderToken, original);

  const unavailable = installInlineMarkdownPatch({ render: () => "X" }, {});
  assert.equal(unavailable.installed, false);
  assert.match(unavailable.reason, /unavailable/);
});

// --- Extension wiring -------------------------------------------------------

test("activation registers source-preview patch lifecycle, renderer, and command", async () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  assert.ok(state.renderers["mermaid-diagram"]);
  assert.ok(state.commands.mermaid);
  assert.ok(state.handlers.session_shutdown?.length === 1);
  assert.equal(state.handlers.turn_end, undefined, "working inline mode must not append duplicate bottom entries");
  assert.equal(state.handlers.agent_start, undefined);
  await state.handlers.session_shutdown[0]({}, {});
});

test("entry renderer produces width-bounded diagram art", async () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  const theme = { fg: (_c, t) => t };
  const comp = state.renderers["mermaid-diagram"]({ data: { source: FLOW } }, {}, theme);
  const lines = comp.render(60).map(stripAnsi);
  assert.ok(lines.some((l) => l.includes("◇ rendered")));
  assert.ok(lines.some((l) => l.includes("Start")));
  for (const line of lines) assert.ok(line.length <= 60, `too wide: ${JSON.stringify(line)}`);
  await state.handlers.session_shutdown[0]({}, {});
});

test("/mermaid renders inline source and last assistant message", async () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  const notifications = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (text, level) => notifications.push({ text, level }) },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: `\`\`\`mermaid\n${FLOW}\n\`\`\`` } },
        { type: "message", message: { role: "user", content: "thanks" } },
      ],
    },
  };
  await state.commands.mermaid.handler(FLOW, ctx);
  assert.equal(state.entries.length, 1);
  await state.commands.mermaid.handler("", ctx);
  assert.equal(state.entries.length, 2);
  assert.equal(notifications.length, 0);

  const emptyCtx = { ...ctx, sessionManager: { getBranch: () => [] } };
  await state.commands.mermaid.handler("", emptyCtx);
  assert.equal(state.entries.length, 2);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  await state.handlers.session_shutdown[0]({}, {});
});
