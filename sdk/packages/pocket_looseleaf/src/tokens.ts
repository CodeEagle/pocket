/**
 * @pocket/looseleaf — Design Tokens, Deterministic Ink Seeds & Theme Context.
 *
 * Mirrors Looseleaf's 4-tier token architecture:
 * - Tier 0: Stationery palette (desk, paper stocks, rules, sticky stocks, pens,
 *   markers, highlighters, sticker accents, tape & umber shadows).
 * - Tier 1: Semantic shadcn/ui role aliases (background, card, primary,
 *   secondary, muted, accent, destructive, border, focus).
 * - Tier 2: Hand-drawn recipe knobs (wobble, misregistration, tilt, calm mode).
 * - Tier 3: Density (`comfortable` 40px | `compact` 32px | `calm` 28px) and
 *   reading direction (`ltr` | `rtl`).
 */

import { createContext, useContext, type JSX } from "solid-js";

export type LooseleafStock =
  | "paper"
  | "paper-shade"
  | "slip"
  | "card"
  | "graph"
  | "kraft"
  | "check"
  | "pad"
  | "photo"
  | "sticky-yellow"
  | "sticky-green"
  | "sticky-orange"
  | "sticky-pink"
  | "sticky-blue";

export type LooseleafRule =
  | "none"
  | "ruled"
  | "ruled-hand"
  | "graph"
  | "index"
  | "pad"
  | "ledger";

export type LooseleafPenTone =
  | "ink"
  | "blue"
  | "pencil"
  | "red"
  | "green"
  | "marker"
  | "hi";

export type LooseleafAccent =
  | "marker"
  | "blue"
  | "hi"
  | "tomato"
  | "tangerine"
  | "lemon"
  | "grass"
  | "teal"
  | "sky"
  | "grape"
  | "bubblegum";

export type LooseleafDensity = "comfortable" | "compact" | "calm";
export type LooseleafThemeMode = "notebook" | "dark" | "amber-night";
export type LooseleafDirection = "ltr" | "rtl";

export interface LooseleafPalette {
  mode: LooseleafThemeMode;
  desk: string;
  deskDeep: string;
  paper: string;
  paperShade: string;
  slip: string;
  card: string;
  graph: string;
  kraft: string;
  check: string;
  pad: string;
  photo: string;
  ruleBlue: string;
  ruleRed: string;
  padRule: string;
  checkRule: string;
  stickyYellow: string;
  stickyGreen: string;
  stickyOrange: string;
  stickyPink: string;
  stickyBlue: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkYou: string;
  pencil: string;
  pencilText: string;
  pencilMark: string;
  red: string;
  green: string;
  marker: string;
  orangeText: string;
  hi: string;
  hiDeep: string;
  hiSelect: string;
  focus: string;
  tomato: string;
  tangerine: string;
  lemon: string;
  grass: string;
  teal: string;
  sky: string;
  grape: string;
  bubblegum: string;
  tape: string;
  tapeEdge: string;
  washiYellow: string;
  washiSky: string;
  washiTomato: string;
  washiGrass: string;
  shadowSheet: string;
  shadowHard: string;
  codeBg: string;
  codeInk: string;
}

