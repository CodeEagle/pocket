# Pocket Studio Desktop IDE Workbench Redesign (2026-11-11)

## 1. Overview & Motivation
Pocket Studio (`sdk/editor/client/`) previously rendered its workspace as a single-column vertical stack of rounded cards with radial background glows and a modal `<dialog>` for source editing. On desktop viewports (`1280×900` and `1440×900`), users had to scroll past the preview stage to reach package resource policies, OTA version slots, build configurations, or build logs, and opening `app.tsx` blocked the live preview stage behind a modal backdrop.

This redesign transforms Pocket Studio into a fixed `100dvh` multi-pane Desktop IDE Workbench inspired by **Xcode 16**, **Linear**, **Cursor**, and **Rive** while preserving 100% of existing DOM IDs, server endpoints, Playwright regression contracts, and the built-in Studio SDK self-upgrade bar (`#studio-upgrade-bar`).

---

## 2. Source Paths & Retained Contracts
- **Modified Client Files**:
  - `sdk/editor/client/index.html`
  - `sdk/editor/client/editor.css`
  - `sdk/editor/client/editor.js`
- **Visual Reference & Live Captures**:
  - `sdk/.pocket-build/studio-redesign-preview/01_main_workspace.jpg` (Design reference — Main Workbench)
  - `sdk/.pocket-build/studio-redesign-preview/02_dual_split_workspace.jpg` (Design reference — Source Split + Dual Runtime + OTA Inspector)
  - `sdk/.pocket-build/studio-redesign-preview/03_live_implemented_main.png` (Live Playwright Chromium `1440×900` capture — Main Workbench)
  - `sdk/.pocket-build/studio-redesign-preview/04_live_implemented_split.png` (Live Playwright Chromium `1440×900` capture — Source Split + Dual Runtime + OTA Inspector)
- **Layout Regression Suite**:
  - `sdk/editor/test/studio_workbench_layout.test.ts`

### Preserved Behavioral & Selector Invariants
1. **Studio SDK Self-Upgrade Capsule (`#studio-upgrade-bar`)**:
   - Retains `#studio-upgrade-version`, `#studio-upgrade-status`, `#studio-upgrade-release`, `#studio-upgrade-action`, `renderStudioUpgrade()`, `pollStudioRestart()`, and `checkStudioUpgrade()` without modification.
2. **Runtime Target Strip (`.preview-toolbar`)**:
   - Retains `.preview-toolbar #device-picker`, `.preview-toolbar #deploy` (`运行`), `.preview-toolbar #deploy-cancel` (`停止`), and `.wechat-validation-controls` (`#wechat-project-label`, `#wechat-state`, `#wechat-start`, `#wechat-stop`, `#wechat-open`).
   - Ensures `.deploy-panel` inside the bottom console dock contains zero duplicate `#device-picker` or `#deploy` controls (`preview_page.test.ts`).
3. **Interactive Stage Resizer & Dual Surface Geometry**:
   - Preserves `#resize-preview-height` (`role="separator"`, `aria-valuemin="240"`, `aria-valuemax="1200"`) and `--preview-height` CSS custom property on `#preview-stage-wrap`.
   - Configures `.preview-panel` and `#preview-stage-wrap` with `flex: 0 0 auto` inside `.stage-column` (`overflow-y: auto`) so dragging `#resize-preview-height` to `640px+` expands `#preview-stage` without flex compression, while fitting `100dvh` cleanly at default height.
   - Preserves side-by-side equal bounding boxes for `#preview-stage` and `#wechat-preview-pane` when `.preview-surfaces.wechat-visible` is active (`wechat_inline_browser.test.ts`).
4. **Right Inspector Mutual-Exclusive Accordion & Tab Sync**:
   - Keeps `#resources-panel` (`open` initially), `#version-manager` (closed initially so `loadVersions()` is lazy-loaded on demand), and `#editor-tools` (closed initially) mounted in `.inspector-body`.
   - Syncs `.inspector-tabs` (`#inspector-tab-resources`, `#inspector-tab-versions`, `#inspector-tab-settings`), `.activity-rail` buttons, `#versions-open`, and native `<summary>` clicks (`resources_ui.test.ts` and `version_management_ui.test.ts`).

---

## 3. Architecture of the `100dvh` 5-Zone Workbench

| Zone | Selector | Dimensions & Responsibility |
| :--- | :--- | :--- |
| **Zone A — Top Global Command Bar** | `.project-switcher-bar` | Fixed `46px` header with Pocket Studio geometric emblem, compact `32px` `#project-switcher` dropdown pill, `+ 新建项目`, primary `#build` (`构建 ⌘B`), mode capsule (`#source-split-toggle`, `#novel-open`, `#versions-open`), and inline `#studio-upgrade-bar`. |
| **Zone B — Left Activity Rail** | `.activity-rail` | Fixed `44px` vertical rail with `16×16` stroke SVG icons for Stage (`#rail-stage`), Source Split (`#rail-source`), Package Resources (`#rail-resources`), Versions & OTA (`#rail-versions`), Project Settings (`#rail-settings`), and Console Dock (`#rail-console`). |
| **Zone C — Docked Source Split** | `#source-dock` | Non-blocking `clamp(320px, 31vw, 460px)` left split pane housing `.source-panel`, `#file-picker`, `#save`, `#refresh-source`, `#source`, and `#source-revision`. Triggers `requestAnimationFrame(() => layoutPreviewFrame())` on toggle. |
| **Zone D — Center Stage & Console Dock** | `.stage-column` | Top `36px` `.preview-toolbar` target strip + `36px` `.preview-header` HUD bar + `18px` dot-grid `#preview-stage-wrap` + collapsible `164px` `.console-dock` with tabs for Build Log (`#log`), Deploy Output (`.deploy-panel`), Artifacts (`#artifacts`), and Signing (`#advanced-panel`). |
| **Zone E — Right Tabbed Inspector** | `.inspector-column` | Fixed `390px` (`340px` at `<= 1200px`) right workbench with 3 synchronized tabs (`包资源`, `版本发布`, `项目设置`) and sticky resource policy footer (`#save-resources`). |

---

## 4. Keyboard Shortcuts
- `Cmd/Ctrl + B`: Triggers `#build` when enabled.
- `Cmd/Ctrl + S`: Triggers `#save` / `saveProject()`.
- `Cmd/Ctrl + E`: Toggles the left `#source-dock` split pane when enabled.
- `Cmd/Ctrl + J`: Toggles the bottom `.console-dock` collapsed/expanded state and re-layouts the preview stage.
