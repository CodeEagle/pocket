import { For, Show } from "solid-js";
import { InputField, MobileButton, MobileDialog } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { select } from "../ui/bind.ts";
import type { Dialogs } from "../state/dialogs.ts";

/** Renders the one active modal of the dialog store (confirm / choices / text prompt). */
export function DialogHost(props: { dialogs: Dialogs }) {
  const active = select(props.dialogs.store, (s) => s.active);
  // MobileDialog calls onClose right after onConfirm. A confirm that validation rejected must keep the dialog open.
  let confirming = false;
  return (
    <MobileDialog
      open={() => active() !== undefined}
      title={active()?.title ?? ""}
      body={active()?.body}
      tone={active()?.tone === "danger" ? "danger" : "default"}
      confirmLabel={active()?.confirmLabel ?? "确定"}
      cancelLabel={active()?.cancelLabel ?? "取消"}
      onClose={() => { if (confirming) { confirming = false; return; } props.dialogs.cancel(); }}
      onConfirm={() => { confirming = true; props.dialogs.confirmActive(); }}
    >
      <Show when={active()?.input}>
        <InputField value={() => active()?.inputValue ?? ""} onInput={(v) => props.dialogs.setInput(v)} onSubmit={() => props.dialogs.confirmActive()} placeholder={active()?.input?.placeholder} />
        <Show when={active()?.error}><Text class="text-xs text-[#F87171]">{active()?.error}</Text></Show>
      </Show>
      <For each={active()?.choices ?? []}>{(choice) => (
        <MobileButton label={choice.label} kind={choice.danger ? "danger" : "tonal"} compact onPress={() => props.dialogs.choose(choice.id)} />
      )}</For>
    </MobileDialog>
  );
}
