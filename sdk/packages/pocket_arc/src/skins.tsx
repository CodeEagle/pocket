/**
 * @pocket/arc — Calm Architectural Surfaces, Concentric Cards, Gliding Controls & Dock.
 *
 * Implements Arc Library's signature aesthetic in native PocketJS vector `<View>` nodes:
 * - Three-tier surfaces (`background`, `surface`, `surfaceRaised`, `surfaceMuted`)
 * - Crisp 1px hairline structural borders (`--border`, `--border-subtle`) with soft
 *   diffused elevation rather than Looseleaf's thick offset ink shadows or washi tape
 * - Concentric corner radii (`22px` panels -> `16px` cards -> `10px` controls)
 * - Calm spring-driven micro-interactions (`ArcSegmentedControl` gliding indicator,
 *   `ArcSwitch` spring thumb, `ArcProgressMeter` smooth fill sweep, `ArcActionButton`
 *   press-settle feedback, and subtle orbital backdrop rings).
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import { Focusable, Image, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { createArcSpring } from "./motion.ts";
import {
  concentricInnerRadius,
  resolveArcPalette,
  useArcTheme,
  type ArcAccent,
  type ArcThemeMode,
} from "./tokens.ts";

export type ArcSurfaceVariant =
  | "surface"
  | "raised"
  | "muted"
  | "inset"
  | "notice-warning"
  | "notice-danger"
  | "notice-success"
  | "compact";

export type ArcBadgeTone =
  | "safe"
  | "sage"
  | "trial"
  | "suspect"
  | "hi"
  | "danger"
  | "coral"
  | "neutral"
  | "outline";

export type ArcActionVariant = "primary" | "secondary" | "danger" | "outline" | "ghost";

function resolveMode(isDark: boolean | undefined, ctxMode: ArcThemeMode): ArcThemeMode {
  if (isDark === undefined) return ctxMode;
  if (!isDark) return "light";
  return ctxMode === "amber-night" ? "amber-night" : "dark";
}

/**
 * Full-bleed Arc calm architectural backdrop: clean `--background` canvas with
 * two subtle concentric orbital rings & soft ambient top glow (zero grid clutter).
 */
export function ArcBackdrop(props: {
  isDark?: boolean | (() => boolean);
  accent?: ArcAccent | (() => ArcAccent);
}): JSX.Element {
  const ctx = useArcTheme();
  const darkBool = () =>
    typeof props.isDark === "function" ? props.isDark() : props.isDark;
  const pal = () => {
    const mode = resolveMode(darkBool(), ctx.mode());
    const acc = typeof props.accent === "function" ? props.accent() : (props.accent ?? ctx.accent());
    return resolveArcPalette(mode, acc);
  };

  return (
    <View
      class="absolute inset-0 overflow-hidden"
      style={{ bgColor: pal().background, hitPass: 1 }}
    >
      {/* Subtle top ambient aura */}
      <View
        class="absolute left-[24] right-[24] top-[-90] h-[220]"
        style={{
          bgColor: pal().accentSubtle,
          opacity: pal().mode === "light" ? 0.55 : 0.28,
          radius: 999,
          hitPass: 1,
        }}
      />
      {/* Signature quiet concentric Arc rings (inspired by @uiarc centered ring backdrop) */}
      <View
        class="absolute right-[-88] top-[34] w-[240] h-[240]"
        style={{
          borderColor: pal().borderSubtle,
          borderWidth: 1,
          radius: 999,
          opacity: 0.7,
          hitPass: 1,
        }}
      />
      <View
        class="absolute right-[-48] top-[74] w-[160] h-[160]"
        style={{
          borderColor: pal().border,
          borderWidth: 1,
          radius: 999,
          opacity: 0.45,
          hitPass: 1,
        }}
      />
    </View>
  );
}

/**
 * Crisp concentric Arc surface / card (`--surface`, `--surface-raised`, `--surface-muted`,
 * or semantic status callout). Uses 1px hairline `--border` and soft diffused shadow.
 */
