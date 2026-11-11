import { createVerify } from "node:crypto";

/** Who signs the requests Chat sends an HTTP endpoint. */
export const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CHAT_CERTS = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v1/certs";
const CERTS_TTL_MS = 60 * 60 * 1000;
// Google's clock and ours never agree to the second.
const CLOCK_SKEW_S = 300;

type Certs = Record<string, string>;

/**
 * Checks the bearer token on a request to the app's endpoint. Chat signs it in
 * one of two ways, depending on the audience the app was set up with: with the
 * project number, a JWT from Chat's own service account; with the endpoint
 * URL, a Google ID token whose email is that account. Anything else — no
 * token, another audience, a stale or forged one — is not Chat.
 */
export function createChatVerifier(audience: string, fetchImpl: typeof fetch = fetch) {
  const caches = new Map<string, { at: number; certs: Certs }>();
  const certs = async (url: string, kid: string): Promise<string | undefined> => {
    let entry = caches.get(url);
    // A kid we have never seen means Google rotated: fetch again rather than wait out the hour.
    if (!entry || Date.now() - entry.at > CERTS_TTL_MS || !entry.certs[kid]) {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`fetching Google certificates failed: ${response.status}`);
      entry = { at: Date.now(), certs: (await response.json()) as Certs };
      caches.set(url, entry);
    }
    return entry.certs[kid];
  };

  return async function verify(authorization: string | undefined): Promise<void> {
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) throw new Error("no bearer token");
    const [headerPart, payloadPart, signature] = token.split(".");
    if (!headerPart || !payloadPart || !signature) throw new Error("malformed token");
    const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("unexpected token algorithm");

    const fromChat = payload.iss === CHAT_ISSUER;
    const idToken = (payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com")
      && payload.email === CHAT_ISSUER && payload.email_verified === true;
    if (!fromChat && !idToken) throw new Error(`token not issued for Google Chat (${String(payload.iss)})`);

    const pem = await certs(fromChat ? CHAT_CERTS : GOOGLE_CERTS, header.kid);
    if (!pem) throw new Error("token signed with an unknown key");
    const valid = createVerify("RSA-SHA256").update(`${headerPart}.${payloadPart}`).verify(pem, Buffer.from(signature, "base64url"));
    if (!valid) throw new Error("bad token signature");

    const now = Date.now() / 1000;
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < now) throw new Error("token expired");
    if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW_S > now) throw new Error("token issued in the future");
    if (payload.aud !== audience) throw new Error(`token audience ${String(payload.aud)} is not this app`);
  };
}
