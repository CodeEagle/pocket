import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import {
  InputField,
  MobileAccordion,
  MobileAlert,
  MobileAvatar,
  MobileBadge,
  MobileButton,
  MobileCard,
  MobileCheckbox,
  MobileDangerButton,
  MobileDialog,
  MobileFilledButton,
  MobileListTile,
  MobileOutlinedButton,
  MobilePopup,
  MobileProgress,
  MobileRadioGroup,
  MobileScaffold,
  MobileSegmentedControl,
  MobileSkeleton,
  MobileStepper,
  MobileSwitch,
  MobileTag,
  MobileTextButton,
  MobileToast,
  MobileTonalButton,
  PlatformTextureSurface,
  FlutterChip,
  FlutterDivider,
  FlutterFloatingActionButton,
  FlutterIconButton,
  FlutterLinearProgressIndicator,
  FlutterNavigationDestination,
  ShadcnAspectRatio,
  ShadcnBreadcrumb,
  ShadcnButtonGroup,
  ShadcnCalendar,
  ShadcnCarousel,
  ShadcnChart,
  ShadcnCollapsible,
  ShadcnCombobox,
  ShadcnCommand,
  ShadcnContextMenu,
  ShadcnDataTable,
  ShadcnDatePicker,
  ShadcnDrawer,
  ShadcnDropdownMenu,
  ShadcnEmpty,
  ShadcnFormField,
  ShadcnHoverCard,
  ShadcnInputGroup,
  ShadcnInputOTP,
  ShadcnItem,
  ShadcnKbd,
  ShadcnMenubar,
  ShadcnNavigationMenu,
  ShadcnPagination,
  ShadcnPopover,
  ShadcnResizable,
  ShadcnScrollArea,
  ShadcnSelect,
  ShadcnSeparator,
  ShadcnSheet,
  ShadcnSidebar,
  ShadcnSpinner,
  ShadcnTable,
  ShadcnTextarea,
  ShadcnToggleGroup,
  ShadcnTooltip,
  ShadcnTypography,
  wrapTextLines,
} from "@pocket/ui";
import {
  TRANSITION_MODES,
  computeTransitionDescriptor,
  type TransitionMode,
} from "@pocket/ui";
import type { JsonValue } from "@pocket/ui/host";
import type { HostBridge } from "@pocket/ui/host";
import type { PlatformExperience } from "@pocket/ui/platform-experience";
import {
  createPocketStreamAdapter,
  type PocketStreamAdapter,
} from "@pocket/ui/streams";
import type {
  CapabilityKey,
  CapabilityState,
  DemoEvent,
  DemoState,
  HardwareCapability,
  HardwarePermission,
} from "./state.ts";
import {
  HardwareStreamsPanel,
  PlatformExperiencePanel,
} from "./capability-panels.tsx";

export type MobilePageProps = {
  state: () => DemoState;
  dispatch: (event: DemoEvent) => void;
  requestCapability: (
    key: CapabilityKey,
    capability: string,
    params?: Record<string, JsonValue>,
  ) => void;
  host?: HostBridge;
  experience?: PlatformExperience;
};

function capabilityTone(
  state: CapabilityState,
): "accent" | "success" | "warning" | "danger" {
  if (state.phase === "ready") return "success";
  if (state.phase === "loading") return "warning";
  if (state.phase === "error") return "danger";
  return "accent";
}

