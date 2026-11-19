/**
 * Ticket labels: their colors and how a name is cleaned. Pure, so the panel,
 * the connector and the tests share it.
 *
 * A label's color is any hex `#rrggbb`. The presets are the dots offered
 * first in the picker; their names also work in the connector ("blue").
 */

export const LABEL_PRESETS = [
  { key: "gray", hex: "#8f8f8f" },
  { key: "red", hex: "#e5484d" },
  { key: "orange", hex: "#f76b15" },
  { key: "amber", hex: "#f5a524" },
  { key: "green", hex: "#30a46c" },
  { key: "teal", hex: "#12a594" },
  { key: "blue", hex: "#0a72ef" },
  { key: "purple", hex: "#8e4ec6" },
  { key: "pink", hex: "#d6409f" },
] as const;
export type LabelPreset = (typeof LABEL_PRESETS)[number]["key"];

export const DEFAULT_LABEL_COLOR = "#8f8f8f";

const PRESET_HEX = new Map<string, string>(LABEL_PRESETS.map((p) => [p.key, p.hex]));

/**
 * A color typed by a person or a tool, as lowercase `#rrggbb`: hex with or
 * without "#", 3 or 6 digits, or a preset name. null when it isn't a color.
 */
export function parseLabelColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const preset = PRESET_HEX.get(value);
  if (preset) return preset;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${digits}`;
}

/** The color to draw for a stored value; anything unreadable draws gray. */
export function labelColorOf(stored: string | null | undefined): string {
  return (stored && parseLabelColor(stored)) || DEFAULT_LABEL_COLOR;
}

export const LABEL_NAME_MAX = 40;
/** An agency's label count is capped so the filter and the picker stay usable. */
export const LABEL_MAX = 50;

/** Trimmed, inner spaces collapsed, cut to the max; "" when nothing is left. */
export function cleanLabelName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, LABEL_NAME_MAX).trim();
}
