//! Minimal API-compatible shim for the `ratatui` types used by the vendored
//! `mermaid.rs` in `pi-mermaid-wasm`. `mermaid.rs` only uses ratatui's *data*
//! types (`Style`, `Modifier`, `Span`, `Line`) — never a backend — so this
//! path crate (deliberately named `ratatui`) lets it compile unmodified
//! without pulling real ratatui/crossterm into the WASM build.

pub mod style {
    /// Bitflag-style text modifier (only the variants `mermaid.rs` and our
    /// palette use).
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Modifier(pub u16);

    impl Modifier {
        pub const BOLD: Modifier = Modifier(1 << 0);
        pub const DIM: Modifier = Modifier(1 << 1);
        pub const ITALIC: Modifier = Modifier(1 << 2);
    }

    /// Attribute-only style (no colors: output stays readable on any
    /// terminal theme).
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Style {
        pub modifiers: u16,
    }

    impl Style {
        pub fn add_modifier(mut self, modifier: Modifier) -> Style {
            self.modifiers |= modifier.0;
            self
        }

        /// SGR escape sequence for this style, or an empty string for the
        /// default style.
        pub fn sgr(&self) -> String {
            if self.modifiers == 0 {
                return String::new();
            }
            let mut codes: Vec<&str> = Vec::new();
            if self.modifiers & Modifier::BOLD.0 != 0 {
                codes.push("1");
            }
            if self.modifiers & Modifier::DIM.0 != 0 {
                codes.push("2");
            }
            if self.modifiers & Modifier::ITALIC.0 != 0 {
                codes.push("3");
            }
            format!("\x1b[{}m", codes.join(";"))
        }
    }
}

pub mod text {
    use super::style::Style;
    use std::borrow::Cow;

    #[derive(Clone, Debug, Default)]
    pub struct Span<'a> {
        pub content: Cow<'a, str>,
        pub style: Style,
    }

    impl<'a> Span<'a> {
        pub fn styled<T: Into<Cow<'a, str>>>(content: T, style: Style) -> Span<'a> {
            Span {
                content: content.into(),
                style,
            }
        }
    }

    #[derive(Clone, Debug, Default)]
    pub struct Line<'a> {
        pub spans: Vec<Span<'a>>,
    }

    impl<'a> From<Vec<Span<'a>>> for Line<'a> {
        fn from(spans: Vec<Span<'a>>) -> Line<'a> {
            Line { spans }
        }
    }

    impl<'a> From<Span<'a>> for Line<'a> {
        fn from(span: Span<'a>) -> Line<'a> {
            Line { spans: vec![span] }
        }
    }
}
