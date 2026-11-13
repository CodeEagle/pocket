/**
 * @pocket/looseleaf — Desk, Paper, Cards, Index Cards, Sticky Notes, Polaroids,
 * Notebooks, Receipts, Tickets, Envelopes, Folders & Fasteners.
 *
 * Implements Looseleaf Law #7 ("Only the sheet tilts, never the text; text sits
 * on real horizontal baselines"): `Paper` rotates only its background stock and
 * shadow layers while keeping its children aligned cleanly on horizontal axes.
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import { Focusable, Text, View, type ViewProps } from "@pocketjs/framework/solid/components";
import { ScrollContourItem } from "@pocket/ui";
import {
  accentColorOf,
  seedTilt,
  stockBackground,
  useLooseleafTheme,
  type LooseleafAccent,
  type LooseleafRule,
  type LooseleafStock,
} from "./tokens.ts";
import { Seal } from "./marks.tsx";

export type TapePlacement = "none" | "top" | "both" | "corner";
export type TapeKind = "masking" | "washi-yellow" | "washi-sky" | "washi-tomato" | "washi-grass";
export type FastenerKind = "none" | "clip" | "pin" | "staple" | "binder-clip";

/** Standalone translucent masking or colored washi tape strip (`og.png` top tape). */
export function Tape(props: {
  kind?: TapeKind;
  angle?: number;
  width?: number;
  height?: number;
  style?: ViewProps["style"];
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const fill = () => {
    const p = palette();
    switch (props.kind) {
      case "washi-yellow":
        return p.washiYellow;
      case "washi-sky":
        return p.washiSky;
      case "washi-tomato":
        return p.washiTomato;
      case "washi-grass":
        return p.washiGrass;
      case "masking":
      default:
        return p.tape;
    }
  };
  return (
    <Show when={density() !== "calm"}>
      <View
        class="items-center justify-center"
        style={{
          width: props.width ?? 58,
          height: props.height ?? 14,
          bgColor: fill(),
          borderColor: palette().tapeEdge,
          borderWidth: 1,
          radius: 2,
          rotate: props.angle ?? -1.8,
          hitPass: 1,
          ...(props.style ?? {}),
        }}
      />
    </Show>
  );
}

/** Stationery paper fastener (`clip`, `pin`, `staple`, or `binder-clip`). */
export function Fastener(props: {
  kind?: Exclude<FastenerKind, "none">;
  accent?: LooseleafAccent;
  style?: ViewProps["style"];
}): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const kind = () => props.kind ?? "clip";
  const pinColor = () => accentColorOf(palette(), props.accent ?? "tomato");
  return (
    <Show when={density() !== "calm"}>
      <Show when={kind() === "clip"}>
        <View
          class="w-[14] h-[32] items-center justify-center"
          style={{
            borderColor: palette().pencil,
            borderWidth: 2,
            radius: 7,
            rotate: 6,
            hitPass: 1,
            ...(props.style ?? {}),
          }}
        >
          <View
            class="w-[6] h-[18]"
            style={{
              borderColor: palette().ink,
              borderWidth: 1.5,
              radius: 3,
              hitPass: 1,
            }}
          />
        </View>
      </Show>
      <Show when={kind() === "pin"}>
        <View
          class="w-[15] h-[15] items-center justify-center"
          style={{
            bgColor: pinColor(),
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 8,
            hitPass: 1,
            ...(props.style ?? {}),
          }}
        >
          <View class="w-[4] h-[4]" style={{ bgColor: "#FFFDF6", radius: 2 }} />
        </View>
      </Show>
      <Show when={kind() === "staple"}>
        <View
          class="w-[18] h-[4]"
          style={{
            bgColor: palette().pencil,
            borderColor: palette().ink,
            borderWidth: 1,
            radius: 1,
            rotate: -24,
            hitPass: 1,
            ...(props.style ?? {}),
          }}
        />
      </Show>
      <Show when={kind() === "binder-clip"}>
        <View
          class="w-[34] h-[15] items-center justify-center"
          style={{
            bgColor: palette().ink,
            borderColor: palette().pencilMark,
            borderWidth: 1,
            radius: 2,
            hitPass: 1,
            ...(props.style ?? {}),
          }}
        >
          <View class="w-[14] h-[5]" style={{ borderColor: palette().paper, borderWidth: 1.5, radius: 2 }} />
        </View>
      </Show>
    </Show>
  );
}

