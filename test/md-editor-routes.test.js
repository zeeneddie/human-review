import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-editor-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { forEditor, stableBaseline } = await import("../src/md-splice.js");

// The real editor in jsdom, as the edit page runs it.
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
  for (const P of [dom.window.Element, dom.window.Text, dom.window.Range]) P.prototype.getClientRects ||= () => [];
  for (const P of [dom.window.Element, dom.window.Text, dom.window.Range]) P.prototype.getBoundingClientRect ||= () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  ({ default: Editor } = await import("@toast-ui/editor"));
} catch {
  Editor = null;
}
const skip = Editor ? false : "jsdom or the editor unavailable on this Node version";

function request(port, token, { method = "GET", route = "/", body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
          ...(host ? { host } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const j = (res) => JSON.parse(res.raw);
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

const SOURCE = "---\ntoc-title: Inhoud\n---\n\n# Rapport\n\nEen alinea die met de hand\nis afgebroken.\n\n**Uitgave** 15 september 2026\n\n[^1]: Voetnoot.\n";

let n = 0;
function file() {
  const f = path.join(tmp, `stuk-${(n += 1)}.md`);
  fs.writeFileSync(f, SOURCE);
  return f;
}

function editorFor(text) {
  const ed = new Editor({ el: document.getElementById("e"), initialEditType: "wysiwyg", initialValue: text, frontMatter: false, usageStatistics: false });
  const b0 = stableBaseline(() => ed.getMarkdown(), (md) => ed.setMarkdown(md, false));
  return {
    b0,
    change(fn) {
      ed.setMarkdown(fn(ed.getMarkdown()), false);
      return ed.getMarkdown();
    },
    done: () => ed.destroy(),
  };
}

test("the edit page carries the editor input: no YAML header, no definitions", async (t) => {
  const f = file();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { target: f } }));
  const page = await request(port, token, { route: `/artifact/${opened.artifactToken}/${opened.key}/__edit__?mode=grafisch`, host: `localhost:${port}` });
  assert.equal(page.status, 200);
  const data = JSON.parse(page.raw.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.mode, "grafisch");
  assert.equal(data.text, forEditor(SOURCE));
  assert.doesNotMatch(data.text, /toc-title|\[\^1\]:/);
  assert.equal(data.hash, sha1(SOURCE));
  const bron = await request(port, token, { route: `/artifact/${opened.artifactToken}/${opened.key}/__edit__?mode=bron`, host: `localhost:${port}` });
  assert.equal(JSON.parse(bron.raw.match(/id="data">([\s\S]*?)<\/script>/)[1]).text, SOURCE, "Bron shows the file itself");
});

test("editor saves write only the changed block, grow one row while typing, and ship as saved", { skip }, async (t) => {
  const f = file();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { target: f } }));
  const key = opened.key;
  const ed = editorFor(forEditor(SOURCE));
  t.after(() => ed.done());

  const check = j(await request(port, token, { method: "POST", route: `/api/page/${key}/mdcheck`, body: { b0: ed.b0 } }));
  assert.equal(check.ok, true, check.reason);

  // Two saves on the same block, as typing does.
  const b1 = ed.change((b) => b.replace("15 september", "22 september"));
  const s1 = j(await request(port, token, { method: "POST", route: `/api/page/${key}/mdsave`, body: { b0: ed.b0, b1, hash: check.hash } }));
  const b2 = ed.change((b) => b.replace("22 september 2026", "22 september 2026 (herzien)"));
  const s2 = j(await request(port, token, { method: "POST", route: `/api/page/${key}/mdsave`, body: { b0: b1, b1: b2, hash: s1.hash } }));
  assert.equal(s2.ok, true);

  const disk = fs.readFileSync(f, "utf8");
  assert.equal(disk, SOURCE.replace("15 september 2026", "22 september 2026 (herzien)"), "only that line changed; header, wrap and footnote intact");
  assert.equal(s2.hash, sha1(disk));
  const rows = s2.page.edits;
  assert.equal(rows.length, 1, "one row for one block, however often it was saved");
  assert.equal(rows[0].before, "**Uitgave** 15 september 2026");
  assert.equal(rows[0].after, "**Uitgave** 22 september 2026 (herzien)");

  await request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId: opened.sessionId } });
  const batch = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(f)}` }));
  assert.equal(batch.pages[0].edits_saved, true);
  assert.equal(batch.pages[0].edits[0].saved, true);
  assert.match(batch.next_step, /already in the file/);
});

test("a stale hash or a baseline that does not line up is refused, and the file stays", async (t) => {
  const f = file();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { target: f } }));
  const key = opened.key;
  const stale = await request(port, token, { method: "POST", route: `/api/page/${key}/mdsource`, body: { text: "weg", hash: "0000" } });
  assert.equal(stale.status, 409);
  const off = await request(port, token, { method: "POST", route: `/api/page/${key}/mdsave`, body: { b0: "# Anders\n", b1: "# Anders!\n", hash: sha1(SOURCE) } });
  assert.equal(off.status, 409);
  assert.equal(fs.readFileSync(f, "utf8"), SOURCE);
  assert.equal(j(await request(port, token, { method: "POST", route: `/api/page/${key}/mdcheck`, body: { b0: "# Anders\n" } })).ok, false);
});

test("Bron writes the file as typed, header and definitions included", async (t) => {
  const f = file();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = j(await request(port, token, { method: "POST", route: "/api/session", body: { target: f } }));
  const next = SOURCE.replace("toc-title: Inhoud", "toc-title: Inhoudsopgave").replace("[^1]: Voetnoot.", "[^1]: Andere voetnoot.");
  const r = j(await request(port, token, { method: "POST", route: `/api/page/${opened.key}/mdsource`, body: { text: next, hash: sha1(SOURCE) } }));
  assert.equal(fs.readFileSync(f, "utf8"), next);
  assert.equal(r.page.edits.length, 2);
  assert.ok(r.page.edits.every((e) => e.saved));
});
