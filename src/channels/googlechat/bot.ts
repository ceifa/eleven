import { createServer, type Server } from "node:http";
import type { ChannelConfig } from "../../config.ts";
import { logger } from "../../log.ts";
import { type InboundMedia, formatInboundBody, mediaNote, sanitizeNoteValue, saveInboundMedia, transcribeMedia } from "../../media-store.ts";
import { healUser, senderAccess, type BotDeps, type ChatBot } from "../bots.ts";
import { Conversations, type TurnSurface } from "../conversations.ts";
import type { ReplyOptions } from "../index.ts";
import type { PairingRequest } from "../pairing.ts";
import { foldDisplayName, sanitizeContextLabel } from "../text.ts";
import { plainStatus, TurnStatus } from "../turn-status.ts";
import { GoogleChatApi, GoogleChatApiError, readServiceAccountKey, type ChatHistoryMessage } from "./api.ts";
import { chatChunks, toChatText } from "./markdown.ts";
import { googleChatSessionKey, parseGoogleChatSessionKey, resourceId } from "./session-key.ts";
import { createChatVerifier } from "./verify.ts";

// Chat's write quota is about one message a second per space, edits included.
const STATUS_THROTTLE_MS = 1_500;
// What one request to the endpoint may carry. An event is a few kilobytes;
// attachments travel by reference.
const MAX_BODY_BYTES = 1024 * 1024;
// What a mention in a space reads before answering: the whole thread it is
// in, and the conversation outside threads in the hours before it.
const THREAD_CONTEXT_MESSAGES = 50;
const SPACE_CONTEXT_MESSAGES = 30;
// Replies come interleaved in the space's listing; one page has room for them.
const SPACE_CONTEXT_PAGE = 100;
const SPACE_CONTEXT_WINDOW_MS = 12 * 60 * 60 * 1000;
const CONTEXT_MESSAGE_CHARS = 1_000;

/** The parts of a Chat interaction event eleven reads. */
export interface ChatEvent {
  type?: string;
  space?: ChatSpace;
  user?: ChatUser;
  message?: {
    name?: string;
    createTime?: string;
    text?: string;
    argumentText?: string;
    sender?: ChatUser;
    thread?: { name?: string };
    space?: ChatSpace;
    attachment?: ChatAttachment[];
  };
}

interface ChatSpace {
  name?: string;
  type?: string;
  spaceType?: string;
  singleUserBotDm?: boolean;
  displayName?: string;
}

interface ChatUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

interface ChatAttachment {
  contentName?: string;
  contentType?: string;
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: unknown;
}

/** Where a turn lands, read off an event or rebuilt from a session key. */
interface Target {
  sessionKey: string;
  /** `spaces/…` — unknown for a DM woken from its key until it is looked up. */
  space?: string;
  /** `spaces/…/threads/…`; replies in a space go into it, a DM has none. */
  thread?: string;
  userId?: string;
  spaceId?: string;
  triggerMessageId?: string;
}

/** What the bot needs from Google: the REST API as the app, and a check that
 *  a request really came from Chat. Injected in tests. */
export interface GoogleChatClient {
  api: Pick<GoogleChatApi, "createMessage" | "updateMessage" | "deleteMessage" | "findDirectMessage" | "download" | "listMessages">;
  verify: (authorization: string | undefined) => Promise<void>;
}

export interface BotHandle extends ChatBot {
  name: string;
  listening(): boolean;
  /** Feed one verified event in. The HTTP endpoint calls it; so do tests. */
  handleEvent(event: ChatEvent): Promise<void>;
}

/** A configured Google Chat channel: `token` is the path to the app's service
 *  account key, and `googlechat` says where its endpoint listens. */
export function startGoogleChatBot(name: string, token: string, deps: BotDeps): BotHandle {
  const settings = deps.botConfig()?.googlechat;
  try {
    if (!settings?.port || !settings.audience) throw new Error("googlechat.port and googlechat.audience are required");
    const bot = createGoogleChatBot(name, deps, { api: new GoogleChatApi(readServiceAccountKey(token)), verify: createChatVerifier(settings.audience) });
    bot.listen(settings.port, settings.host ?? "127.0.0.1");
    return bot;
  } catch (error) {
    // A broken channel must not take the daemon down with it: it stays listed, offline.
    logger(`googlechat/${name}`).error(`not starting: ${error instanceof Error ? error.message : error}`);
    const fail = () => Promise.reject(error);
    return createGoogleChatBot(name, deps, {
      api: { createMessage: fail, updateMessage: fail, deleteMessage: fail, findDirectMessage: fail, download: fail, listMessages: fail },
      verify: fail,
    });
  }
}

