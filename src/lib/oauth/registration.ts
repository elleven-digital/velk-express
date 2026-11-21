import { clientNameOf, redirectUrisOf } from "@/lib/oauth/client-metadata";

/**
 * Dynamic client registration (RFC 7591), the pure part: reading the request
 * body and shaping the response. Apps are public (no secret): PKCE and the
 * person's click on "Authorize" are the protection.
 */

export const REGISTRATION_MAX_BYTES = 16 * 1024;

const DEFAULT_NAME = "Unnamed app";

export type ParsedRegistration = { name: string; redirectUris: string[] };

export type RegistrationRefusal = {
  error: "invalid_redirect_uri" | "invalid_client_metadata";
  description: string;
};

/** Refusal messages, for whoever programs the app. */
export const REGISTRATION_ERRORS = {
  notObject: "The body must be a JSON object.",
  notJson: "The body must be JSON.",
  tooLarge: "The body is larger than 16 KB.",
  redirectUris:
    "redirect_uris must have 1 to 10 https URIs, or http on localhost, 127.0.0.1 or [::1], without fragment.",
  clientName: "client_name must be text up to 100 characters.",
  grantTypes: "grant_types must include authorization_code.",
} as const;

export function parseRegistration(
  body: unknown,
): { ok: true; value: ParsedRegistration } | { ok: false; refusal: RegistrationRefusal } {
  const refuse = (error: RegistrationRefusal["error"], description: string) => ({
    ok: false as const,
    refusal: { error, description },
  });

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse("invalid_client_metadata", REGISTRATION_ERRORS.notObject);
  }
  const fields = body as Record<string, unknown>;

  const redirectUris = redirectUrisOf(fields.redirect_uris);
  if (!redirectUris) return refuse("invalid_redirect_uri", REGISTRATION_ERRORS.redirectUris);

  let name = DEFAULT_NAME;
  if (fields.client_name !== undefined) {
    const read = clientNameOf(fields.client_name);
    if (read === null) return refuse("invalid_client_metadata", REGISTRATION_ERRORS.clientName);
    if (read) name = read;
  }

  if (
    fields.grant_types !== undefined &&
    !(Array.isArray(fields.grant_types) && fields.grant_types.includes("authorization_code"))
  ) {
    return refuse("invalid_client_metadata", REGISTRATION_ERRORS.grantTypes);
  }

  return { ok: true, value: { name, redirectUris } };
}

export function registrationResponse(
  client: { clientId: string; name: string; redirectUris: string[] },
  issuedAt: Date,
): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
