/** Guest app source for the shared-component native tests (written into a buildGuest project as app.tsx). */
export function sharedComponentsApp(): string {
  return `
import { mount } from "@pocketjs/framework/solid";
import { View, Text } from "@pocketjs/framework/solid/components";
import { createSignal } from "solid-js";
import { Tree } from "@pocket/ui/tree";
import { toggled } from "@pocket/ui/tree-model";
import { SplitPane } from "@pocket/ui/split-pane";
import { TabsBar } from "@pocket/ui/tabs";
import { ToastHost } from "@pocket/ui/toast-host";
import { subscribeHostEvents } from "@pocket/ui/display";

const emit = (name: string, payload: any) => (globalThis as any).pocket._emitValue({ type: "event", name, payload });
const files = [
  { path: "app.tsx", bytes: 1 }, { path: "src/b.ts", bytes: 2 }, { path: "src/a.ts", bytes: 3 },
  { path: "src/deep/c.ts", bytes: 4 }, { path: "manifest.json", bytes: 5 },
];
const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
const [selected, setSelected] = createSignal<string | undefined>(undefined);
const [size, setSize] = createSignal(200);
const [ended, setEnded] = createSignal(0);
const [tabs, setTabs] = createSignal([{ id: "a", label: "tab-a" }, { id: "b", label: "tab-b", dirty: true }, { id: "c", label: "tab-c" }]);
const [active, setActive] = createSignal<string | undefined>("a");
const [toasts, setToasts] = createSignal([{ id: 1, tone: "info" as const, message: "TOAST_ONE" }, { id: 2, tone: "danger" as const, message: "TOAST_TWO" }]);
subscribeHostEvents((ev: any) => {
  if (ev.method === "test.dump") emit("sc.dump", { size: size(), ended: ended(), selected: selected(), expanded: [...expanded()], tabs: tabs().map(t => t.id), active: active(), toasts: toasts().map(t => t.id) });
});
mount(() => <View class="w-full h-full flex-col" style={{ width: 600, height: 500 }}>
  <TabsBar tabs={tabs()} active={active()} onActivate={(id) => setActive(id)} onClose={(id) => setTabs(tabs().filter(t => t.id !== id))} />
  <SplitPane size={size()} min={100} max={400} onResize={setSize} onResizeEnd={(w) => { setEnded(ended() + 1); emit("sc.end", { size: w }); }}
    first={<Tree files={files} directories={["empty/inner"]} expanded={expanded()} selected={selected()} marked={new Set(["src/a.ts"])}
      onOpenFile={(p) => { setSelected(p); emit("sc.open", { path: p }); }} onToggleFolder={(p) => setExpanded(toggled(expanded(), p))} />}
    second={<View class="flex-col flex-1"><Text class="text-sm">RIGHT_PANE</Text></View>} />
  <ToastHost items={toasts()} onDismiss={(id) => setToasts(toasts().filter(t => t.id !== id))} />
</View>);
`;
}
