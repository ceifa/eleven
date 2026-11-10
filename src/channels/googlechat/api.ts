import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const CHAT_API = "https://chat.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
// Reading a space's messages as the app needs this scope and a one-time admin approval.
const READ_SCOPE = "https://www.googleapis.com/auth/chat.app.messages.readonly";
// Access tokens live an hour; renew with margin so a slow turn never sends with a dead one.
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** The fields eleven reads from a Google service account's JSON key. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export function readServiceAccountKey(path: string): ServiceAccountKey {
  const key = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) throw new Error(`${path} is not a service account key (client_email and private_key missing)`);
  return { client_email: key.client_email, private_key: key.private_key, private_key_id: key.private_key_id };
}

export class GoogleChatApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A message as the history listing returns it. */
export interface ChatHistoryMessage {
  name: string;
  createTime: string;
  text?: string;
  sender?: { name?: string; displayName?: string; type?: string };
  thread?: { name?: string };
  attachment?: { contentName?: string }[];
  annotations?: { type?: string; userMention?: { user?: { type?: string } } }[];
}

/** What a Chat message create or update returns that eleven uses. */
export interface ChatMessage {
  name: string;
  thread?: { name: string };
}

/**
 * The Chat REST API as the app itself (app authentication, `chat.bot` scope):
 * enough to post, edit and delete its own messages, find a person's DM and
 * download what people attach to messages that mention it.
 */
export class GoogleChatApi {
  private key: ServiceAccountKey;
  private fetch: typeof fetch;
  private cached = new Map<string, { token: string; expiresAt: number }>();

  constructor(key: ServiceAccountKey, fetchImpl: typeof fetch = fetch) {
    this.key = key;
    this.fetch = fetchImpl;
  }

  private async accessToken(scope: string): Promise<string> {
    const cached = this.cached.get(scope);
    if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = { alg: "RS256", typ: "JWT", ...(this.key.private_key_id && { kid: this.key.private_key_id }) };
    const unsigned = `${part(header)}.${part({ iss: this.key.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key).toString("base64url")}`;
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !body.access_token) throw new GoogleChatApiError(response.status, `Google token exchange failed: ${body.error_description ?? body.error ?? response.status}`);
    this.cached.set(scope, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  private async request(method: string, path: string, body?: unknown, scope = BOT_SCOPE): Promise<Response> {
    const response = await this.fetch(`${CHAT_API}/${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken(scope)}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = (() => {
        try { return (JSON.parse(detail) as { error?: { message?: string } }).error?.message; } catch { return undefined; }
      })();
      throw new GoogleChatApiError(response.status, `Google Chat ${method} ${path.split("?")[0]}: ${response.status} ${message ?? detail.slice(0, 200)}`.trim());
    }
    return response;
  }

  /** Post a message. With a thread, it lands in that thread (or starts one if
   *  the thread is gone); without one, as its own message. */
  async createMessage(space: string, text: string, thread?: string): Promise<ChatMessage> {
    const query = thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : "";
    const response = await this.request("POST", `${space}/messages${query}`, { text, ...(thread && { thread: { name: thread } }) });
    return (await response.json()) as ChatMessage;
  }

  async updateMessage(name: string, text: string): Promise<void> {
    await this.request("PATCH", `${name}?updateMask=text`, { text });
  }

  async deleteMessage(name: string): Promise<void> {
    await this.request("DELETE", name);
  }

  /** The DM space between a person and the app, if they ever opened one. */
  async findDirectMessage(user: string): Promise<string | undefined> {
    try {
      const response = await this.request("GET", `spaces:findDirectMessage?name=${encodeURIComponent(user)}`);
      return ((await response.json()) as { name?: string }).name;
    } catch (error) {
      if (error instanceof GoogleChatApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** A space's messages, newest first: those of one thread, or the whole
   *  space's when no thread is given. Needs the admin-approved read scope;
   *  without it Google answers 403. */
  async listMessages(space: string, options: { thread?: string; before: string; pageSize: number }): Promise<ChatHistoryMessage[]> {
    const filter = [`createTime < "${options.before}"`, options.thread && `thread.name = ${options.thread}`].filter(Boolean).join(" AND ");
    const query = new URLSearchParams({ pageSize: String(options.pageSize), orderBy: "createTime desc", filter });
    const response = await this.request("GET", `${space}/messages?${query}`, undefined, READ_SCOPE);
    return ((await response.json()) as { messages?: ChatHistoryMessage[] }).messages ?? [];
  }

  /** The bytes of an uploaded attachment (its `attachmentDataRef.resourceName`). */
  async download(resourceName: string): Promise<Buffer> {
    const response = await this.request("GET", `media/${resourceName}?alt=media`);
    return Buffer.from(await response.arrayBuffer());
  }
}