export function createGoogleChatBot(name: string, deps: BotDeps, client: GoogleChatClient): BotHandle & { listen(port: number, host: string): Server } {
  const log = logger(`googlechat/${name}`);
  const { api } = client;
  let server: Server | undefined;
  let listening = false;
  // A DM is keyed by the person; sending to it needs the space, which every
  // message from them names and the API can look up after a restart.
  const dmSpaces = new Map<string, string>();
  const conversations = new Conversations<Target>({
    type: "googlechat",
    name,
    deps,
    log,
    sessionKey: (target) => target.sessionKey,
    targetOf: targetFor,
    surface,
    describe: describeConversation,
    capabilities: ["basic formatting (bold, italic, strikethrough, code, links, lists); headings and tables arrive flattened"],
  });
  let historyDenied = false;

  async function handleEvent(event: ChatEvent): Promise<void> {
    const config = deps.botConfig();
    if (!config) return;
    const space = event.message?.space ?? event.space;
    const sender = event.message?.sender ?? event.user;
    const userId = resourceId(sender?.name);
    const spaceId = resourceId(space?.name);
    if (!space?.name || !spaceId || !userId || sender?.type === "BOT") return;
    // A DIRECT_MESSAGE can also be two people who added the app; only this flag means one person and the app.
    const dm = space.singleUserBotDm === true;
    if (dm) dmSpaces.set(userId, space.name);

    if (event.type === "REMOVED_FROM_SPACE") return void log.info(`removed from ${space.name}`);
    if (event.type !== "MESSAGE" && event.type !== "ADDED_TO_SPACE") return;

    const access = senderAccess(config, userId, dm ? undefined : spaceId);
    if (access === "pair") return offerPairing(dm, userId, spaceId, sender, space);
    if (access === "ignore") return;
    selfHeal(dm, userId, spaceId, sender, space);

    const message = event.message;
    // Being added without a message (the DM opened, the app joined a space) is not a request.
    if (!message?.name || conversations.seen(space.name, message.name)) return;
    // In a space Chat only delivers what mentions the app; argumentText is that message without the mention.
    const text = (dm ? message.text : message.argumentText ?? message.text)?.trim() ?? "";
    const threadId = resourceId(message.thread?.name);
    if (!dm && !threadId) return void log.warn(`message ${message.name} in a space came without a thread`);
    const target: Target = dm
      ? { sessionKey: googleChatSessionKey(name, { userId }), space: space.name, userId, triggerMessageId: message.name }
      : { sessionKey: googleChatSessionKey(name, { spaceId, threadId: threadId! }), space: space.name, thread: message.thread!.name, spaceId, triggerMessageId: message.name };

    if (text.startsWith("/") && (await handleCommand(target, text))) return;
    const release = conversations.bursts.prepare(target.sessionKey);
    try {
      const media = await collectAttachments(message.attachment ?? []);
      const body = formatInboundBody(text, media);
      if (!body.trim() && !media.images.length) return;
      const context = dm ? "" : await conversationContext(target.sessionKey, space.name, message.thread!.name!, message.createTime);
      const heading = context ? `[Current message, from ${senderLabel(sender)} — respond to this]` : `[${senderLabel(sender)}]`;
      conversations.bursts.enqueue(target.sessionKey, target, dm ? body : `${context}${heading}\n${body}`, media.images);
    } finally {
      release();
    }
  }

  /** What the space was talking about when someone mentioned the app, as
   *  blocks the agent reads as context before the message it answers: the
   *  conversation outside threads in the hours before, and the thread the
   *  mention is in, its first message apart. Chat delivers only the mention
   *  itself. When the agent is still in the session where it last answered
   *  this thread, it already holds everything up to that question, so only
   *  what came after is sent. Empty without the read scope: the mention alone
   *  still gets an answer. */
  async function conversationContext(sessionKey: string, space: string, thread: string, before: string | undefined): Promise<string> {
    if (!before) return "";
    try {
      const [inSpace, inThread] = await Promise.all([
        api.listMessages(space, { before, pageSize: SPACE_CONTEXT_PAGE }),
        api.listMessages(space, { thread, before, pageSize: THREAD_CONTEXT_MESSAGES }),
      ]);
      historyDenied = false;
      const seenUntil = alreadySeen(sessionKey, inThread);
      const unseen = (m: ChatHistoryMessage) => seenUntil === undefined || (Date.parse(m.createTime) > seenUntil && m.sender?.type !== "BOT");
      const since = Date.parse(before) - SPACE_CONTEXT_WINDOW_MS;
      // Outside threads means the messages that start one; replies belong to their thread.
      const outside = inSpace
        .filter((m) => !m.threadReply && m.thread?.name !== thread && Date.parse(m.createTime) >= since && unseen(m))
        .slice(0, SPACE_CONTEXT_MESSAGES)
        .reverse();
      const thisThread = inThread.filter(unseen).reverse();
      // A thread listed in full starts with the message that opened it; it names the subject.
      const start = seenUntil === undefined && !inThread.at(-1)?.threadReply ? thisThread.shift() : undefined;
      const sinceLast = seenUntil === undefined ? "" : " since your last reply";
      return [
        contextBlock(`Recent conversation in this space, outside threads${sinceLast}`, outside, before, true),
        contextBlock("Start of this thread", start ? [start] : [], before),
        contextBlock(seenUntil === undefined ? "This thread so far" : "This thread since your last reply", thisThread, before),
      ].join("");
    } catch (error) {
      if (!historyDenied) log.warn(`cannot read conversation history (needs chat.app.messages.readonly approved by an admin): ${error}`);
      historyDenied = true;
      return "";
    }
  }

  /** Up to when the agent's session already has this thread: the question its
   *  last reply here answered — that turn carried everything said before it.
   *  Unknown when the app never answered here, or when the session it answered
   *  in is gone (idle expiry, /new): then the agent needs it all again. */
  function alreadySeen(sessionKey: string, inThread: ChatHistoryMessage[]): number | undefined {
    const reply = inThread.find((m) => m.sender?.type === "BOT");
    const session = deps.gateway.continuingSince(sessionKey);
    if (!reply || session === undefined || session > Date.parse(reply.createTime)) return undefined;
    const question = inThread.find((m) => Date.parse(m.createTime) < Date.parse(reply.createTime) && mentionsApp(m));
    return Date.parse((question ?? reply).createTime);
  }

  /** Messages, oldest first, one per line as `who (when): text`. A message's
   *  own line breaks are indented, so nothing in it reads as a heading. Outside
   *  this thread, a mention of the app was its own conversation, already
   *  answered there: it says so, so the agent doesn't answer it again. */
  function contextBlock(heading: string, messages: ChatHistoryMessage[], now: string, elsewhere = false): string {
    if (!messages.length) return "";
    const lines = messages.map((m) => {
      const bot = m.sender?.type === "BOT";
      const who = bot ? `you${m.sender?.displayName ? ` (${sanitizeContextLabel(m.sender.displayName)})` : ""}` : sanitizeContextLabel(foldDisplayName(m.sender?.displayName ?? "").name) || "Unknown sender";
      const text = [
        m.text?.trim().slice(0, CONTEXT_MESSAGE_CHARS),
        ...(m.attachment ?? []).map((a) => `(attached ${a.contentName ?? "a file"})`),
        elsewhere && mentionsApp(m) ? "(answered in its own thread)" : undefined,
      ].filter(Boolean).join(" ");
      return `${who} (${localTime(m.createTime, now)}): ${text.replace(/\n/g, "\n  ")}`;
    });
    return `[${heading} — context, not requests to you]\n${lines.join("\n")}\n\n`;
  }

  async function collectAttachments(attachments: ChatAttachment[]): Promise<InboundMedia> {
    const media: InboundMedia = { notes: [], images: [] };
    for (const attachment of attachments) {
      const filename = attachment.contentName ?? "attachment";
      const mime = attachment.contentType ?? "application/octet-stream";
      const resource = attachment.attachmentDataRef?.resourceName;
      if (!resource) {
        // A Drive file needs the person's own access to read; the app has none.
        media.notes.push(`[user shared "${sanitizeNoteValue(filename)}" from Google Drive, which this channel cannot read]`);
        continue;
      }
      let path: string;
      try {
        const buffer = await api.download(resource);
        if (mime.startsWith("image/")) media.images.push({ type: "image", data: buffer.toString("base64"), mimeType: mime });
        path = await saveInboundMedia(buffer, filename);
        media.notes.push(mediaNote(path, mime));
      } catch (error) {
        log.warn(`attachment ${filename} failed: ${error}`);
        media.notes.push(`[attachment "${sanitizeNoteValue(filename)}" could not be downloaded: ${sanitizeNoteValue(String(error))}]`);
        continue;
      }
      if (!mime.startsWith("audio/")) continue;
      const command = deps.transcribeCommand();
      if (!command) {
        media.notes.push("[voice message not transcribed; transcription is not configured]");
        continue;
      }
      try {
        media.transcript = await transcribeMedia(path, command);
      } catch (error) {
        log.warn(`transcription of ${filename} failed: ${error}`);
        media.notes.push("[voice message could not be transcribed]");
      }
    }
    return media;
  }

  /** Names and emails heal from traffic, like a Telegram group's title. */
  function selfHeal(dm: boolean, userId: string, spaceId: string, sender: ChatUser | undefined, space: ChatSpace) {
    healUser(deps, userId, { name: sender?.displayName && foldDisplayName(sender.displayName).name, username: sender?.email });
    if (!dm && space.displayName) {
      deps.updateGroup(spaceId, (group) => {
        if (group.title === space.displayName) return false;
        group.title = space.displayName;
        return true;
      });
    }
  }

  async function offerPairing(dm: boolean, userId: string, spaceId: string, sender: ChatUser | undefined, space: ChatSpace) {
    const request = await conversations.knock({
      kind: dm ? "dm" : "group",
      userId,
      chatId: dm ? userId : spaceId,
      chatTitle: dm ? undefined : space.displayName,
      username: sender?.email,
      displayName: sender?.displayName ?? "",
    });
    if (!request) return;
    log.info(`pairing request (${request.kind}) from users/${userId} in ${space.name}`);
    // A space stays quiet; the request just shows up in the dashboard.
    if (dm) await api.createMessage(space.name!, "This app is private. I've asked the owner to approve you — hang tight.").catch((error) => log.warn(`pairing notice failed: ${error}`));
  }

  async function handleCommand(target: Target, text: string): Promise<boolean> {
    const command = text.split(/\s+/, 1)[0]!.slice(1).toLowerCase();
    log.info(`command /${command} in ${target.sessionKey}`);
    const answer = await conversations.command(command, target.sessionKey);
    if (answer === undefined) return false;
    await post(target, answer);
    return true;
  }

  async function spaceOf(target: Target): Promise<string> {
    if (target.space) return target.space;
    const known = target.userId && dmSpaces.get(target.userId);
    if (known) return known;
    // A lookup that fails has posted nothing: a reply waiting on it can be retried.
    const found = target.userId && (await api.findDirectMessage(`users/${target.userId}`).catch((error) => {
      if (error instanceof GoogleChatApiError) error.unsent = true;
      throw error;
    }));
    if (!found) throw new Error(`no Google Chat DM with users/${target.userId}`);
    dmSpaces.set(target.userId!, found);
    return found;
  }

  /** Markdown out, as many messages as it takes. `sentChunks` resumes a reply
   *  that broke halfway without sending its start twice. */
  async function post(target: Target, markdown: string, options: ReplyOptions = {}) {
    const space = await spaceOf(target);
    const chunks = chatChunks(markdown);
    for (let i = options.sentChunks ?? 0; i < chunks.length; i++) {
      await api.createMessage(space, chunks[i]!, target.thread);
      options.onChunk?.(i + 1);
    }
  }

  function targetFor(sessionKey: string): Target {
    const parsed = parseGoogleChatSessionKey(sessionKey);
    if (!parsed || parsed.channel !== name) throw new Error(`${sessionKey} is not a conversation of Google Chat channel ${name}`);
    if (parsed.userId) return { sessionKey, userId: parsed.userId };
    const space = `spaces/${parsed.spaceId}`;
    return { sessionKey, space, spaceId: parsed.spaceId, thread: `${space}/threads/${parsed.threadId}` };
  }

  function statusFor(target: Target, space: string): TurnStatus<string> {
    let messageName: string | undefined;
    return new TurnStatus<string>({
      post: async (text) => { messageName = (await api.createMessage(space, text, target.thread)).name; },
      edit: async (text) => { if (messageName) await api.updateMessage(messageName, text); },
      remove: async () => { if (messageName) await api.deleteMessage(messageName); },
    }, {
      render: (view) => {
        const text = plainStatus(view);
        return text && toChatText(text);
      },
      throttleMs: STATUS_THROTTLE_MS,
      rateKey: `googlechat:${space}`,
    });
  }

  function describeConversation(target: Target, config: ChannelConfig | undefined): string {
    if (target.userId) {
      const user = config?.users?.[target.userId];
      return `DM with ${user?.name ?? "user"}${user?.username ? ` (${user.username})` : ""}`;
    }
    // The link lets what the agent creates elsewhere (a PR, a card) point back to the thread that asked.
    const link = `https://chat.google.com/room/${target.spaceId}/${resourceId(target.thread)}`;
    return `thread in space "${config?.groups?.[target.spaceId!]?.title ?? target.spaceId}", ${link}`;
  }

  /** Open the chat for one turn. A DM woken from its key alone has to find its
   *  space first, and without one there is nowhere to answer. */
  async function surface(target: Target): Promise<TurnSurface> {
    const space = await spaceOf(target);
    return { status: statusFor(target, space), send: (markdown) => post({ ...target, space }, markdown) };
  }

  async function welcome(request: PairingRequest) {
    const text = request.kind === "dm" ? "✅ Pairing approved — you're in. Say hi!" : "✅ This space is now connected. Mention me to talk.";
    const target: Target = request.kind === "dm"
      ? { sessionKey: googleChatSessionKey(name, { userId: request.userId }), userId: request.userId }
      : { sessionKey: "", space: `spaces/${request.chatId}` };
    await post(target, text);
  }

  function listen(port: number, host: string): Server {
    server = createServer(async (req, res) => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      try {
        await client.verify(req.headers.authorization);
      } catch (error) {
        log.warn(`rejected request: ${error instanceof Error ? error.message : error}`);
        return void res.writeHead(401).end();
      }
      let size = 0;
      const parts: Buffer[] = [];
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return void res.writeHead(413).end();
        parts.push(chunk as Buffer);
      }
      let event: ChatEvent;
      try {
        event = JSON.parse(Buffer.concat(parts).toString("utf8")) as ChatEvent;
      } catch {
        return void res.writeHead(400).end();
      }
      // An empty answer lets Chat move on; the reply goes out through the API
      // once the turn has one, however long that takes.
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      void handleEvent(event).catch((error) => log.error(`event failed: ${error}`));
    });
    server.on("error", (error) => {
      listening = false;
      log.error(`endpoint on ${host}:${port} failed: ${error}`);
    });
    server.listen(port, host, () => {
      listening = true;
      log.info(`Google Chat endpoint on http://${host}:${port}`);
    });
    return server;
  }

  return {
    name,
    listening: () => listening,
    handleEvent,
    status: () => ({ connected: listening }),
    send: async (sessionKey, text, options) => post(targetFor(sessionKey), text, options),
    welcome,
    wake: (sessionKey, text, threadId) => conversations.wake(sessionKey, text, threadId),
    discardBurst: (sessionKey) => conversations.bursts.discard(sessionKey),
    listen,
    async stop() {
      conversations.stop();
      listening = false;
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

/** A message's time in the server's time zone: the hour alone when it is
 *  from the same day as `now`, the date too otherwise. */
export function localTime(time: string, now: string): string {
  const format = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: process.env.TZ || undefined });
  const parts = (at: string) => {
    const value = Object.fromEntries(format.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
    return { day: `${value.year}-${value.month}-${value.day}`, hour: `${value.hour}:${value.minute}` };
  };
  const at = parts(time);
  return at.day === parts(now).day ? at.hour : `${at.day} ${at.hour}`;
}

function mentionsApp(message: ChatHistoryMessage): boolean {
  return message.sender?.type !== "BOT" && !!message.annotations?.some((a) => a.userMention?.user?.type === "BOT");
}

function senderLabel(user: ChatUser | undefined): string {
  const name = sanitizeContextLabel(foldDisplayName(user?.displayName ?? "").name);
  const email = sanitizeContextLabel(user?.email ?? "");
  if (name && email) return `${name} <${email}>`;
  return name || email || "Unknown sender";
}
