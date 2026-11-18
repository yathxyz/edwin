// A fixture for the indent engine: prettier's layout.
import { useState } from "react";

type Props = {
  title: string;
  items: string[];
};

export function List({ title, items }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <section className="list">
      <h2 onClick={() => setOpen(!open)}>{title} — café 𝔸</h2>
      {open && (
        <ul>
          {items.map((item) => (
            <li key={item}>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        type="checkbox"
        checked={open}
        onChange={(e) => setOpen(e.target.checked)}
      />
    </section>
  );
}

export const Empty = () => <p>nothing</p>;
