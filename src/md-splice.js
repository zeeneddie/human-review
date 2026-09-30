/**
 * Editing a Markdown source through a WYSIWYG editor without letting the
 * editor rewrite the file.
 *
 * The editor (Toast UI) re-serialises everything it touches: `---` becomes
 * `***`, `-` becomes `*`, punctuation gets escaped, and a soft line break
 * inside bold or italic glues two words together. So the file is never saved
 * from the editor as a whole. Instead:
 *
 *   1. `forEditor` gives the editor the source with soft-wrapped lines joined
 *      (no soft break can sit inside emphasis) and without the protected
 *      blocks — link and footnote definitions, which it would escape and
 *      merge.
 *   2. The editor's own serialisation right after loading (`b0`) is the
 *      baseline. `aligned` checks that it has exactly the source's content
 *      blocks, same count and same types; if not, the page is not editable.
 *   3. On save, `splice` diffs the editor's current serialisation (`b1`)
 *      against `b0` block by block and writes only the blocks that changed
 *      into the source. Everything else stays byte-identical.
 *
 * Pure string work on `marked`'s lexer, whose token `raw`s concatenate back
 * to the exact source.
 */
import { marked } from "marked";

/** A YAML header at the very top of the file (`---` … `---`), as pandoc reads it. */
const FRONT_MATTER = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;

/**
 * The file's tokens, each marked `protected` when the editor must never see
 * it: link and footnote definitions (`[x]: …`, `[^1]: …`), which it escapes
 * and merges, and the YAML header, which Markdown reads as a rule plus a
 * heading — a click there turned `toc-title:` into `# --- toc-title …`.
 * Protected blocks are edited in Bron only.
 */
function lex(md) {
  const text = String(md || "");
  const header = text.match(FRONT_MATTER);
  const headerEnd = header ? header[0].length : 0;
  let at = 0;
  return marked.lexer(text).map((t) => {
    const start = at;
    at += t.raw.length;
    return Object.assign(t, { protected: t.type === "def" || start < headerEnd });
  });
}

const isProtected = (token) => token.protected;
const isContent = (token) => token.type !== "space" && !isProtected(token);

const trimEnd = (raw) => raw.replace(/\n+$/, "");

/** Content blocks of a Markdown text as the editor would have them. */
export function contentBlocks(md) {
  return lex(md).filter(isContent).map((t) => ({ type: t.type, raw: trimEnd(t.raw) }));
}

const joinSoft = (text) => text.replace(/([^\n])\n(?=[^\n])/g, "$1 ");

/**
 * Soft-wrapped lines on one line — in paragraphs, blockquotes and list items.
 * The editor glues words together at a soft break inside emphasis
 * ("zowel\ninterne" inside **…** became "zowelinterne").
 */
export function unwrap(md) {
  return lex(md)
    .map((t) => {
      const tail = t.raw.match(/\n*$/)[0];
      if (t.type === "paragraph") return joinSoft(trimEnd(t.raw)) + tail;
      if (t.type === "blockquote") {
        const inner = trimEnd(t.raw).split("\n").map((l) => l.replace(/^ {0,3}> ?/, "")).join("\n");
        return trimEnd(unwrap(inner)).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") + tail;
      }
      // A continuation line: indented, and not itself the start of an item.
      if (t.type === "list") return t.raw.replace(/([^\n])\n([ \t]+)(?![-*+][ \t]|\d+[.)][ \t])(?=\S)/g, "$1 ");
      return t.raw;
    })
    .join("");
}

/** What the editor loads: unwrapped, protected blocks left out. */
export function forEditor(source) {
  const kept = lex(source).filter((t) => !isProtected(t)).map((t) => t.raw).join("");
  return unwrap(kept);
}

/**
 * Does the editor's baseline line up with the source, block for block? If
 * not, a save could land on the wrong block, so the page must not be edited.
 */
export function aligned(source, b0) {
  const src = contentBlocks(source);
  const ed = contentBlocks(b0);
  if (src.length !== ed.length) return { ok: false, reason: `the editor sees ${ed.length} blocks, the file has ${src.length}` };
  const at = src.findIndex((b, i) => b.type !== ed[i].type);
  if (at !== -1) return { ok: false, reason: `block ${at + 1} is a ${src[at].type} in the file but a ${ed[at].type} in the editor` };
  return { ok: true };
}

/**
 * Undo the editor's escaping in a block it rewrote. It escapes far more than
 * Markdown needs (`1\\.250`, `memo\\,`), and some of it changes meaning: a
 * reference link `[tekst][ref]` came back as `\\[tekst\\]\\[ref\\]`, plain
 * text. An escape stays only where it matters: at the start of a line, where
 * `2\\.` or `\\-` would otherwise open a list.
 */
export function tidyBlock(raw) {
  return raw
    .split("\n")
    .map((line) =>
      line
        // Footnote references and reference links back to links.
        .replace(/\\\[\^([^\]\\]+)\\\]/g, "[^$1]")
        .replace(/\\\[([^\]\\]+)\\\]\\\[([^\]\\]+)\\\]/g, "[$1][$2]")
        .replace(/\]\\\[([^\]\\]+)\\\]/g, "][$1]")
        // Punctuation needs no escape — except where it would start a list.
        .replace(/\\([,.;:!?()\-])/g, (m, ch, at, all) => {
          const before = all.slice(0, at);
          const opensList = (/^\s*$/.test(before) && ch === "-") || (/^\s*\d+$/.test(before) && (ch === "." || ch === ")"));
          return opensList ? m : ch;
        })
    )
    .join("\n");
}