export function ArcSurface(props: {
  variant?: ArcSurfaceVariant;
  isDark?: boolean;
  accent?: ArcAccent;
  accentStripe?: boolean;
  radius?: number;
  class?: string;
  style?: ViewProps["style"];
  children?: JSX.Element;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () =>
    resolveArcPalette(resolveMode(props.isDark, ctx.mode()), props.accent ?? ctx.accent());
  const variant = () => props.variant ?? "surface";

  const fill = (): string => {
    const p = pal();
    const v = variant();
    if (v === "notice-warning") return p.warning.subtle;
    if (v === "notice-danger") return p.danger.subtle;
    if (v === "notice-success") return p.success.subtle;
    if (v === "muted" || v === "inset") return p.surfaceMuted;
    if (v === "raised") return p.surfaceRaised;
    return p.surface;
  };

  const border = (): string => {
    const p = pal();
    const v = variant();
    if (v === "notice-warning") return p.warning.border;
    if (v === "notice-danger") return p.danger.border;
    if (v === "notice-success") return p.success.border;
    if (v === "muted" || v === "inset") return p.borderSubtle;
    return p.border;
  };

  const rad = (): number => {
    if (props.radius !== undefined) return props.radius;
    const v = variant();
    if (v === "compact" || v === "inset") return concentricInnerRadius(pal().radiusSurface, 4, 10);
    if (v.startsWith("notice-")) return 12;
    return pal().radiusSurface;
  };

  const showSoftElevation = () => {
    const v = variant();
    return v === "surface" || v === "raised";
  };

  return (
    <View
      class={props.class ?? "relative w-full p-4 flex-col gap-2.5"}
      style={props.style}
    >
      {/* Subtle 1px vertical ambient shadow (no offset lateral cartoon shadow) */}
      <Show when={showSoftElevation()}>
        <View
          class="absolute inset-0"
          style={{
            insetL: 0,
            insetT: 1.5,
            insetR: 0,
            insetB: -1.5,
            bgColor: pal().shadowAmbient,
            radius: rad(),
            hitPass: 1,
          }}
        />
      </Show>

      <View
        class="absolute inset-0 overflow-hidden"
        style={{
          bgColor: fill(),
          borderColor: border(),
          borderWidth: 1,
          radius: rad(),
          hitPass: 1,
        }}
      >
        {/* Optional subtle top accent hairline */}
        <Show when={Boolean(props.accentStripe)}>
          <View
            class="absolute left-4 right-4 top-0 h-[2]"
            style={{
              bgColor: pal().accent,
              radius: 999,
              opacity: 0.78,
              hitPass: 1,
            }}
          />
        </Show>
      </View>

      {props.children}
    </View>
  );
}

/** Semantic status badge paired with subtle background, hairline border & optional status dot. */
export function ArcBadge(props: {
  tone?: ArcBadgeTone;
  isDark?: boolean;
  label: string;
  showDot?: boolean;
  class?: string;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const tone = (): ArcBadgeTone => props.tone ?? "safe";

  const colors = () => {
    const p = pal();
    const t = tone();
    if (t === "safe" || t === "sage") {
      return { bg: p.success.subtle, border: p.success.border, fg: p.success.fg, dot: p.success.solid };
    }
    if (t === "danger") {
      return { bg: p.danger.solid, border: p.danger.solid, fg: p.danger.solidFg, dot: p.danger.solidFg };
    }
    if (t === "trial") {
      return { bg: p.info.subtle, border: p.info.border, fg: p.info.fg, dot: p.info.solid };
    }
    if (t === "coral") {
      return { bg: p.accentSubtle, border: p.borderStrong, fg: p.accent, dot: p.accent };
    }
    if (t === "suspect" || t === "hi") {
      return { bg: p.warning.subtle, border: p.warning.border, fg: p.warning.fg, dot: p.warning.solid };
    }
    return { bg: p.surfaceMuted, border: p.border, fg: p.textSecondary, dot: p.textMuted };
  };

  return (
    <View
      class={props.class ?? "relative px-2.5 py-1 flex-row items-center justify-center gap-1 shrink-0"}
    >
      <View
        class="absolute inset-0"
        style={{
          bgColor: colors().bg,
          borderColor: colors().border,
          borderWidth: 1,
          radius: 999,
          hitPass: 1,
        }}
      />
      <Show when={props.showDot === true}>
        <View
          class="w-1.5 h-1.5 shrink-0"
          style={{ bgColor: colors().dot, radius: 999, hitPass: 1 }}
        />
      </Show>
      <Text
        class="text-2xs font-bold"
        style={{ textColor: colors().fg, hitPass: 1 }}
      >
        {props.label}
      </Text>
    </View>
  );
}

/**
 * Tactile Arc action button (`--radius-control: 10px`) with calm spring press-settle
 * (`scale` / subtle elevation settle) and clean secondary/ghost states.
 */
export function ArcActionButton(props: {
  variant?: ArcActionVariant;
  isDark?: boolean;
  label: string;
  fullWidth?: boolean;
  boxClass?: string;
  onPress?: () => void;
}): JSX.Element {
  const ctx = useArcTheme();
  const [pressedPulse, setPressedPulse] = createSignal(0);
  const settleOffset = createArcSpring(() => (pressedPulse() > 0 ? 1 : 0), {
    preset: "snappy",
    reducedMotion: ctx.reducedMotion,
  });

  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const variant = (): ArcActionVariant => props.variant ?? "primary";

  const styleTokens = () => {
    const p = pal();
    const v = variant();
    if (v === "danger") {
      return { bg: p.danger.solid, border: p.danger.solid, fg: p.danger.solidFg, bw: 1, rad: p.radiusControl };
    }
    if (v === "secondary") {
      return { bg: p.surfaceMuted, border: p.border, fg: p.foreground, bw: 1, rad: p.radiusControl };
    }
    if (v === "outline") {
      return { bg: p.surface, border: p.borderStrong, fg: p.foreground, bw: 1, rad: p.radiusControl };
    }
    if (v === "ghost") {
      return { bg: p.accentSubtle, border: p.borderSubtle, fg: p.accent, bw: 1, rad: 999 };
    }
    return { bg: p.accent, border: p.accentStrong, fg: p.accentForeground, bw: 1, rad: p.radiusControl };
  };

  const handlePress = () => {
    setPressedPulse(1);
    setPressedPulse(0);
    props.onPress?.();
  };

  return (
    <Focusable class={props.fullWidth ? "w-full" : ""} onPress={handlePress}>
      <View
        class={
          props.boxClass ??
          (props.fullWidth
            ? "relative w-full py-2.5 px-4 items-center justify-center"
            : variant() === "ghost"
              ? "relative py-1 px-2.5 items-center justify-center"
              : "relative py-2 px-3.5 items-center justify-center")
        }
        style={{ translateY: settleOffset() * 1.2 }}
      >
        <View
          class="absolute inset-0"
          style={{
            bgColor: styleTokens().bg,
            borderColor: styleTokens().border,
            borderWidth: styleTokens().bw,
            radius: styleTokens().rad,
            hitPass: 1,
          }}
        />
        <Text
          class={variant() === "ghost" ? "text-2xs font-bold" : "text-xs font-bold"}
          style={{ textColor: styleTokens().fg, hitPass: 1 }}
        >
          {props.label}
        </Text>
      </View>
    </Focusable>
  );
}

/** Circular toolbar icon button with quiet `--surface-raised` fill & hairline border. */
export function ArcCircleIconButton(props: {
  iconSrc: string;
  isDark?: boolean;
  active?: boolean;
  sizeClass?: string;
  iconClass?: string;
  showBadgeDot?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const fill = () => (props.active ? pal().accentSubtle : pal().surfaceRaised);
  const border = () => (props.active ? pal().accent : pal().border);

  return (
    <Focusable onPress={props.onPress}>
      <View class={props.sizeClass ?? "relative w-7 h-7 items-center justify-center shrink-0"}>
        <View
          class="absolute inset-0"
          style={{
            bgColor: fill(),
            borderColor: border(),
            borderWidth: 1,
            radius: 999,
            hitPass: 1,
          }}
        />
        <Image
          src={props.iconSrc}
          class={props.iconClass ?? "w-4 h-4"}
          style={{ hitPass: 1 }}
        />
        <Show when={props.showBadgeDot === true}>
          <View
            class="absolute top-0 right-0 w-2 h-2"
            style={{ bgColor: pal().accent, radius: 999, hitPass: 1 }}
          />
        </Show>
      </View>
    </Focusable>
  );
}

/**
 * Signature Arc Segmented Control (`@uiarc/segmented-control`):
 * Recessed `--surface-muted` pill track with a **gliding spring-animated** `--surface-raised`
 * selection indicator that slides smoothly between segments!
 */
export function ArcSegmentedControl<T extends string>(props: {
  isDark?: boolean;
  items: readonly { id: T; label: string }[];
  activeId: () => T;
  onSelect: (id: T) => void;
  class?: string;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());

  const activeIndex = () => {
    const idx = props.items.findIndex((it) => it.id === props.activeId());
    return idx >= 0 ? idx : 0;
  };

  // Spring-animated normalized position [0 .. N-1]
  const animatedIdx = createArcSpring(activeIndex, {
    preset: "calm",
    reducedMotion: ctx.reducedMotion,
  });

  const count = () => Math.max(1, props.items.length);

  return (
    <View
      class={props.class ?? "relative w-full h-9 p-[3] flex-row items-center"}
    >
      {/* Recessed muted track */}
      <View
        class="absolute inset-0"
        style={{
          bgColor: pal().surfaceMuted,
          borderColor: pal().borderSubtle,
          borderWidth: 1,
          radius: pal().radiusControl,
          hitPass: 1,
        }}
      />
      <For each={props.items}>
        {(item, idx) => {
          const selected = () => props.activeId() === item.id;
          // Smooth proximity glow from the gliding spring indicator
          const proximity = () => Math.max(0, 1 - Math.abs(animatedIdx() - idx()));
          return (
            <Focusable
              class="flex-1 h-full items-center justify-center"
              onPress={() => props.onSelect(item.id)}
            >
              <View class="relative w-full h-full items-center justify-center px-2">
                <Show when={proximity() > 0.05}>
                  <View
                    class="absolute inset-0"
                    style={{
                      bgColor: pal().surfaceRaised,
                      borderColor: pal().border,
                      borderWidth: 1,
                      radius: concentricInnerRadius(pal().radiusControl, 3, 7),
                      opacity: proximity(),
                      hitPass: 1,
                    }}
                  />
                </Show>
                <Text
                  class={selected() ? "text-xs font-bold" : "text-xs"}
                  style={{
                    textColor: selected() ? pal().foreground : pal().textSecondary,
                    hitPass: 1,
                  }}
                >
                  {item.label}
                </Text>
              </View>
            </Focusable>
          );
        }}
      </For>
    </View>
  );
}

/**
 * Arc Usage / Progress Meter (`@uiarc/progress` & `@uiarc/usage-meter`):
 * Smoothly sweeps width via `gentle` spring physics.
 */
export function ArcProgressMeter(props: {
  isDark?: boolean;
  ratio: () => number;
  tone?: "sage" | "coral";
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const clampedTarget = () => Math.max(0.04, Math.min(1, props.ratio()));
  const animatedRatio = createArcSpring(clampedTarget, {
    preset: "gentle",
    reducedMotion: ctx.reducedMotion,
  });

  const barFill = () =>
    props.tone === "coral" ? pal().accent : pal().success.solid;

  return (
    <View
      class="relative w-full h-[8] overflow-hidden flex-row items-center"
      style={{
        bgColor: pal().surfaceMuted,
        borderColor: pal().borderSubtle,
        borderWidth: 1,
        radius: 999,
      }}
    >
      <View
        class="h-full"
        style={{
          grow: animatedRatio(),
          bgColor: barFill(),
          radius: 999,
          hitPass: 1,
        }}
      />
      <View
        class="h-full"
        style={{
          grow: Math.max(0, 1 - animatedRatio()),
          hitPass: 1,
        }}
      />
    </View>
  );
}

/**
 * Tactile Arc Switch (`@uiarc/switch`):
 * Smooth `snappy` spring thumb travel (`translateX: 0 -> 20px`).
 */
export function ArcSwitchPill(props: {
  checked: boolean;
  isDark?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const progress = createArcSpring(() => (props.checked ? 1 : 0), {
    preset: "snappy",
    reducedMotion: ctx.reducedMotion,
  });

  const body = (
    <View
      class="relative w-[44] h-[24] px-[3] flex-row items-center shrink-0"
      style={{
        bgColor: props.checked ? pal().accent : pal().surfaceMuted,
        borderColor: props.checked ? pal().accentStrong : pal().borderStrong,
        borderWidth: 1,
        radius: 999,
      }}
    >
      <View
        class="w-[18] h-[18]"
        style={{
          translateX: progress() * 19,
          bgColor: props.checked ? pal().accentForeground : pal().surfaceRaised,
          borderColor: props.checked ? pal().accentStrong : pal().border,
          borderWidth: 1,
          radius: 999,
          hitPass: 1,
        }}
      />
    </View>
  );

  return props.onPress ? <Focusable onPress={props.onPress}>{body}</Focusable> : body;
}

/** Clean architectural vertical timeline row (`@uiarc/timeline`) with concentric ring node & 1px hairline rail. */
export function ArcTimelineRow(props: {
  time: string;
  isDark: boolean;
  isLast: boolean;
  children?: JSX.Element;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());

  return (
    <View class="flex-row items-stretch gap-2.5 w-full">
      <View class="w-12 pt-3 flex-row items-start justify-between shrink-0">
        <Text
          class="text-2xs font-bold"
          style={{ textColor: pal().textMuted }}
        >
          {props.time}
        </Text>
        <View class="flex-col items-center h-full pt-1">
          <View
            class="w-2.5 h-2.5 items-center justify-center shrink-0"
            style={{
              bgColor: pal().accentSubtle,
              borderColor: pal().accent,
              borderWidth: 1.5,
              radius: 999,
            }}
          />
          <Show when={!props.isLast}>
            <View
              class="flex-1 w-[1] mt-1"
              style={{ bgColor: pal().border }}
            />
          </Show>
        </View>
      </View>
      {props.children}
    </View>
  );
}

/**
 * Floating Arc Dock Tray (`@uiarc/floating-button-group` & `dock`):
 * Concentric `22px` `--surface-raised` capsule with 1px hairline border and soft shadow.
 */
export function ArcDockCapsule(props: {
  isDark: boolean;
  bottomInset: number;
  leftInset: number;
  rightInset: number;
  children?: JSX.Element;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const safeBottom = () => Math.max(10, props.bottomInset);

  return (
    <View
      style={{
        height: 62 + safeBottom(),
        paddingT: 4,
        paddingL: 14 + props.leftInset,
        paddingR: 14 + props.rightInset,
        paddingB: safeBottom(),
      }}
      class="flex-col w-full shrink-0 bg-transparent items-center justify-center"
    >
      <View class="relative w-full h-[56] px-2 flex-row items-center justify-between">
        <View
          class="absolute inset-0"
          style={{
            insetL: 0,
            insetT: 2,
            insetR: 0,
            insetB: -2,
            bgColor: pal().shadowAmbient,
            radius: pal().radiusPanel,
            hitPass: 1,
          }}
        />
        <View
          class="absolute inset-0"
          style={{
            bgColor: pal().surfaceRaised,
            borderColor: pal().border,
            borderWidth: 1,
            radius: pal().radiusPanel,
            hitPass: 1,
          }}
        />
        {props.children}
      </View>
    </View>
  );
}

/** Clean geometric step dots (`@uiarc/stepper` / `usage-meter` cells). */
export function ArcStepDots(props: {
  count: number;
  total?: number;
  isDark?: boolean;
}): JSX.Element {
  const ctx = useArcTheme();
  const pal = () => resolveArcPalette(resolveMode(props.isDark, ctx.mode()), ctx.accent());
  const totalSlots = () => Math.max(props.total ?? 6, Math.max(0, props.count));
  const indices = () => Array.from({ length: totalSlots() }, (_, i) => i);

  return (
    <View class="flex-row items-center gap-1 py-0.5">
      <For each={indices()}>
        {(idx) => {
          const filled = () => idx < props.count;
          return (
            <View
              class="w-[8] h-[8]"
              style={{
                bgColor: filled() ? pal().accent : pal().surfaceMuted,
                borderColor: filled() ? pal().accentStrong : pal().border,
                borderWidth: 1,
                radius: 3,
                hitPass: 1,
              }}
            />
          );
        }}
      </For>
    </View>
  );
}
