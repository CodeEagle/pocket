// Executes shell commands (keymap.ts ids) against the Studio stores. The keyboard, and any future menu or
// command palette, call `run`; there is no second place where "build" or "close tab" is defined.
import { stepTab } from "@pocket/ui/tabs-model";
import { createStore } from "./store.ts";
import { resolveShellKey, PAGE_COMMANDS, type KeyContext, type ShellCommand } from "../keymap.ts";
import type { StudioPage } from "./studio.ts";
import type { Workspace } from "./workspace.ts";
import type { Build } from "./build.ts";
import type { Preview } from "./preview.ts";
import type { Publish } from "./publish.ts";
import type { Dialogs } from "./dialogs.ts";
import type { QuickOpen } from "./quick-open.ts";
import type { Toasts } from "./toasts.ts";

export interface CommandDeps {
  pages: readonly StudioPage[];
  page: () => StudioPage;
  setPage: (page: StudioPage) => void;
  project: () => string | undefined;
  workspace: Workspace;
  build: Build;
  preview: Preview;
  publish: Publish;
  dialogs: Dialogs;
  quickOpen: QuickOpen;
  toasts: Toasts;
  platform?: KeyContext["platform"];
}

export function createCommands(deps: CommandDeps) {
  const { workspace, build, preview, publish, dialogs, quickOpen, toasts } = deps;
  /** Counters the editor pane watches: a request to focus the code view's find bar. */
  const requests = createStore<{ find: number }>({ find: 0 });

  const needProject = (): boolean => {
    if (deps.project()) return true;
    toasts.info("请先在“项目”页打开一个项目。");
    return false;
  };

  /** Runs a command. Returns true when it was handled (the key is consumed), false when not applicable right now. */
  function run(command: ShellCommand): boolean {
    switch (command) {
      case "save":
        if (!workspace.state().active) return false;
        void workspace.save();
        return true;
      case "find":
        if (!workspace.state().active) return false;
        deps.setPage("source");
        requests.update({ find: requests.get().find + 1 });
        return true;
      case "build":
        if (!needProject()) return true;
        void build.start();
        return true;
      case "buildPreview":
        if (!needProject()) return true;
        void preview.run({ build: true });
        return true;
      case "quickOpen":
        if (!needProject()) return true;
        quickOpen.toggle();
        return true;
      case "closeTab": {
        const active = workspace.state().active;
        if (!active) return false;
        void workspace.close(active);
        return true;
      }
      case "prevTab":
      case "nextTab": {
        const docs = workspace.state().docs.map((d) => ({ id: d.path, label: d.path }));
        const at = stepTab(docs, workspace.state().active, command === "nextTab" ? 1 : -1);
        if (at < 0) return false;
        workspace.activate(docs[at]!.id);
        deps.setPage("source");
        return true;
      }
      case "publish":
        if (!needProject()) return true;
        deps.setPage("publish");
        void publish.enter();
        return true;
      case "closeOverlay":
        if (dialogs.active()) { dialogs.cancel(); return true; }
        if (quickOpen.isOpen()) { quickOpen.hide(); return true; }
        return false;
      case "listUp":
        if (!quickOpen.isOpen()) return false;
        quickOpen.move(-1);
        return true;
      case "listDown":
        if (!quickOpen.isOpen()) return false;
        quickOpen.move(1);
        return true;
      case "listAccept":
        if (!quickOpen.isOpen()) return false;
        void quickOpen.accept();
        return true;
      default: {
        const index = PAGE_COMMANDS.indexOf(command);
        const page = index >= 0 ? deps.pages[index] : undefined;
        if (!page) return false;
        deps.setPage(page);
        return true;
      }
    }
  }

  /** A raw key name from the shell hook or the CodeView hook. Returns true when it was consumed. */
  function handleKey(name: string, context: Pick<KeyContext, "editorFocused"> = {}): boolean {
    const command = resolveShellKey(name, { platform: deps.platform, editorFocused: context.editorFocused });
    return command ? run(command) : false;
  }

  return { run, handleKey, requests };
}
export type Commands = ReturnType<typeof createCommands>;
