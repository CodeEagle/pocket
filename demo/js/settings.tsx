import { Show, createSignal, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  MobileAlert,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileDialog,
  MobileListTile,
  MobileSegmentedControl,
  ScrollablePage,
  useMobileTheme,
  toMobileColor,
} from "@pocket/ui";
import { version } from "./package.json";
import type { AccentColor, DemoEvent, DemoState, InterfaceDensity } from "./state.ts";

type Appearance = { dark: boolean; accent: AccentColor; density: InterfaceDensity };

/** Only recognized preferences cross the persisted-data boundary. */
export function readAppearance(value: unknown): Appearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  return {
    dark: record.dark === true,
    accent: record.accent === "violet" || record.accent === "teal" || record.accent === "rose" ? record.accent : "blue",
    density: record.density === "touch" || record.density === "desktop" ? record.density : "auto",
  };
}

export function storedAppearance(state: DemoState): Appearance & { version: number } {
  return { version: 1, dark: state.mobileDark, accent: state.accentColor, density: state.interfaceDensity };
}

export function SettingsPage(props: {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  ready: () => boolean;
  status: () => string;
}): JSX.Element {
  const theme = useMobileTheme();
  const [resetOpen, setResetOpen] = createSignal(false);
  return (
    <ScrollablePage>
      <View class="flex-col gap-4 p-4 pb-6">

        <Show when={props.ready()} fallback={<MobileAlert title="Loading preferences" body="Getting your saved appearance from this device." tone="info" />}>
          <MobileCard title="Appearance" detail="Choose how Pocket looks, everywhere.">
            <Text class={theme().name === "dark" ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>Theme</Text>
            <MobileSegmentedControl
              items={[{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }]}
              active={props.state().mobileDark ? "dark" : "light"}
              onChange={(id) => props.dispatch({ type: "setMobileDark", value: id === "dark" })}
            />
            <Text class={theme().name === "dark" ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>Accent color</Text>
            <MobileSegmentedControl
              accentActive
              items={[{ id: "blue", label: "Blue" }, { id: "violet", label: "Violet" }, { id: "teal", label: "Teal" }, { id: "rose", label: "Rose" }]}
              active={props.state().accentColor}
              onChange={(id) => props.dispatch({ type: "setAccentColor", value: id as AccentColor })}
            />
            <View
              class={
                theme().name === "dark"
                  ? "flex-row items-center justify-between gap-3 p-3 rounded-xl bg-[#09090B] border-[#27272A]"
                  : "flex-row items-center justify-between gap-3 p-3 rounded-xl bg-[#FAFAFA] border-[#E4E4E7]"
              }
              style={{ radius: 12, borderWidth: 1 }}
            >
              <View
                class="w-[4] h-[36] rounded-full"
                style={{ radius: 2, bgColor: toMobileColor(theme().accentColor) }}
              />
              <View class="flex-col gap-1 flex-1">
                <Text class={theme().name === "dark" ? "text-sm font-bold text-[#FAFAFA]" : "text-sm font-bold text-[#09090B]"}>Your Pocket, your palette</Text>
                <Text class={theme().name === "dark" ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>Changes appear as you choose.</Text>
              </View>
              <MobileBadge label="PREVIEW" tone="accent" />
            </View>
          </MobileCard>
          <MobileCard title="Interface density" detail="Automatic adapts to your window size.">
            <MobileSegmentedControl
              items={[{ id: "auto", label: "Automatic" }, { id: "touch", label: "Comfortable" }, { id: "desktop", label: "Compact" }]}
              active={props.state().interfaceDensity}
              onChange={(id) => props.dispatch({ type: "setInterfaceDensity", value: id as InterfaceDensity })}
            />
          </MobileCard>
          <MobileCard title="Your preferences">
            <MobileListTile title="Device storage" detail={props.status()} />
            <MobileButton label="Reset appearance" kind="outlined" onPress={() => setResetOpen(true)} />
          </MobileCard>
        </Show>
        <MobileCard title="About Pocket" detail="An interactive collection of components, motion and device experiences.">
          <MobileListTile title="Version" detail={version} trailing={<MobileBadge label="SHOWCASE" tone="neutral" />} />
          <MobileListTile title="Device capabilities" detail="Camera, photos, location and other device features ask for access when you use them." />
          <MobileButton label="Explore device capabilities" kind="text" onPress={() => props.dispatch({ type: "navigate", route: "hardware" })} />
        </MobileCard>
        <MobileDialog
          open={resetOpen()}
          title="Reset appearance?"
          body="Restore the light theme, blue accent and automatic density. Your other data stays on this device."
          confirmLabel="Reset"
          onConfirm={() => {
            props.dispatch({ type: "resetAppearance" });
            setResetOpen(false);
          }}
          onClose={() => setResetOpen(false)}
        />
      </View>
    </ScrollablePage>
  );
}
