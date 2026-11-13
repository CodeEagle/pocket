/**
 * @pocket/arc — Semantic Design Tokens, Concentric Radii & Theme Context.
 *
 * Faithful to `kuratlielia/arc-library` (`foundation.css`):
 * - Components read semantic tokens (`background`, `surface`, `surfaceRaised`,
 *   `surfaceMuted`, `foreground`, `textSecondary`, `textMuted`, `border`,
 *   `borderSubtle`, `borderStrong`, `accent`, `accentStrong`, `accentSubtle`,
 *   `success`, `warning`, `danger`), never hardcoded raw colors.
 * - Dark mode (`dark`) is tuned separately, not inverted; `amber-night` provides
 *   BabyLink's clinical 0%-blue-light OLED night mode (`#RRGG00`).
 * - Supports all 8 Arc `data-accent` presets: `neutral`, `violet`, `blue`,
 *   `green`, `amber`, `orange`, `coral`, and `rose`.
 * - Concentric radii (`radiusControl` 10px, `radiusSurface` 16px, `radiusPanel` 22px)
 *   plus `concentricInnerRadius(outer, padding)` helper.
 */

import { createContext, useContext, type JSX } from "solid-js";

export type ArcThemeMode = "light" | "dark" | "amber-night";

export type ArcAccent =
  | "neutral"
  | "violet"
  | "blue"
  | "green"
  | "amber"
  | "orange"
  | "coral"
  | "rose";

export type ArcDensity = "comfortable" | "compact";

export interface ArcAccentTokens {
  readonly accent: string;
  readonly accentStrong: string;
  readonly accentSubtle: string;
  readonly accentForeground: string;
}

export interface ArcStatusTriplet {
  readonly fg: string;
  readonly subtle: string;
  readonly border: string;
  readonly solid: string;
  readonly solidFg: string;
}

export interface ArcSemanticPalette {
  readonly mode: ArcThemeMode;
  readonly accentName: ArcAccent;
  // Surfaces (`--background`, `--surface`, `--surface-raised`, `--surface-muted`)
  readonly background: string;
  readonly backgroundMeshA: string;
  readonly backgroundMeshB: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceMuted: string;
  readonly surfaceScrim: string;
  // Text (`--foreground`, `--text-secondary`, `--text-muted`)
  readonly foreground: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  // Hairline structural borders (`--border`, `--border-subtle`, `--border-strong`)
  readonly border: string;
  readonly borderSubtle: string;
  readonly borderStrong: string;
  readonly shadowAmbient: string;
  // Accent (`--accent`, `--accent-strong`, `--accent-subtle`)
  readonly accent: string;
  readonly accentStrong: string;
  readonly accentSubtle: string;
  readonly accentForeground: string;
  // Status triplets (`--success`, `--warning`, `--danger`, `--info`)
  readonly success: ArcStatusTriplet;
  readonly warning: ArcStatusTriplet;
  readonly danger: ArcStatusTriplet;
  readonly info: ArcStatusTriplet;
  // Concentric geometry (`--radius-control`, `--radius-surface`, `--radius-panel`)
  readonly radiusControl: number;
  readonly radiusSurface: number;
  readonly radiusPanel: number;
}

export const ARC_ALL_ACCENTS: readonly ArcAccent[] = [
  "coral",
  "violet",
  "blue",
  "green",
  "amber",
  "orange",
  "rose",
  "neutral",
] as const;

const LIGHT_ACCENTS: Readonly<Record<ArcAccent, ArcAccentTokens>> = {
  neutral: {
    accent: "#18181B",
    accentStrong: "#09090B",
    accentSubtle: "#EFEFF2",
    accentForeground: "#FAFAFC",
  },
  violet: {
    accent: "#6D5AE6",
    accentStrong: "#5743D4",
    accentSubtle: "#EEECFD",
    accentForeground: "#FFFFFF",
  },
  blue: {
    accent: "#2563EB",
    accentStrong: "#1D4ED8",
    accentSubtle: "#EBF2FE",
    accentForeground: "#FFFFFF",
  },
  green: {
    accent: "#16A34A",
    accentStrong: "#15803D",
    accentSubtle: "#E9F8EF",
    accentForeground: "#FFFFFF",
  },
  amber: {
    accent: "#D97706",
    accentStrong: "#B45309",
    accentSubtle: "#FEF3C7",
    accentForeground: "#FFFFFF",
  },
  orange: {
    accent: "#EA580C",
    accentStrong: "#C2410C",
    accentSubtle: "#FFEDD5",
    accentForeground: "#FFFFFF",
  },
  coral: {
    accent: "#DE5A43",
    accentStrong: "#C4452F",
    accentSubtle: "#FCECE8",
    accentForeground: "#FFFFFF",
  },
  rose: {
    accent: "#E11D48",
    accentStrong: "#BE123C",
    accentSubtle: "#FFE4E9",
    accentForeground: "#FFFFFF",
  },
};

