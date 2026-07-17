//! Mermaid diagram -> Unicode box-drawing art, for the `pi-mermaid` extension.
//!
//! The heavy lifting lives in `mermaid.rs`, vendored unmodified from
//! [`xai-org/grok-build`](https://github.com/xai-org/grok-build)
//! `crates/codegen/xai-grok-markdown/src/mermaid.rs`
//! (commit `8adf9013a0929e5c7f1d4e849492d2387837a28d`, Apache-2.0 — see
//! `LICENSE.grok-build`). It renders `graph`/`flowchart`, `sequenceDiagram`,
//! `stateDiagram`, `classDiagram`, and `erDiagram` blocks as Unicode box art;
//! unsupported types fall back to the source in a framed box.
//!
//! `mermaid.rs` only depends on ratatui's data types, which are provided by
//! the local `ratatui-shim` path crate so the whole crate compiles cleanly to
//! `wasm32-unknown-unknown` with no bindgen and no JS glue.

mod mermaid;

use ratatui::style::{Modifier, Style};

/// Untrusted model output: refuse absurdly large sources outright.
const MAX_SOURCE_BYTES: usize = 64 * 1024;

/// Attribute-only palette (no colors) so the art respects any terminal theme.
fn default_styles() -> mermaid::MermaidStyles {
    let dim = Style::default().add_modifier(Modifier::DIM);
    mermaid::MermaidStyles {
        border: dim,
        node_text: Style::default(),
        edge: dim,
        edge_label: Style::default().add_modifier(Modifier::ITALIC),
        title: Style::default().add_modifier(Modifier::BOLD),
    }
}

/// Render mermaid source to diagram art.
///
/// Returns `None` for blank input or oversized source. `ansi` selects
/// SGR-styled lines (bold/dim/italic only) vs plain text.
pub fn render_to_string(src: &str, max_width: Option<usize>, ansi: bool) -> Option<String> {
    if src.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let art = mermaid::render(src, &default_styles(), max_width)?;
    if !ansi {
        return Some(art.plain_lines.join("\n"));
    }
    let mut out = String::new();
    for (i, line) in art.styled_lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        for span in &line.spans {
            let sgr = span.style.sgr();
            if sgr.is_empty() {
                out.push_str(&span.content);
            } else {
                out.push_str(&sgr);
                out.push_str(&span.content);
                out.push_str("\x1b[0m");
            }
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// C-ABI surface for the WASM build (no wasm-bindgen; the JS host talks to
// these four exports directly through WebAssembly.Memory).
// ---------------------------------------------------------------------------

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

/// Allocate `len` bytes inside WASM memory for the host to write into.
///
/// # Safety
/// Host must pair every allocation with [`wasm_free`] using the same length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        raw_alloc(layout)
    }
}

/// Free a buffer previously returned by [`wasm_alloc`] or [`render_mermaid`].
///
/// # Safety
/// `ptr`/`len` must describe exactly one live allocation made by this module.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn wasm_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        let layout = Layout::from_size_align_unchecked(len, 1);
        raw_dealloc(ptr, layout);
    }
}

/// Render mermaid source (UTF-8 at `src_ptr..src_ptr+src_len`) and return the
/// result as a packed `(ptr << 32) | len` pointing at a UTF-8 buffer the host
/// must release with [`wasm_free`]. Returns `0` when nothing renders.
///
/// `max_width == 0` means "no width limit"; `ansi != 0` selects SGR styling.
///
/// # Safety
/// `src_ptr`/`src_len` must describe a valid readable range in WASM memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn render_mermaid(
    src_ptr: *const u8,
    src_len: usize,
    max_width: usize,
    ansi: u32,
) -> u64 {
    let bytes = unsafe { std::slice::from_raw_parts(src_ptr, src_len) };
    let src = String::from_utf8_lossy(bytes);
    let width = if max_width == 0 { None } else { Some(max_width) };
    let Some(rendered) = render_to_string(&src, width, ansi != 0) else {
        return 0;
    };
    let boxed = rendered.into_bytes().into_boxed_slice();
    let len = boxed.len();
    if len == 0 {
        return 0;
    }
    let ptr = Box::into_raw(boxed) as *mut u8;
    ((ptr as u64) << 32) | (len as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOW: &str = "flowchart TD\n    A[Start] --> B{Is it working?}\n    B -->|Yes| C[Ship it]\n    B -->|No| D[Debug]\n    D --> B";

    #[test]
    fn renders_flowchart_plain() {
        let out = render_to_string(FLOW, Some(80), false).expect("renders");
        assert!(out.contains("Start"));
        assert!(out.contains("Ship it"));
        assert!(out.contains('│') || out.contains('─'));
        assert!(!out.contains('\x1b'));
    }

    #[test]
    fn renders_flowchart_ansi() {
        let out = render_to_string(FLOW, Some(80), true).expect("renders");
        assert!(out.contains('\x1b'));
        assert!(out.contains("Start"));
    }

    #[test]
    fn renders_sequence_diagram() {
        let src = "sequenceDiagram\n    Alice->>Bob: Hello Bob\n    Bob-->>Alice: Hi Alice";
        let out = render_to_string(src, Some(80), false).expect("renders");
        assert!(out.contains("Alice"));
        assert!(out.contains("Hello Bob"));
    }

    #[test]
    fn unsupported_type_falls_back_to_framed_source() {
        let src = "pie title Pets\n    \"Dogs\" : 386";
        let out = render_to_string(src, Some(80), false).expect("renders fallback");
        assert!(out.contains("Dogs"));
    }

    #[test]
    fn blank_and_oversized_return_none() {
        assert!(render_to_string("   \n  ", Some(80), false).is_none());
        let big = "flowchart TD\n".repeat(10_000);
        assert!(render_to_string(&big, Some(80), false).is_none());
    }
}
