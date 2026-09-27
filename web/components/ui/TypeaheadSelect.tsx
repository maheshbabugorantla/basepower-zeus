"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

// A select you can type into: shows the current choice like a dropdown, and on
// focus becomes a text field that narrows its own option list as you type.
// Used for City / ZIP / Neighborhood in the ranking Filters popover, where the
// native <select> lists hundreds of block groups. Options come from data the
// page already has; nothing is fetched. The list renders inline (not as a
// floating layer) so it never escapes or gets clipped by the Filters popover.

export interface TypeaheadOption {
  /** "" is a real value (e.g. "no city on file"), distinct from "all" (null) */
  key: string;
  label: string;
  /** right-aligned note, e.g. "2,116 homes" */
  meta?: string;
}

export interface TypeaheadSelectProps {
  label: string;
  value: string | null;
  options: TypeaheadOption[];
  /** label for the "no filter" choice, e.g. "All (163,859 homes)" */
  allLabel: string;
  onChange: (key: string | null) => void;
  testId?: string;
  /** cap on rows rendered at once; typing narrows past it */
  limit?: number;
}

type Row = { key: string | null; label: string; meta?: string };

export function TypeaheadSelect({ label, value, options, allLabel, onChange, testId, limit = 60 }: TypeaheadSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const selected = value === null ? null : options.find((o) => o.key === value) ?? null;
  const shown = selected ? selected.label : allLabel;

  const rows: Row[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return [{ key: null, label: allLabel }, ...matches.slice(0, limit)];
  }, [text, options, allLabel, limit]);
  const hiddenCount = Math.max(0, (text.trim() ? options.filter((o) => o.label.toLowerCase().includes(text.trim().toLowerCase())).length : options.length) - limit);

  useEffect(() => setActive(0), [text]);

  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setText("");
      }
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  function choose(row: Row) {
    onChange(row.key);
    setOpen(false);
    setText("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && rows[active]) {
        e.preventDefault();
        choose(rows[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setText("");
    }
  }

  return (
    <div className="typeahead" ref={wrapRef}>
      <span className="typeahead__label">{label}</span>
      <input
        className="typeahead__input"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
        value={open ? text : shown}
        placeholder={open ? `Type to find a ${label.toLowerCase()}` : undefined}
        onFocus={() => {
          setOpen(true);
          setText("");
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        data-testid={testId}
      />
      {open ? (
        <div className="typeahead__list" id={listId} role="listbox" aria-label={label}>
          {rows.map((r, i) => (
            <div
              key={r.key ?? "__all"}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={r.key === value}
              className={
                "typeahead__option" +
                (i === active ? " typeahead__option--active" : "") +
                (r.key === value ? " typeahead__option--selected" : "")
              }
              onPointerDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="typeahead__option-label">{r.label}</span>
              {r.meta ? <span className="typeahead__option-meta">{r.meta}</span> : null}
            </div>
          ))}
          {rows.length === 1 && text.trim() ? <div className="typeahead__status">No {label.toLowerCase()} matches “{text.trim()}”.</div> : null}
          {hiddenCount > 0 ? <div className="typeahead__status">{hiddenCount.toLocaleString()} more; keep typing to narrow.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
