export interface TabsBarItem { id: string; label: string; dirty?: boolean }

/** Index of the tab `step` places from `active`, wrapping; -1 when there are no tabs. Pure, used by keyboard tab switching. */
export function stepTab(tabs: readonly TabsBarItem[], active: string | undefined, step: number): number {
  if (tabs.length === 0) return -1;
  const at = tabs.findIndex((t) => t.id === active);
  if (at < 0) return step >= 0 ? 0 : tabs.length - 1;
  return (((at + step) % tabs.length) + tabs.length) % tabs.length;
}
