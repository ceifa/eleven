/* The transcript's markdown. Its own module because it is the one piece of the
   dashboard that is pure text in, text out — so it is the one piece that can be
   tested outside a browser.

   The parsing is marked's (GFM: tables, nested lists, strikethrough, autolinks,
   reference links — the hand-rolled line parser this replaced handled none of
   them, and a table arrived as a row of pipes). What stays ours is the output:
   marked emits raw HTML and unfiltered hrefs by design, and a transcript row is
   whatever a channel delivered, so the renderer below is what keeps a message
   from becoming markup. */

import { Marked } from "./vendor/marked.esm.js";

// Escapes text for both element and attribute contexts. The quote escape
// matters for links: link() drops the URL into an href="…", and without it a
// message like [x](https://a" onerror=…) could break out of the attribute.
export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The only schemes that may reach an href. Anything else — javascript:, data:,
// a bare "vbscript:" — renders as the link's text, unclickable.
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/** A link, or its text when the target isn't something we'll hand to a click. */
function anchor(href, body, title) {
  if (!SAFE_SCHEME.test(href)) return body;
  const label = title ? ` title="${esc(title)}"` : "";
  return `<a class="link" href="${esc(href)}" target="_blank" rel="noopener"${label}>${body}</a>`;
}

const marked = new Marked({
  gfm: true,
  // A line break an agent typed is a line break it meant: chat prose is written
  // for the bubble, not reflowed like a document.
  breaks: true,
  renderer: {
    // Raw HTML in a message is content, not markup — this is the one override
    // that has to exist, and it is why no sanitizer is needed downstream.
    html: ({ text }) => esc(text),
    // Every heading is an h4: inside a chat bubble even an h2 at document scale
    // would shout, and the stylesheet only dresses one level.
    heading({ tokens }) {
      return `<h4>${this.parser.parseInline(tokens)}</h4>`;
    },
    link({ href, title, tokens }) {
      return anchor(href, this.parser.parseInline(tokens), title);
    },
    // An image is rendered as a link, never as an <img>: a transcript can carry
    // any URL, and fetching it would leak that the message was read to whoever
    // owns the host. Real attachments never come through here — they arrive as
    // media on the message and get their own preview.
    image({ href, text, title }) {
      return anchor(href, esc(text || href), title);
    },
    checkbox({ checked }) {
      return `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
    },
    // A GFM task box is a checkbox, not a "[ ]" the reader has to decode — and
    // the class is what drops the bullet beside it.
    listitem(item) {
      return `<li${item.task ? ' class="task"' : ""}>${this.parser.parse(item.tokens)}</li>`;
    },
    // marked's own table, wrapped: six columns are wider than a chat bubble, so
    // the wrapper scrolls instead of the message stretching the transcript.
    table(token) {
      const cells = (row) => row.map((cell) => this.tablecell(cell)).join("");
      const body = token.rows.map((row) => `<tr>${cells(row)}</tr>`).join("");
      return `<div class="msg-table"><table><thead><tr>${cells(token.header)}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
    },
  },
});

/**
 * Render a message body. Never throws and never returns nothing: a parser that
 * chokes on some pathological input must not blank the row it was given.
 *
 * A half-written fence renders as code from the first backtick, which is the
 * normal state of a message being streamed — marked reads an unclosed fence as
 * a code block, so the block appears as it is typed instead of showing three
 * backticks and a paragraph until the turn catches up.
 */
export function md(text) {
  try {
    return marked.parse(text).trim();
  } catch {
    return `<p>${esc(text)}</p>`;
  }
}
