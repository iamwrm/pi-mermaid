# Changelog

## 0.2.1 — 2026-07-17

- Automatic assistant-message rendering now preserves each completed Mermaid
  source block and inserts a width-aware `◇ rendered` preview immediately
  below it, keeping multiple diagrams beside their surrounding explanation.
- Added a guarded, reference-counted patch of the live pi-tui
  `Markdown.renderToken` method (pi 0.80.10 exposes no public code-block hook):
  it calls pi's original source renderer first, only previews closed fences,
  restores the prototype on `session_shutdown`, and never modifies session or
  model context. WASM failure leaves the original block untouched.
- If pi changes the internal token method, activation warns and falls back to
  0.1-style post-message entries instead of failing. Explicit `/mermaid`
  standalone entries remain available.
- Wide horizontal `graph`/`flowchart` previews retry LR/RL source as a
  preview-only TD layout and label the result (`reflowed LR→TD to fit`); the
  visible source and model/session context remain unchanged.
- Intrinsically wide diagrams show an ANSI-aware, measured notice such as
  `preview needs 143 columns; 72 available`, without duplicating the already
  visible source block. Explicit `/mermaid` entries use the same policy.
- Intercepted grok-build's wrapped/styled width fallback so pi-mermaid never
  displays its inapplicable “open the image” action.
- Added tilde-fence extraction plus deterministic coverage for source/preview
  ordering, incomplete streaming fences, guarded patch lifecycle, direction
  rewriting, real WASM overflow and vertical retry, ANSI-aware natural width,
  retry exhaustion, and removal of the upstream image hint (20 tests total).

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
