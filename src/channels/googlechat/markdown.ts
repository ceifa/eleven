import { toDiscordMarkdown } from "../discord/markdown.ts";
import { splitMarkdown } from "../text.ts";

// Chat takes up to 32,000 bytes a message, but a wall that long is unreadable
// in a thread; this is where a long answer turns into several messages.
const MESSAGE_LIMIT = 4_000;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Agent markdown in the syntax Chat's API renders: `*bold*`, `_italic_`,
 * `~strike~`, `[text](url)` links, code as it is. Chat draws no headings and no
 * tables, so a heading becomes a bold line and a table a monospace block.
 */
export function toChatText(markdown: string): string {
  let fence: string | undefined;
  return toDiscordMarkdown(markdown).split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return line;
    }
    return fence ? line : inline(line);
  }).join("\n");
}

/** Chat-ready text, cut into messages that fit. */
export function chatChunks(markdown: string): string[] {
  return splitMarkdown(toChatText(markdown), MESSAGE_LIMIT).filter((chunk) => chunk.trim());
}

function inline(line: string): string {
  // Inline code is left exactly as written; everything else is converted around it.
  return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : prose(part))).join("");
}

function prose(text: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
  if (heading) return `*${heading[1]!.replaceAll(/\*\*|__/g, "")}*`;
  const bold: string[] = [];
  // Bold first, into placeholders, so its asterisks aren't read as italics after.
  return text
    .replace(/^(\s*)[*+]\s/, "$1• ")
    .replaceAll(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a: string | undefined, b: string | undefined) => `\u0000${bold.push(a ?? b ?? "") - 1}\u0000`)
    .replaceAll(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "_$1_")
    .replaceAll(/~~(.+?)~~/g, "~$1~")
    .replaceAll(/\u0000(\d+)\u0000/g, (_, index: string) => `*${bold[Number(index)]}*`);
}
