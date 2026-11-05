import type { PocketUpdateStateOptions } from "@pocket/ui/updates";
import type { DemoState, Route } from "./state.ts";

/** Only portable UI state crosses an update; native handles and requests expire. */
export function showcaseUpdateState(
  storage: PocketUpdateStateOptions["storage"],
  read: () => DemoState,
  write: (update: (current: DemoState) => DemoState) => unknown,
  parseRoute: (value: unknown) => Route | undefined,
): PocketUpdateStateOptions {
  return {
    key: "system-ui.update-state",
    schema: "showcase-ui/1",
    storage,
    capture: () => {
      const current = read();
      return {
        routeStack: current.routeStack.slice(),
        count: current.count,
        draft: current.draft,
        selectedComponent: current.selectedComponent,
        detailsOpen: current.detailsOpen,
        lazyVisible: current.lazyVisible,
        transitionMode: current.transitionMode,
      };
    },
    restore: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const stack = value.routeStack;
      if (!Array.isArray(stack) || stack.length === 0 || stack.length > 32) return false;
      const routes = stack.map(parseRoute);
      if (routes.some((route) => route === undefined)) return false;
      const transitionMode = value.transitionMode;
      if (transitionMode !== "IOS_SPRING_PARALLAX" && transitionMode !== "SHARED_AXIS_Z" &&
          transitionMode !== "LIQUID_GLASS_MORPH" && transitionMode !== "PORTAL_EXPAND") return false;
      if (typeof value.count !== "number" || !Number.isSafeInteger(value.count) ||
          typeof value.draft !== "string" ||
          (value.selectedComponent !== null && typeof value.selectedComponent !== "string") ||
          typeof value.detailsOpen !== "boolean" || typeof value.lazyVisible !== "boolean") return false;
      write((current) => ({
        ...current,
        route: routes[routes.length - 1]!,
        routeStack: routes as Route[],
        count: value.count as number,
        draft: value.draft as string,
        selectedComponent: value.selectedComponent as string | null,
        detailsOpen: value.detailsOpen as boolean,
        lazyVisible: value.lazyVisible as boolean,
        transitionMode,
        lastAction: "Restored after update",
      }));
      return true;
    },
  };
}
