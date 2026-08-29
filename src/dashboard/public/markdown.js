/* The transcript's markdown. Its own module because it is the one piece of the
   dashboard that is pure text in, text out — so it is the one piece that can be
   tested outside a browser. */

// Escapes text for both element and attribute contexts. The quote escape
// matters for links: inline() drops the captured URL into an href="…", and
// without it a message like [x](https://a" onerror=…) could break out of the
// attribute.
export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Minimal markdown for transcripts: fences, headings, lists, quotes, paragraphs.
 *
 * Split on the fence marker rather than on a fence *pair*: odd chunks are code,
 * and the last one is code even when its closing fence hasn't arrived yet —
 * which is the normal state of a message being streamed, and used to render as
 * a paragraph starting with three backticks until the turn caught up.
 */
export function md(text) {
  return text
    .split("```")
    .map((chunk, index) => (index % 2 === 0 ? blocks(chunk) : `<pre><code>${esc(chunk.replace(/^\w*\n?/, ""))}</code></pre>`))
    .join("");
}

/** Line-driven block parser. Agents write lists and headings constantly, and
 *  rendering them as literal "- " lines inside one pre-wrap blob was the single
 *  biggest thing making a transcript hard to read. */
function blocks(text) {
  let out = "";
  let list; // "ul" | "ol" while one is open
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out += `<p>${paragraph.map(inline).join("<br>")}</p>`;
    paragraph = [];
  };
  const flushList = () => {
    if (list) out += `</${list}>`;
    list = undefined;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); out += `<h4>${inline(heading[1])}</h4>`; continue; }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      flushParagraph();
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== kind) { flushList(); out += `<${kind}>`; list = kind; }
      // A GFM task box is a checkbox, not a "[ ]" the reader has to decode.
      const task = item[1].match(/^\[([ xX])\]\s+(.*)$/);
      out += task
        ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}>${inline(task[2])}</li>`
        : `<li>${inline(item[1])}</li>`;
      continue;
    }
    flushList();
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flushParagraph(); out += `<blockquote>${inline(quote[1])}</blockquote>`; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); out += "<hr>"; continue; }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out;
}

/** Bold, italics, inline code and links — everything that lives inside a line. */
export function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="link" href="$2" target="_blank" rel="noopener">$1</a>');
}