export function MobileUiPage(props: MobilePageProps): JSX.Element {
  const [selected, setSelected] = createSignal("overview");
  const dark = () => props.state().mobileDark;
  const [enabled, setEnabled] = createSignal(true);
  const [asyncEnabled, setAsyncEnabled] = createSignal(false);
  const [toggleResolution, setToggleResolution] = createSignal<((accepted: boolean) => void) | undefined>();
  const resolveToggle = (accepted: boolean): void => {
    const resolve = toggleResolution();
    setToggleResolution(undefined);
    resolve?.(accepted);
  };
  onCleanup(() => toggleResolution()?.(false));
  const [level, setLevel] = createSignal(3);
  const [draft, setDraft] = createSignal("");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [dialogMode, setDialogMode] = createSignal<"default" | "confirm" | "danger">("default");
  const [popupOpen, setPopupOpen] = createSignal(false);
  const [toastOpen, setToastOpen] = createSignal(true);
  const [toastTone, setToastTone] = createSignal<"info" | "success" | "warning" | "danger">("info");
  const [toastMessage, setToastMessage] = createSignal("Workspace updates are visible here");
  const [alertOpen, setAlertOpen] = createSignal(true);
  const [alertTone, setAlertTone] = createSignal<"info" | "success" | "warning" | "danger">("info");
  const [checkboxAutoSave, setCheckboxAutoSave] = createSignal(true);
  const [checkboxHaptics, setCheckboxHaptics] = createSignal(false);
  const [radioLayout, setRadioLayout] = createSignal("adaptive");
  const [selectedTag, setSelectedTag] = createSignal("m3");
  const [accordionSpecOpen, setAccordionSpecOpen] = createSignal(true);
  const [accordionAnimOpen, setAccordionAnimOpen] = createSignal(false);
  const [skeletonPulse, setSkeletonPulse] = createSignal(true);
  const [lastOverlayAction, setLastOverlayAction] = createSignal("No action yet");
  const [destination, setDestination] = createSignal("home");
  const [selectedFramework, setSelectedFramework] = createSignal("Next.js");
  const [otpSlot, setOtpSlot] = createSignal(2);
  const [otpCode, setOtpCode] = createSignal("482910");
  const [toggleFormatting, setToggleFormatting] = createSignal<string[]>(["bold", "italic"]);
  const [calendarDay, setCalendarDay] = createSignal(14);
  const [selectedCommand, setSelectedCommand] = createSignal("calendar");
  const [selectedInvoice, setSelectedInvoice] = createSignal("INV001");
  const [tablePage, setTablePage] = createSignal(1);
  const [shadcnSuiteTab, setShadcnSuiteTab] = createSignal<"scroll" | "menus" | "forms" | "data" | "overlays">("scroll");
  const showToast = (
    tone: "info" | "success" | "warning" | "danger",
    msg: string,
  ): void => {
    setToastTone(tone);
    setToastMessage(msg);
    setToastOpen(true);
    setLastOverlayAction(`Toast (${tone})`);
  };
  const openDialogVariant = (mode: "default" | "confirm" | "danger"): void => {
    setDialogMode(mode);
    setDialogOpen(true);
    setLastOverlayAction(`Dialog (${mode})`);
  };
  const showOverview = () => selected() === "overview";
  const showFeedback = () => selected() === "overview" || selected() === "feedback";
  const showControls = () => selected() === "overview" || selected() === "controls";
  const showData = () => selected() === "overview" || selected() === "data";
  return (
    <MobileScaffold class="flex-col gap-4 p-4">
        <MobileSegmentedControl
          items={[
            { id: "overview", label: "Overview" },
            { id: "feedback", label: "Feedback" },
            { id: "controls", label: "Controls" },
            { id: "data", label: "Data" },
          ]}
          active={selected()}
          onChange={setSelected}
        />
        <Show when={showOverview()}>
          <MobileCard title="Scaffold + AppBar" detail="Shared page layout and navigation.">
            <MobileListTile
              title="ListTile"
              detail="Tap the row or its action to open details."
              leading={<MobileBadge label="UI" />}
              trailing={
                <MobileButton
                  label="Open"
                  kind="text"
                  compact
                  onPress={() => openDialogVariant("default")}
                />
              }
              onPress={() => openDialogVariant("default")}
            />
            <View class="flex-row flex-wrap gap-2">
              <MobileFilledButton
                label="Primary"
                compact
                onPress={() =>
                  props.dispatch({
                    type: "setTransitionMode",
                    mode: "IOS_SPRING_PARALLAX",
                  })
                }
              />
              <MobileTonalButton
                label="Tonal"
                compact
                onPress={() => showToast("info", "Information message shown")}
              />
              <MobileOutlinedButton
                label="Transitions"
                compact
                onPress={() =>
                  props.dispatch({ type: "navigate", route: "transitions" })
                }
              />
              <MobileDangerButton
                label="Danger"
                compact
                onPress={() => openDialogVariant("danger")}
              />
            </View>
          </MobileCard>

          <MobileCard
            title="shadcn/ui Command & Overlays"
            detail="Breadcrumb, Command palette, DropdownMenu and HoverCard."
          >
            <ShadcnBreadcrumb
              items={["shadcn/ui", "Components", "Command"]}
              dark={dark()}
            />
            <ShadcnSeparator dark={dark()} />
            <ShadcnCommand
              placeholder="Type a command or search..."
              selectedId={selectedCommand()}
              onSelect={(id) => {
                setSelectedCommand(id);
                setLastOverlayAction(`Command (${id})`);
              }}
              items={[
                { id: "calendar", label: "Calendar", group: "Suggestions" },
                { id: "emoji", label: "Search Emoji", group: "Suggestions" },
                { id: "calculator", label: "Calculator", group: "Suggestions" },
                { id: "profile", label: "Profile", group: "Preferences", shortcut: "⌘P" },
                { id: "billing", label: "Billing", group: "Preferences", shortcut: "⌘B" },
                { id: "settings", label: "Preferences", group: "Preferences", shortcut: "⌘S" },
              ]}
              dark={dark()}
            />
            <ShadcnDropdownMenu
              triggerLabel="My Account"
              items={[
                { id: "profile", label: "Profile", shortcut: "⇧⌘P" },
                { id: "billing", label: "Billing", shortcut: "⌘B" },
                { id: "team", label: "Team" },
                { id: "shortcuts", label: "Keyboard shortcuts", shortcut: "⌘K" },
              ]}
              onSelect={(id) => showToast("info", `Selected menu: ${id}`)}
              dark={dark()}
            />
            <ShadcnHoverCard
              handle="@nextjs"
              description="The React Framework – created and maintained by @vercel."
              joined="Joined December 2021"
              dark={dark()}
            />
          </MobileCard>

          <MobileCard
            title="shadcn/ui Full Component Suite (50+)"
            detail="ScrollArea + ScrollFade, Resizable, Sidebar, NavigationMenu, Menubar, Command, Forms, Charts, DataTable & Overlays."
          >
            <View class="flex-row flex-wrap gap-1.5">
              <MobileButton
                label="Scroll & Layout"
                kind={shadcnSuiteTab() === "scroll" ? "filled" : "tonal"}
                compact
                onPress={() => setShadcnSuiteTab("scroll")}
              />
              <MobileButton
                label="Menus & Command"
                kind={shadcnSuiteTab() === "menus" ? "filled" : "tonal"}
                compact
                onPress={() => setShadcnSuiteTab("menus")}
              />
              <MobileButton
                label="Forms & Date"
                kind={shadcnSuiteTab() === "forms" ? "filled" : "tonal"}
                compact
                onPress={() => setShadcnSuiteTab("forms")}
              />
              <MobileButton
                label="Charts & Tables"
                kind={shadcnSuiteTab() === "data" ? "filled" : "tonal"}
                compact
                onPress={() => setShadcnSuiteTab("data")}
              />
              <MobileButton
                label="Overlays & Text"
                kind={shadcnSuiteTab() === "overlays" ? "filled" : "tonal"}
                compact
                onPress={() => setShadcnSuiteTab("overlays")}
              />
            </View>
            <Show when={shadcnSuiteTab() === "scroll"}>
              <ShadcnScrollArea
                title="Tags (ScrollArea + ScrollFade)"
                dark={dark()}
              />
              <ShadcnSeparator dark={dark()} />
              <ShadcnResizable dark={dark()} />
              <ShadcnSeparator dark={dark()} />
              <ShadcnSidebar dark={dark()} />
              <ShadcnCarousel dark={dark()} />
              <ShadcnAspectRatio dark={dark()} />
            </Show>
            <Show when={shadcnSuiteTab() === "menus"}>
              <ShadcnNavigationMenu dark={dark()} />
              <ShadcnSeparator dark={dark()} />
              <ShadcnMenubar dark={dark()} />
              <ShadcnSeparator dark={dark()} />
              <ShadcnContextMenu dark={dark()} />
            </Show>
            <Show when={shadcnSuiteTab() === "forms"}>
              <ShadcnCombobox dark={dark()} />
              <ShadcnDatePicker dark={dark()} />
              <ShadcnFormField dark={dark()} />
              <ShadcnInputGroup dark={dark()} />
              <ShadcnTextarea dark={dark()} />
              <ShadcnButtonGroup dark={dark()} />
            </Show>
            <Show when={shadcnSuiteTab() === "data"}>
              <ShadcnChart dark={dark()} />
              <ShadcnDataTable dark={dark()} />
              <ShadcnItem
                title="Two-factor authentication (Item)"
                description="Verify via email or authenticator code."
                badge="Enabled"
                dark={dark()}
              />
              <ShadcnTypography dark={dark()} />
            </Show>
            <Show when={shadcnSuiteTab() === "overlays"}>
              <ShadcnDrawer dark={dark()} />
              <ShadcnSheet dark={dark()} />
              <ShadcnPopover dark={dark()} />
              <View class="flex-row items-center justify-between flex-wrap gap-2">
                <ShadcnTooltip dark={dark()} />
                <ShadcnSpinner dark={dark()} />
              </View>
              <ShadcnEmpty
                onAction={() => showToast("success", "Created new project")}
                dark={dark()}
              />
            </Show>
          </MobileCard>
        </Show>

        <Show when={showFeedback()}>
          <MobileCard
            title="Feedback & Overlays"
            detail="Notifications, menus and confirmations for everyday actions."
          >
            <MobileToast
              open={toastOpen()}
              tone={toastTone()}
              message={toastMessage()}
              detail={`Last action · ${lastOverlayAction()}`}
              actionLabel="Undo"
              onAction={() => setLastOverlayAction("Toast Undo")}
              onClose={() => setToastOpen(false)}
            />
            <View class="flex-row flex-wrap gap-2">
              <MobileTonalButton
                label="Info Toast"
                compact
                onPress={() => showToast("info", "Information message shown")}
              />
              <MobileTonalButton
                label="Success Toast"
                compact
                onPress={() => showToast("success", "Changes saved for this session")}
              />
              <MobileOutlinedButton
                label="Warn Toast"
                compact
                onPress={() => showToast("warning", "Please review this setting")}
              />
              <MobileDangerButton
                label="Error Toast"
                compact
                onPress={() => showToast("danger", "The requested action could not be completed")}
              />
            </View>

            <MobileAlert
              open={alertOpen()}
              tone={alertTone()}
              title={`Alert Banner (${alertTone()})`}
              body="Inline semantic status alert with animated tone & entrance transition."
              closable
              actionLabel="Cycle"
              onAction={() => {
                const order: Array<"info" | "success" | "warning" | "danger"> = [
                  "info",
                  "success",
                  "warning",
                  "danger",
                ];
                const next = order[(order.indexOf(alertTone()) + 1) % order.length]!;
                setAlertTone(next);
                setLastOverlayAction(`Alert (${next})`);
              }}
              onClose={() => setAlertOpen(false)}
            />
            <Show when={!alertOpen()}>
              <MobileOutlinedButton
                label="Restore Alert Banner"
                compact
                onPress={() => setAlertOpen(true)}
              />
            </Show>

            <View class="flex-row flex-wrap gap-2">
              <MobileFilledButton
                label="Open Popup"
                compact
                onPress={() => {
                  setPopupOpen(true);
                  setLastOverlayAction("Popup opened");
                }}
              />
              <MobileTonalButton
                label="Confirm Dialog"
                compact
                onPress={() => openDialogVariant("confirm")}
              />
              <MobileDangerButton
                label="Danger Dialog"
                compact
                onPress={() => openDialogVariant("danger")}
              />
            </View>
            <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
              Overlay status · {lastOverlayAction()}
            </Text>
            <ShadcnSeparator label="Collapsible" dark={dark()} />
            <ShadcnCollapsible
              title="@peduarte starred 3 repositories"
              pinnedItem="@radix-ui/primitives"
              hiddenItems={["@radix-ui/colors", "@stitches/react"]}
              dark={dark()}
            />
          </MobileCard>

          <Show when={selected() === "feedback"}>
            <MobileCard
              title="shadcn/ui Drawer, Sheet, Popover, ContextMenu, Tooltip & Empty"
              detail="Vaul Drawer, Side Sheet, Popover, ContextMenu, Tooltip and Empty/Spinner states."
            >
              <ShadcnDrawer dark={dark()} />
              <ShadcnSheet dark={dark()} />
              <ShadcnPopover dark={dark()} />
              <ShadcnContextMenu dark={dark()} />
              <View class="flex-row items-center justify-between flex-wrap gap-2">
                <ShadcnTooltip dark={dark()} />
                <ShadcnSpinner dark={dark()} />
              </View>
              <ShadcnEmpty
                onAction={() => showToast("success", "Created new project")}
                dark={dark()}
              />
            </MobileCard>
          </Show>
        </Show>

        <Show when={showControls()}>
          <MobileCard
            title="Controls"
            detail="Adjust preferences and try a native text field."
          >
            <MobileSwitch
              value={enabled()}
              label={enabled() ? "Enabled" : "Disabled"}
              onChange={setEnabled}
            />
            <MobileSwitch
              value={asyncEnabled()}
              label={asyncEnabled() ? "Async on" : "Async off"}
              onChange={setAsyncEnabled}
              onBeforeChange={() => new Promise<boolean>((resolve) => setToggleResolution(() => resolve))}
            />
            <Show when={toggleResolution()}>
              <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>{wrapTextLines("Waiting for a result. Complete or reject this change below.", 34, 240)}</Text>
              <View class="flex-row flex-wrap gap-2">
                <MobileButton label="Complete change" compact onPress={() => resolveToggle(true)} />
                <MobileButton label="Reject change" compact kind="outlined" onPress={() => resolveToggle(false)} />
              </View>
            </Show>
            <MobileStepper
              value={level()}
              min={0}
              max={10}
              onChange={setLevel}
            />
            <MobileProgress
              value={level()}
              max={10}
              label="Animated Progress"
              animated={enabled()}
              tone={level() >= 8 ? "success" : level() <= 2 ? "warning" : "accent"}
            />
            <View class="flex-col gap-2">
              <MobileCheckbox
                checked={checkboxAutoSave()}
                onChange={setCheckboxAutoSave}
                label="Auto-commit state snapshots"
                detail="Keep these changes for the session"
              />
              <MobileCheckbox
                checked={checkboxHaptics()}
                onChange={setCheckboxHaptics}
                label="Desktop keyboard shortcuts"
                detail="Choose a keyboard-friendly layout"
              />
            </View>
            <MobileRadioGroup
              value={radioLayout()}
              onChange={setRadioLayout}
              items={[
                { id: "adaptive", label: "Adaptive layout", detail: "Adjusts to your window" },
                { id: "mobile", label: "Single column", detail: "Focused mobile layout" },
                { id: "desktop", label: "Multi-pane", detail: "More room for desktop" },
              ]}
            />
            <InputField
              value={draft}
              onInput={setDraft}
              onSubmit={setDraft}
              placeholder="System keyboard input"
            />
            <Text
              class={
                dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#09090B]"
              }
            >
              State · {enabled() ? "on" : "off"} · level {String(level())} · layout {radioLayout()}
            </Text>
            <Text
              class={
                dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#09090B]"
              }
            >
              Draft · {draft() || "(empty)"}
            </Text>
            <MobileFilledButton
              label="Show dialog"
              onPress={() => openDialogVariant("default")}
            />
          </MobileCard>

          <MobileCard
            title="shadcn/ui Select, InputOTP, ToggleGroup & Calendar"
            detail="Interactive form primitives from the shadcn/ui suite."
          >
            <ShadcnSelect
              label="Framework"
              value={selectedFramework()}
              options={["Next.js", "SolidJS", "SvelteKit", "Astro", "Remix"]}
              onChange={setSelectedFramework}
              dark={dark()}
            />
            <View class="flex-col gap-1.5">
              <View class="flex-row items-center justify-between">
                <Text
                  class={
                    dark()
                      ? "text-xs text-[#FAFAFA]"
                      : "text-xs text-[#09090B]"
                  }
                >
                  One-Time Password (InputOTP)
                </Text>
                <MobileTextButton
                  label="Rotate code"
                  compact
                  onPress={() =>
                    setOtpCode((prev) =>
                      prev === "482910" ? "739204" : "482910",
                    )
                  }
                />
              </View>
              <ShadcnInputOTP
                value={otpCode()}
                activeSlot={otpSlot()}
                onSelectSlot={setOtpSlot}
                dark={dark()}
              />
            </View>
            <View class="flex-col gap-1.5">
              <Text
                class={
                  dark()
                    ? "text-xs text-[#FAFAFA]"
                    : "text-xs text-[#09090B]"
                }
              >
                ToggleGroup formatting
              </Text>
              <ShadcnToggleGroup
                options={[
                  { id: "bold", label: "B Bold" },
                  { id: "italic", label: "I Italic" },
                  { id: "underline", label: "U Underline" },
                ]}
                selected={toggleFormatting()}
                onToggle={(id) =>
                  setToggleFormatting((prev) =>
                    prev.includes(id)
                      ? prev.filter((item) => item !== id)
                      : [...prev, id],
                  )
                }
                dark={dark()}
              />
            </View>
            <ShadcnCalendar
              monthLabel="November 2026"
              selectedDay={calendarDay()}
              onSelectDay={setCalendarDay}
              dark={dark()}
            />
          </MobileCard>

          <Show when={selected() === "controls"}>
            <MobileCard
              title="shadcn/ui Combobox, DatePicker, Form, InputGroup, Textarea & ButtonGroup"
              detail="Complete form and selection primitives from shadcn/ui."
            >
              <ShadcnCombobox dark={dark()} />
              <ShadcnDatePicker dark={dark()} />
              <ShadcnFormField dark={dark()} />
              <ShadcnInputGroup dark={dark()} />
              <ShadcnTextarea dark={dark()} />
              <ShadcnButtonGroup dark={dark()} />
            </MobileCard>
          </Show>
        </Show>

        <Show when={showData()}>
          <MobileCard
            title="Data Display & Disclosure"
            detail="Profiles, labels, expandable sections and loading previews."
          >
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <View class="flex-row items-center gap-3">
                <MobileAvatar label="AC" tone="accent" status="online" />
                <MobileAvatar label="LN" tone="success" status="busy" />
                <MobileAvatar label="PK" tone="warning" status="offline" />
              </View>
              <View class="flex-row flex-wrap gap-1">
                <MobileBadge label="Core" tone="accent" />
                <MobileBadge label="Active" tone="success" />
                <MobileBadge label="Warn" tone="warning" />
                <MobileBadge label="Alert" tone="danger" />
              </View>
            </View>
            <View class="flex-row flex-wrap gap-2">
              <MobileTag
                label="Core components"
                selected={selectedTag() === "m3"}
                onPress={() => setSelectedTag("m3")}
              />
              <MobileTag
                label="Cells"
                selected={selectedTag() === "tdesign"}
                onPress={() => setSelectedTag("tdesign")}
              />
              <MobileTag
                label="Slate"
                selected={selectedTag() === "shadcn"}
                onPress={() => setSelectedTag("shadcn")}
              />
            </View>
            <MobileAccordion
              title="Appearance options"
              detail="Tap to expand or collapse details"
              badge="Details"
              expanded={accordionSpecOpen()}
              onToggle={() => setAccordionSpecOpen((v) => !v)}
            >
              <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
                {wrapTextLines(
                  "Choose clear surfaces, accents and status colors that keep the interface easy to scan.",
                  38,
                  252,
                )}
              </Text>
            </MobileAccordion>
            <MobileAccordion
              title="Motion details"
              detail="Subtle transitions keep feedback clear as controls change"
              badge="Motion"
              expanded={accordionAnimOpen()}
              onToggle={() => setAccordionAnimOpen((v) => !v)}
            >
              <Text class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}>
                {wrapTextLines(
                  "Buttons, menus and panels ease between states so changes are easy to follow.",
                  38,
                  252,
                )}
              </Text>
            </MobileAccordion>
            <View class="flex-row items-center justify-between">
              <Text class={dark() ? "text-xs text-[#FAFAFA] font-bold" : "text-xs text-[#09090B] font-bold"}>
                Loading preview
              </Text>
              <MobileTextButton
                label={skeletonPulse() ? "Pause pulse" : "Resume pulse"}
                compact
                onPress={() => setSkeletonPulse((v) => !v)}
              />
            </View>
            <MobileSkeleton rows={3} avatar active={skeletonPulse()} />
          </MobileCard>

          <MobileCard
            title="shadcn/ui Table, Pagination & Kbd"
            detail="Recent invoices table, keyboard shortcuts and page navigation."
          >
            <ShadcnTable
              caption="A list of your recent invoices."
              selectedInvoice={selectedInvoice()}
              onSelectRow={setSelectedInvoice}
              rows={[
                { invoice: "INV001", status: "Paid", method: "Credit Card", amount: "$250.00" },
                { invoice: "INV002", status: "Pending", method: "PayPal", amount: "$150.00" },
                { invoice: "INV003", status: "Unpaid", method: "Bank Transfer", amount: "$350.00" },
                { invoice: "INV004", status: "Paid", method: "Credit Card", amount: "$450.00" },
              ]}
              totalAmount="$1,200.00"
              dark={dark()}
            />
            <View class="flex-row items-center justify-between flex-wrap gap-2">
              <View class="flex-row items-center gap-1.5">
                <ShadcnKbd keys="⌘K" dark={dark()} />
                <ShadcnKbd keys="⇧⌘P" dark={dark()} />
                <ShadcnKbd keys="⌘B" dark={dark()} />
              </View>
              <ShadcnPagination
                page={tablePage()}
                totalPages={3}
                onChange={setTablePage}
                dark={dark()}
              />
            </View>
          </MobileCard>

          <Show when={selected() === "data"}>
            <MobileCard
              title="shadcn/ui Chart, DataTable, Carousel, AspectRatio, Item & Typography"
              detail="Interactive Bar Chart, Payments DataTable, Carousel, AspectRatio, Item and Typography."
            >
              <ShadcnChart dark={dark()} />
              <ShadcnDataTable dark={dark()} />
              <ShadcnCarousel dark={dark()} />
              <ShadcnAspectRatio dark={dark()} />
              <ShadcnItem
                title="Two-factor authentication (Item)"
                description="Verify via email or authenticator code."
                badge="Enabled"
                dark={dark()}
              />
              <ShadcnTypography dark={dark()} />
            </MobileCard>
          </Show>

          <MobileCard
            title="Additional controls"
            detail="Buttons, chips and navigation samples."
          >
            <Text
              class={
                dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#09090B]"
              }
            >
              Widget actions
            </Text>
            <View class="flex-row items-center gap-2">
              <FlutterChip
                label="Chip"
                selected={enabled()}
                onPress={() => setEnabled((value) => !value)}
              />
              <FlutterIconButton
                icon="⋯"
                tooltip="More"
                onPress={() => openDialogVariant("default")}
              />
              <FlutterFloatingActionButton
                icon="+"
                tooltip="Increment"
                onPress={() => props.dispatch({ type: "increment" })}
              />
            </View>
            <FlutterDivider />
            <Text
              class={
                dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#09090B]"
              }
            >
              Progress · {level()}/10
            </Text>
            <FlutterLinearProgressIndicator value={level() / 10} />
            <View class="flex-row items-center gap-1">
              <FlutterNavigationDestination
                icon="⌂"
                label="Home"
                selected={destination() === "home"}
                onPress={() => setDestination("home")}
              />
              <FlutterNavigationDestination
                icon="◉"
                label="Library"
                selected={destination() === "library"}
                onPress={() => setDestination("library")}
              />
            </View>
          </MobileCard>
        </Show>

        <MobilePopup
          open={popupOpen()}
          title="More actions"
          subtitle="Choose an action for this workspace."
          actions={[
            { id: "reset", label: "Reset control state", detail: "Restore the default values", danger: true },
          ]}
          onSelectAction={(id) => {
            if (id === "reset") {
              setLevel(3);
              setEnabled(true);
              setDraft("");
              setLastOverlayAction("Controls restored");
              showToast("warning", "Controls restored");
              return;
            }
          }}
          onClose={() => setPopupOpen(false)}
        />

        <MobileDialog
          open={dialogOpen()}
          title={
            dialogMode() === "danger"
              ? "Delete cached snapshot?"
              : dialogMode() === "confirm"
              ? "Apply appearance?"
                : "Confirm action"
          }
          body={
            dialogMode() === "danger"
              ? "This action clears local draft signals and animates dismissal."
              : dialogMode() === "confirm"
              ? "Use this appearance across the app."
                : "This action will update the current workspace."
          }
          tone={dialogMode() === "danger" ? "danger" : "default"}
          confirmLabel={
            dialogMode() === "danger"
              ? "Delete"
              : dialogMode() === "confirm"
                ? "Apply"
                : undefined
          }
          onConfirm={
            dialogMode() === "default"
              ? undefined
              : () => {
                  if (dialogMode() === "danger") {
                    setDraft("");
                    setLevel(3);
                    setEnabled(true);
                  }
                  setLastOverlayAction(`Dialog confirmed (${dialogMode()})`);
                  showToast(
                    dialogMode() === "danger" ? "danger" : "success",
                    `Dialog confirmed: ${dialogMode()}`,
                  );
                }
          }
          onClose={() => setDialogOpen(false)}
        />
      </MobileScaffold>
  );
}
const transitionLabels: Record<TransitionMode, string> = {
  IOS_SPRING_PARALLAX: "iOS parallax",
  SHARED_AXIS_Z: "Shared axis",
  LIQUID_GLASS_MORPH: "Glass morph",
  PORTAL_EXPAND: "Portal expand",
};

