import { For, Show, createSignal, useContext, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  AppleDraggableGlass,
  AppleGlassButton,
  AppleGlassNavigationBar,
  AppleGlassToolbar,
  MobileButton,
  SafeAreaScaffoldContext,
  ScrollablePage,
  useMobileTheme,
  type NavigationItem,
} from "@pocket/ui";

const appleTabs: readonly NavigationItem[] = [
  { id: "overview", label: "Overview", kind: "home" },
  { id: "focus", label: "Focus", kind: "gallery" },
  { id: "notes", label: "Notes", kind: "host" },
];

const focusRows = [
  { id: "morning", title: "Morning focus", detail: "25 minutes · Today" },
  { id: "archive", title: "Open the archive", detail: "Review yesterday's notes" },
  { id: "walk", title: "Take a short walk", detail: "A reset between ideas" },
  { id: "plan", title: "Plan tomorrow", detail: "Three clear next actions" },
];

function DotIcon(props: { color?: string }): JSX.Element {
  return <View class="w-[12] h-[12] rounded-full" style={{ bgColor: props.color ?? "#FFFFFFCC" }} />;
}
function ActionRow(props: {
  title: string;
  detail: string;
  selected: boolean;
  dark: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <View
      class={props.dark
        ? "flex-row items-center gap-3 w-full min-h-[64] p-3 rounded-[16] bg-[#15233ACC] border-[#2D4267]"
        : "flex-row items-center gap-3 w-full min-h-[64] p-3 rounded-[16] bg-[#FFFFFFCC] border-[#D9E1EF]"}
      style={{ borderWidth: props.selected ? 2 : 1 }}
    >
      <View class="w-[10] h-[10] rounded-full" style={{ bgColor: props.selected ? "#315DEB" : props.dark ? "#7E94BB" : "#A6B4C8" }} />
      <View class="flex-col gap-1 flex-1 overflow-hidden" style={{ minW: 0 }}>
        <Text class="text-sm font-bold" style={{ textColor: props.dark ? "#F8FAFC" : "#152238" }}>{props.title}</Text>
        <Text class="text-sm" style={{ textColor: props.dark ? "#B9C5D8" : "#66758A" }}>{props.detail}</Text>
      </View>
      <MobileButton
        label={props.selected ? "Done" : "Open"}
        kind={props.selected ? "filled" : "text"}
        compact
        onPress={props.onPress}
      />
    </View>
  );
}

/**
 * The independent Apple Glass route. It keeps three sparse glass surfaces—a
 * toolbar, capsule navigation overlay, and one standalone action—while the
 * page below is ordinary content over a deliberately varied backdrop so
 * scrolling changes what the glass samples. The main Showcase NavigationBar
 * is untouched on this secondary route and the host app bar supplies the
 * existing back affordance.
 */
