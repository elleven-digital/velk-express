"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_LABEL_COLOR, LABEL_PRESETS, labelColorOf, parseLabelColor, type LabelPreset } from "@/lib/labels";
import { cn, inputClasses } from "./ui";

export type LabelColorTexts = {
  /** Name of each preset dot (title and screen readers). */
  presets: Record<LabelPreset, string>;
  /** The color field's label ("Cor"). */
  color: string;
  /** The hex text field. */
  hex: string;
  /** The native picker for any other color. */
  pick: string;
};

/**
 * A label color: preset dots to click, then any color by hex (typed, or from
 * the browser's own picker). Sends `name` as `#rrggbb` with the form.
 * `compact` folds it behind a dot button, for a label's row.
 */
export function LabelColorPicker({
  name = "color",
  defaultValue,
  texts,
  compact,
}: {
  name?: string;
  defaultValue?: string | null;
  texts: LabelColorTexts;
  compact?: boolean;
}) {
  const [color, setColor] = useState(() => labelColorOf(defaultValue ?? DEFAULT_LABEL_COLOR));
  const [text, setText] = useState(color);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const valid = parseLabelColor(text) !== null;

  const choose = (hex: string) => {
    setColor(hex);
    setText(hex);
  };

  // the folded picker closes on a click outside or Escape
  useEffect(() => {
    if (!compact || !open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [compact, open]);

  const panel = (
    <div className="space-y-2.5">
      <div role="radiogroup" aria-label={texts.color} className={cn("flex gap-1.5", !compact && "flex-wrap")}>
        {LABEL_PRESETS.map((p) => {
          const on = color === p.hex;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={texts.presets[p.key]}
              title={texts.presets[p.key]}
              onClick={() => choose(p.hex)}
              style={{ backgroundColor: p.hex }}
              className={cn(
                "size-6 rounded-full ring-1 ring-inset ring-black/10 transition-shadow cursor-pointer",
                on && "shadow-[0_0_0_2px_white,0_0_0_4px_var(--color-ink)]"
              )}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label
          title={texts.pick}
          className="relative size-8 flex-none overflow-hidden rounded-md border border-line cursor-pointer hover:border-line-strong"
          style={{ backgroundColor: color }}
        >
          <span className="sr-only">{texts.pick}</span>
          <input
            type="color"
            value={color}
            onChange={(e) => choose(e.currentTarget.value)}
            className="absolute inset-0 size-full opacity-0 cursor-pointer"
          />
        </label>
        <input
          id={`${id}-hex`}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={7}
          value={text}
          aria-label={texts.hex}
          aria-invalid={!valid}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setText(value);
            const hex = parseLabelColor(value);
            if (hex) setColor(hex);
          }}
          onBlur={() => setText(color)}
          className={cn(inputClasses, "!w-28 !h-8 !py-1 font-mono uppercase", !valid && "!border-danger")}
        />
      </div>
    </div>
  );

  return (
    <div ref={box} className={cn(compact && "relative flex-none")}>
      <input type="hidden" name={name} value={color} />
      {compact ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${texts.color}: ${color}`}
            title={color}
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 h-8 px-2 rounded-md border border-line bg-white hover:border-line-strong cursor-pointer"
          >
            <span
              aria-hidden="true"
              className="size-4 rounded-full ring-1 ring-inset ring-black/10"
              style={{ backgroundColor: color }}
            />
            <span className="font-mono text-[0.75rem] uppercase text-muted">{color}</span>
          </button>
          {open ? (
            <div className="absolute right-0 top-full z-30 mt-1.5 w-max rounded-card border border-line bg-white p-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
              {panel}
            </div>
          ) : null}
        </>
      ) : (
        panel
      )}
    </div>
  );
}
