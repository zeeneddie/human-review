import test from "node:test";
import assert from "node:assert/strict";
import { aligned, contentBlocks, forEditor, sourceEdits, splice, stableBaseline, tidyBlock, unwrap } from "../src/md-splice.js";

// The real editor, in jsdom (a dev dependency that needs Node 22+).
let Editor = null;
try {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id=e></div></body></html>", { pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "getComputedStyle", "DOMParser", "MutationObserver", "Range", "Element", "KeyboardEvent", "MouseEvent", "Event", "HTMLDivElement"]) {
    try {
      globalThis[k] = k === "window" ? dom.window : dom.window[k];
    } catch {}
  }
  globalThis.getSelection = () => dom.window.getSelection();
  // jsdom has no layout; the editor asks for it when it scrolls to the cursor.
  const noRects = () => [];
  dom.window.Element.prototype.getClientRects ||= noRects;
  dom.window.Text.prototype.getClientRects ||= noRects;
  dom.window.Range.prototype.getClientRects ||= noRects;
  dom.window.Range.prototype.getBoundingClientRect ||= () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  ({ default: Editor } = await import("@toast-ui/editor"));
} catch {
  Editor = null;
}
const skip = Editor ? false : "jsdom or the editor unavailable on this Node version";

/** Load a source the way the review does, then let `change` play the user. */
function session(source) {
  const ed = new Editor({ el: document.getElementById("e"), initialEditType: "wysiwyg", initialValue: forEditor(source), frontMatter: false, usageStatistics: false });
  const b0 = stableBaseline(() => ed.getMarkdown(), (md) => ed.setMarkdown(md));
  return {
    b0,
    edit(change) {
      ed.setMarkdown(change(b0));
      const b1 = ed.getMarkdown();
      return b1;
    },
    done: () => ed.destroy(),
  };
}

const SOURCE = `---
toc-title: Inhoudsopgave
---

# Rapport

**Aan** de directie · **Uitgave** 15 september 2026

Een alinea die met de hand is afgebroken, met **vet dat over
de regel loopt** en een voetnoot.[^1]

::: {.kader}
Een pandoc-blok.
:::

| Dimensie | Stand |
|---|---:|
| Security | 0 |

- punt één
- punt twee

<!-- interne notitie -->

Zie ook [de norm][iso].

[^1]: De voetnoottekst.
[iso]: https://example.org/iso

Slotalinea
over twee regels.
`;

test("opening and saving without a change leaves the file byte-identical", { skip }, () => {
  const s = session(SOURCE);
  assert.equal(aligned(SOURCE, s.b0).ok, true, aligned(SOURCE, s.b0).reason);
  const { source, edits } = splice(SOURCE, s.b0, s.edit((b) => b));
  s.done();
  assert.equal(source, SOURCE);
  assert.deepEqual(edits, []);
});

test("editing one block rewrites that block only; wraps, markers and definitions elsewhere stay", { skip }, () => {
  const s = session(SOURCE);
  const b1 = s.edit((b) => b.replace("Uitgave** 15 september", "Uitgave** 22 september"));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].kind, "edited");
  assert.match(source, /\*\*Uitgave\*\* 22 september 2026/);
  // Everything but that one line is untouched.
  assert.equal(source.replace("22 september", "15 september"), SOURCE);
});

test("a block with emphasis across a line break is edited without gluing words", { skip }, () => {
  const s = session(SOURCE);
  const b1 = s.edit((b) => b.replace("een voetnoot.", "een voetnoot erbij."));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.equal(edits.length, 1);
  assert.match(edits[0].after, /\*\*vet dat over de regel loopt\*\*/, "the words stay apart");
  assert.match(edits[0].after, /voetnoot erbij\.\[\^1\]/, "the footnote reference stays a reference");
  assert.match(source, /^\[\^1\]: De voetnoottekst\.$/m, "the definition is untouched");
  assert.match(source, /^\[iso\]: https:\/\/example\.org\/iso$/m);
});