const transitionModeLabels: Record<TransitionMode, string> = {
  IOS_SPRING_PARALLAX: "iOS spring",
  SHARED_AXIS_Z: "Shared axis",
  LIQUID_GLASS_MORPH: "Glass",
  PORTAL_EXPAND: "Portal",
};

// Keep the shared transition enum intact, but do not expose the deferred
// glass mode as a selectable Demo route-motion option.
const demoTransitionModes = TRANSITION_MODES.filter(
  (id) => id !== "LIQUID_GLASS_MORPH",
);

export function TransitionsPage(props: MobilePageProps): JSX.Element {
  const [progress, setProgress] = createSignal(0.55);
  const descriptor = () =>
    computeTransitionDescriptor(
      props.state().transitionMode,
      progress(),
      false,
      360,
    );
  const dark = () => props.state().mobileDark;
  const modeItems = demoTransitionModes.map((id) => ({
    id,
    label: transitionModeLabels[id],
  }));
  return (
      <MobileScaffold class="flex-col gap-4 p-4">
        <MobileCard
          title="Mode"
          detail="Choose how the next page enters the screen."
        >
          <MobileSegmentedControl
            items={modeItems}
            active={props.state().transitionMode}
            onChange={(id) =>
              props.dispatch({
                type: "setTransitionMode",
                mode: id as TransitionMode,
              })
            }
          />
          <MobileStepper
            value={Math.round(progress() * 100)}
            min={0}
            max={100}
            onChange={(value) => setProgress(value / 100)}
          />
          <Text
            class={dark() ? "text-xs text-[#A1A1AA]" : "text-xs text-[#09090B]"}
          >
            Progress {Math.round(progress() * 100)}% · in{" "}
            {descriptor().inTx.toFixed(1)} · out {descriptor().outTx.toFixed(1)}
          </Text>
          <View
            class={
              dark()
                ? "relative h-[64] overflow-hidden rounded-xl bg-[#18181B] border-[#27272A]"
                : "relative h-[64] overflow-hidden rounded-xl bg-[#F4F4F5] border-[#E4E4E7]"
            }
          >
            <View
              class={
                dark()
                  ? "absolute inset-2 flex-col justify-center rounded-lg bg-[#FAFAFA] px-3"
                  : "absolute inset-2 flex-col justify-center rounded-lg bg-[#18181B] px-3"
              }
              style={{
                translateX: descriptor().inTx,
                translateY: descriptor().inTy,
                scale: descriptor().inScale,
              }}
            >
              <Text
                class={
                  dark()
                    ? "text-xs text-[#09090B] font-bold"
                    : "text-xs text-[#FAFAFA] font-bold"
                }
              >
                Incoming preview
              </Text>
              <Text
                class={
                  dark() ? "text-xs text-[#71717A]" : "text-xs text-[#A1A1AA]"
                }
              >
                {transitionLabels[props.state().transitionMode]}
              </Text>
            </View>
          </View>
        </MobileCard>
        <MobileCard
          title="Route stack"
          detail="Open a page, then return with Back."
        >
          <View class="flex-row flex-wrap gap-1">
            <For each={props.state().routeStack}>
              {(route) => (
                <MobileBadge
                  label={route}
                  tone={route === props.state().route ? "success" : "accent"}
                />
              )}
            </For>
          </View>
          <View class="flex-row flex-wrap gap-2">
            <MobileFilledButton
              label="Push Mobile"
              onPress={() =>
                props.dispatch({ type: "navigate", route: "mobile" })
              }
            />
            <MobileButton
              label="Back"
              kind="outlined"
              compact
              onPress={() => props.dispatch({ type: "popRoute" })}
            />
          </View>
        </MobileCard>
      </MobileScaffold>
  );
}
const hardwarePermissions: readonly {
  name: HardwarePermission;
  label: string;
}[] = [
  { name: "hardware.camera", label: "Camera" },
  { name: "hardware.photos", label: "Photos" },
  { name: "hardware.bluetooth", label: "Bluetooth" },
  { name: "hardware.sensors", label: "Sensors" },
  { name: "hardware.biometrics", label: "Biometrics" },
  { name: "hardware.location", label: "Location" },
  { name: "hardware.microphone", label: "Microphone" },
  { name: "hardware.network", label: "Network" },
];

