/** Default token -> colour map (sRGB hex) for light and dark editor surfaces. */
import { Kind, KIND_NAMES } from "./tokenizer.ts";

export interface TokenTheme {
  /** Editor background. */
  background: string;
  foreground: string;
  gutter: string;
  gutterActive: string;
  selection: string;
  caret: string;
  /** Underline colour for IME marked text. */
  marked: string;
  /** Colour per token kind, indexed by `Kind` value. */
  colors: string[];
}

function colors(map: Record<string, string>): string[] {
  const out: string[] = [];
  for (let k = 0; k < KIND_NAMES.length; k++) out.push(map[KIND_NAMES[k]]);
  return out;
}

export const lightTheme: TokenTheme = {
  background: "#ffffff", foreground: "#24292f", gutter: "#8c959f", gutterActive: "#24292f",
  selection: "#b6d7ff", caret: "#0969da", marked: "#0969da",
  colors: colors({
    plain: "#24292f", keyword: "#cf222e", identifier: "#24292f", type: "#8250df", number: "#0550ae", string: "#0a3069",
    template: "#0a3069", regexp: "#116329", comment: "#6e7781", punctuation: "#57606a", operator: "#cf222e",
    "jsx-tag": "#116329", "jsx-attribute": "#953800", "jsx-text": "#24292f",
  }),
};

export const darkTheme: TokenTheme = {
  background: "#0d1117", foreground: "#e6edf3", gutter: "#6e7681", gutterActive: "#e6edf3",
  selection: "#264f78", caret: "#58a6ff", marked: "#58a6ff",
  colors: colors({
    plain: "#e6edf3", keyword: "#ff7b72", identifier: "#e6edf3", type: "#d2a8ff", number: "#79c0ff", string: "#a5d6ff",
    template: "#a5d6ff", regexp: "#7ee787", comment: "#8b949e", punctuation: "#9da7b3", operator: "#ff7b72",
    "jsx-tag": "#7ee787", "jsx-attribute": "#ffa657", "jsx-text": "#e6edf3",
  }),
};

/** Colour for a token kind. */
export function colorFor(theme: TokenTheme, kind: number): string { return theme.colors[kind] ?? theme.colors[Kind.Plain]; }

export function themeFor(dark: boolean): TokenTheme { return dark ? darkTheme : lightTheme; }
