import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Tool answers, in one shape.
 *
 * What comes from Velk Express — titles, messages, names — is text written
 * by people (clients included) and reaches an AI model. So it always leaves
 * as data: in `structuredContent` and as the same JSON in the text, never
 * inside a sentence. The sentences here are fixed (from the dictionaries).
 */

export function toolData(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** A refusal: the sentence, and optional helpful data in a separate block. */
export function toolError(message: string, data?: Record<string, unknown>): CallToolResult {
  if (!data) return { isError: true, content: [{ type: "text", text: message }] };
  return {
    isError: true,
    content: [
      { type: "text", text: message },
      { type: "text", text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}