/**
 * Cutting-mat / sage stationery desk backdrop (`--ll-desk: #A8C8BB`).
 * Clean cutting-mat grid hairlines let physical taped paper sheets stand out
 * with 1:1 fidelity to `kevintngo/looseleaf` (`public/og.png`).
 */
export function Desk(props: {
  objects?: boolean;
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette, clutter } = useLooseleafTheme();
  const showMatTicks = () => (props.objects ?? clutter()) === true;
  return (
    <View
      class="relative flex-col w-full gap-3.5 px-3.5 pt-3 pb-5"
      style={{ bgColor: palette().desk }}
    >
      {/* Subtle cutting-mat registration hairlines along top edge (zero layout bloat) */}
      <Show when={showMatTicks()}>
        <View
          class="flex-row items-center justify-between w-full px-1"
          style={{ opacity: 0.48 }}
        >
          <View class="flex-row items-center gap-2">
            <For each={[0, 1, 2, 3, 4, 5, 6]}>
              {(cm) => (
                <View
                  class="w-[1]"
                  style={{
                    height: cm % 2 === 0 ? 6 : 3,
                    bgColor: palette().inkSoft,
                  }}
                />
              )}
            </For>
          </View>
          <View class="flex-row items-center gap-2">
            <For each={[0, 1, 2, 3, 4]}>
              {(cm) => (
                <View
                  class="w-[1]"
                  style={{
                    height: cm % 2 === 0 ? 6 : 3,
                    bgColor: palette().inkSoft,
                  }}
                />
              )}
            </For>
          </View>
        </View>
      </Show>
      {props.children}
    </View>
  );
}

export interface PaperProps {
  stock?: LooseleafStock;
  rules?: LooseleafRule;
  tilt?: boolean | number;
  tape?: TapePlacement | false;
  tapeKind?: TapeKind;
  fastener?: FastenerKind | false;
  fastenerAccent?: LooseleafAccent;
  curl?: boolean;
  shadow?: "sheet" | "hard" | "none";
  seed?: string | number;
  paddingClass?: string;
  onPress?: () => void;
  children?: JSX.Element;
}

/**
 * Core Looseleaf `<Paper>` sheet (`--radius: 3px`, `1.5px` `#2A2420` ink border).
 * Only the sheet background & shadow tilt; foreground text stays horizontal!
 */