/** Longest common subsequence of two block lists, as edit operations. */
function diffBlocks(a, b) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      L[i][j] = a[i].raw === b[j].raw ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].raw === b[j].raw) {
      ops.push({ op: "same", i, j });
      i += 1;
      j += 1;
    } else if (j < m && (i === n || L[i][j + 1] > L[i + 1][j])) {
      ops.push({ op: "insert", i, j });
      j += 1;
    } else {
      ops.push({ op: "delete", i });
      i += 1;
    }
  }
  // Within each run of changes between two unchanged blocks, the n-th removed
  // block and the n-th added block are one edit; what is left over was really
  // removed or added. Added blocks go in after the run.
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op === "same") {
      out.push(ops[k]);
      k += 1;
      continue;
    }
    const dels = [];
    const ins = [];
    while (k < ops.length && ops[k].op !== "same") {
      (ops[k].op === "delete" ? dels : ins).push(ops[k]);
      k += 1;
    }
    const runEnd = k < ops.length ? ops[k].i : n;
    const pairs = Math.min(dels.length, ins.length);
    for (let p = 0; p < pairs; p += 1) out.push({ op: "edit", i: dels[p].i, j: ins[p].j });
    for (const d of dels.slice(pairs)) out.push({ op: "delete", i: d.i });
    for (const a of ins.slice(pairs)) out.push({ op: "insert", i: runEnd, j: a.j });
  }
  return out;
}

const label = (raw) => {
  const text = raw.replace(/^[#>*\-+\d.)\s|]+/, "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || "(leeg blok)";
};

/**
 * Write the blocks that changed between `b0` and `b1` into `source`.
 * Returns the new source and one edit row per changed block. Throws when
 * `b0` does not line up with the source — never guess where a block goes.
 */
export function splice(source, b0, b1) {
  const check = aligned(source, b0);
  if (!check.ok) throw new Error(`Cannot save safely: ${check.reason}.`);
  const tokens = lex(source);
  const contentAt = []; // content block index -> token index
  tokens.forEach((t, k) => {
    if (isContent(t)) contentAt.push(k);
  });
  const e0 = contentBlocks(b0);
  const e1 = contentBlocks(b1);

  const replaceAt = new Map(); // token index -> new raw (null = drop)
  const insertBefore = new Map(); // token index (or tokens.length) -> [raw]
  const edits = [];
  for (const d of diffBlocks(e0, e1)) {
    if (d.op === "same") continue;
    if (d.op === "edit") {
      const k = contentAt[d.i];
      const after = tidyBlock(e1[d.j].raw);
      replaceAt.set(k, after + tokens[k].raw.match(/\n*$/)[0]);
      edits.push({ kind: "edited", label: label(trimEnd(tokens[k].raw)), before: trimEnd(tokens[k].raw), after });
    } else if (d.op === "delete") {
      const k = contentAt[d.i];
      replaceAt.set(k, null);
      // The blank line after a removed block goes with it, so no double gap is left.
      if (tokens[k + 1] && tokens[k + 1].type === "space" && !replaceAt.has(k + 1)) replaceAt.set(k + 1, null);
      edits.push({ kind: "deleted", label: label(trimEnd(tokens[k].raw)), before: trimEnd(tokens[k].raw), after: "" });
    } else {
      // Inserted before content block d.i of the baseline (or at the end).
      const k = d.i < contentAt.length ? contentAt[d.i] : tokens.length;
      const raw = tidyBlock(e1[d.j].raw);
      if (!insertBefore.has(k)) insertBefore.set(k, []);
      insertBefore.get(k).push(raw);
      edits.push({ kind: "inserted", label: label(raw), before: "", after: raw });
    }
  }

  let out = "";
  const ensureGap = () => {
    if (!out) return;
    if (!out.endsWith("\n")) out += "\n";
    if (!out.endsWith("\n\n")) out += "\n";
  };
  for (let k = 0; k <= tokens.length; k += 1) {
    for (const raw of insertBefore.get(k) || []) {
      ensureGap();
      out += `${raw}\n\n`;
    }
    if (k === tokens.length) break;
    const next = replaceAt.has(k) ? replaceAt.get(k) : tokens[k].raw;
    if (next === null) continue;
    out += next;
  }
  if (source.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  return { source: out, edits };
}

/**
 * The editor's baseline for a freshly loaded page. Right after loading it may
 * still hand back parts of the input as given (a table's `|---|` separator)
 * and normalise them only on the next round, which would read as an edit the
 * user never made. So load its own output again until two rounds agree.
 * Null when it does not settle within three rounds: that page is not editable.
 */
export function stableBaseline(getMarkdown, setMarkdown) {
  let prev = getMarkdown();
  for (let round = 0; round < 3; round += 1) {
    setMarkdown(prev);
    const cur = getMarkdown();
    if (cur === prev) return prev;
    prev = cur;
  }
  return null;
}

/**
 * Edit rows for a whole-file change (the Bron view, where you type the file
 * itself). Every block counts here, definitions included.
 */
export function sourceEdits(before, after) {
  const all = (md) => lex(md).filter((t) => t.type !== "space").map((t) => ({ type: t.type, raw: trimEnd(t.raw) }));
  const a = all(before);
  const b = all(after);
  const edits = [];
  for (const d of diffBlocks(a, b)) {
    if (d.op === "edit") edits.push({ kind: "edited", label: label(a[d.i].raw), before: a[d.i].raw, after: b[d.j].raw });
    else if (d.op === "delete") edits.push({ kind: "deleted", label: label(a[d.i].raw), before: a[d.i].raw, after: "" });
    else if (d.op === "insert") edits.push({ kind: "inserted", label: label(b[d.j].raw), before: "", after: b[d.j].raw });
  }
  return edits;
}