export function ApplePage(): JSX.Element {
  const theme = useMobileTheme();
  const scaffold = useContext(SafeAreaScaffoldContext);
  const [activeTab, setActiveTab] = createSignal("overview");
  const [quiet, setQuiet] = createSignal(false);
  const [selectedRow, setSelectedRow] = createSignal("morning");
  const [lastAction, setLastAction] = createSignal("Ready");
  const dark = () => theme().name === "dark";
  // The secondary Showcase route is already inside the root scaffold's
  // consumed bottom inset. Pass that policy explicitly; reusable Apple bars
  // keep the caller's geometry untouched for standalone consumers.
  const barGeometry = () => {
    const current = scaffold.geometry();
    return { ...current, safeArea: { ...current.safeArea, bottom: 0 } };
  };
  const selectTab = (id: string): void => {
    setActiveTab(id);
    setLastAction(id === "overview" ? "Overview selected" : id === "focus" ? "Focus selected" : "Notes selected");
  };
  const selectRow = (id: string): void => {
    setSelectedRow(id);
    setLastAction("Updated");
  };
  return (
    <View class="relative flex-1 w-full overflow-hidden" style={{ bgColor: dark() ? 0xff0e1728 : 0xfff4f7ff }}>
      <ScrollablePage class="flex-1 w-full overflow-hidden">
        <View class="relative flex-col w-full min-h-[1180] overflow-hidden">
          <View
            class="absolute inset-0"
            style={{
              gradFrom: dark() ? 0xff10223b : 0xfff2f6ff,
              gradTo: dark() ? 0xff24132d : 0xfffff5ea,
              gradDir: 1,
            }}
          />
          <View class={dark() ? "absolute left-[-48] top-[92] w-[260] h-[260] rounded-full bg-[#304C83] opacity-60" : "absolute left-[-48] top-[92] w-[260] h-[260] rounded-full bg-[#C7D8FF] opacity-80"} style={{ rotate: -12 }} />
          <View class={dark() ? "absolute right-[-88] top-[340] w-[280] h-[280] rounded-full bg-[#733F69] opacity-55" : "absolute right-[-88] top-[340] w-[280] h-[280] rounded-full bg-[#FFD7CF] opacity-80"} style={{ rotate: 18 }} />
          <View class={dark() ? "absolute left-[52] top-[760] w-[330] h-[190] rounded-[76] bg-[#17604F] opacity-40" : "absolute left-[52] top-[760] w-[330] h-[190] rounded-[76] bg-[#C7F0E3] opacity-80"} style={{ rotate: -8 }} />

          <View class="relative flex-col gap-4 w-full p-4 pt-[78] pb-[152]">
            <View class={dark() ? "flex-col gap-2 p-4 rounded-[24] bg-[#111D32DD] border-[#2D3D5A]" : "flex-col gap-2 p-4 rounded-[24] bg-[#FFFFFFCC] border-[#DCE3F0]"}>
              <Text class="text-xs font-bold" style={{ textColor: dark() ? "#9EB8F2" : "#315DEB" }}>TODAY · 09:41</Text>
              <Text class="text-2xl font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>Make room for what matters.</Text>
              <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>A calm, focused space for the next small thing.</Text>
              <View class="flex-row items-center gap-2 pt-2">
                <View class="w-[7] h-[7] rounded-full bg-[#30C99A]" />
                <Text class="text-sm font-bold" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>{lastAction()}</Text>
              </View>
            </View>

            <AppleGlassButton
              label="Add a focus block"
              icon={<DotIcon color="#315DEB" />}
              onPress={() => setLastAction("Focus block added")}
            />

            <View class={dark() ? "flex-col gap-2 p-3 rounded-[24] bg-[#111D32CC] border-[#2D3D5A]" : "flex-col gap-2 p-3 rounded-[24] bg-[#FFFFFFCC] border-[#DCE3F0]"}>
              <Text class="text-sm font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>A little movement</Text>
              <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>Drag the glass card, then let it settle back into place.</Text>
              <View class="relative w-full h-[132] flex-row items-center justify-center overflow-hidden rounded-[20]" style={{ radius: 20, bgColor: dark() ? 0xff243756 : 0xffe8efff }}>
                <View class="absolute left-[-18] top-[18] w-[180] h-[96] rounded-full" style={{ bgColor: dark() ? 0xff365d9e : 0xffbfd2ff, opacity: 0.8, rotate: -12 }} />
                <View class="absolute right-[-10] bottom-[-28] w-[176] h-[104] rounded-full" style={{ bgColor: dark() ? 0xff7c456e : 0xffffcfc6, opacity: 0.75, rotate: 12 }} />
                <AppleDraggableGlass
                  class="w-[176] h-[68] flex-col items-center justify-center"
                  maxX={Math.max(16, Math.min(64, ((scaffold.geometry().width || 375) - 232) / 2 - 12))}
                  maxY={20}
                >
                  <Text class="text-sm font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>Drag the glass</Text>
                </AppleDraggableGlass>
              </View>
            </View>

            <Show when={activeTab() === "overview"}>
              <View class="flex-col gap-3">
                <View class="flex-row gap-3">
                  <View class={dark() ? "flex-1 flex-col gap-1 p-3 rounded-[16] bg-[#15233ACC] border-[#2D4267]" : "flex-1 flex-col gap-1 p-3 rounded-[16] bg-[#FFFFFFCC] border-[#D9E1EF]"}>
                    <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>Focus streak</Text>
                    <Text class="text-xl font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>04:28</Text>
                  </View>
                  <View class={dark() ? "flex-1 flex-col gap-1 p-3 rounded-[16] bg-[#15233ACC] border-[#2D4267]" : "flex-1 flex-col gap-1 p-3 rounded-[16] bg-[#FFFFFFCC] border-[#D9E1EF]"}>
                    <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>Tasks clear</Text>
                    <Text class="text-xl font-bold" style={{ textColor: "#315DEB" }}>12</Text>
                  </View>
                </View>
                <For each={focusRows}>{(row) => (
                  <ActionRow title={row.title} detail={row.detail} dark={dark()} selected={selectedRow() === row.id} onPress={() => selectRow(row.id)} />
                )}</For>
              </View>
            </Show>

            <Show when={activeTab() === "focus"}>
              <View class={dark() ? "flex-col gap-3 p-4 rounded-[24] bg-[#111D32DD] border-[#2D3D5A]" : "flex-col gap-3 p-4 rounded-[24] bg-[#FFFFFFCC] border-[#DCE3F0]"}>
                <Text class="text-lg font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>Focus controls</Text>
                <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>Keep the next action visible and let the rest wait.</Text>
                <ActionRow title="Quiet mode" detail="Reduce interruptions" dark={dark()} selected={quiet()} onPress={() => { setQuiet(true); setLastAction("Quiet mode on"); }} />
                <ActionRow title="Open mode" detail="Keep everything in view" dark={dark()} selected={!quiet()} onPress={() => { setQuiet(false); setLastAction("Quiet mode off"); }} />
              </View>
            </Show>

            <Show when={activeTab() === "notes"}>
              <View class={dark() ? "flex-col gap-3 p-4 rounded-[24] bg-[#111D32DD] border-[#2D3D5A]" : "flex-col gap-3 p-4 rounded-[24] bg-[#FFFFFFCC] border-[#DCE3F0]"}>
                <Text class="text-lg font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>Notes</Text>
                <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>A few words are enough. Keep the surface quiet and the content clear.</Text>
                <MobileButton label="Save note" onPress={() => setLastAction("Note saved")} />
              </View>
            </Show>

            <View class={dark() ? "flex-col gap-2 p-4 rounded-[16] bg-[#0B1425DD] border-[#243454]" : "flex-col gap-2 p-4 rounded-[16] bg-[#FFFDF9DD] border-[#EBDCCF]"}>
              <Text class="text-sm font-bold" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>A little further down</Text>
              <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>Scroll to keep exploring. Your next small step is waiting below.</Text>
            </View>
            <For each={["A clear next step", "A quiet pause", "A note worth keeping"]}>{(label) => (
              <View class={dark() ? "min-h-[112] flex-col justify-center gap-2 p-4 rounded-[24] bg-[#172944CC] border-[#2D4267]" : "min-h-[112] flex-col justify-center gap-2 p-4 rounded-[24] bg-[#FFFFFFCC] border-[#D9E1EF]"}>
                <Text class="text-lg font-bold" style={{ textColor: dark() ? "#F8FAFC" : "#152238" }}>{label}</Text>
                <Text class="text-sm" style={{ textColor: dark() ? "#B9C5D8" : "#66758A" }}>A little space to think, then one clear next step.</Text>
              </View>
            )}</For>
          </View>
        </View>
      </ScrollablePage>

      <View class="absolute left-4 right-4 top-3">
        <AppleGlassToolbar
          title="Liquid Glass"
          subtitle="A calm layer over your day"
          leading={<View class="w-[34] h-[34] items-center justify-center rounded-full bg-[#FFFFFF66]"><DotIcon /></View>}
          actions={() => (
          <AppleGlassButton
            label={quiet() ? "Quiet" : "Active"}
            selected={quiet()}
            onPress={() => { setQuiet((value) => !value); setLastAction(quiet() ? "Active mode" : "Quiet mode on"); }}
          />
          )}
        />
      </View>
      <View class="absolute left-0 right-0 bottom-3 items-center">
        <AppleGlassNavigationBar
          items={appleTabs}
          active={activeTab()}
          onChange={selectTab}
          dark={dark()}
          geometry={barGeometry}
        />
      </View>
    </View>
  );
}