export function Paper(props: PaperProps): JSX.Element {
  const { palette, density } = useLooseleafTheme();
  const stockKind = () => props.stock ?? "paper";
  const bg = () => stockBackground(palette(), stockKind());
  const ruleKind = (): LooseleafRule => {
    if (props.rules !== undefined) return props.rules;
    if (stockKind() === "graph") return "graph";
    return "none";
  };
  const tiltDeg = () => {
    if (props.tilt === false) return 0;
    if (typeof props.tilt === "number") return density() === "calm" ? 0 : props.tilt;
    const max = ruleKind() === "none" ? 0.75 : 0.4;
    return seedTilt(props.seed ?? stockKind(), max, density());
  };
  const shadowMode = () => props.shadow ?? "sheet";
  const tapeMode = (): TapePlacement => (props.tape === false || props.tape === undefined ? "none" : props.tape);
  const fastenerMode = (): FastenerKind =>
    props.fastener === false || props.fastener === undefined ? "none" : props.fastener;

  const ruledLines = [0, 1, 2, 3, 4];

  const inner = (
    <ScrollContourItem class="relative flex-col w-full">
      {/* Offset warm umber / ink drop-shadow layer (`og.png` crisp sheet shadow) */}
      <Show when={shadowMode() !== "none"}>
        <View
          class="absolute inset-0"
          style={{
            insetL: shadowMode() === "hard" ? 3 : 2.5,
            insetT: shadowMode() === "hard" ? 4 : 3,
            insetR: shadowMode() === "hard" ? -3 : -2.5,
            insetB: shadowMode() === "hard" ? -4 : -3,
            bgColor: shadowMode() === "hard" ? palette().shadowHard : palette().shadowSheet,
            radius: 3,
            rotate: tiltDeg(),
            hitPass: 1,
          }}
        />
      </Show>

      {/* Tilted physical paper stock sheet (`--radius: 3px`) */}
      <View
        class="absolute inset-0 overflow-hidden"
        style={{
          bgColor: bg(),
          borderColor: palette().ink,
          borderWidth: density() === "calm" ? 1 : 1.5,
          radius: 3,
          rotate: tiltDeg(),
          hitPass: 1,
        }}
      >
        {/* Optional ruled / index / pad / ledger lines */}
        <Show
          when={
            ruleKind() === "ruled" ||
            ruleKind() === "ruled-hand" ||
            ruleKind() === "index" ||
            ruleKind() === "pad" ||
            ruleKind() === "ledger"
          }
        >
          <View class="absolute inset-0 flex-col justify-between py-5" style={{ hitPass: 1 }}>
            <Show when={ruleKind() === "index"}>
              <View class="w-full h-[2]" style={{ bgColor: palette().ruleRed, opacity: 0.72 }} />
            </Show>
            <For each={ruledLines}>
              {() => (
                <View
                  class="w-full h-[1]"
                  style={{
                    bgColor:
                      ruleKind() === "pad"
                        ? palette().padRule
                        : ruleKind() === "ledger"
                          ? palette().checkRule
                          : palette().ruleBlue,
                    opacity: 0.45,
                  }}
                />
              )}
            </For>
          </View>
          <Show when={ruleKind() === "ruled" || ruleKind() === "ruled-hand" || ruleKind() === "pad"}>
            <View
              class="absolute top-0 bottom-0 left-[26] w-[1.5]"
              style={{ bgColor: palette().ruleRed, opacity: 0.55, hitPass: 1 }}
            />
          </Show>
        </Show>

        {/* Graph paper horizontal + vertical `#7FA37C` grid lines */}
        <Show when={ruleKind() === "graph"}>
          <View class="absolute inset-0 flex-col justify-between py-3" style={{ hitPass: 1 }}>
            <For each={[0, 1, 2, 3, 4, 5, 6]}>
              {() => (
                <View class="w-full h-[1]" style={{ bgColor: palette().checkRule, opacity: 0.28 }} />
              )}
            </For>
          </View>
          <View class="absolute inset-0 flex-row justify-between px-4" style={{ hitPass: 1 }}>
            <For each={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}>
              {() => (
                <View class="h-full w-[1]" style={{ bgColor: palette().checkRule, opacity: 0.24 }} />
              )}
            </For>
          </View>
        </Show>

        {/* Optional curled bottom-right dog-ear */}
        <Show when={props.curl === true && density() !== "calm"}>
          <View
            class="absolute right-0 bottom-0 w-[14] h-[14]"
            style={{
              bgColor: palette().paperShade,
              borderColor: palette().ink,
              borderWidth: 1,
              radius: 2,
              hitPass: 1,
            }}
          />
        </Show>
      </View>

      {/* Untransformed content container so text sits on crisp horizontal baselines */}
      <View
        class={
          props.paddingClass ??
          (ruleKind() === "ruled" || ruleKind() === "ruled-hand"
            ? "relative flex-col gap-2.5 w-full pl-9 pr-3.5 py-3.5"
            : "relative flex-col gap-2.5 w-full p-3.5")
        }
      >
        {props.children}
      </View>

      {/* Top / Corner / Dual Masking Tape strips (`og.png` signature detail) */}
      <Show when={tapeMode() === "top"}>
        <View class="absolute top-[-7] left-0 right-0 items-center justify-center" style={{ hitPass: 1 }}>
          <Tape kind={props.tapeKind ?? "masking"} angle={-1.8} />
        </View>
      </Show>
      <Show when={tapeMode() === "corner"}>
        <View class="absolute top-[-4] left-[-7]" style={{ hitPass: 1 }}>
          <Tape kind={props.tapeKind ?? "masking"} width={46} height={13} angle={-32} />
        </View>
      </Show>
      <Show when={tapeMode() === "both"}>
        <View class="absolute top-[-4] left-[-7]" style={{ hitPass: 1 }}>
          <Tape kind={props.tapeKind ?? "masking"} width={44} height={13} angle={-32} />
        </View>
        <View class="absolute top-[-4] right-[-7]" style={{ hitPass: 1 }}>
          <Tape kind={props.tapeKind ?? "masking"} width={44} height={13} angle={30} />
        </View>
      </Show>

      {/* Fasteners */}
      <Show when={fastenerMode() !== "none"}>
        <View class="absolute top-[-9] right-[16]" style={{ hitPass: 1 }}>
          <Fastener
            kind={fastenerMode() as Exclude<FastenerKind, "none">}
            accent={props.fastenerAccent}
          />
        </View>
      </Show>
    </ScrollContourItem>
  );

  if (props.onPress) {
    return (
      <Focusable class="w-full" onPress={props.onPress}>
        {inner}
      </Focusable>
    );
  }
  return inner;
}

