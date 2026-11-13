// Generic file/folder tree. The caller owns the state (files, expanded set, selection);
// the component only renders rows and reports presses.
import { For } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { ScrollablePage } from "./ui.tsx";
import { buildTree, visibleRows, type FlatFile } from "./tree-model.ts";

export * from "./tree-model.ts";

export interface TreeProps {
  files: readonly FlatFile[];
  /** Folders without files (a flat list cannot carry them). */
  directories?: readonly string[];
  expanded: ReadonlySet<string>;
  selected?: string;
  /** Paths that get a trailing "●" (unsaved files). */
  marked?: ReadonlySet<string>;
  onOpenFile: (path: string) => void;
  onToggleFolder: (path: string) => void;
  /** Left margin per depth level, in px (default 14). */
  indent?: number;
  /** Wrap the rows in a ScrollablePage (default true); pass false when the parent already scrolls. */
  scroll?: boolean;
}

export function Tree(props: TreeProps) {
  const rows = () => visibleRows(buildTree(props.files, props.directories ?? []), props.expanded);
  const body = () => (
    <View class="flex-col w-full">
      <For each={rows()}>{(row) => (
        <Focusable
          class={props.selected === row.node.path ? "py-1 rounded bg-[#27272A]" : "py-1 rounded"}
          style={{ marginL: row.depth * (props.indent ?? 14) }}
          onPress={() => row.node.kind === "directory" ? props.onToggleFolder(row.node.path) : props.onOpenFile(row.node.path)}
        >
          <Text class="text-sm text-[#FAFAFA]">{row.node.kind === "directory"
            ? `${row.expanded ? "▾" : "▸"} ${row.node.name}`
            : `${row.node.name}${props.marked?.has(row.node.path) ? " ●" : ""}`}</Text>
        </Focusable>
      )}</For>
    </View>
  );
  return props.scroll === false ? body() : <ScrollablePage>{body()}</ScrollablePage>;
}