/** Default "Notebook" daylight stationery palette (`looseleaf.css`). */
export const LOOSELEAF_NOTEBOOK_PALETTE: LooseleafPalette = {
  mode: "notebook",
  desk: "#A8C8BB",
  deskDeep: "#93B4A7",
  paper: "#F8F5EE",
  paperShade: "#ECE6DA",
  slip: "#FBF8F1",
  card: "#FBF6E9",
  graph: "#F4F7EF",
  kraft: "#DCC8A3",
  check: "#DFE9D8",
  pad: "#F8F2DE",
  photo: "#FFFDF6",
  ruleBlue: "#8FB0D4",
  ruleRed: "#D9776A",
  padRule: "#B2C3DC",
  checkRule: "#7FA37C",
  stickyYellow: "#F7E38A",
  stickyGreen: "#CFE6A8",
  stickyOrange: "#F7C08E",
  stickyPink: "#F6B8B0",
  stickyBlue: "#BCD8F0",
  ink: "#2A2420",
  inkSoft: "#4A423B",
  inkMuted: "#5A524A",
  inkYou: "#2C4F9E",
  pencil: "#6B6660",
  pencilText: "#5A554E",
  pencilMark: "#8E887F",
  red: "#C2412D",
  green: "#3B7A4B",
  marker: "#DF6B3C",
  orangeText: "#A4502A",
  hi: "#F8DC4C",
  hiDeep: "#A87F0C",
  hiSelect: "#F8DC4CA6",
  focus: "#2C4F9E",
  tomato: "#E8483A",
  tangerine: "#F59A2F",
  lemon: "#FBD63A",
  grass: "#5DB85C",
  teal: "#2FB1A3",
  sky: "#4AA8E8",
  grape: "#8F6FD6",
  bubblegum: "#F38BB8",
  tape: "#F6F4ECC8",
  tapeEdge: "#8C87786E",
  washiYellow: "#F8DC4CC4",
  washiSky: "#4AA8E8BA",
  washiTomato: "#E8483ABA",
  washiGrass: "#5DB85CBA",
  shadowSheet: "#3A2C1E2E",
  shadowHard: "#2A242040",
  codeBg: "#24272E",
  codeInk: "#ECE6D9",
};

/** Opaque charcoal-ink dark notebook material palette. */
export const LOOSELEAF_DARK_PALETTE: LooseleafPalette = {
  mode: "dark",
  desk: "#191E1C",
  deskDeep: "#121614",
  paper: "#24211E",
  paperShade: "#1C1917",
  slip: "#2B2723",
  card: "#27231F",
  graph: "#212622",
  kraft: "#3A3024",
  check: "#222A23",
  pad: "#2A261E",
  photo: "#2F2B26",
  ruleBlue: "#3F5873",
  ruleRed: "#8A473E",
  padRule: "#425368",
  checkRule: "#3E5942",
  stickyYellow: "#4A3F1C",
  stickyGreen: "#2B3F28",
  stickyOrange: "#4A311E",
  stickyPink: "#4A2929",
  stickyBlue: "#24394A",
  ink: "#F2ECE1",
  inkSoft: "#D6CEC0",
  inkMuted: "#A89F91",
  inkYou: "#7BA4F7",
  pencil: "#9E9689",
  pencilText: "#B5ADA0",
  pencilMark: "#6B645B",
  red: "#F07562",
  green: "#6AC47E",
  marker: "#E87A4D",
  orangeText: "#F2986B",
  hi: "#D9B526",
  hiDeep: "#F5D756",
  hiSelect: "#D9B52659",
  focus: "#7BA4F7",
  tomato: "#F06456",
  tangerine: "#F7A645",
  lemon: "#F5D547",
  grass: "#6BC96A",
  teal: "#47C4B6",
  sky: "#62B6F0",
  grape: "#A68AE6",
  bubblegum: "#F59CC3",
  tape: "#EAE3D245",
  tapeEdge: "#BFB6A455",
  washiYellow: "#D9B52666",
  washiSky: "#62B6F059",
  washiTomato: "#F0645659",
  washiGrass: "#6BC96A59",
  shadowSheet: "#0A080666",
  shadowHard: "#08070588",
  codeBg: "#16181D",
  codeInk: "#ECE6D9",
};

/**
 * Zero-blue-light (`B = 00`) warm amber night notebook palette.
 * Ideal for nursery, bedside, and dark-room reading without blue-channel glare.
 */