/** Drop-in shadcn-compatible `<Card>` built on `<Paper stock="card">` with top tape by default. */
export function Card(props: PaperProps & { title?: string; description?: string; action?: JSX.Element }): JSX.Element {
  const resolvedTape = (): TapePlacement | false => {
    if (props.tape !== undefined) return props.tape;
    if (props.fastener && props.fastener !== "none") return false;
    return "top";
  };
  return (
    <Paper
      stock={props.stock ?? "card"}
      rules={props.rules}
      tilt={props.tilt}
      tape={resolvedTape()}
      tapeKind={props.tapeKind}
      fastener={props.fastener}
      fastenerAccent={props.fastenerAccent}
      curl={props.curl}
      shadow={props.shadow ?? "hard"}
      seed={props.seed ?? props.title}
      paddingClass={props.paddingClass}
      onPress={props.onPress}
    >
      <Show when={Boolean(props.title || props.description || props.action)}>
        <CardHeader>
          <View class="flex-row items-start justify-between gap-2 w-full">
            <View class="flex-col gap-0.5 flex-1">
              <Show when={Boolean(props.title)}>
                <CardTitle text={props.title} />
              </Show>
              <Show when={Boolean(props.description)}>
                <CardDescription text={props.description} />
              </Show>
            </View>
            {props.action}
          </View>
        </CardHeader>
      </Show>
      {props.children}
    </Paper>
  );
}

export function CardHeader(props: { rule?: boolean; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-1 w-full">
      {props.children}
      <Show when={props.rule === true}>
        <View class="w-full h-[1] mt-1" style={{ bgColor: palette().pencilMark, opacity: 0.55 }} />
      </Show>
    </View>
  );
}

export function CardTitle(props: { text?: string; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
      {props.text ?? props.children}
    </Text>
  );
}

export function CardDescription(props: { text?: string; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Text class="text-xs" style={{ textColor: palette().pencilText }}>
      {props.text ?? props.children}
    </Text>
  );
}

export function CardAction(props: { children?: JSX.Element }): JSX.Element {
  return <View class="flex-row items-center gap-1.5 shrink-0">{props.children}</View>;
}

export function CardContent(props: { children?: JSX.Element }): JSX.Element {
  return <View class="flex-col gap-2.5 w-full">{props.children}</View>;
}

export function CardFooter(props: { rule?: boolean; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-2 w-full pt-1">
      <Show when={props.rule === true}>
        <View class="w-full h-[1]" style={{ bgColor: palette().pencilMark, opacity: 0.55 }} />
      </Show>
      <View class="flex-row items-center justify-between gap-2 w-full">{props.children}</View>
    </View>
  );
}

/**
 * Looseleaf `<IndexCard>` — 3×5 ruled index card with top red rule, blue body
 * rules, optional colored tab `flag`, stacked card backing, and serial footer.
 */
