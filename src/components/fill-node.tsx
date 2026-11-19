import { Fragment, type ReactNode } from "react";

/**
 * Like `fmt`, but the values may be elements (a `LocalTime`): "Edited by {name} · {date}" becomes
 * text and nodes in order. Placeholders the template lacks are skipped; unknown ones stay as text.
 */
export function fillNode(template: string, values: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{key !== undefined && key in values ? values[key] : part}</Fragment>;
  });
}
