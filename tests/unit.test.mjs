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
const { extractMermaidBlocks, textOfContent, MermaidEngine } = mod;

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

test("handles longer outer fences containing inner backticks", () => {
  const text = "````mermaid\ngraph TD\n  A --> B\n````\n";
  assert.deepEqual(extractMermaidBlocks(text), ["graph TD\n  A --> B"]);
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

// --- Extension wiring -------------------------------------------------------

test("activation registers renderer, command, and handlers", () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  assert.ok(state.renderers["mermaid-diagram"]);
  assert.ok(state.commands.mermaid);
  assert.ok(state.handlers.turn_end?.length === 1);
  assert.ok(state.handlers.agent_start?.length === 1);
});

test("turn_end appends one entry per fence, deduped within a prompt", async () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  await state.handlers.agent_start[0]({}, {});
  const message = {
    role: "assistant",
    content: [{ type: "text", text: `\`\`\`mermaid\n${FLOW}\n\`\`\`` }],
  };
  await state.handlers.turn_end[0]({ turnIndex: 0, message }, {});
  await state.handlers.turn_end[0]({ turnIndex: 0, message }, {}); // replacement/retry
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].type, "mermaid-diagram");
  assert.equal(state.entries[0].data.source, FLOW);

  // Next prompt cycle renders it again.
  await state.handlers.agent_start[0]({}, {});
  await state.handlers.turn_end[0]({ turnIndex: 0, message }, {});
  assert.equal(state.entries.length, 2);
});

test("turn_end ignores user messages and invalid sources", async () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  await state.handlers.turn_end[0](
    { turnIndex: 0, message: { role: "user", content: `\`\`\`mermaid\n${FLOW}\n\`\`\`` } },
    {},
  );
  await state.handlers.turn_end[0](
    { turnIndex: 0, message: { role: "assistant", content: "```mermaid\n   \n```" } },
    {},
  );
  assert.equal(state.entries.length, 0);
});

test("entry renderer produces width-bounded diagram art", () => {
  const { pi, state } = makeStubPi();
  activate(pi);
  const theme = { fg: (_c, t) => t };
  const comp = state.renderers["mermaid-diagram"]({ data: { source: FLOW } }, {}, theme);
  const lines = comp.render(60).map(stripAnsi);
  assert.ok(lines.some((l) => l.includes("◇ mermaid")));
  assert.ok(lines.some((l) => l.includes("Start")));
  for (const line of lines) assert.ok(line.length <= 60, `too wide: ${JSON.stringify(line)}`);
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
});