const DARK_ACCENTS: Readonly<Record<ArcAccent, ArcAccentTokens>> = {
  neutral: {
    accent: "#F4F4F6",
    accentStrong: "#FFFFFF",
    accentSubtle: "#27272C",
    accentForeground: "#09090B",
  },
  violet: {
    accent: "#8B7CF6",
    accentStrong: "#A396FA",
    accentSubtle: "#221E3A",
    accentForeground: "#FFFFFF",
  },
  blue: {
    accent: "#3B82F6",
    accentStrong: "#60A5FA",
    accentSubtle: "#172542",
    accentForeground: "#FFFFFF",
  },
  green: {
    accent: "#22C55E",
    accentStrong: "#4ADE80",
    accentSubtle: "#132A1C",
    accentForeground: "#06140B",
  },
  amber: {
    accent: "#F59E0B",
    accentStrong: "#FBBF24",
    accentSubtle: "#2D210E",
    accentForeground: "#0C0904",
  },
  orange: {
    accent: "#F97316",
    accentStrong: "#FB923C",
    accentSubtle: "#2F1B0F",
    accentForeground: "#0D0704",
  },
  coral: {
    accent: "#EE6D57",
    accentStrong: "#F48875",
    accentSubtle: "#2E1916",
    accentForeground: "#FFFFFF",
  },
  rose: {
    accent: "#FB7185",
    accentStrong: "#FDA4AF",
    accentSubtle: "#31151C",
    accentForeground: "#140609",
  },
};

/**
 * Clinical 0%-Blue-Light Amber Night tokens (`#RRGG00` — every single hex color
 * maintains `00` on the blue channel for nocturnal melatonin protection).
 */
export const ARC_AMBER_NIGHT_BASE: Omit<ArcSemanticPalette, "accentName"> = {
  mode: "amber-night",
  background: "#060500",
  backgroundMeshA: "#140E00",
  backgroundMeshB: "#1A1200",
  surface: "#120E00",
  surfaceRaised: "#1B1500",
  surfaceMuted: "#171100",
  surfaceScrim: "#050400CC",
  foreground: "#F4DC00",
  textSecondary: "#C69E00",
  textMuted: "#8C6D00",
  border: "#3A2C00",
  borderSubtle: "#261D00",
  borderStrong: "#594300",
  shadowAmbient: "#000000CC",
  accent: "#E58A00",
  accentStrong: "#FFA000",
  accentSubtle: "#2B1B00",
  accentForeground: "#080600",
  success: {
    fg: "#9CD600",
    subtle: "#192400",
    border: "#3D5700",
    solid: "#6FA800",
    solidFg: "#080600",
  },
  warning: {
    fg: "#FFB300",
    subtle: "#2B1E00",
    border: "#5E4200",
    solid: "#E58A00",
    solidFg: "#080600",
  },
  danger: {
    fg: "#FF6A00",
    subtle: "#2E1200",
    border: "#6B2900",
    solid: "#D94400",
    solidFg: "#FFF200",
  },
  info: {
    fg: "#E8B400",
    subtle: "#261D00",
    border: "#4F3B00",
    solid: "#C98A00",
    solidFg: "#080600",
  },
  radiusControl: 10,
  radiusSurface: 16,
  radiusPanel: 22,
};

