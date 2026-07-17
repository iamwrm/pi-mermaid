# Changelog

## 0.1.0 — 2026-07-17

- Initial release: render ` ```mermaid ` fences from assistant messages as
  display-only Unicode box-drawing transcript entries, plus a `/mermaid`
  command (last message / inline source / file path).
- Engine: xai-org/grok-build's terminal Mermaid renderer
  (`crates/codegen/xai-grok-markdown/src/mermaid.rs`, Apache-2.0, vendored
  unmodified at `8adf901`) compiled to `wasm32-unknown-unknown` behind a
  4-function C ABI with trap recovery; ratatui data types satisfied by a
  local `ratatui-shim` path crate emitting SGR attributes. The module is
  built with `opt-level = "z"` and shipped brotli-compressed
  (`pi-mermaid.wasm.br`, ~60 KB), decompressed at load via `node:zlib`.
- Width-aware re-render on resize; attribute-only styling (bold/dim/italic)
  so any terminal theme works; per-prompt dedup of repeated fences;
  blank/oversized (>64 KB) sources are skipped.