function objectResult(
  state: CapabilityState,
): Record<string, unknown> | undefined {
  return state.result &&
    typeof state.result === "object" &&
    !Array.isArray(state.result)
    ? (state.result as Record<string, unknown>)
    : undefined;
}

function compactText(value: unknown, limit = 44): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit
    ? `${text.slice(0, Math.max(1, limit - 1))}…`
    : text;
}

const hardwareCapabilityLabels: Record<HardwareCapability, string> = {
  "hardware.permissions": "Permission check",
  "hardware.permissions.request": "Permission request",
  "hardware.camera.preview.start": "Preview start",
  "hardware.camera.preview.stop": "Preview stop",
  "hardware.camera.lens.switch": "Lens switch",
  "hardware.camera.flash.toggle": "Flash mode",
  "hardware.camera.capture": "Photo capture",
  "hardware.photos.list": "Photo list",
  "hardware.photos.delete": "Photo delete",
  "hardware.bluetooth.scan": "BLE scan",
  "hardware.bluetooth.connect": "BLE connect",
  "hardware.sensors.read": "Sensor read",
  "hardware.biometrics.authenticate": "Biometric check",
  "hardware.location.current": "Current location",
  "hardware.weather.current": "Current weather",
};

function permissionLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = Object.entries(value as Record<string, unknown>);
  const granted = entries.filter(
    ([, item]) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).granted === true,
  ).length;
  const lines = [`${granted}/${entries.length} permissions granted`];
  for (const [name, item] of entries.slice(0, 3)) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const status =
      record.granted === true
        ? "Granted"
        : compactText(record.status ?? "Unavailable", 24);
    lines.push(`${name} · ${status}`);
  }
  if (entries.length > 3) lines.push(`+${entries.length - 3} more`);
  return lines;
}

