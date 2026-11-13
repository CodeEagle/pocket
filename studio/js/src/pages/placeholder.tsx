import { Text, View } from "@pocketjs/framework/solid/components";
import { C } from "../ui/theme.ts";

/** Rail entries whose pages land in later milestones. */
export function PlaceholderPage(props: { title: string; milestone: string }) {
  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <Text class="text-xl text-[#FAFAFA] font-bold">{props.title}</Text>
      <Text class="text-sm" style={{ textColor: C.muted }}>{`此功能将在 ${props.milestone} 提供。`}</Text>
    </View>
  );
}