export const LOOSELEAF_AMBER_NIGHT_PALETTE: LooseleafPalette = {
  mode: "amber-night",
  desk: "#120A00",
  deskDeep: "#0A0500",
  paper: "#1C1000",
  paperShade: "#160C00",
  slip: "#241500",
  card: "#211300",
  graph: "#1E1100",
  kraft: "#2E1A00",
  check: "#1F1200",
  pad: "#241400",
  photo: "#291700",
  ruleBlue: "#523000",
  ruleRed: "#7A2E00",
  padRule: "#593400",
  checkRule: "#4D2D00",
  stickyYellow: "#3B2400",
  stickyGreen: "#2E1E00",
  stickyOrange: "#422100",
  stickyPink: "#3D1A00",
  stickyBlue: "#331F00",
  ink: "#FFB800",
  inkSoft: "#E09B00",
  inkMuted: "#AD7400",
  inkYou: "#FF9500",
  pencil: "#996500",
  pencilText: "#BA7D00",
  pencilMark: "#6E4700",
  red: "#FF5500",
  green: "#D49B00",
  marker: "#FF7700",
  orangeText: "#FF8800",
  hi: "#FFA600",
  hiDeep: "#FFCC00",
  hiSelect: "#FFA60045",
  focus: "#FF9500",
  tomato: "#FF5500",
  tangerine: "#FF8800",
  lemon: "#FFBB00",
  grass: "#CC9900",
  teal: "#B88600",
  sky: "#E69500",
  grape: "#CC6600",
  bubblegum: "#FF6600",
  tape: "#FFB30033",
  tapeEdge: "#99630066",
  washiYellow: "#FFB3004D",
  washiSky: "#E695004D",
  washiTomato: "#FF55004D",
  washiGrass: "#CC99004D",
  shadowSheet: "#08040088",
  shadowHard: "#050200AA",
  codeBg: "#140B00",
  codeInk: "#FFB800",
};

export function resolveLooseleafPalette(
  mode: LooseleafThemeMode | boolean | undefined,
): LooseleafPalette {
  if (mode === "amber-night") return LOOSELEAF_AMBER_NIGHT_PALETTE;
  if (mode === "dark" || mode === true) return LOOSELEAF_DARK_PALETTE;
  return LOOSELEAF_NOTEBOOK_PALETTE;
}

