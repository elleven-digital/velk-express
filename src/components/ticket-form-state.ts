import type { FormValues } from "@/lib/form-values";

/** What the new-ticket actions (panel and portal) return: null before the first submit; text is already translated. Errors carry the submitted `values`. */
export type TicketFormState = { error?: string; values?: FormValues } | null;
