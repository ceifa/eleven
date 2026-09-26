/**
 * What a thread is called: the opening of its first message.
 *
 * Not the literal opening, though. A message from a shared conversation arrives
 * wrapped in attribution — `[Gabriel @c3if4]`, `[Replying to a message from …]`
 * — one bracketed line each, ahead of what was actually said. That envelope is
 * for the model. As a title it is the same eighty characters on every thread
 * of the group, and the words that tell two threads apart never make the cut.
 */
const TITLE_CHARS = 80;

// A whole line of envelope, or — in a title that was cut at eighty characters
// before this existed — the envelope line the cut left open at the end.
const ENVELOPE_LINE = /^\[[^\n]*\](?:\n|$)|^\[[^\n\]]*$/;

/** The readable part of a message, clipped to a title. Empty when the message
 *  is all envelope (a bare attachment, say) — the caller picks a fallback. */
export function threadTitle(text: string): string {
  let rest = text.trimStart();
  while (ENVELOPE_LINE.test(rest)) rest = rest.replace(ENVELOPE_LINE, "").trimStart();
  return rest.trimEnd().slice(0, TITLE_CHARS);
}

/**
 * The title update a message makes, if any. The first message names the thread.
 * A title that is nothing but envelope — the first message was a bare photo in
 * a group, or it was written before the envelope was dropped — is not a name
 * yet, so the next message that says something takes its place.
 */
export function retitle(current: string | undefined, text: string): { title: string } | undefined {
  if (current && threadTitle(current)) return undefined;
  const title = threadTitle(text);
  if (title) return { title };
  return current ? undefined : { title: text.slice(0, TITLE_CHARS) };
}

/** A stored title as it is shown. Titles written before the envelope was
 *  dropped still carry it; one that is nothing but envelope stays as it is,
 *  because an attribution is still more to go on than a blank. */
export const displayTitle = (title: string | undefined): string | undefined =>
  title === undefined ? undefined : threadTitle(title) || title;
