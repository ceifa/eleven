import assert from "node:assert/strict";
import test from "node:test";
import { md } from "../src/dashboard/public/markdown.js";

/* The transcript renderer used to be one escaped blob with pre-wrap holding it
   together: a list arrived as literal "- " lines, a heading as bold text, and
   every blank line the writer used became a full empty row. It then became a
   hand-rolled line parser, which covered those shapes and nothing else. The
   parsing is marked's now; these are the shapes an agent actually writes, plus
   the output guarantees that are ours and not marked's. */

test("a bullet list is a list, not lines that start with a dash", () => {
  const html = md("Fechei o mês:\n\n- entradas: 42\n- saídas: 28\n- sobra: 14");
  assert.equal(html, "<p>Fechei o mês:</p>\n<ul>\n<li>entradas: 42</li><li>saídas: 28</li><li>sobra: 14</li></ul>");
});

test("a numbered list is ordered, and a nested list nests instead of flattening", () => {
  assert.equal(md("1. first\n2. second"), "<ol>\n<li>first</li><li>second</li></ol>");
  // The line parser this replaced emitted both levels as siblings of one <ul>.
  assert.equal(md("- a\n  - b\n- c"), "<ul>\n<li>a<ul>\n<li>b</li></ul>\n</li><li>c</li></ul>");
});

test("a checklist renders checkboxes, checked and not", () => {
  assert.equal(
    md("- [ ] open\n- [x] done"),
    '<ul>\n<li class="task"><input type="checkbox" disabled>open</li>' +
      '<li class="task"><input type="checkbox" disabled checked>done</li></ul>',
  );
});

test("headings are headings, and every level is an h4", () => {
  assert.equal(md("## Resumo\ntexto"), "<h4>Resumo</h4><p>texto</p>");
  assert.equal(md("# T"), "<h4>T</h4>");
  assert.equal(md("#### T"), "<h4>T</h4>");
});

test("lines inside a paragraph stay on separate lines, and a blank line ends it", () => {
  assert.equal(md("um\ndois\n\ntrês"), "<p>um<br>dois</p>\n<p>três</p>");
});

test("quotes and rules get their own blocks", () => {
  assert.equal(md("> citado"), "<blockquote>\n<p>citado</p>\n</blockquote>");
  assert.equal(md("antes\n\n---\n\ndepois"), "<p>antes</p>\n<hr>\n<p>depois</p>");
});

test("a fenced block keeps its text verbatim, language tagged for later", () => {
  assert.equal(
    md("veja:\n\n```js\nconst a = 1 < 2;\n```"),
    '<p>veja:</p>\n<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>',
  );
});

/* The streaming case: half a fence is on screen for as long as the model takes
   to write the block, and it used to render as a paragraph of backticks. */
test("a fence whose closing marker hasn't arrived yet already renders as code", () => {
  assert.equal(md("olha:\n```sh\nnpm test"), '<p>olha:</p>\n<pre><code class="language-sh">npm test\n</code></pre>');
});

test("inline formatting survives inside blocks", () => {
  assert.equal(md("- **bold** and `code`"), "<ul>\n<li><strong>bold</strong> and <code>code</code></li></ul>");
  assert.equal(md("~~riscado~~ e _itálico_"), "<p><del>riscado</del> e <em>itálico</em></p>");
  assert.equal(
    md("[eleven](https://example.com)"),
    '<p><a class="link" href="https://example.com" target="_blank" rel="noopener">eleven</a></p>',
  );
});

/* The whole reason for the rewrite: an agent writes tables constantly and every
   one of them used to land as a paragraph of pipes. */
test("a GFM table is a table, with the column alignment it asked for", () => {
  assert.equal(
    md("| conta | saldo |\n| --- | ---: |\n| nubank | 1.200 |\n| itaú | 340 |"),
    '<div class="msg-table"><table><thead><tr><th>conta</th>\n<th align="right">saldo</th>\n</tr></thead>' +
      '<tbody><tr><td>nubank</td>\n<td align="right">1.200</td>\n</tr>' +
      '<tr><td>itaú</td>\n<td align="right">340</td>\n</tr></tbody></table></div>',
  );
  // A header with no body rows still renders — the streaming state of a table.
  assert.equal(
    md("| a | b |\n| --- | --- |"),
    '<div class="msg-table"><table><thead><tr><th>a</th>\n<th>b</th>\n</tr></thead></table></div>',
  );
});

/* Every transcript row is untrusted text — it is whatever a channel delivered.
   marked passes raw HTML and any href straight through, so these are the
   renderer overrides earning their keep, not library behaviour. */
test("markup in a message is escaped, in a block, inline, and in code alike", () => {
  assert.equal(md("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(md("antes <b>meio</b> depois"), "<p>antes &lt;b&gt;meio&lt;/b&gt; depois</p>");
  assert.equal(
    md("```\n<script>alert(1)</script>\n```"),
    "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>",
  );
});

test("only a clickable scheme becomes a link; the rest is text", () => {
  assert.equal(md("[j](javascript:alert(1))"), "<p>j</p>");
  assert.equal(md("[m](mailto:gabriel@example.com)"), '<p><a class="link" href="mailto:gabriel@example.com" target="_blank" rel="noopener">m</a></p>');
  // A quote inside a link target cannot break out of the href it is dropped in.
  assert.equal(
    md('[x](https://a"onerror=alert)'),
    '<p><a class="link" href="https://a&quot;onerror=alert" target="_blank" rel="noopener">x</a></p>',
  );
});

/* An <img> would fetch a URL the transcript happened to contain, telling
   whoever owns the host that the message was opened. */
test("an image is a link to the image, never a fetch", () => {
  assert.equal(
    md("![gráfico](https://tracker.example/pixel.png)"),
    '<p><a class="link" href="https://tracker.example/pixel.png" target="_blank" rel="noopener">gráfico</a></p>',
  );
  assert.equal(md("![](javascript:alert(1))"), "<p>javascript:alert(1)</p>");
});

test("empty input renders as nothing rather than throwing", () => {
  assert.equal(md(""), "");
  assert.equal(md("\n\n"), "");
});