function capabilityLines(
  state: CapabilityState,
  capability: HardwareCapability,
): string[] {
  if (state.phase === "idle") return ["Not requested"];
  if (state.phase === "loading") return ["Waiting for host response…"];
  if (state.phase === "error")
    return [
      state.error?.code ?? "host_error",
      compactText(state.error?.message ?? "Host request failed", 34),
    ];
  if (state.result === null || state.result === undefined)
    return ["Host returned no result"];
  if (Array.isArray(state.result))
    return [
      `${state.result.length} item${state.result.length === 1 ? "" : "s"}`,
    ];

  const result = objectResult(state);
  if (!result) return [compactText(state.result, 34) || "Completed"];
  const lines: string[] = [];
  if (result.permissions) lines.push(...permissionLines(result.permissions));
  if (Array.isArray(result.photos))
    lines.push(
      `${result.photos.length} saved photo${result.photos.length === 1 ? "" : "s"}`,
    );
  if (Array.isArray(result.devices)) {
    const count = result.devices.length;
    const suffix = count === 1 ? "" : "s";
    lines.push(result.scanMode === "authorized-devices"
      ? `${count} authorized device${suffix}`
      : result.scanMode === "chooser"
        ? `${count} selected device${suffix}`
        : `${count} device${suffix} found`);
  }
  if (
    typeof result.textureId === "number" &&
    typeof result.width === "number" &&
    typeof result.height === "number"
  ) {
    lines.push(
      `Texture ${result.textureId} · ${result.width}×${result.height}`,
    );
  }
  if (typeof result.fileName === "string")
    lines.push(compactText(result.fileName, 28));
  if (result.deleted === true) lines.push("Deleted");
  if (typeof result.authenticated === "boolean")
    lines.push(result.authenticated ? "Authenticated" : "Not authenticated");
  if (typeof result.status === "string")
    lines.push(`Status · ${compactText(result.status, 30)}`);
  if (
    typeof result.latitude === "number" &&
    typeof result.longitude === "number"
  ) {
    lines.push(
      `Location ${result.latitude.toFixed(3)}, ${result.longitude.toFixed(3)}`,
    );
  }
  if (typeof result.temperature_2m === "number")
    lines.push(`Temperature ${result.temperature_2m.toFixed(1)}°`);
  const currentWeather =
    result.current &&
    typeof result.current === "object" &&
    !Array.isArray(result.current)
      ? (result.current as Record<string, unknown>)
      : undefined;
  if (currentWeather) {
    const temperature =
      typeof currentWeather.temperature_2m === "number"
        ? `${currentWeather.temperature_2m.toFixed(1)}°`
        : "—";
    const wind =
      typeof currentWeather.wind_speed_10m === "number"
        ? `${currentWeather.wind_speed_10m.toFixed(0)} wind`
        : "";
    lines.push(`Current ${temperature}${wind ? ` · ${wind}` : ""}`);
  }
  const motion = ["accelX", "accelY", "accelZ"]
    .map((key) => result[key])
    .filter((value): value is number => typeof value === "number");
  if (motion.length === 3)
    lines.push(`Motion ${motion.map((value) => value.toFixed(2)).join(" · ")}`);
  if (typeof result.pressureHpa === "number")
    lines.push(`Pressure ${result.pressureHpa.toFixed(1)} hPa`);
  if (result.ok === true && lines.length === 0) lines.push("Completed");
  if (
    result.realHardware === true ||
    result.realHardwareCamera === true ||
    result.realSensors === true ||
    result.realBiometrics === true ||
    result.realGps === true ||
    result.realNetwork === true
  ) {
    lines.push("Live host result");
  }
  if (lines.length === 0) {
    const summary = Object.entries(result)
      .filter(([key]) => key !== "ok" && key !== "provider" && key !== "source")
      .slice(0, 2)
      .map(([key, value]) => `${key} · ${compactText(value, 28)}`);
    lines.push(...summary);
  }
  return lines.length > 0
    ? lines.slice(0, 5)
    : [hardwareCapabilityLabels[capability]];
}

