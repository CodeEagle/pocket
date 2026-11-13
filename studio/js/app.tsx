// Studio shell: rail + the active page + global overlays. Pages, state and
// components live under src/; this file only composes them.
import { Show, onCleanup } from "solid-js";
import { MOBILE_THEME_DARK, MobileThemeProvider, deliverTextInputEvent } from "@pocket/ui";
import { createHostBridge, type HostBridge } from "@pocket/ui/host";
import { createPocketStreamAdapter } from "@pocket/ui/streams";
import { mount } from "@pocketjs/framework/solid";
import { onTextEvent } from "@pocketjs/framework/input";
import { Screen, View } from "@pocketjs/framework/solid/components";
import { createStudioClient } from "./src/studio-client.ts";
import { createStudio, type Studio } from "./src/state/studio.ts";
import { createSystemLink } from "./src/state/system-link.ts";
import { guestTimers } from "./src/ui/guest-env.ts";
import { select } from "./src/ui/bind.ts";
import { Rail } from "./src/components/rail.tsx";
import { ToastHost } from "./src/components/toasts.tsx";
import { DialogHost } from "./src/components/dialog-host.tsx";
import { CreateProjectDialog } from "./src/pages/projects.tsx";
import { pages } from "./src/pages/index.tsx";

function Shell(props: { studio: Studio; host: HostBridge }) {
  const page = select(props.studio.nav, (n) => n.page);
  // The Flutter text overlay answers InputField sessions with textInput.* events; route them to the field.
  const stopText = props.host.onEvent?.((event) => { deliverTextInputEvent(event.method, event.params as Record<string, unknown>); });
  onCleanup(() => stopText?.());
  // Cmd/Ctrl+S saves. A focused InputField is a Flutter text field that keeps
  // its own key handling, so the toolbar "保存" button is the reliable path
  // until the raw-text CodeView (M4) owns the keyboard.
  onTextEvent((event) => {
    if (event.kind === "key" && event.pressed && (event.key === "Control+s" || event.key === "Meta+s")) {
      void props.studio.workspace.save();
      return true;
    }
  });
  return (
    <Screen class="w-full h-full flex-row bg-[#09090B]">
      <Rail studio={props.studio} />
      <View class="flex-col flex-1">
        {pages.map((def) => <Show when={page() === def.id}>{def.render(props.studio)}</Show>)}
      </View>
      <CreateProjectDialog studio={props.studio} />
      <DialogHost dialogs={props.studio.dialogs} />
      <ToastHost toasts={props.studio.toasts} />
    </Screen>
  );
}

function App() {
  const host = createHostBridge();
  const streams = createPocketStreamAdapter(host);
  const link = createSystemLink(host);
  const studio = createStudio({ client: createStudioClient(host, streams), timers: guestTimers, runtime: link, settingsBackend: link });
  return (
    <MobileThemeProvider theme={() => MOBILE_THEME_DARK}>
      <Shell studio={studio} host={host} />
    </MobileThemeProvider>
  );
}

mount(() => <App />);
