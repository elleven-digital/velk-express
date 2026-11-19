/** What a quote action returns to its form: null before the first submit; text is already translated. */
export type QuoteState = { error?: string; ok?: string; link?: string } | null;