export function IndexCard(props: {
  title?: string;
  flag?: LooseleafAccent;
  serial?: string;
  page?: string;
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const flagColor = () => (props.flag ? accentColorOf(palette(), props.flag) : undefined);
  return (
    <View class="relative flex-col w-full">
      {/* Stacked second index card peeking underneath */}
      <View
        class="absolute left-[3] right-[-2] top-[4] bottom-[-3]"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().pencilMark,
          borderWidth: 1,
          radius: 3,
          rotate: 0.85,
          hitPass: 1,
        }}
      />
      <Show when={Boolean(flagColor())}>
        <View
          class="absolute right-[16] top-[-8] w-[34] h-[11]"
          style={{
            bgColor: flagColor()!,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 2,
            hitPass: 1,
          }}
        />
      </Show>
      <Paper stock="card" rules="index" shadow="hard" seed={props.seed ?? props.title ?? "index"}>
        <Show when={Boolean(props.title)}>
          <IndexCardHeader>
            <IndexCardTitle text={props.title} />
          </IndexCardHeader>
        </Show>
        <IndexCardContent>{props.children}</IndexCardContent>
        <Show when={Boolean(props.serial || props.page)}>
          <IndexCardFooter serial={props.serial ?? "no. 0007"} page={props.page ?? "p. 1"} />
        </Show>
      </Paper>
    </View>
  );
}

export function IndexCardHeader(props: { children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-1 w-full pb-0.5">
      {props.children}
      <View class="w-full h-[2]" style={{ bgColor: palette().ruleRed, opacity: 0.78 }} />
    </View>
  );
}

export function IndexCardTitle(props: { text?: string; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
      {props.text ?? props.children}
    </Text>
  );
}

export function IndexCardContent(props: { children?: JSX.Element }): JSX.Element {
  return <View class="flex-col gap-2 w-full">{props.children}</View>;
}

export function IndexCardFooter(props: { serial?: string; page?: string; children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-row items-center justify-between w-full pt-0.5">
      {props.children ?? (
        <>
          <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
            {props.serial ?? "no. 0001"}
          </Text>
          <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
            {props.page ?? "p. 1"}
          </Text>
        </>
      )}
    </View>
  );
}

