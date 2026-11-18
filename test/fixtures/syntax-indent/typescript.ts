// A fixture for the indent engine: prettier's layout.
import { readFileSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";

/* A block comment
   over lines,
     kept as written. */
export interface Options {
  name: string;
  width?: number;
  tags: Array<{ key: string; value: number }>;
}

type Shape =
  { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };

enum Colour {
  Red,
  Green = "green",
}

export class Store<T> {
  private items = new Map<string, T>();

  constructor(
    private readonly name: string,
    private readonly limit: number,
  ) {}

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  async load(path: string): Promise<void> {
    try {
      const text = readFileSync(path, "utf8");
      for (const [k, v] of Object.entries(JSON.parse(text))) {
        this.items.set(k, v as T);
      }
    } catch (e) {
      console.error(`could not load ${path}:
  ${String(e)}`);
    } finally {
      this.items.size > this.limit && this.items.clear();
    }
  }
}

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.r * s.r;
    case "rect": {
      const a = s.w * s.h;
      return a;
    }
    default:
      return 0;
  }
}

const shapes: Shape[] = [
  { kind: "circle", r: 1 },
  { kind: "rect", w: 2, h: 3 },
];
const total = shapes
  .map((s) => area(s))
  .filter((a) => a > 0)
  .reduce((x, y) => x + y, 0);
const options: Options = {
  name: "edwin",
  tags: [
    { key: "a", value: 1 },
    { key: "b", value: 2 },
  ],
};
if (total > 1 && options.name.length > 0) {
  writeFileSync(
    "out.json",
    JSON.stringify({ total, options, colour: Colour.Red }),
  );
} else if (total === 0) {
  console.log("none");
} else {
  console.log(
    "a long message that is long enough",
    total,
    options.name,
    Colour.Green,
  );
}
export const handler = async (stats: Stats): Promise<number> => {
  const size = stats.size;
  return size > 10 ? size : 0;
};

function braceless(a: number, b: number): number {
  if (a > b) return a;
  else if (a < b) return b;
  else return 0;
}

function nested(items: string[], cond: boolean) {
  for (const item of items) {
    if (cond) {
      const label =
        item.length > 10
          ? item.slice(0, 10).toUpperCase().trim()
          : item.toLowerCase().trim().padEnd(10);
      const value = items
        .filter((x) => x.startsWith(item))
        .map((x) => x.length)
        .reduce((a, b) => a + b, 0);
      if (
        label.length > 100 &&
        value > 100 &&
        items.length > 100 &&
        items.every((x) => x !== label)
      ) {
        return label;
      }
    }
  }
  return items.length > 0
    ? items
        .map((x) => x.trim())
        .filter(Boolean)
        .join(", ")
    : "none at all here";
}

function longBodies(entries: Map<string, number>, key: string) {
  if (entries.has(key))
    entries.set(key, (entries.get(key) ?? 0) + key.length * 1000 + 1);
  else
    entries.set(
      key,
      key.length * 1000 + entries.size + key.charCodeAt(0) + 99999,
    );
  while (entries.size > 10)
    entries.delete(entries.keys().next().value ?? "something long");
}
