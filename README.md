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

- After every assistant message, any ` ```mermaid ` fences in its text are
  rendered as display-only transcript entries (never sent back to the LLM).
- `/mermaid` — no argument: re-render the fences from the latest assistant
  message; with an argument: render inline mermaid source, or a file path
  (`.mmd` raw source, or markdown whose fences are extracted).
- Diagrams re-render width-aware on terminal resize and use only bold/dim/
  italic SGR attributes, so they respect any terminal theme.

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
re-instantiates itself and the entry falls back to showing the raw source.

## Rebuilding the WASM

```bash
rustup target add wasm32-unknown-unknown
npm run build:wasm   # cargo build + brotli-compress into pi-mermaid.wasm.br
```

Then run `npm test` (strict typecheck + 14 unit tests over jiti, including the
WASM ABI round-trip). The vendored `rust/src/mermaid.rs` also carries its
upstream test suite: `cd rust && cargo test` (150 tests).

## Re-syncing with upstream

`rust/src/mermaid.rs` is a byte-for-byte copy. To update: copy the file from a
newer grok-build checkout, run `cd rust && cargo test`, rebuild the WASM, and
record the new upstream commit here and in `rust/src/lib.rs`.