test("inserting and deleting blocks lands in the right place", { skip }, () => {
  const s = session(SOURCE);
  const b1 = s.edit((b) => b.replace("# Rapport", "# Rapport\n\n## Samenvatting\n\nNieuwe alinea.").replace(/<!-- interne notitie -->\n*/, ""));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.deepEqual(edits.map((e) => e.kind).sort(), ["deleted", "inserted", "inserted"]);
  assert.match(source, /# Rapport\n\n## Samenvatting\n\nNieuwe alinea\.\n\n\*\*Aan\*\*/);
  assert.doesNotMatch(source, /interne notitie/);
  assert.doesNotMatch(source, /\n\n\n/, "no double gap where the block was");
  assert.match(source, /Slotalinea\nover twee regels\./, "an untouched wrapped paragraph keeps its wrap");
});

test("a table row added in the editor is written as a table", { skip }, () => {
  const s = session(SOURCE);
  const b1 = s.edit((b) => b.replace(/(\| Security \| 0 \|)/, "$1\n| Tests | 1\\.250 |"));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.equal(edits.length, 1);
  assert.equal(contentBlocks(edits[0].after)[0].type, "table");
  assert.match(source, /\| Tests \| 1\.250 \|/);
});

test("a baseline that does not line up refuses to save", () => {
  assert.equal(aligned("# A\n\nB\n", "# A\n").ok, false);
  assert.equal(aligned("# A\n\nB\n", "B\n\n# A\n").ok, false);
  assert.throws(() => splice("# A\n\nB\n", "# A\n", "# A\n"), /Cannot save safely/);
});

test("the editor input joins soft wraps and leaves the definitions out", () => {
  assert.equal(unwrap("een **vet\nwoord**\n"), "een **vet woord**\n");
  assert.equal(unwrap("> citaat dat\n> doorloopt\n"), "> citaat dat doorloopt\n");
  assert.equal(unwrap("- punt dat\n  doorloopt\n- tweede\n"), "- punt dat doorloopt\n- tweede\n");
  const input = forEditor("Tekst.[^1]\n\n[^1]: Voetnoot.\n[a]: http://x\n");
  assert.doesNotMatch(input, /\[\^1\]:|\[a\]:/);
  assert.equal(tidyBlock("Zie\\[^1\\] en [norm]\\[iso\\]"), "Zie[^1] en [norm][iso]");
  // Needless escapes go; one that stops a line from opening a list stays.
  assert.equal(tidyBlock("## 1\\. Het memo\\, teruggelezen"), "## 1. Het memo, teruggelezen");
  assert.equal(tidyBlock("| Tests | 1\\.250 |"), "| Tests | 1.250 |");
  assert.equal(tidyBlock("2\\. geen lijst"), "2\\. geen lijst");
  assert.equal(tidyBlock("\\- geen lijst"), "\\- geen lijst");
});

test("a reference link in an edited block stays a reference link", { skip }, () => {
  const s = session(SOURCE);
  const b1 = s.edit((b) => b.replace("Zie ook", "Lees ook"));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].after, "Lees ook [de norm][iso].");
  assert.match(source, /^\[iso\]: https:\/\/example\.org\/iso$/m);
});

test("a table's separator normalised on the second round is not an edit", { skip }, () => {
  const src = "| A | B |\n|---|---|\n| 1 | 2 |\n\nTekst.\n";
  const s = session(src);
  const { source, edits } = splice(src, s.b0, s.edit((b) => b));
  s.done();
  assert.deepEqual(edits, []);
  assert.equal(source, src);
});

test("a baseline that never settles is refused", () => {
  let n = 0;
  assert.equal(stableBaseline(() => `ronde ${(n += 1)}`, () => {}), null);
  assert.equal(stableBaseline(() => "vast", () => {}), "vast");
});

test("the YAML header never reaches the editor and survives every save byte for byte", { skip }, () => {
  assert.doesNotMatch(forEditor(SOURCE), /toc-title/, "the editor does not see it");
  const s = session(SOURCE);
  assert.doesNotMatch(s.b0, /toc-title/);
  // Change the first block the editor does have: the title.
  const b1 = s.edit((b) => b.replace("# Rapport", "### Rapport (kort)"));
  s.done();
  const { source, edits } = splice(SOURCE, s.b0, b1);
  assert.equal(edits.length, 1);
  assert.ok(source.startsWith("---\ntoc-title: Inhoudsopgave\n---\n\n### Rapport (kort)\n"), source.slice(0, 80));
  // In Bron the header is an ordinary block you can change.
  const bron = sourceEdits(SOURCE, SOURCE.replace("Inhoudsopgave", "Inhoud"));
  assert.equal(bron.length, 1);
});
