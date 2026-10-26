// Text shaping every channel does the same way: names strangers write, quotes,
// and agent markdown cut to what one message holds.

// Channels can redeliver updates after reconnects/restarts; remember handled
// message ids long enough to swallow those instead of running double turns.
const SEEN_MESSAGE_TTL_MS = 20 * 60 * 1000;
const MAX_SEEN_MESSAGES = 5_000;

const REPLY_QUOTE_LIMIT = 200;
const REPLY_QUOTE_HEAD = 120;
const REPLY_QUOTE_TAIL = 70;

/** Remembers handled messages so a redelivery doesn't run the turn twice. */
export function createSeenMessages(now: () => number = Date.now) {
  // Insertion-ordered so eviction drops the oldest.
  const seen = new Map<string, number>();
  return function alreadyHandled(chatId: number | string, messageId: number | string): boolean {
    const key = `${chatId}:${messageId}`;
    const at = seen.get(key);
    if (at !== undefined && now() - at < SEEN_MESSAGE_TTL_MS) return true;
    seen.delete(key);
    seen.set(key, now());
    if (seen.size > MAX_SEEN_MESSAGES) seen.delete(seen.keys().next().value!);
    return false;
  };
}

/**
 * Display names are attacker-controlled, and a stranger who writes theirs in
 * styled unicode ("T𝚎𝐥𝚎𝚐𝚛𝚊𝗺") or pads it with invisible characters looks
 * official everywhere the name lands — the pairing panel, the config, a prompt
 * label. NFKC folds those lookalikes back to plain letters, so the name reads
 * as what it imitates; comparing against plain NFC (which differs only for the
 * compatibility characters) is also the detector: a name that moves was
 * wearing a costume.
 */
export function foldDisplayName(value: string): { name: string; disguised: boolean } {
  const visible = value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");
  const name = visible.normalize("NFKC").replaceAll(/\s+/g, " ").trim();
  return { name, disguised: name !== value.normalize("NFC").replaceAll(/\s+/g, " ").trim() };
}

/** A name or handle fit to sit inside a `[...]` attribution line. */
export function sanitizeContextLabel(value: string): string {
  return value.replaceAll("[", "(").replaceAll("]", ")").replaceAll(/\s+/g, " ").trim();
}

export function compactReplyQuote(text: string): string {
  const chars = [...text.replaceAll(/\s+/g, " ").trim()];
  if (chars.length <= REPLY_QUOTE_LIMIT) return chars.join("");
  return `${chars.slice(0, REPLY_QUOTE_HEAD).join("")}…${chars.slice(-REPLY_QUOTE_TAIL).join("")}`;
}

/** Split markdown into messages of at most `limit` characters (plus the fence
 * markers a code block cut in two needs), on paragraphs when it can. */
export function splitMarkdown(markdown: string, limit: number): string[] {
  if (markdown.length <= limit) return [markdown];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of markdown.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    // Candidate overflows: flush what we have, then place the paragraph itself —
    // slicing it when even a single paragraph exceeds the limit (previously
    // an oversized paragraph following accumulated text slipped through whole).
    // Its last piece stays open as `current`, so a short tail still absorbs the
    // paragraphs that follow instead of becoming a message of its own.
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length > limit) {
      const pieces = sliceParagraph(paragraph, limit);
      chunks.push(...pieces.slice(0, -1));
      current = pieces.at(-1)!;
    } else {
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return balanceFences(chunks);
}

/**
 * Cut an oversized paragraph into limit-sized pieces. Two boundaries matter.
 * A cut must never land between the halves of a surrogate pair: `slice` counts
 * UTF-16 code units, so cutting at a fixed offset splits an emoji in half and
 * the lone surrogate left behind makes the API reject the whole message.
 * And a cut should prefer the last line break in the window — landing mid-line
 * shreds tables, list items and fences far more visibly than breaking early.
 */
function sliceParagraph(paragraph: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > limit) {
    let cut = limit;
    const lastBreak = rest.lastIndexOf("\n", cut - 1);
    if (lastBreak >= limit / 2) cut = lastBreak + 1;
    // A line break is never half of a pair, so this only matters for hard cuts:
    // move the whole pair to the next piece.
    else if (isLowSurrogate(rest.charCodeAt(cut))) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** An open fenced block: the run of backticks or tildes that opened it, plus
 *  the rest of the opening line (the language hint) so it can be reopened. */
interface Fence {
  marker: string;
  info: string;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fence state after reading `text`, starting from `open`. */
function scanFence(text: string, open: Fence | undefined): Fence | undefined {
  for (const line of text.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const [, marker, info] = match;
    // CommonMark: a closing fence repeats the opening character at least as
    // many times and carries no info string. Anything else opens a block.
    if (!open) open = { marker, info };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !info.trim()) open = undefined;
  }
  return open;
}

/**
 * Make every chunk renderable on its own: a chunk ending inside a fenced block
 * gets the block closed, and the next chunk reopens it with the same marker and
 * language hint. Without this, splitting a long code block leaves one message
 * with an unterminated fence and the next one with orphan code.
 */
function balanceFences(chunks: string[]): string[] {
  const balanced: string[] = [];
  let open: Fence | undefined;
  for (const chunk of chunks) {
    const reopen = open;
    open = scanFence(chunk, open);
    balanced.push(`${reopen ? `${reopen.marker}${reopen.info}\n` : ""}${chunk}${open ? `\n${open.marker}` : ""}`);
  }
  return balanced;
}
