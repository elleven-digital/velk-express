"use client";

import { fmt } from "@/lib/i18n";
import type { MessageActionState } from "./chat";
import { Icon } from "./icons";
import { ControlButton, ControlSelect } from "./ticket-controls";
import { cn } from "./ui";
import { LABEL_DOT, LABEL_PILL, labelVars } from "./work-list";

type LabelItem = { id: string; name: string; color: string | null };

export type TicketLabelsText = {
  none: string;
  noneYet: string;
  add: string;
  /** Contains {name}. */
  remove: string;
};

/**
 * A ticket's labels with their color dot and a remove button, and a select to apply another one.
 * Internal only: the portal never renders this. Anyone who sees the ticket may apply labels.
 */
export function TicketLabels({
  applied,
  all,
  addAction,
  removeAction,
  text,
}: {
  applied: LabelItem[];
  all: LabelItem[];
  /** Field: labelId. */
  addAction: (fd: FormData) => Promise<MessageActionState>;
  removeAction: (labelId: string) => Promise<MessageActionState>;
  text: TicketLabelsText;
}) {
  const appliable = all.filter((l) => !applied.some((a) => a.id === l.id));
  return (
    <div>
      {applied.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 mb-3">
          {applied.map((l) => (
            <li
              key={l.id}
              style={labelVars(l.color)}
              className={cn("inline-flex flex-wrap items-center gap-1.5 h-6 max-w-full pl-2 pr-0.5 rounded-full border text-[0.75rem]", LABEL_PILL)}
            >
              <span aria-hidden="true" className={cn("size-1.5 flex-none", LABEL_DOT)} />
              <span className="truncate">{l.name}</span>
              <ControlButton
                variant="ghost"
                size="sm"
                className="!h-5 !w-5 !px-0 rounded-full text-muted hover:text-danger"
                label={fmt(text.remove, { name: l.name })}
                action={() => removeAction(l.id)}
              >
                <Icon name="x" size={12} />
              </ControlButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted mb-3">{all.length > 0 ? text.none : text.noneYet}</p>
      )}
      {appliable.length > 0 ? (
        <ControlSelect
          action={addAction}
          name="labelId"
          placeholder={text.add}
          label={text.add}
          options={appliable.map((l) => ({ value: l.id, label: l.name }))}
        />
      ) : null}
    </div>
  );
}
