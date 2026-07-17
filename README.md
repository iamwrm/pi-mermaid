# pi-mermaid

Pi extension that renders ` ```mermaid ` fences as Unicode box-drawing
diagrams directly in the transcript.

```
        ┌───────┐
        │ Start │
        └───┬───┘
            │
            ▼
   ╭────────────────╮
   │ Is it working? │◄───┐
   ╰────────┬───────╯    │
      ┌─────┴──────┐     │
      ▼Yes         ▼No   │
 ┌─────────┐   ┌───────┐ │
 │ Ship it │   │ Debug ├─┘
 └─────────┘   └───────┘
```

## What it does

- Keeps each completed ` ```mermaid ` source block visible and inserts a
  `◇ rendered` Unicode preview immediately below that block, before the next
  paragraph. Multiple diagrams therefore stay beside their surrounding
  explanation instead of collecting at the end of the assistant message.
- While a model is streaming an unclosed fence, shows ordinary source only;
  the preview appears atomically when the closing fence arrives.
- `/mermaid` — no argument: re-render the fences from the latest assistant
  message as standalone entries; with an argument: render inline Mermaid
  source, or a file path (`.mmd` raw source, or markdown whose fences are
  extracted).
- Diagrams re-render width-aware on terminal resize and use only bold/dim/
  italic SGR attributes, so they respect any terminal theme.
- If a horizontal `graph`/`flowchart` is too wide, the preview retries it as
  `TD` and labels the display `reflowed LR→TD` (source is untouched). Other
  intrinsic overflow becomes a precise `preview needs N columns; M available`
  notice—never grok-build's inapplicable “open the image” hint or a duplicate
  framed copy of the source.

Inline previews are display-only. The original source remains unchanged in
session storage and model context.

Supported diagram types: `graph`/`flowchart` (incl. subgraphs), `sequenceDiagram`,
`stateDiagram`, `classDiagram`, `erDiagram`. Anything else falls back to the
source in a framed box.

## Install

```bash
pi install git:github.com/iamwrm/pi-mermaid
```

Or from a local checkout:

```bash
pi install ./path/to/pi-mermaid
```

## How it works

The layout/drawing engine is the terminal Mermaid renderer from
[xai-org/grok-build](https://github.com/xai-org/grok-build)
(`crates/codegen/xai-grok-markdown/src/mermaid.rs`, Apache-2.0, vendored
unmodified at commit `8adf9013a0929e5c7f1d4e849492d2387837a28d` — license copy
in `rust/LICENSE.grok-build`). It is compiled to a `wasm32-unknown-unknown`
module with a 4-function C ABI — no wasm-bindgen, no Node native deps, no
browser, no network. The shipped artifact is brotli-compressed
(`pi-mermaid.wasm.br`, ~60 KB vs ~190 KB raw) and decompressed at load time
with Node's built-in `zlib`; the engine sniffs the `\0asm` magic, so a raw
`.wasm` path also works.

`mermaid.rs` only uses ratatui's *data* types, so `rust/ratatui-shim/` provides
a ~90-line path crate named `ratatui` that lets the vendored file compile
untouched (and emit SGR-attribute styling instead of ratatui spans).

A WASM panic (the source is untrusted model output) traps in JS; the engine
re-instantiates itself and leaves pi's original source block untouched.

### Inline integration and compatibility

Pi 0.80.10 has no public Markdown code-block renderer hook. The extension
therefore guards and patches the live pi-tui `Markdown.renderToken` prototype
method, first calling pi's original source renderer and then inserting the
preview at that token's effective width (including list/blockquote nesting).
Pi's extension loader aliases `@earendil-works/pi-tui` to the running instance,
so the patch reaches the actual TUI class. A global symbol plus reference count
prevents double wrapping across duplicate activation/reload, and
`session_shutdown` restores the original method.

If a future pi release changes/removes that internal method, activation remains
safe: pi-mermaid warns once and falls back to its 0.1 behavior (display-only
diagram entries after the assistant message). `/mermaid` remains available in
either mode. This guard should be revalidated against every pi release until pi
exposes a public code-block renderer API.

## Rebuilding the WASM

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm   # cargo build + brotli-compress into pi-mermaid.wasm.br
```

Then run `npm test` (strict typecheck + 20 unit tests over jiti, including the
WASM ABI round-trip, guarded inline-patch lifecycle, vertical reflow, and
ANSI-aware natural-width reporting). The vendored `rust/src/mermaid.rs` also carries its
upstream test suite: `cd rust && cargo test` (150 tests).

## Re-syncing with upstream

`rust/src/mermaid.rs` is a byte-for-byte copy. To update: copy the file from a
newer grok-build checkout, run `cd rust && cargo test`, rebuild the WASM, and
record the new upstream commit here and in `rust/src/lib.rs`.