function resultInt(state: CapabilityState, key: string): number | undefined {
  const value = objectResult(state)?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function photosFrom(
  state: CapabilityState,
): { id: string; path: string; title: string }[] {
  const result = state.result;
  const items = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { photos?: unknown }).photos)
      ? (result as { photos: unknown[] }).photos
      : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const path = String(value.filePath ?? value.path ?? value.id ?? "");
    if (!path) return [];
    return [
      {
        id: `${index}-${path}`,
        path,
        title: String(value.name ?? value.title ?? path),
      },
    ];
  });
}

function compactPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  return compactText(name || normalized, 32);
}

function compactIdentifier(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function bluetoothDevicesFrom(
  state: CapabilityState,
): { id: string; name: string; rssi?: number }[] {
  const result = objectResult(state);
  const items = Array.isArray(result?.devices) ? result.devices : [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    const id = String(value.deviceId ?? value.id ?? "");
    if (!id) return [];
    return [
      {
        id,
        name: compactText(String(value.name ?? `Device ${index + 1}`), 28),
        ...(typeof value.rssi === "number" && Number.isFinite(value.rssi) ? { rssi: value.rssi } : {}),
      },
    ];
  });
}

function HardwareResult(props: {
  label: string;
  capability: HardwareCapability;
  state: CapabilityState;
  onRefresh?: () => void;
  dark?: boolean;
}): JSX.Element {
  return (
    <View
      class={
        props.dark
          ? "flex-col gap-1 px-3 py-2 rounded-xl bg-[#18181B] border-[#27272A]"
          : "flex-col gap-1 px-3 py-2 rounded-xl bg-[#FAFAFA] border-[#E4E4E7]"
      }
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text
          class={
            props.dark
              ? "text-xs text-[#FAFAFA] font-bold"
              : "text-xs text-[#09090B] font-bold"
          }
        >
          {props.label}
        </Text>
        <MobileBadge
          label={props.state.phase}
          tone={capabilityTone(props.state)}
        />
      </View>
      <Text
        class={props.dark ? "text-xs text-[#A1A1AA]" : "text-xs text-[#71717A]"}
      >
        {hardwareCapabilityLabels[props.capability]}
      </Text>
      <For each={capabilityLines(props.state, props.capability)}>
        {(line) => (
          <Text
            class={
              props.state.phase === "error"
                ? props.dark
                  ? "text-xs text-rose-300"
                  : "text-xs text-rose-700"
                : props.dark
                  ? "text-xs text-[#FAFAFA]"
                  : "text-xs text-[#09090B]"
            }
          >
            {line}
          </Text>
        )}
      </For>
      <Show when={props.onRefresh !== undefined}>
        <MobileButton
          label={props.state.phase === "loading" ? "Waiting" : "Refresh"}
          kind="text"
          compact
          onPress={props.onRefresh}
        />
      </Show>
    </View>
  );
}