/** Deterministic FNV-1a 32-bit hash for seeded hand-drawn strokes and paper tilt. */
export function hashSeed(seed: string | number | undefined, salt = "ll"): number {
  const input = `${String(seed ?? "default")}|${salt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in `[-1, 1]` derived from `seed`. */
export function seedSigned(seed: string | number | undefined, salt = "ll"): number {
  const u = hashSeed(seed, salt) / 0xffffffff;
  return u * 2 - 1;
}

/**
 * Deterministic sheet tilt in degrees (`[-maxDeg, +maxDeg]`).
 * Returns `0` under `"calm"` density (Looseleaf Law #10: "Charm is a dial you can turn down").
 */
export function seedTilt(
  seed: string | number | undefined,
  maxDeg = 1.1,
  density: LooseleafDensity = "comfortable",
): number {
  if (density === "calm" || maxDeg <= 0) return 0;
  const raw = seedSigned(seed, "tilt") * maxDeg;
  return Math.round(raw * 100) / 100;
}

/** Deterministic integer pixel misregistration offset in `[-maxPx, +maxPx]`. */
export function seedOffset(
  seed: string | number | undefined,
  maxPx = 2,
  salt = "misreg",
  density: LooseleafDensity = "comfortable",
): number {
  if (density === "calm" || maxPx <= 0) return 0;
  return Math.round(seedSigned(seed, salt) * maxPx * 10) / 10;
}

export function stockBackground(palette: LooseleafPalette, stock: LooseleafStock | undefined): string {
  switch (stock) {
    case "paper-shade":
      return palette.paperShade;
    case "slip":
      return palette.slip;
    case "card":
      return palette.card;
    case "graph":
      return palette.graph;
    case "kraft":
      return palette.kraft;
    case "check":
      return palette.check;
    case "pad":
      return palette.pad;
    case "photo":
      return palette.photo;
    case "sticky-yellow":
      return palette.stickyYellow;
    case "sticky-green":
      return palette.stickyGreen;
    case "sticky-orange":
      return palette.stickyOrange;
    case "sticky-pink":
      return palette.stickyPink;
    case "sticky-blue":
      return palette.stickyBlue;
    case "paper":
    default:
      return palette.paper;
  }
}

export function penColor(palette: LooseleafPalette, tone: LooseleafPenTone | undefined): string {
  switch (tone) {
    case "blue":
      return palette.inkYou;
    case "pencil":
      return palette.pencil;
    case "red":
      return palette.red;
    case "green":
      return palette.green;
    case "marker":
      return palette.marker;
    case "hi":
      return palette.hi;
    case "ink":
    default:
      return palette.ink;
  }
}

export function accentColorOf(palette: LooseleafPalette, accent: LooseleafAccent | undefined): string {
  switch (accent) {
    case "blue":
      return palette.inkYou;
    case "hi":
      return palette.hi;
    case "tomato":
      return palette.tomato;
    case "tangerine":
      return palette.tangerine;
    case "lemon":
      return palette.lemon;
    case "grass":
      return palette.grass;
    case "teal":
      return palette.teal;
    case "sky":
      return palette.sky;
    case "grape":
      return palette.grape;
    case "bubblegum":
      return palette.bubblegum;
    case "marker":
    default:
      return palette.marker;
  }
}

export function densityHitHeight(density: LooseleafDensity): number {
  if (density === "calm") return 30;
  if (density === "compact") return 34;
  return 40;
}

export interface LooseleafThemeState {
  palette: () => LooseleafPalette;
  density: () => LooseleafDensity;
  direction: () => LooseleafDirection;
  clutter: () => boolean;
}

const defaultThemeState: LooseleafThemeState = {
  palette: () => LOOSELEAF_NOTEBOOK_PALETTE,
  density: () => "comfortable",
  direction: () => "ltr",
  clutter: () => true,
};

const LooseleafThemeContext = createContext<LooseleafThemeState>(defaultThemeState);

export function LooseleafThemeProvider(props: {
  mode?: LooseleafThemeMode | boolean | (() => LooseleafThemeMode | boolean);
  palette?: LooseleafPalette | (() => LooseleafPalette);
  density?: LooseleafDensity | (() => LooseleafDensity);
  direction?: LooseleafDirection | (() => LooseleafDirection);
  clutter?: boolean | (() => boolean);
  children?: JSX.Element;
}): JSX.Element {
  const parent = useContext(LooseleafThemeContext);
  const state: LooseleafThemeState = {
    palette: () => {
      if (props.palette !== undefined) {
        return typeof props.palette === "function" ? props.palette() : props.palette;
      }
      if (props.mode !== undefined) {
        const m = typeof props.mode === "function" ? props.mode() : props.mode;
        return resolveLooseleafPalette(m);
      }
      return parent.palette();
    },
    density: () => {
      if (props.density !== undefined) {
        return typeof props.density === "function" ? props.density() : props.density;
      }
      return parent.density();
    },
    direction: () => {
      if (props.direction !== undefined) {
        return typeof props.direction === "function" ? props.direction() : props.direction;
      }
      return parent.direction();
    },
    clutter: () => {
      if (props.clutter !== undefined) {
        return typeof props.clutter === "function" ? props.clutter() : props.clutter;
      }
      return parent.clutter();
    },
  };
  return LooseleafThemeContext.Provider({
    value: state,
    get children() {
      return props.children;
    },
  });
}

export function DirectionProvider(props: {
  dir?: LooseleafDirection | (() => LooseleafDirection);
  children?: JSX.Element;
}): JSX.Element {
  return LooseleafThemeProvider({
    direction: props.dir ?? "ltr",
    get children() {
      return props.children;
    },
  });
}

export function useLooseleafTheme(): LooseleafThemeState {
  return useContext(LooseleafThemeContext);
}
