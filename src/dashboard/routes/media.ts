import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { resolveMediaPath, saveInboundMedia, validMime } from "../../media-store.ts";
import type { DashboardContext } from "../context.ts";
import { ApiError, rawBody } from "../http.ts";
import type { Route } from "../router.ts";

// What a composer may upload in one file. Telegram tops out at 20 MB; this is
// the same order of magnitude, and the ceiling a browser is held to so a slip of
// the finger on a video file can't stream gigabytes into the state directory.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Types a stored attachment may be rendered as, inside the dashboard's own
// origin. Everything else is downloaded instead: an uploaded .html or .svg
// served inline would be a script running as the page that can drive the agent.
// (image/svg+xml is deliberately absent from this list for that reason.)
const INLINE_MEDIA = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/)/;

/** Bytes rather than JSON: attachments in and out, and conversation pictures. */
export function mediaRoutes({ channels }: DashboardContext): Route[] {
  return [
    // An attachment on its way to a turn. The body is the file itself — a
    // multipart parser would buy nothing here, since one upload is one file.
    // The answer is a receipt: the stored name, which is the only handle the
    // page ever holds (the absolute path stays on this side of the tunnel).
    {
      method: "POST",
      pattern: "/media",
      async handler({ req, url, send }) {
        const bytes = await rawBody(req, MAX_UPLOAD_BYTES);
        if (!bytes.length) throw new ApiError(400, "upload is empty");
        const name = url.searchParams.get("name") ?? "attachment";
        const stored = await saveInboundMedia(bytes, name);
        return send(201, { id: basename(stored), bytes: bytes.length, mime: validMime(req.headers["content-type"]) });
      },
    },
    // Reading one back: how the transcript shows a photo instead of a path,
    // for anything attached here *or* sent from a channel. The caller says how
    // it wants the bytes typed, and only the renderable types are honored —
    // the rest is served as an opaque download, never as a document in this
    // origin.
    {
      method: "GET",
      pattern: "/media/*",
      async handler({ url, params, send, deliver }) {
        const file = resolveMediaPath(decodeURIComponent(params["*"]));
        let bytes: Buffer | undefined;
        try {
          bytes = file ? await readFile(file) : undefined;
        } catch {
          bytes = undefined;
        }
        if (!bytes) return send(404, { error: "media not found" });
        const declared = validMime(url.searchParams.get("type") ?? undefined) ?? "";
        const inline = INLINE_MEDIA.test(declared);
        return deliver(200, {
          "content-type": inline ? declared : "application/octet-stream",
          "content-disposition": inline ? "inline" : "attachment",
          "x-content-type-options": "nosniff",
          // Stored names are unique per file and their contents never change.
          "cache-control": "private, max-age=31536000, immutable",
        }, bytes);
      },
    },
    // A conversation's picture, fetched from Telegram once and kept on disk.
    // Cached here for a day (the URL changes when a topic's emoji does); a
    // miss for five minutes, so a chat without a photo isn't asked for on
    // every paint, and one that just set a photo shows it soon enough.
    {
      method: "GET",
      pattern: "/avatars/*",
      async handler({ res, params, deliver }) {
        const avatar = await channels.avatar(decodeURIComponent(params["*"]));
        if (!avatar) {
          res.writeHead(404, { "cache-control": "private, max-age=300" });
          return res.end();
        }
        return deliver(200, {
          "content-type": avatar.type,
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=86400",
        }, avatar.bytes);
      },
    },
  ];
}
