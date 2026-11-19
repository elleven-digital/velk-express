import { z } from "zod";
import { parseMoney } from "@/lib/format";

/** What the "New charge" form sends: the text of its fields. */
export type ChargeFormInput = { clientId: string; label: string; amount: string; kind: string; provider: string };

export type ChargeFormValue = {
  clientId: string;
  label: string;
  amountCents: number;
  kind: "one_time" | "subscription";
  /** Null is the manual record. */
  provider: "stripe" | "mercadopago" | null;
};

/** A provider field: "manual" is no provider, anything unknown is undefined. */
export function parseProviderField(raw: string): "stripe" | "mercadopago" | null | undefined {
  return raw === "manual" ? null : raw === "stripe" || raw === "mercadopago" ? raw : undefined;
}

const LABEL_MAX = 200;
const uuid = z.uuid();

/**
 * Reads the free charge form. The client and the label are required (`required`), the amount must
 * be money above zero (`invalidAmount`), the kind one of the two and the provider one of the
 * choices, "manual" meaning none (`providerUnavailable`). Whether the provider really serves this
 * charge is the core's call.
 */
export function parseChargeForm(input: ChargeFormInput): { ok: true; value: ChargeFormValue } | { ok: false; error: string } {
  const clientId = input.clientId.trim();
  const label = input.label.trim();
  if (!uuid.safeParse(clientId).success || !label) return { ok: false, error: "required" };
  if (label.length > LABEL_MAX) return { ok: false, error: "tooLong" };
  if (input.kind !== "one_time" && input.kind !== "subscription") return { ok: false, error: "required" };
  const amountCents = parseMoney(input.amount);
  if (amountCents === null || amountCents <= 0) return { ok: false, error: "invalidAmount" };
  const provider = parseProviderField(input.provider);
  if (provider === undefined) return { ok: false, error: "providerUnavailable" };
  return { ok: true, value: { clientId, label, amountCents, kind: input.kind, provider } };
}
