/**
 * Route activity primitives for retained guest page subtrees.
 *
 * Solid's conditional <Show> removes the inactive branch, which also disposes
 * its signals, kinetic scrollers and native input sessions. RouteView keeps
 * the branch mounted and switches the official native `display` property to
 * `Display.None` while inactive. The renderer therefore keeps the JS owner
 * alive, while layout, paint and hit testing skip the hidden subtree.
 *
 * This module intentionally depends only on the pinned framework. It must not
 * import the UI or mobile layers: both may consume route activity without a
 * route -> mobile/ui dependency cycle.
 */

import { createContext, useContext, type Accessor, type JSX } from "solid-js";
import { View, type ViewProps } from "@pocketjs/framework/solid/components";

export type RouteActiveSource = boolean | (() => boolean) | undefined;

/** The default keeps standalone SDK pages active when no RouteView is used. */
export const RouteActivityContext = createContext<Accessor<boolean>>(() => true);

export function useRouteActive(): Accessor<boolean> {
  return useContext(RouteActivityContext);
}

function resolveActive(value: RouteActiveSource): boolean {
  return typeof value === "function" ? value() : value ?? true;
}

export interface RouteViewProps extends ViewProps {
  /** Whether this route is the current visible/interactive route. */
  active?: RouteActiveSource;
}

/**
 * Keep one route subtree mounted while making inactive routes inert to the
 * native renderer. The root app owns the single `FocusScope`: adding a nested
 * scope here would make root-level Back/Tab controls (which sit beside the
 * route slots) fail the framework's scope-aware hit test.
 */
export function RouteView(props: RouteViewProps): JSX.Element {
  const parentActive = useRouteActive();
  const active = (): boolean => parentActive() && resolveActive(props.active);

  return (
    <RouteActivityContext.Provider value={active}>
      <View
        class={props.class ?? "flex-1 flex-col w-full h-full overflow-hidden"}
        debugName={props.debugName}
        focusable={props.focusable}
        onPress={props.onPress}
        ref={props.ref}
        nodeRef={props.nodeRef}
        style={{ ...(props.style ?? {}), display: active() ? 0 : 1 }}
      >
        {props.children}
      </View>
    </RouteActivityContext.Provider>
  );
}