/** Pastel adhesive `<StickyNote>` (`yellow`, `pink`, `green`, `orange`, `blue`). */
export function StickyNote(props: {
  color?: "yellow" | "pink" | "green" | "orange" | "blue";
  title?: string;
  pin?: boolean;
  seed?: string | number;
  onPress?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const stock = (): LooseleafStock => {
    switch (props.color) {
      case "pink":
        return "sticky-pink";
      case "green":
        return "sticky-green";
      case "orange":
        return "sticky-orange";
      case "blue":
        return "sticky-blue";
      case "yellow":
      default:
        return "sticky-yellow";
    }
  };
  return (
    <Paper
      stock={stock()}
      curl
      fastener={props.pin ? "pin" : false}
      tilt={seedTilt(props.seed ?? props.title ?? "sticky", 1.4)}
      shadow="sheet"
      seed={props.seed}
      onPress={props.onPress}
    >
      <Show when={Boolean(props.title)}>
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
      </Show>
      {props.children}
    </Paper>
  );
}

/** Instant `<Polaroid>` photo frame with thick `#FFFDF6` bottom caption margin. */
export function Polaroid(props: {
  caption: string;
  date?: string;
  tape?: TapePlacement;
  seed?: string | number;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper
      stock="photo"
      tape={props.tape ?? "top"}
      tapeKind="washi-yellow"
      shadow="hard"
      seed={props.seed ?? props.caption}
      paddingClass="relative flex-col gap-2 w-full p-2.5 pb-3.5"
    >
      <View
        class="w-full min-h-[84] p-2.5 items-center justify-center overflow-hidden"
        style={{
          bgColor: palette().paperShade,
          borderColor: palette().ink,
          borderWidth: 1.5,
          radius: 2,
        }}
      >
        {props.children}
      </View>
      <View class="flex-row items-center justify-between px-1 pt-0.5">
        <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
          {props.caption}
        </Text>
        <Show when={Boolean(props.date)}>
          <Text class="text-2xs" style={{ textColor: palette().pencilText }}>
            {props.date}
          </Text>
        </Show>
      </View>
    </Paper>
  );
}

/** Spiral wire-bound `<Notebook>` sheet with left coil rings and ruled lines. */
export function Notebook(props: {
  title?: string;
  subtitle?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const rings = [0, 1, 2, 3, 4, 5];
  return (
    <View class="relative flex-row items-stretch w-full">
      {/* Spiral wire rings */}
      <View class="flex-col justify-around py-3 z-10 mr-[-6] shrink-0">
        <For each={rings}>
          {() => (
            <View
              class="w-[14] h-[8]"
              style={{
                bgColor: palette().paperShade,
                borderColor: palette().ink,
                borderWidth: 2,
                radius: 4,
              }}
            />
          )}
        </For>
      </View>
      <View class="flex-1">
        <Paper stock="pad" rules="ruled" shadow="hard" tilt={false}>
          <Show when={Boolean(props.title)}>
            <View class="flex-row items-center justify-between w-full">
              <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
                {props.title}
              </Text>
              <Show when={Boolean(props.subtitle)}>
                <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
                  {props.subtitle}
                </Text>
              </Show>
            </View>
          </Show>
          {props.children}
        </Paper>
      </View>
    </View>
  );
}

/** Document `<Page>` header + content layout matching Looseleaf docs pages. */
export function Page(props: {
  kicker?: string;
  title: string;
  description?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col gap-3.5 w-full">
      <Paper stock="paper" tape="both" shadow="hard" tilt={false}>
        <Show when={Boolean(props.kicker)}>
          <Text class="text-xs font-mono font-bold" style={{ textColor: palette().marker }}>
            {props.kicker}
          </Text>
        </Show>
        <Text class="text-2xl font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Show when={Boolean(props.description)}>
          <Text class="text-sm" style={{ textColor: palette().inkSoft }}>
            {props.description}
          </Text>
        </Show>
        <Show when={Boolean(props.actions)}>
          <View class="flex-row flex-wrap items-center gap-2 pt-1">{props.actions}</View>
        </Show>
      </Paper>
      {props.children}
    </View>
  );
}

/** Itemized `<Receipt>` slip with perforated top/bottom edge and monospace totals. */
export function Receipt(props: {
  store?: string;
  items: readonly { label: string; value: string }[];
  totalLabel?: string;
  totalValue: string;
  footer?: string;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const teeth = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return (
    <Paper stock="slip" shadow="sheet" tilt={-0.5} paddingClass="relative flex-col gap-2 w-full px-4 py-3">
      <View class="flex-row justify-between w-full pb-1">
        <For each={teeth}>
          {() => <View class="w-[8] h-[3]" style={{ bgColor: palette().desk, radius: 1 }} />}
        </For>
      </View>
      <Text class="text-sm font-mono font-bold text-center" style={{ textColor: palette().ink }}>
        {props.store ?? "LOOSELEAF STATIONERY CO."}
      </Text>
      <View class="w-full h-[1]" style={{ bgColor: palette().pencilMark }} />
      <For each={props.items}>
        {(row) => (
          <View class="flex-row items-center justify-between w-full">
            <Text class="text-xs font-mono" style={{ textColor: palette().inkSoft }}>
              {row.label}
            </Text>
            <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
              {row.value}
            </Text>
          </View>
        )}
      </For>
      <View class="w-full h-[1.5]" style={{ bgColor: palette().ink }} />
      <View class="flex-row items-center justify-between w-full">
        <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
          {props.totalLabel ?? "TOTAL"}
        </Text>
        <Text class="text-sm font-mono font-bold" style={{ textColor: palette().red }}>
          {props.totalValue}
        </Text>
      </View>
      <Show when={Boolean(props.footer)}>
        <Text class="text-xs font-mono text-center" style={{ textColor: palette().pencilText }}>
          {props.footer}
        </Text>
      </Show>
    </Paper>
  );
}

/** Perforated stub `<Ticket>` with serial number and accent tint. */
export function Ticket(props: {
  title: string;
  subtitle?: string;
  stub: string;
  accent?: LooseleafAccent;
  onPress?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const tint = () => accentColorOf(palette(), props.accent ?? "hi");
  return (
    <Paper
      stock="card"
      shadow="hard"
      onPress={props.onPress}
      paddingClass="relative flex-row items-stretch w-full overflow-hidden"
    >
      <View class="w-[10] shrink-0" style={{ bgColor: tint() }} />
      <View class="flex-col gap-0.5 p-3 flex-1">
        <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
          {props.title}
        </Text>
        <Show when={Boolean(props.subtitle)}>
          <Text class="text-xs" style={{ textColor: palette().pencilText }}>
            {props.subtitle}
          </Text>
        </Show>
      </View>
      <View class="w-[1.5] my-2" style={{ bgColor: palette().pencilMark }} />
      <View class="px-3 py-2 items-center justify-center shrink-0" style={{ bgColor: palette().paperShade }}>
        <Text class="text-xs font-mono font-bold" style={{ textColor: palette().inkYou }}>
          {props.stub}
        </Text>
      </View>
    </Paper>
  );
}

/** Kraft `<Envelope>` with flap rule and wax `<Seal>`. */
export function Envelope(props: {
  to: string;
  from?: string;
  sealLabel?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="kraft" shadow="hard" seed={props.to}>
      <View class="flex-row items-start justify-between w-full">
        <View class="flex-col gap-0.5">
          <Show when={Boolean(props.from)}>
            <Text class="text-xs font-mono" style={{ textColor: palette().inkSoft }}>
              {`FROM: ${props.from}`}
            </Text>
          </Show>
          <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
            {`TO: ${props.to}`}
          </Text>
        </View>
        <Seal label={props.sealLabel ?? "LL"} size={36} />
      </View>
      {props.children}
    </Paper>
  );
}

/** Tabbed manila `<Folder>` container. */
export function Folder(props: {
  tabLabel: string;
  accent?: LooseleafAccent;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="flex-col w-full">
      <View class="flex-row items-end">
        <View
          class="px-3.5 py-1 flex-row items-center gap-1.5"
          style={{
            bgColor: palette().kraft,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 3,
          }}
        >
          <Show when={Boolean(props.accent)}>
            <View
              class="w-[8] h-[8]"
              style={{ bgColor: accentColorOf(palette(), props.accent), radius: 4 }}
            />
          </Show>
          <Text class="text-xs font-bold" style={{ textColor: palette().ink }}>
            {props.tabLabel}
          </Text>
        </View>
      </View>
      <Paper stock="pad" shadow="hard" tilt={false}>
        {props.children}
      </Paper>
    </View>
  );
}

/** Pinned `<Corkboard>` surface for sticky notes and polaroids. */
export function Corkboard(props: {
  title?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View
      class="flex-col gap-3 w-full p-3.5"
      style={{
        bgColor: palette().kraft,
        borderColor: palette().ink,
        borderWidth: 2,
        radius: 4,
      }}
    >
      <Show when={Boolean(props.title)}>
        <View class="flex-row items-center justify-between">
          <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
            {props.title}
          </Text>
          <Fastener kind="pin" accent="tomato" />
        </View>
      </Show>
      {props.children}
    </View>
  );
}

/** Backing `<Clipboard>` with top centered metallic binder clip. */
export function Clipboard(props: {
  title?: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <View class="relative flex-col w-full pt-2">
      <View
        class="p-2.5 flex-col gap-2 w-full"
        style={{
          bgColor: palette().kraft,
          borderColor: palette().ink,
          borderWidth: 2,
          radius: 4,
        }}
      >
        <View class="items-center justify-center mt-[-12]">
          <Fastener kind="binder-clip" />
        </View>
        <Paper stock="slip" rules="ruled" tilt={false} shadow="sheet">
          <Show when={Boolean(props.title)}>
            <Text class="text-base font-bold" style={{ textColor: palette().ink }}>
              {props.title}
            </Text>
          </Show>
          {props.children}
        </Paper>
      </View>
    </View>
  );
}

/** Embossed cocktail sketch `<Napkin>`. */
export function Napkin(props: { children?: JSX.Element }): JSX.Element {
  const { palette } = useLooseleafTheme();
  return (
    <Paper stock="photo" tilt={1.1} shadow="sheet">
      <View
        class="p-2.5 flex-col gap-2 w-full"
        style={{ borderColor: palette().pencilMark, borderWidth: 1, radius: 3 }}
      >
        {props.children}
      </View>
    </Paper>
  );
}

/** Interactive tap-to-flip `<FlipCard>` with front and back paper faces. */
export function FlipCard(props: {
  front: JSX.Element;
  back: JSX.Element;
  flipped?: boolean;
  onFlip?: (flipped: boolean) => void;
}): JSX.Element {
  const [internalFlipped, setInternalFlipped] = createSignal(false);
  const isFlipped = () => (props.flipped !== undefined ? props.flipped : internalFlipped());
  const toggle = () => {
    const next = !isFlipped();
    setInternalFlipped(next);
    props.onFlip?.(next);
  };
  return (
    <Paper stock={isFlipped() ? "graph" : "card"} tape="corner" shadow="hard" onPress={toggle}>
      <Show when={!isFlipped()} fallback={props.back}>
        {props.front}
      </Show>
    </Paper>
  );
}

/** Interactive `<PeelCorner>` card revealing a secret note underneath. */
export function PeelCorner(props: {
  revealText: string;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [peeled, setPeeled] = createSignal(false);
  return (
    <Paper stock="card" curl shadow="hard" onPress={() => setPeeled((p) => !p)}>
      {props.children}
      <View class="flex-row items-center justify-end pt-1">
        <Text class="text-xs font-mono font-bold" style={{ textColor: palette().inkYou }}>
          {peeled() ? `↳ ${props.revealText}` : "↗ Tap corner to peel"}
        </Text>
      </View>
    </Paper>
  );
}

/** Perforated `<TearOff>` note with detachable bottom coupon/tab. */
export function TearOff(props: {
  stubLabel: string;
  onTear?: () => void;
  children?: JSX.Element;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const [torn, setTorn] = createSignal(false);
  return (
    <View class="flex-col w-full gap-1">
      <Paper stock="slip" shadow="sheet" tilt={false}>
        {props.children}
      </Paper>
      <Show when={!torn()}>
        <Focusable
          class="flex-row items-center justify-between px-4 py-2 w-full"
          style={{
            bgColor: palette().stickyYellow,
            borderColor: palette().ink,
            borderWidth: 1.5,
            radius: 3,
          }}
          onPress={() => {
            setTorn(true);
            props.onTear?.();
          }}
        >
          <Text class="text-xs font-mono font-bold" style={{ textColor: "#2A2420" }}>
            {`✂ ${props.stubLabel}`}
          </Text>
          <Text class="text-xs font-mono" style={{ textColor: "#2A2420" }}>
            TEAR OFF
          </Text>
        </Focusable>
      </Show>
    </View>
  );
}

/** Decorative `<Ribbon>` banner header. */
export function Ribbon(props: {
  label: string;
  accent?: LooseleafAccent;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const fill = () => accentColorOf(palette(), props.accent ?? "marker");
  return (
    <View
      class="px-3.5 py-1 flex-row items-center justify-center"
      style={{
        bgColor: fill(),
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 3,
        rotate: -1,
      }}
    >
      <Text class="text-xs font-bold tracking-wide" style={{ textColor: "#2A2420" }}>
        {props.label}
      </Text>
    </View>
  );
}

/** Page-edge `<Bookmark>` ribbon tab. */
export function Bookmark(props: {
  label?: string;
  accent?: LooseleafAccent;
  active?: boolean;
  onPress?: () => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();
  const fill = () => accentColorOf(palette(), props.accent ?? "tomato");
  const node = (
    <View
      class="px-2.5 py-1.5 items-center justify-center"
      style={{
        bgColor: props.active === false ? palette().paperShade : fill(),
        borderColor: palette().ink,
        borderWidth: 1.5,
        radius: 3,
      }}
    >
      <Text
        class="text-2xs font-bold"
        style={{ textColor: props.active === false ? palette().ink : "#FFFDF6" }}
      >
        {props.label ?? "★"}
      </Text>
    </View>
  );
  return props.onPress ? <Focusable onPress={props.onPress}>{node}</Focusable> : node;
}
