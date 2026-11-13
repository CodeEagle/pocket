/**
 * Official Looseleaf Showcase Route (`route === "looseleaf"`).
 *
 * Recreates kevintngo/looseleaf's signature "This desk is made of real
 * components" showcase AND provides an interactive catalog of the standalone
 * `@pocket/looseleaf` package (Surfaces, Marks & Pens, Controls, Charts &
 * Tables, Overlays, Theme Modes & Density Dial).
 */

import { For, Show, createSignal, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/solid/components";
import { ScrollablePage, createDisplayGeometry, type NavigationItem } from "@pocket/ui";
import {
  Accordion,
  Alert,
  Annotate,
  Avatar,
  Badge,
  BarChart,
  Breadcrumb,
  Button,
  ButtonGroup,
  Calendar,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Carousel,
  Checkbox,
  Circled,
  Clipboard,
  CodeBlock,
  Command,
  Confetti,
  Corkboard,
  Dialog,
  Drawer,
  Dropzone,
  Empty,
  Envelope,
  Field,
  FlipCard,
  Folder,
  Highlight,
  HoverCard,
  IndexCard,
  Input,
  InputGroup,
  InputOTP,
  Item,
  Kbd,
  LabelTag,
  Lettering,
  LooseleafDesk,
  LooseleafNavigationBar,
  LooseleafThemeProvider,
  LooseleafTimelineItem,
  LooseleafToolbar,
  Mascot,
  Message,
  MessageGroup,
  Notebook,
  Pagination,
  Paper,
  PeelCorner,
  Polaroid,
  Progress,
  PromptInput,
  Quote,
  RadioGroup,
  Rating,
  Receipt,
  Reveal,
  Ribbon,
  Seal,
  Select,
  Separator,
  Sidebar,
  SignaturePad,
  Sketchpad,
  Skeleton,
  Slider,
  Spinner,
  Squiggle,
  Stamp,
  StampButton,
  Stepper,
  StickerSheet,
  StickyNote,
  Switch,
  Table,
  Tabs,
  Tally,
  TearOff,
  Ticket,
  Toast,
  ToggleGroup,
  Tooltip,
  Typewriter,
  Underline,
  useLooseleafTheme,
  type LooseleafDensity,
  type LooseleafThemeMode,
} from "@pocket/looseleaf";

const LOOSELEAF_DOCK_ITEMS: readonly NavigationItem[] = [
  { id: "desk", label: "Desk", kind: "home" },
  { id: "surfaces", label: "Paper", kind: "gallery" },
  { id: "controls", label: "Controls", kind: "host" },
  { id: "data", label: "Data", kind: "settings" },
];

const SIGNUPS_DATA = [
  { label: "Mon", value: 42 },
  { label: "Tue", value: 58 },
  { label: "Wed", value: 35 },
  { label: "Thu", value: 71 },
  { label: "Fri", value: 64 },
  { label: "Sat", value: 30 },
  { label: "Sun", value: 22 },
];

const WEEK_TASKS = [
  { id: "ship", label: "Ship the sign-in card" },
  { id: "draw", label: "Draw the dashboard" },
  { id: "focus", label: "Fix the focus ring" },
  { id: "water", label: "Water the plant" },
];

function LooseleafShowcaseBody(props: {
  section: () => string;
  onSelectSection: (next: string) => void;
  themeMode: () => LooseleafThemeMode;
  onChangeThemeMode: (mode: LooseleafThemeMode) => void;
  density: () => LooseleafDensity;
  onChangeDensity: (density: LooseleafDensity) => void;
  clutter: () => boolean;
  onToggleClutter: (value: boolean) => void;
}): JSX.Element {
  const { palette } = useLooseleafTheme();

  // Interactive Desk state
  const [email, setEmail] = createSignal("ada@looseleaf.dev");
  const [rememberDesk, setRememberDesk] = createSignal(true);
  const [signedIn, setSignedIn] = createSignal(false);
  const [airplane, setAirplane] = createSignal(false);
  const [writeInPencil, setWriteInPencil] = createSignal(true);
  const [pressure, setPressure] = createSignal(60);
  const [keepTally, setKeepTally] = createSignal(true);
  const [tallyCount, setTallyCount] = createSignal(7);
  const [selectedDay, setSelectedDay] = createSignal(14);
  const [weekTab, setWeekTab] = createSignal("todo");
  const [doneTasks, setDoneTasks] = createSignal<Record<string, boolean>>({
    ship: true,
    draw: true,
  });
  const [toastState, setToastState] = createSignal<{
    open: boolean;
    tone: "default" | "success" | "error" | "info";
    title: string;
    description: string;
  }>({
    open: true,
    tone: "success",
    title: "Notebook saved",
    description: "All 48 pages are safe on this desk.",
  });

  // Catalog state
  const [otpSlot, setOtpSlot] = createSignal(2);
  const [framework, setFramework] = createSignal("PocketJS Solid");
  const [radioChoice, setRadioChoice] = createSignal("marker");
  const [rating, setRating] = createSignal(5);
  const [stepperVal, setStepperVal] = createSignal(120);
  const [toggles, setToggles] = createSignal<string[]>(["bold", "marker"]);
  const [cmdSelected, setCmdSelected] = createSignal("calendar");
  const [pageIdx, setPageIdx] = createSignal(1);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [pickedSticker, setPickedSticker] = createSignal("SHIP IT");

  const doneCount = () => WEEK_TASKS.filter((t) => doneTasks()[t.id]).length;

  return (
    <LooseleafDesk seed="looseleaf-showcase">
      {/* Top Toolbar: Mode & Density Dial */}
      <LooseleafToolbar
        title="Looseleaf"
        subtitle="shadcn/ui, drawn by hand · @pocket/looseleaf"
        trailing={
          <Stamp
            label={
              props.themeMode() === "amber-night"
                ? "0% BLUE NIGHT"
                : props.themeMode() === "dark"
                  ? "CHARCOAL DARK"
                  : "NOTEBOOK"
            }
            tone={props.themeMode() === "amber-night" ? "marker" : "blue"}
          />
        }
      />

      {/* Quick Theme + Density Dial Strip */}
      <Paper stock="slip" shadow="sheet" tilt={false} paddingClass="relative flex-col gap-2.5 w-full p-3">
        <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
          <Text class="text-xs font-mono font-bold" style={{ textColor: palette().ink }}>
            MATERIAL & CHARM DIAL
          </Text>
          <ButtonGroup
            value={props.themeMode()}
            onChange={(id) => props.onChangeThemeMode(id as LooseleafThemeMode)}
            items={[
              { id: "notebook", label: "Notebook" },
              { id: "dark", label: "Dark" },
              { id: "amber-night", label: "Amber 0% Blue" },
            ]}
          />
        </View>
        <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
          <ButtonGroup
            value={props.density()}
            onChange={(id) => props.onChangeDensity(id as LooseleafDensity)}
            items={[
              { id: "comfortable", label: "Comfortable" },
              { id: "compact", label: "Compact" },
              { id: "calm", label: "Calm (0° tilt)" },
            ]}
          />
          <Switch
            label="Desk ruler"
            checked={props.clutter()}
            onChange={props.onToggleClutter}
          />
        </View>
      </Paper>

      {/* TAB 1: OFFICIAL LOOSELEAF HOME DESK */}
      <Show when={props.section() === "desk"}>
        {/* Hero Card */}
        <Paper stock="paper" tape="both" shadow="hard" seed="hero">
          <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
            <Badge label="120+ COMPONENTS · STANDALONE PACKAGE" variant="secondary" />
            <LabelTag label="v0.1.0" accent="sky" />
          </View>
          <Lettering text="Looseleaf" size="5xl" accent="marker" />
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Text class="text-xl font-bold" style={{ textColor: palette().ink }}>
              shadcn/ui,
            </Text>
            <Underline text="drawn by hand." tone="marker" size="xl" seed="tagline" />
          </View>
          <Text class="text-sm" style={{ textColor: palette().inkSoft }}>
            Paper, felt-tip, marker and masking tape for PocketJS. Every sheet tilts while text sits crisp on horizontal baselines.
          </Text>
          <CodeBlock
            title="Import from the standalone @pocket/looseleaf package"
            code={'import { Desk, Card, Button, Tally } from "@pocket/looseleaf";'}
          />
          <View class="flex-row flex-wrap items-center gap-2.5 pt-1">
            <Button
              label="Browse Paper & Marks"
              trailingIcon="arrow-right"
              onPress={() => props.onSelectSection("surfaces")}
            />
            <Button
              label="Interactive Controls"
              variant="outline"
              onPress={() => props.onSelectSection("controls")}
            />
          </View>
        </Paper>

        {/* Sign-in Card (Home Hero Companion) */}
        <Card
          stock="paper"
          tape="both"
          title="Welcome back"
          description="sign in to pick up where you left off."
          seed="home-sign-in"
        >
          <CardContent>
            <Field label="Email" required>
              <Input value={email} onInput={setEmail} placeholder="ada@looseleaf.dev" />
            </Field>
            <Checkbox
              checked={rememberDesk()}
              onChange={setRememberDesk}
              label="Remember me on this desk"
            />
          </CardContent>
          <CardFooter>
            <Button
              label={signedIn() ? "✓ Signed in" : "Sign in"}
              variant={signedIn() ? "blue" : "primary"}
              onPress={() => setSignedIn((v) => !v)}
            />
            <Show when={signedIn()}>
              <Stamp label="VERIFIED" tone="green" />
            </Show>
          </CardFooter>
        </Card>

        {/* Section Heading */}
        <View class="flex-col gap-0.5 pt-1">
          <Text class="text-2xl font-bold" style={{ textColor: palette().ink }}>
            This desk is made of real components.
          </Text>
          <Squiggle tone="marker" segments={16} />
        </View>

        {/* 1. ChartCard */}
        <BarChart
          title="Signups"
          description="This week. The record is circled."
          data={SIGNUPS_DATA}
          peakNote="launch day!"
          fastener="clip"
        />

        {/* 2. PrefsCard (IndexCard) */}
        <IndexCard title="Settings" flag="sky" serial="no. 0007" page="p. 1" seed="home-prefs">
          <Switch
            label="Airplane mode"
            checked={airplane()}
            onChange={setAirplane}
          />
          <Switch
            label="Write in pencil"
            checked={writeInPencil()}
            onChange={setWriteInPencil}
          />
          <Slider
            label="Pen pressure"
            value={pressure()}
            onChange={setPressure}
            min={0}
            max={100}
            step={10}
          />
          <Checkbox
            checked={keepTally()}
            onChange={setKeepTally}
            label="Keep score with tally marks"
          />
        </IndexCard>

        {/* 3. Annotated Ruled Note with Tally */}
        <Paper stock="paper" rules="ruled" tape="corner" seed="home-notes">
          <Text class="text-xs font-mono" style={{ textColor: palette().pencilText }}>
            Reading notes / Tuesday
          </Text>
          <Text class="text-2xl font-bold" style={{ textColor: palette().ink }}>
            Same parts, new hand
          </Text>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Text class="text-sm" style={{ textColor: palette().ink }}>
              Looseleaf swaps the skin: every line is
            </Text>
            <Highlight text="drawn by a pen with pressure" />
            <Text class="text-sm" style={{ textColor: palette().ink }}>
              and every fill sits
            </Text>
            <Circled text="clean inside it" tone="red" />
          </View>
          <View class="flex-row justify-end pr-2">
            <Callout text="on purpose!" direction="up-left" tone="blue" />
          </View>
          <View class="flex-row items-center justify-between flex-wrap gap-2 pt-1">
            <View class="flex-row items-center gap-2.5">
              <Text class="text-xs" style={{ textColor: palette().pencilText }}>
                times I said “hand-drawn”:
              </Text>
              <Tally count={tallyCount()} />
            </View>
            <Button
              label="+1 tally"
              variant="outline"
              size="xs"
              onPress={() => setTallyCount((c) => (c >= 20 ? 1 : c + 1))}
            />
          </View>
        </Paper>

        {/* 4. Planner Calendar */}
        <Calendar
          monthLabel="November 2026"
          today={11}
          selectedDay={selectedDay()}
          onSelectDay={setSelectedDay}
        />

        {/* 5. TabsCard */}
        <Card
          title="This week"
          description={`${String(doneCount())} of ${String(WEEK_TASKS.length)} done`}
          tape="top"
          seed="home-tabs"
        >
          <Tabs
            value={weekTab()}
            onChange={setWeekTab}
            items={[
              { id: "todo", label: "To do", count: WEEK_TASKS.length - doneCount() },
              { id: "sprint", label: "Sprint" },
              { id: "team", label: "Team" },
            ]}
          >
            <Show when={weekTab() === "todo"}>
              <View class="flex-col gap-1">
                <For each={WEEK_TASKS}>
                  {(task) => (
                    <Checkbox
                      checked={Boolean(doneTasks()[task.id])}
                      strikeWhenChecked
                      label={task.label}
                      onChange={(v) =>
                        setDoneTasks((prev) => ({ ...prev, [task.id]: v }))
                      }
                    />
                  )}
                </For>
              </View>
            </Show>
            <Show when={weekTab() === "sprint"}>
              <Progress label="Sprint 7 of 10" value={70} />
            </Show>
            <Show when={weekTab() === "team"}>
              <View class="flex-row flex-wrap items-center gap-2.5 pt-1">
                <Avatar name="Ada Lovelace" size="lg" accent="sky" />
                <Avatar name="Jo Okafor" size="lg" accent="grass" />
                <Avatar name="Mika Kobayashi" size="lg" accent="lemon" />
                <Avatar name="Sam Reyes" size="lg" accent="tangerine" />
                <Avatar name="Priya Nair" size="lg" accent="bubblegum" />
              </View>
            </Show>
          </Tabs>
        </Card>

        {/* 6. ChatCard */}
        <MessageGroup>
          <Message
            sender="Ada"
            align="end"
            messages={["Can I use Looseleaf as a standalone PocketJS package?"]}
          />
          <Message
            sender="Sam"
            align="start"
            messages={[
              "Yes! @pocket/looseleaf ships 120+ components.",
              "Swap the import, keep your Solid JSX.",
            ]}
          />
        </MessageGroup>

        {/* 7. ToastCard */}
        <Paper stock="slip" tape="top" shadow="hard" seed="home-toast">
          <Text class="text-xl font-bold" style={{ textColor: palette().ink }}>
            Toss a toast
          </Text>
          <Text class="text-xs" style={{ textColor: palette().pencilText }}>
            Each kind is its own paper stock, so the meaning is not only a color.
          </Text>
          <View class="flex-row flex-wrap items-center gap-2">
            <Button
              label="Saved"
              size="sm"
              onPress={() =>
                setToastState({
                  open: true,
                  tone: "success",
                  title: "Notebook saved",
                  description: "All 48 pages are safe.",
                })
              }
            />
            <Button
              label="Oops"
              variant="outline"
              size="sm"
              onPress={() =>
                setToastState({
                  open: true,
                  tone: "error",
                  title: "Could not sync",
                  description: "Offline mode — queued in pencil.",
                })
              }
            />
            <Button
              label="Note"
              variant="outline"
              size="sm"
              onPress={() =>
                setToastState({
                  open: true,
                  tone: "info",
                  title: "Pinned to desk",
                  description: "Added yellow masking tape.",
                })
              }
            />
          </View>
          <Toast
            open={() => toastState().open}
            tone={toastState().tone}
            title={toastState().title}
            description={toastState().description}
            onClose={() => setToastState((s) => ({ ...s, open: false }))}
          />
        </Paper>
      </Show>

      {/* TAB 2: PAPER SURFACES, STATIONERY & MARKS */}
      <Show when={props.section() === "surfaces"}>
        <Corkboard title="CORKBOARD · STICKY NOTES & POLAROIDS">
          <StickyNote color="yellow" title="Law #1: Calm Paper" pin>
            <Text class="text-xs" style={{ textColor: "#2A2420" }}>
              Cream stock for structure; saturated stationery colors stay in stickers, washi, badges and stamps.
            </Text>
          </StickyNote>
          <StickyNote color="pink" title="Law #7: Real Baselines" pin>
            <Text class="text-xs" style={{ textColor: "#2A2420" }}>
              Only the paper sheet tilts — text never rotates, keeping typography razor-sharp.
            </Text>
          </StickyNote>
          <Polaroid caption="Stubby & Stationery Kit" date="2026-11-11">
            <Mascot pose="celebrate" caption="100% Zero-Texture Vector Ink!" />
            <Confetti count={8} />
          </Polaroid>
        </Corkboard>

        <Notebook title="Spiral Notebook" subtitle="p. 14 · Pad Stock">
          <Quote
            text="Every stroke is seeded, so server and client draw the exact same hand."
            author="Looseleaf Principles"
          />
          <Annotate note="hand-inked!" tone="red">
            <Typewriter text="font-mono: 12px / 14px / 16px baked slots" />
          </Annotate>
        </Notebook>

        <Clipboard title="Stationery Props & Tickets">
          <View class="flex-row flex-wrap items-center gap-2">
            <Ribbon label="FEATURED KIT" accent="marker" />
            <Seal label="OK" accent="grass" size={38} />
            <Stamp label="ARCHIVED" tone="blue" />
          </View>
          <Ticket
            title="Admit One · Looseleaf Desk"
            subtitle="Full shadcn-compatible PocketJS registry"
            stub="#0042"
            accent="hi"
          />
          <Receipt
            items={[
              { label: "Cream Index Cards (x24)", value: "$4.50" },
              { label: "Terracotta Felt Marker", value: "$3.00" },
              { label: "Masking Tape Roll", value: "$2.25" },
            ]}
            totalValue="$9.75"
            footer="THANK YOU FOR DRAWING BY HAND"
          />
        </Clipboard>

        <Folder tabLabel="Interactive Paper Tricks" accent="sky">
          <FlipCard
            front={
              <View class="flex-col gap-1">
                <Badge label="FRONT FACE" variant="secondary" />
                <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
                  Tap this card to flip it over ↻
                </Text>
              </View>
            }
            back={
              <View class="flex-col gap-1">
                <Badge label="GRAPH BACK" variant="sky" />
                <Text class="text-sm font-bold" style={{ textColor: palette().inkYou }}>
                  Graph stock on the reverse side!
                </Text>
              </View>
            }
          />
          <PeelCorner revealText="Hidden crib note under the dog-ear!">
            <Text class="text-sm font-bold" style={{ textColor: palette().ink }}>
              Peelable Corner Note
            </Text>
          </PeelCorner>
          <TearOff stubLabel=" Redeem 1 Free Sticker Pack">
            <Text class="text-xs" style={{ textColor: palette().inkSoft }}>
              Perforated coupon note — tap the yellow stub below to tear it off.
            </Text>
          </TearOff>
          <Envelope to="Pocket SDK Team" from="Looseleaf Studio" sealLabel="LL">
            <Reveal secret="All 120+ Looseleaf primitives compiled cleanly!" />
          </Envelope>
        </Folder>
      </Show>

      {/* TAB 3: INTERACTIVE CONTROLS, FORMS & SKETCH */}
      <Show when={props.section() === "controls"}>
        <Card title="Buttons, Stamps & Toggles" description="Tactile misregistered fills with press sink.">
          <View class="flex-row flex-wrap items-center gap-2">
            <Button label="Primary Marker" variant="primary" />
            <Button label="Highlighter" variant="secondary" />
            <Button label="Paper Outline" variant="outline" />
            <Button label="Blue Felt" variant="blue" />
            <Button label="Danger Red" variant="destructive" />
          </View>
          <StampButton label="Approve Page" stampedLabel="APPROVED" />
          <ToggleGroup
            options={[
              { id: "bold", label: "B Bold" },
              { id: "italic", label: "I Italic" },
              { id: "marker", label: "✎ Marker" },
            ]}
            selected={toggles()}
            onToggle={(id) =>
              setToggles((prev) =>
                prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
              )
            }
          />
        </Card>

        <Card title="Inputs, OTP, Select & Rating" description="Native keyboard + spring controls.">
          <InputGroup prefix="https://" value="looseleaf.pocket.dev" suffix=".ui" />
          <Field label="Verification Code (InputOTP)">
            <InputOTP value="482910" activeSlot={otpSlot()} onSelectSlot={setOtpSlot} />
          </Field>
          <Select
            label="Target Runtime"
            value={framework()}
            options={["PocketJS Solid", "QuickJS Bytecode", "Flutter Host", "Web Preview"]}
            onChange={setFramework}
          />
          <RadioGroup
            value={radioChoice()}
            onChange={setRadioChoice}
            options={[
              { id: "marker", label: "Terracotta Marker", detail: "Bold primary strokes" },
              { id: "blue", label: "Blue Felt-Tip", detail: "Interactive ink-you accents" },
            ]}
          />
          <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
            <Rating value={rating()} onChange={setRating} />
            <Stepper value={stepperVal()} step={15} unit="ml" onChange={setStepperVal} />
          </View>
        </Card>

        <PromptInput value="" placeholder="Write a field note or attach a sketch..." />
        <Dropzone />
        <Sketchpad />
        <SignaturePad signerName="Lincoln" />
      </Show>

      {/* TAB 4: DATA, TIMELINE, MENUS & OVERLAYS */}
      <Show when={props.section() === "data"}>
        <Card title="Unified Journal Timeline" description="Multi-tag vertical ink rail with rubber stamps.">
          <LooseleafTimelineItem
            time="09:40"
            tagLabel="Luna · Older Sister"
            tagAccent="bubblegum"
            stampLabel="FED 150ML"
            title="Morning bottle & vitamin D drops"
            detail="Finished warmly in 12 minutes; burped smoothly."
          />
          <LooseleafTimelineItem
            time="10:15"
            tagLabel="Theo · Little Brother"
            tagAccent="sky"
            stampLabel="NAP 90M"
            title="Morning crib nap started"
            detail="White noise machine at 42 dB, room 22°C."
            isLast
          />
        </Card>

        <Table
          caption="Stationery inventory ledger on check-ruled paper."
          columns={[
            { key: "sku", header: "SKU" },
            { key: "item", header: "Item" },
            { key: "stock", header: "Status" },
          ]}
          rows={[
            { sku: "LL-01", item: "Cream A5 Pad", stock: "In Stock" },
            { sku: "LL-02", item: "Felt-Tip Set", stock: "Low (4)" },
            { sku: "LL-03", item: "Washi Tape", stock: "In Stock" },
          ]}
        />

        <Command
          selectedId={cmdSelected()}
          onSelect={setCmdSelected}
          items={[
            { id: "calendar", label: "Open Planner Calendar", group: "Desk", shortcut: "⌘C" },
            { id: "sticker", label: "Insert Die-Cut Sticker", group: "Desk", shortcut: "⌘S" },
            { id: "night", label: "Toggle 0% Blue Night Mode", group: "Appearance", shortcut: "⌘N" },
          ]}
        />

        <StickerSheet onPick={setPickedSticker} />
        <Item
          title={`Selected Sticker: ${pickedSticker()}`}
          description="Tap any die-cut sticker above to test selection."
          badge="Interactive"
        />

        <Sidebar title="Looseleaf">
          <Breadcrumb items={["Looseleaf", "Catalog", "Preview"]} />
          <View class="flex-row items-center justify-between flex-wrap gap-2 w-full">
            <View class="flex-row items-center gap-1.5">
              <Kbd keys="⌘K" />
              <Kbd keys="⇧⌘P" />
            </View>
            <Pagination page={pageIdx()} totalPages={3} onChange={setPageIdx} />
          </View>
        </Sidebar>

        <Carousel
          slides={[
            { title: "Slide 1 · Seeded Wobble", detail: "Deterministic FNV-1a hashes ensure identical strokes everywhere." },
            { title: "Slide 2 · Zero PAK Bloat", detail: "Pure vector composition keeps app.pak tiny and instant." },
            { title: "Slide 3 · Amber Night Safe", detail: "0% blue-channel mode protects dark-adapted eyes at 3 AM." },
          ]}
        />

        <Accordion
          items={[
            {
              id: "q1",
              title: "Can I use @pocket/looseleaf in any PocketJS app or mini-app?",
              content: "Yes! Declare @pocket/looseleaf in package.json (or vendor/pocket-looseleaf) and build_guest.ts compiles all JSX and Tailwind literals into bytecode.",
            },
            {
              id: "q2",
              title: "How do I turn down the hand-drawn tilt for dense forms?",
              content: 'Wrap any subtree in <LooseleafThemeProvider density="calm"> to zero out paper tilt and tighten hit targets.',
            },
          ]}
        />

        <Alert
          tone="info"
          title="Overlays & Sheets"
          description="Open a taped paper Dialog or bottom Notebook Drawer below."
        />
        <View class="flex-row flex-wrap items-center gap-2">
          <Button label="Open Paper Dialog" onPress={() => setDialogOpen(true)} />
          <Button label="Open Notebook Drawer" variant="outline" onPress={() => setDrawerOpen(true)} />
          <Tooltip label="Tap Tooltip" tip="Sticky-note callout!" />
          <Spinner label="Ink ready" />
        </View>

        <HoverCard
          handle="@kevintngo / looseleaf"
          bio="Hand-drawn paper, felt-tip, marker and tape design language adapted natively for PocketJS."
          meta="MIT · Standalone @pocket/looseleaf package"
        />

        <Empty
          title="End of the notebook"
          description="Stubby has drawn every component on the desk."
          actionLabel="Back to Desk"
          onAction={() => props.onSelectSection("desk")}
        />

        <Dialog
          open={dialogOpen}
          title="Save notebook changes?"
          description="Your annotations, tally marks, and masking tape placements stay synced in JS state."
          confirmLabel="Save page"
          onConfirm={() =>
            setToastState({
              open: true,
              tone: "success",
              title: "Saved from Dialog",
              description: "Page committed to notebook.",
            })
          }
          onClose={() => setDialogOpen(false)}
        />

        <Drawer
          open={drawerOpen}
          title="Quick Stationery Drawer"
          subtitle="Bottom sheet on cream index stock with masking tape."
          onClose={() => setDrawerOpen(false)}
        >
          <Skeleton rows={2} />
        </Drawer>
      </Show>

      {/* Reserve bottom space for floating paper dock */}
      <View class="h-[84]" />
    </LooseleafDesk>
  );
}

export function LooseleafPage(): JSX.Element {
  const [section, setSection] = createSignal("desk");
  const [themeMode, setThemeMode] = createSignal<LooseleafThemeMode>("notebook");
  const [density, setDensity] = createSignal<LooseleafDensity>("comfortable");
  const [clutter, setClutter] = createSignal(true);
  const geometry = createDisplayGeometry({ top: 0, right: 0, bottom: 0, left: 0 });

  return (
    <LooseleafThemeProvider mode={themeMode} density={density} clutter={clutter}>
      <View class="relative flex-1 w-full h-full overflow-hidden">
        <ScrollablePage>
          <LooseleafShowcaseBody
            section={section}
            onSelectSection={setSection}
            themeMode={themeMode}
            onChangeThemeMode={setThemeMode}
            density={density}
            onChangeDensity={setDensity}
            clutter={clutter}
            onToggleClutter={setClutter}
          />
        </ScrollablePage>
        <View class="absolute left-0 right-0 bottom-0">
          <LooseleafNavigationBar
            active={section()}
            items={LOOSELEAF_DOCK_ITEMS}
            onChange={setSection}
            geometry={geometry}
          />
        </View>
      </View>
    </LooseleafThemeProvider>
  );
}
