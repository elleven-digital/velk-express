import "server-only";
import type { FormValues } from "./form-values";
import { htmlToText } from "./sanitize";

/**
 * The text of a refused message, as plain text, to send back with the refusal. The composer may be
 * gone by the time the answer arrives (the ticket was closed meanwhile), so the client shows this
 * as a block to copy. Undefined when there is nothing worth showing.
 */
export function unsentText(values?: FormValues): string | undefined {
  const html = values?.body;
  if (!html) return undefined;
  const text = htmlToText(html);
  return text || undefined;
}
