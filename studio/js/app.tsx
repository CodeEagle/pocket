// Studio shell: rail + the active page + global overlays. Pages, state and
// components live under src/; this file only composes them.
import { Show, onCleanup } from "solid-js";
import { MOBILE_THEME_DARK, MobileThemeProvider, deliverTextInputEvent } from "@pocket/ui";
import { createHostBridge, type HostBridge } from "@pocket/ui/host";
import { createPocketStreamAdapter } from "@pocket/ui/streams";
import { createPocketClipboardClient } from "@pocket/ui/clipboard";
import { mount } from "@pocketjs/framework/solid";
import { onTextEvent } from "@pocketjs/framework/input";
import { Screen, View } from "@pocketjs/framework/solid/components";
import { createStudioClient } from "./src/studio-client.ts";
import { createStudio, type Studio } from "./src/state/studio.ts";
import { createSystemLink } from "./src/state/system-link.ts";
import { createUpdateLink } from "./src/state/update-link.ts";
import { guestTimers, yieldTurn } from "./src/ui/guest-env.ts";
import { fromStore, select } from "./src/ui/bind.ts";
import { Rail } from "./src/components/rail.tsx";
import { ToastHost } from "@pocket/ui/toast-host";
import { QuickOpenOverlay } from "./src/components/quick-open.tsx";
import { DialogHost } from "./src/components/dialog-host.tsx";
import { CreateProjectDialog } from "./src/pages/projects.tsx";
import { pages } from "./src/pages/index.tsx";

function Shell(props: { studio: Studio; host: HostBridge }) {
  const page = select(props.studio.nav, (n) => n.page);
  const toastState = fromStore(props.studio.toasts.store);
  // The Flutter text overlay answers InputField sessions with textInput.* events; route them to the field.
  const stopText = props.host.onEvent?.((event) => { deliverTextInputEvent(event.method, event.params as Record<string, unknown>); });
  onCleanup(() => stopText?.());
  // Shell shortcuts (src/keymap.ts). A focused CodeView offers every key to the shell first through its onKeyDown hook
  // (global bindings win, editor-scoped ones stay with the editor); this hook covers keys that arrive as plain key events
  // when no editor has the keyboard. A focused InputField is a Flutter text field and keeps its own key handling.
  const toasts = props.studio.toasts;
  const stopKeys = onTextEvent((event) => {
    if (event.kind === "key" && event.pressed && !event.repeat) return props.studio.commands.handleKey(event.key, { editorFocused: false });
  });
  onCleanup(stopKeys);
  return (
    <Screen class="w-full h-full flex-row bg-[#09090B]">
      <Rail studio={props.studio} />
      <View class="flex-col flex-1">
        {pages.map((def) => <Show when={page() === def.id}>{def.render(props.studio)}</Show>)}
      </View>
      <CreateProjectDialog studio={props.studio} />
      <DialogHost dialogs={props.studio.dialogs} />
      <QuickOpenOverlay quickOpen={props.studio.quickOpen} />
      <ToastHost items={toastState().items} onDismiss={(id) => toasts.dismiss(id)} />
    </Screen>
  );
}

function App() {
  const host = createHostBridge();
  const streams = createPocketStreamAdapter(host);
  const link = createSystemLink(host);
  const studio = createStudio({ client: createStudioClient(host, streams, { yieldTurn }), timers: guestTimers, runtime: link, settingsBackend: link, clipboard: createPocketClipboardClient(host), updates: (handoff) => createUpdateLink(host, handoff) });
  return (
    <MobileThemeProvider theme={() => MOBILE_THEME_DARK}>
      <Shell studio={studio} host={host} />
    </MobileThemeProvider>
  );
}

mount(() => <App />);
