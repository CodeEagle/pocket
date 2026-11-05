import { Focusable, View } from "@pocketjs/framework/solid/components";
import type { JSX } from "solid-js";
import { toMobileColor, useMobileTheme } from "./mobile.tsx";

/** A compact icon-only back action for app bars and secondary routes. */
export interface MobileBackButtonProps {
  onPress?: () => void;
  disabled?: boolean;
}

/**
 * Keep the native AppBar affordance recognizable without depending on a font
 * glyph. The 44x44 Focusable is the touch target; the two rotated View bars
 * form a left chevron inside a 24x24 drawing box. The bars deliberately
 * share one explicit outer-corner pivot: rotated rounded boxes are square
 * fills in the pinned renderer, so independent rounded caps can otherwise
 * leave a one-pixel notch or a double-point where the two TRI fans meet.
 */
export function MobileBackButton(props: MobileBackButtonProps): JSX.Element {
  const theme = useMobileTheme();
  const color = () => toMobileColor(theme().accentInkColor ?? theme().accentColor);
  const className = () => props.disabled
    ? "relative flex-row items-center justify-center w-[44] h-[44] rounded-full bg-transparent opacity-50"
    : theme().name === "dark"
      ? "relative flex-row items-center justify-center w-[44] h-[44] rounded-full bg-transparent focus:bg-[#22314A] active:bg-[#30405A] transition-colors duration-150 ease-out"
      : "relative flex-row items-center justify-center w-[44] h-[44] rounded-full bg-transparent focus:bg-[#EEF1F6] active:bg-[#E4E9F2] transition-colors duration-150 ease-out";
  return (
    <Focusable
      class={className()}
      focusable={!props.disabled}
      debugName="Back"
      onPress={props.disabled ? undefined : props.onPress}
    >
      <View class="relative w-[24] h-[24]">
        <View
          class="absolute"
          style={{ bgColor: color(), insetL: 7, insetT: 1, width: 3, height: 11, originX: -0.5, originY: 0.5, rotate: 45 }}
        />
        <View
          class="absolute"
          style={{ bgColor: color(), insetL: 7, insetT: 12, width: 3, height: 11, originX: -0.5, originY: -0.5, rotate: -45 }}
        />
      </View>
    </Focusable>
  );
}
