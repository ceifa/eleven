/* Message identity and presentation live outside the SPA so the optimistic
   bubble and the durable transcript agree about what "the same message" is. */

const MEDIA_NOTE = /^\[media attached: (\S+) \(([^)\n]*)\)\]$/gm;

export function splitMedia(text) {
  const media = [];
  const stripped = text.replace(MEDIA_NOTE, (_, path, mime) => {
    media.push({ id: path.split("/").pop(), mime });
    return "";
  });
  return { text: media.length ? stripped.replace(/\n{3,}/g, "\n\n").trim() : text, media };
}

/** ⚡ is the diagnostic view: no friendly attachment rendering, because its
 *  job is to show the literal text the agent received. */
export const presentMessage = (text, exact = false) => exact ? { text, media: [] } : splitMedia(text);

const mediaIds = (text) => splitMedia(text).media.map(({ id }) => id).sort();

/** A local attachment first appears with its upload receipt, then comes back
 *  from the daemon as an absolute path (and a voice transcript). The stored
 *  basename is the stable identity across those two representations. */
export function sameMessage(left, right, prefixChars = 200) {
  if (left.role !== right.role) return false;
  if (left.text.slice(0, prefixChars) === right.text.slice(0, prefixChars)) return true;
  const a = mediaIds(left.text);
  const b = mediaIds(right.text);
  return a.length > 0 && a.length === b.length && a.every((id, index) => id === b[index]);
}