export function HardwarePage(props: MobilePageProps): JSX.Element {
  const [lens, setLens] = createSignal<"back" | "front">("back");
  const [flash, setFlash] = createSignal<"auto" | "on" | "off">("auto");
  const [deletePath, setDeletePath] = createSignal<string | undefined>(
    undefined,
  );
  const dark = () => props.state().mobileDark;
  const permissions = () => props.state().hardwarePermissions;
  const preview = () => props.state().hardwareCameraPreviewStart;
  let streamAdapter: PocketStreamAdapter | undefined;
  if (props.host) {
    try {
      streamAdapter = createPocketStreamAdapter(props.host, {
        maxActiveStreams: 4,
        maxBufferedMessages: 8,
      });
    } catch {
      streamAdapter = undefined;
    }
  }
  const deleteDescription = () => {
    const path = deletePath();
    return path ? `Delete ${compactPath(path)}?` : "Choose a photo first.";
  };
  const previewTexture = () => {
    const textureId = resultInt(preview(), "textureId");
    const width = resultInt(preview(), "width");
    const height = resultInt(preview(), "height");
    const rotationDegrees = resultInt(preview(), "previewRotationDegrees") ?? 0;
    const mirrorX = objectResult(preview())?.previewMirrorX === true;
    return textureId === undefined ||
      width === undefined ||
      height === undefined
      ? undefined
      : { textureId, width, height, rotationDegrees, mirrorX };
  };
  const previewReady = () =>
    preview().phase === "ready" && previewTexture() !== undefined;
  onCleanup(() => {
    // The root route gate also catches a start response arriving after pop.
    streamAdapter?.dispose("hardware_page_unmounted");
  });
  return (
      <MobileScaffold class="flex-col gap-4 p-4">
        <MobileCard
          title="Permissions"
          detail="Check access or request one item."
        >
          <HardwareResult
            label="Current state"
            capability="hardware.permissions"
            state={permissions()}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwarePermissions",
                "hardware.permissions",
              )
            }
          />
          <For each={hardwarePermissions}>
            {(item) => (
              <MobileListTile
                title={item.label}
                detail={`${item.label} access`}
                trailing={
                  <MobileButton
                    label={
                      props.state().hardwarePermissionRequest.phase ===
                      "loading"
                        ? "Waiting"
                        : "Request"
                    }
                    kind="text"
                    compact
                    disabled={
                      props.state().hardwarePermissionRequest.phase ===
                      "loading"
                    }
                    onPress={() =>
                      props.requestCapability(
                        "hardwarePermissionRequest",
                        "hardware.permissions.request",
                        { permission: item.name },
                      )
                    }
                  />
                }
              />
            )}
          </For>
        </MobileCard>
        <MobileCard
          title="Camera"
          detail="Preview uses host texture."
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                preview().phase === "loading"
                  ? "Starting"
                  : previewReady()
                    ? "Preview on"
                    : "Start preview"
              }
              compact
              disabled={preview().phase === "loading" || previewReady()}
              onPress={() => {
                props.requestCapability(
                  "hardwareCameraPreviewStart",
                  "hardware.camera.preview.start",
                  { lens: lens() },
                );
              }}
            />
            <MobileButton
              label={
                props.state().hardwareCameraPreviewStop.phase === "loading"
                  ? "Stopping"
                  : "Stop"
              }
              kind="outlined"
              compact
              disabled={
                props.state().hardwareCameraPreviewStop.phase === "loading"
              }
              onPress={() => {
                props.requestCapability(
                  "hardwareCameraPreviewStop",
                  "hardware.camera.preview.stop",
                );
              }}
            />
          </View>
          <Show when={previewTexture()}>
            {(texture) => (
              <PlatformTextureSurface
                textureId={texture().textureId}
                sourceWidth={texture().width}
                sourceHeight={texture().height}
                rotationDegrees={texture().rotationDegrees}
                mirrorX={texture().mirrorX}
                class="relative w-full h-[150] rounded-xl bg-[#09090B]"
              />
            )}
          </Show>
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={`Lens ${lens()}`}
              kind="text"
              compact
              onPress={() => {
                const next = lens() === "back" ? "front" : "back";
                setLens(next);
                props.requestCapability(
                  "hardwareCameraLensSwitch",
                  "hardware.camera.lens.switch",
                  { lens: next },
                );
              }}
            />
            <MobileButton
              label={`Flash ${flash()}`}
              kind="text"
              compact
              onPress={() => {
                const next =
                  flash() === "auto" ? "on" : flash() === "on" ? "off" : "auto";
                setFlash(next);
                props.requestCapability(
                  "hardwareCameraFlashToggle",
                  "hardware.camera.flash.toggle",
                  { flash: next },
                );
              }}
            />
            <MobileButton
              label={
                props.state().hardwareCameraCapture.phase === "loading"
                  ? "Capturing"
                  : "Capture"
              }
              kind="outlined"
              compact
              disabled={props.state().hardwareCameraCapture.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareCameraCapture",
                  "hardware.camera.capture",
                )
              }
            />
          </View>
          <HardwareResult
            label="Preview"
            capability="hardware.camera.preview.start"
            state={preview()}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareCameraPreviewStart",
                "hardware.camera.preview.start",
                { lens: lens() },
              )
            }
          />
          <HardwareResult
            label="Capture"
            capability="hardware.camera.capture"
            state={props.state().hardwareCameraCapture}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareCameraCapture",
                "hardware.camera.capture",
              )
            }
          />
        </MobileCard>
        <MobileCard
          title="Photos"
          detail="Delete always requires confirmation."
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                props.state().hardwarePhotosList.phase === "loading"
                  ? "Loading"
                  : "List photos"
              }
              compact
              disabled={props.state().hardwarePhotosList.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwarePhotosList",
                  "hardware.photos.list",
                )
              }
            />
          </View>
          <HardwareResult
            label="Photo provider"
            capability="hardware.photos.list"
            state={props.state().hardwarePhotosList}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwarePhotosList",
                "hardware.photos.list",
              )
            }
          />
          <For each={photosFrom(props.state().hardwarePhotosList)}>
            {(photo) => (
              <MobileListTile
                title={compactText(photo.title, 28)}
                detail={compactPath(photo.path)}
                trailing={
                  <MobileButton
                    label="Delete"
                    kind="danger"
                    compact
                    onPress={() => setDeletePath(photo.path)}
                  />
                }
              />
            )}
          </For>
          <HardwareResult
            label="Delete"
            capability="hardware.photos.delete"
            state={props.state().hardwarePhotosDelete}
            dark={dark()}
          />
        </MobileCard>
        <MobileCard
          title="Connectivity"
          detail="BLE and sensors use host permissions."
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label={
                props.state().hardwareBluetoothScan.phase === "loading"
                  ? "Scanning"
                  : "Scan BLE"
              }
              compact
              disabled={props.state().hardwareBluetoothScan.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareBluetoothScan",
                  "hardware.bluetooth.scan",
                  { timeoutMs: 1600 },
                )
              }
            />
            <MobileButton
              label={
                props.state().hardwareSensorsRead.phase === "loading"
                  ? "Reading"
                  : "Read sensors"
              }
              kind="outlined"
              disabled={props.state().hardwareSensorsRead.phase === "loading"}
              onPress={() =>
                props.requestCapability(
                  "hardwareSensorsRead",
                  "hardware.sensors.read",
                )
              }
            />
          </View>
          <HardwareResult
            label="BLE"
            capability="hardware.bluetooth.scan"
            state={props.state().hardwareBluetoothScan}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareBluetoothScan",
                "hardware.bluetooth.scan",
                { timeoutMs: 1600 },
              )
            }
          />
          <For each={bluetoothDevicesFrom(props.state().hardwareBluetoothScan)}>
            {(device) => (
              <MobileListTile
                title={device.name}
                detail={`${compactIdentifier(device.id)}${device.rssi === undefined ? "" : ` · ${device.rssi} dBm`}`}
                trailing={
                  <MobileButton
                    label="Connect"
                    kind="text"
                    compact
                    onPress={() =>
                      props.requestCapability(
                        "hardwareBluetoothConnect",
                        "hardware.bluetooth.connect",
                        { deviceId: device.id },
                      )
                    }
                  />
                }
              />
            )}
          </For>
          <HardwareResult
            label="Sensors"
            capability="hardware.sensors.read"
            state={props.state().hardwareSensorsRead}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareSensorsRead",
                "hardware.sensors.read",
              )
            }
          />
          <HardwareResult
            label="BLE connect"
            capability="hardware.bluetooth.connect"
            state={props.state().hardwareBluetoothConnect}
            dark={dark()}
          />
        </MobileCard>
        <MobileCard
          title="Device services"
          detail="Each action calls the host."
        >
          <View class="flex-row flex-wrap gap-2">
            <MobileButton
              label="Biometrics"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareBiometricsAuthenticate",
                  "hardware.biometrics.authenticate",
                  { reason: "Pocket Host Lab" },
                )
              }
            />
            <MobileButton
              label="Location"
              kind="outlined"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareLocationCurrent",
                  "hardware.location.current",
                )
              }
            />
            <MobileButton
              label="Weather"
              kind="outlined"
              compact
              onPress={() =>
                props.requestCapability(
                  "hardwareWeatherCurrent",
                  "hardware.weather.current",
                )
              }
            />
          </View>
          <HardwareResult
            label="Biometrics"
            capability="hardware.biometrics.authenticate"
            state={props.state().hardwareBiometricsAuthenticate}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareBiometricsAuthenticate",
                "hardware.biometrics.authenticate",
                { reason: "Pocket Host Lab" },
              )
            }
          />
          <HardwareResult
            label="Location"
            capability="hardware.location.current"
            state={props.state().hardwareLocationCurrent}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareLocationCurrent",
                "hardware.location.current",
              )
            }
          />
          <HardwareResult
            label="Weather"
            capability="hardware.weather.current"
            state={props.state().hardwareWeatherCurrent}
            dark={dark()}
            onRefresh={() =>
              props.requestCapability(
                "hardwareWeatherCurrent",
                "hardware.weather.current",
              )
            }
          />
        </MobileCard>
        <PlatformExperiencePanel dark={dark()} experience={props.experience} />
        <HardwareStreamsPanel
          dark={dark()}
          host={props.host}
          adapter={streamAdapter}
          bluetoothConnect={props.state().hardwareBluetoothConnect}
        />
        <MobileDialog
          open={() => deletePath() !== undefined}
          title="Delete photo?"
          body={deleteDescription()}
          tone="danger"
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={() => {
            const path = deletePath();
            if (path) props.requestCapability(
              "hardwarePhotosDelete", "hardware.photos.delete", { filePath: path },
            );
          }}
          onClose={() => setDeletePath(undefined)}
        />
      </MobileScaffold>
  );
}
