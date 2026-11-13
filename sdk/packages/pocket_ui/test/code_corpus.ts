/** Deterministic TSX corpus shared by the tokenizer and benchmark tests. */
export const TSX_SAMPLE = `import { createSignal, For } from "solid-js";
import type { Item } from "./types";

/* block comment
 * spanning lines */
interface Props<T> { items: T[]; onPick?: (item: T) => void }

const RE = /ab+c\\/[/]x/gi;
const total = (a: number, b: number) => a / b / 2;

export function List<T extends Item>(props: Props<T>) {
  const [count, setCount] = createSignal(0);
  const label = \`Items: \${props.items.length} (\${count() > 1 ? \`many \${count()}\` : "few"})\`;
  const generic = <T,>(x: T) => x;
  if (count() < 3 && props.items.length > 0) setCount(count() + 1);
  return (
    <div class="list" data-id={props.items.length}>
      <h1>Hello, {label} world</h1>
      <For each={props.items}>{(item) => <Row item={item} onClick={() => props.onPick?.(item)} />}</For>
      {count() > 0 && <span style={{ color: "red" }}>it's {count()}</span>}
      <>
        <Foo.Bar a='x' b={1.5e3} {...props}
          multi="line
          attr" />
      </>
    </div>
  );
}

// trailing comment with "quotes" and \`ticks\`
const big = 0xff_ff + 10n + .5 + 1_000;
const s = 'single \\' escaped' + "double \\" escaped";
type Union = "a" | "b" | Array<Map<string, number>>;
`;

export function buildCorpus(lines: number): string {
  const base = TSX_SAMPLE.split("\n");
  const out: string[] = [];
  while (out.length < lines) for (const l of base) { if (out.length < lines) out.push(l); }
  return out.join("\n");
}
