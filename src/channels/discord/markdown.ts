import { splitMarkdown } from "../text.ts";

// Discord caps a message at 2000 characters. The slack pays for the fence
// markers splitMarkdown adds when a code block spans two messages.
const MESSAGE_LIMIT = 1_900;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
// Wider than this, a monospace row wraps in a phone's code block and the
// columns fall apart.
const TABLE_WIDTH = 60;

/**
 * Agent markdown as Discord renders it. Discord draws headings up to `###`,
 * lists, quotes, code and spoilers like any chat, but not tables — a table
 * arrives as rows of pipes. A narrow one becomes a monospace block with the
 * columns lined up; a wide one, one entry per row, which wraps cleanly.
 */
export function toDiscordMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      out.push(line);
      continue;
    }
    if (!fence && line.includes("|") && TABLE_DELIMITER.test(lines[i + 1] ?? "") && lines[i + 1]!.includes("-")) {
      const rows = [line];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim()) rows.push(lines[j++]!);
      out.push(...renderTable(rows.map(cells)));
      i = j - 1;
      continue;
    }
    // Discord stops at ###: a deeper heading would show its hashes.
    out.push(fence ? line : line.replace(/^#{4,6}\s+(.+)$/, "**$1**"));
  }
  return out.join("\n");
}

/** Discord-ready markdown, cut into messages that fit. */
export function discordChunks(markdown: string): string[] {
  return splitMarkdown(toDiscordMarkdown(markdown), MESSAGE_LIMIT).filter((chunk) => chunk.trim());
}

/** Text that renders as written, whatever it contains. */
export function escapeMarkdown(text: string): string {
  return text.replaceAll(/[\\*_~`|]/g, "\\$&");
}

function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  // An escaped pipe is part of the cell, not a border.
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function renderTable(markdown: string[][]): string[] {
  const rows = markdown.map((row) => row.map((cell) => cell.replaceAll(/\*\*|__|`/g, "")));
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...rows.map((row) => [...(row[c] ?? "")].length)));
  if (widths.reduce((sum, width) => sum + width + 2, -2) > TABLE_WIDTH) return renderEntries(markdown);
  const render = (row: string[]) => widths.map((width, c) => (row[c] ?? "").padEnd(width + (row[c] ?? "").length - [...(row[c] ?? "")].length)).join("  ").trimEnd();
  const [header, ...body] = rows;
  return ["```", render(header!), widths.map((width) => "─".repeat(width)).join("  "), ...body.map(render), "```"];
}

function renderEntries([header, ...body]: string[][]): string[] {
  const plain = (cell = "") => cell.replaceAll(/\*\*|__/g, "");
  return body.flatMap((row, r) => [
    ...(r ? [""] : []),
    `**${plain(row[0])}**`,
    ...row.slice(1).flatMap((cell, c) => (cell ? [`- ${header![c + 1] ? `${plain(header![c + 1])}: ` : ""}${cell}`] : [])),
  ]);
}
