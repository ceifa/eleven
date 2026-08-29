import assert from "node:assert/strict";
import test from "node:test";
import { md } from "../src/dashboard/public/markdown.js";

/* The transcript renderer used to be one escaped blob with pre-wrap holding it
   together: a list arrived as literal "- " lines, a heading as bold text, and
   every blank line the writer used became a full empty row. These are the
   shapes an agent actually writes. */

test("a bullet list is a list, not lines that start with a dash", () => {
  const html = md("Fechei o mês:\n\n- entradas: 42\n- saídas: 28\n- sobra: 14");
  assert.equal(html, "<p>Fechei o mês:</p><ul><li>entradas: 42</li><li>saídas: 28</li><li>sobra: 14</li></ul>");
});

test("a numbered list keeps its own kind, and a switch closes the previous one", () => {
  assert.equal(md("1. first\n2) second"), "<ol><li>first</li><li>second</li></ol>");
  assert.equal(md("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("a checklist renders checkboxes, checked and not", () => {
  assert.equal(
    md("- [ ] open\n- [x] done"),
    '<ul><li class="task"><input type="checkbox" disabled>open</li>' +
      '<li class="task"><input type="checkbox" disabled checked>done</li></ul>',
  );
});

test("headings are headings and close whatever block preceded them", () => {
  assert.equal(md("## Resumo\ntexto"), "<h4>Resumo</h4><p>texto</p>");
  assert.equal(md("- a\n# T"), "<ul><li>a</li></ul><h4>T</h4>");
});

test("lines inside a paragraph stay on separate lines, and a blank line ends it", () => {
  assert.equal(md("um\ndois\n\ntrês"), "<p>um<br>dois</p><p>três</p>");
});

test("quotes and rules get their own blocks", () => {
  assert.equal(md("> citado"), "<blockquote>citado</blockquote>");
  assert.equal(md("antes\n\n---\n\ndepois"), "<p>antes</p><hr><p>depois</p>");
});

test("a fenced block keeps its text verbatim, language tag stripped", () => {
  assert.equal(md("veja:\n\n```js\nconst a = 1 < 2;\n```"), "<p>veja:</p><pre><code>const a = 1 &lt; 2;\n</code></pre>");
});

/* The streaming case: half a fence is on screen for as long as the model takes
   to write the block, and it used to render as a paragraph of backticks. */
test("a fence whose closing marker hasn't arrived yet already renders as code", () => {
  assert.equal(md("olha:\n```sh\nnpm test"), "<p>olha:</p><pre><code>npm test</code></pre>");
});

test("inline formatting survives inside blocks", () => {
  assert.equal(md("- **bold** and `code`"), "<ul><li><b>bold</b> and <code>code</code></li></ul>");
  assert.equal(
    md("[eleven](https://example.com)"),
    '<p><a class="link" href="https://example.com" target="_blank" rel="noopener">eleven</a></p>',
  );
});

/* Every transcript row is untrusted text — it is whatever a channel delivered. */
test("markup in a message is escaped, in text and in an href alike", () => {
  assert.equal(md("<img src=x onerror=alert(1)>"), "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  assert.equal(md('```\n<script>alert(1)</script>\n```'), "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>");
  // A quote inside a link target cannot break out of the href it is dropped in.
  assert.equal(
    md('[x](https://a"onerror=alert)'),
    '<p><a class="link" href="https://a&quot;onerror=alert" target="_blank" rel="noopener">x</a></p>',
  );
});
