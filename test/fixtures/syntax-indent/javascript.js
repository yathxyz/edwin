// A fixture for the indent engine: prettier's layout.
import { readFile } from "node:fs/promises";

/**
 * A doc comment
 *   kept as written.
 */
export async function load(path, { strict = false } = {}) {
  const text = await readFile(path, "utf8");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (strict && !lines[i].includes("=")) {
      throw new Error(`line ${i + 1}: no =`);
    }
  }
  return Object.fromEntries(
    lines.map((l) => {
      const [k, ...v] = l.split("=");
      return [k, v.join("=")];
    }),
  );
}

export class Counter {
  #n = 0;
  add(by = 1) {
    this.#n += by;
    return this;
  }
}

const table = {
  one: 1,
  nested: {
    list: [1, 2, 3],
    fn() {
      return "x";
    },
  },
};
switch (table.one) {
  case 1:
    console.log("one");
    break;
  default:
    console.log(table);
}
