import type { Page } from "playwright";

/** Wait for the user-visible context check, including its canonical edit. */
export async function clickNovelHistory(page: Page, action: "undo" | "redo"): Promise<void> {
  await page.locator(`#novel-${action}`).click();
  await page.locator(`#novel-${action}[aria-busy="false"]`).waitFor();
}