export function resolveArcPalette(
  modeInput: ArcThemeMode | boolean = "light",
  accentName: ArcAccent = "coral",
): ArcSemanticPalette {
  const safeAccent: ArcAccent = (ARC_ALL_ACCENTS as readonly string[]).includes(accentName)
    ? accentName
    : "coral";
  const mode: ArcThemeMode =
    typeof modeInput === "boolean" ? (modeInput ? "dark" : "light") : modeInput;

  if (mode === "amber-night") {
    return {
      ...ARC_AMBER_NIGHT_BASE,
      accentName: safeAccent,
    };
  }

  if (mode === "dark") {
    const acc = DARK_ACCENTS[safeAccent];
    return {
      mode: "dark",
      accentName: safeAccent,
      background: "#09090B",
      backgroundMeshA: "#13131A",
      backgroundMeshB: "#17141D",
      surface: "#121215",
      surfaceRaised: "#19191E",
      surfaceMuted: "#17171B",
      surfaceScrim: "#040406BB",
      foreground: "#F4F4F6",
      textSecondary: "#A1A1AA",
      textMuted: "#71717A",
      border: "#25252B",
      borderSubtle: "#1D1D22",
      borderStrong: "#383842",
      shadowAmbient: "#00000099",
      ...acc,
      success: {
        fg: "#34D399",
        subtle: "#11281E",
        border: "#1F4D38",
        solid: "#16A34A",
        solidFg: "#FFFFFF",
      },
      warning: {
        fg: "#FBBF24",
        subtle: "#2A1F0D",
        border: "#573F18",
        solid: "#D97706",
        solidFg: "#09090B",
      },
      danger: {
        fg: "#F87171",
        subtle: "#2C1517",
        border: "#5E262A",
        solid: "#DC2626",
        solidFg: "#FFFFFF",
      },
      info: {
        fg: "#60A5FA",
        subtle: "#15233D",
        border: "#254275",
        solid: "#2563EB",
        solidFg: "#FFFFFF",
      },
      radiusControl: 10,
      radiusSurface: 16,
      radiusPanel: 22,
    };
  }

  const acc = LIGHT_ACCENTS[safeAccent];
  return {
    mode: "light",
    accentName: safeAccent,
    background: "#F6F6F9",
    backgroundMeshA: "#ECEEF5",
    backgroundMeshB: "#F4ECE8",
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    surfaceMuted: "#EFEFF3",
    surfaceScrim: "#11111666",
    foreground: "#111114",
    textSecondary: "#52525B",
    textMuted: "#8A8A95",
    border: "#E3E3E9",
    borderSubtle: "#ECECF1",
    borderStrong: "#CFCFD8",
    shadowAmbient: "#11111812",
    ...acc,
    success: {
      fg: "#15803D",
      subtle: "#EAF8EF",
      border: "#B9E9CA",
      solid: "#16A34A",
      solidFg: "#FFFFFF",
    },
    warning: {
      fg: "#B45309",
      subtle: "#FEF3C7",
      border: "#F7D674",
      solid: "#D97706",
      solidFg: "#FFFFFF",
    },
    danger: {
      fg: "#B91C1C",
      subtle: "#FEE2E2",
      border: "#F8B4B4",
      solid: "#DC2626",
      solidFg: "#FFFFFF",
    },
    info: {
      fg: "#1D4ED8",
      subtle: "#EBF2FE",
      border: "#BFDBFE",
      solid: "#2563EB",
      solidFg: "#FFFFFF",
    },
    radiusControl: 10,
    radiusSurface: 16,
    radiusPanel: 22,
  };
}

/**
 * Arc concentric corner radius formula (`design.md`):
 * `innerRadius = max(4, outerRadius - padding)` so nested controls sit concentrically
 * inside cards and floating trays without uneven corner pinch.
 */
export function concentricInnerRadius(outerRadius: number, padding: number, minRadius = 4): number {
  if (!Number.isFinite(outerRadius) || !Number.isFinite(padding)) return minRadius;
  return Math.max(minRadius, Math.round((outerRadius - Math.max(0, padding)) * 10) / 10);
}

export interface ArcThemeContextValue {
  readonly mode: () => ArcThemeMode;
  readonly accent: () => ArcAccent;
  readonly density: () => ArcDensity;
  readonly reducedMotion: () => boolean;
  readonly palette: () => ArcSemanticPalette;
}

const DEFAULT_LIGHT = resolveArcPalette("light", "coral");

export const ArcThemeContext = createContext<ArcThemeContextValue>({
  mode: () => "light",
  accent: () => "coral",
  density: () => "compact",
  reducedMotion: () => false,
  palette: () => DEFAULT_LIGHT,
});

export function ArcThemeProvider(props: {
  mode?: ArcThemeMode | (() => ArcThemeMode);
  accent?: ArcAccent | (() => ArcAccent);
  density?: ArcDensity | (() => ArcDensity);
  reducedMotion?: boolean | (() => boolean);
  children?: JSX.Element;
}): JSX.Element {
  const mode = (): ArcThemeMode =>
    typeof props.mode === "function" ? props.mode() : (props.mode ?? "light");
  const accent = (): ArcAccent =>
    typeof props.accent === "function" ? props.accent() : (props.accent ?? "coral");
  const density = (): ArcDensity =>
    typeof props.density === "function" ? props.density() : (props.density ?? "compact");
  const reducedMotion = (): boolean =>
    typeof props.reducedMotion === "function"
      ? props.reducedMotion()
      : Boolean(props.reducedMotion);
  const palette = () => resolveArcPalette(mode(), accent());

  return ArcThemeContext.Provider({
    value: { mode, accent, density, reducedMotion, palette },
    get children() {
      return props.children;
    },
  });
}

export function useArcTheme(): ArcThemeContextValue {
  return useContext(ArcThemeContext);
}
