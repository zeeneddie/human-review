import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-notes-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { start } = await import("../src/server.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
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

function ackAndAbandon(port, token, target, ms = 200) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: `/api/poll?target=${encodeURIComponent(target)}&ack=1`,
      headers: { "x-human-review-token": token },
    });
    req.on("error", () => {});
    req.on("response", () => setTimeout(() => {
      req.destroy();
      resolve();
    }, ms));
    req.end();
  });
}

let n = 0;
function page() {
  const file = path.join(tmp, `rapport-${(n += 1)}.md`);
  fs.writeFileSync(file, "# Rapport\n\nUitgave 15 september 2026.\n\nDe dekking is laag.\n");
  return file;
}

async function open(port, token, file) {
  return j(await request(port, token, { method: "POST", route: "/api/session", body: { target: file } }));
}

const post = (port, token, notes) => request(port, token, { method: "POST", route: "/api/notes", body: { notes } });
const answer = (port, token, key, id, body) => request(port, token, { method: "POST", route: `/api/page/${key}/note/${id}`, body });
const state = async (port, token, key) => j(await request(port, token, { route: `/api/page/${key}` }));
const poll = async (port, token, file) => j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(file)}` }));

test("a reviewer posts notes under any name; they anchor on the quote and wait for an answer", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);

  const res = j(await post(port, token, [
    { page: file, author: "Fable", quote: "Uitgave 15 september 2026", text: "Datum klopt niet meer.", suggestion: "Uitgave 22 september 2026" },
    { page: file, text: "Geen citaat: een losse notitie." },
  ]));
  assert.deepEqual(res.notes.map((x) => x.author), ["Fable", "Claude"], "author is free, Claude by default");

  const s = await state(port, token, opened.key);
  assert.equal(s.notes.length, 2);
  assert.deepEqual(s.notes[0].anchor, { prefix: "", quote: "Uitgave 15 september 2026", suffix: "" });
  assert.equal(s.notes[1].anchor, null);
  assert.deepEqual(s.unsent, { comments: 0, edits: 0, replies: 0 }, "an unanswered note is not feedback");
  assert.equal(j(await request(port, token, { method: "POST", route: `/api/page/${opened.key}/send`, body: { sessionId: opened.sessionId } })).error, "nothing to send");
});

test("answers ship as replies: akkoord, aangepast, niet and antwoord", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const ids = j(await post(port, token, [
    { page: file, author: "Claude", quote: "Uitgave 15 september 2026", text: "Datum?", suggestion: "Uitgave 22 september 2026" },
    { page: file, author: "ChatGPT", quote: "De dekking is laag.", text: "Te vaag.", suggestion: "De regeldekking is 12 %." },
    { page: file, author: "Fable", text: "Kop mist een ondertitel." },
    { page: file, author: "Claude", text: "Gaat de scorecard mee?" },
  ])).notes.map((x) => x.id);

  await answer(port, token, opened.key, ids[0], { verdict: "akkoord" });
  await answer(port, token, opened.key, ids[1], { verdict: "aangepast", suggestion: "De regeldekking is 11,8 %.", reply: "Afronden op één decimaal." });
  await answer(port, token, opened.key, ids[2], { verdict: "niet" });
  await answer(port, token, opened.key, ids[3], { verdict: "antwoord", reply: "Nee, die gaat niet mee." });
  assert.equal((await state(port, token, opened.key)).unsent.replies, 4);

  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/send`, body: { sessionId: opened.sessionId, scope: "page" } });
  const batch = await poll(port, token, file);
  const replies = Object.fromEntries(batch.pages[0].replies.map((r) => [r.note_id, r]));
  assert.equal(replies[ids[0]].verdict, "akkoord");
  assert.equal(replies[ids[0]].final_suggestion, "Uitgave 22 september 2026", "akkoord carries the suggestion as is");
  assert.equal(replies[ids[1]].verdict, "aangepast");
  assert.equal(replies[ids[1]].final_suggestion, "De regeldekking is 11,8 %.", "aangepast carries your wording");
  assert.equal(replies[ids[1]].suggestion, "De regeldekking is 12 %.", "and the original, for comparison");
  assert.equal(replies[ids[1]].reply, "Afronden op één decimaal.");
  assert.equal(replies[ids[1]].author, "ChatGPT");
  assert.equal(replies[ids[2]].verdict, "niet");
  assert.equal(replies[ids[2]].final_suggestion, undefined);
  assert.equal(replies[ids[3]].reply, "Nee, die gaat niet mee.");
  assert.match(batch.next_step, /replies/);
  await ackAndAbandon(port, token, file);
});

test("a sent answer is locked until the ack; then answered notes go and unanswered ones stay", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const [done, waiting] = j(await post(port, token, [
    { page: file, quote: "De dekking is laag.", text: "Onderbouwen?", suggestion: "De regeldekking is 12 %." },
    { page: file, text: "Nog even laten liggen." },
  ])).notes.map((x) => x.id);

  await answer(port, token, opened.key, done, { verdict: "akkoord" });
  await request(port, token, { method: "POST", route: `/api/page/${opened.key}/send`, body: { sessionId: opened.sessionId } });
  await poll(port, token, file);

  const late = await answer(port, token, opened.key, done, { verdict: "niet" });
  assert.equal(late.status, 409, "the agent has this answer; changing it now would go unseen");
  const s = await state(port, token, opened.key);
  assert.equal(s.notes.find((x) => x.id === done).sent, true);

  await ackAndAbandon(port, token, file);
  const after = await state(port, token, opened.key);
  assert.deepEqual(after.notes.map((x) => x.id), [waiting]);
});

test("an answer can be taken back, and invalid answers are refused", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);
  const [id] = j(await post(port, token, [{ page: file, text: "Iets.", suggestion: "Iets anders." }])).notes.map((x) => x.id);

  assert.equal((await answer(port, token, opened.key, id, { verdict: "misschien" })).status, 400);
  assert.equal((await answer(port, token, opened.key, id, { verdict: "aangepast", suggestion: "  " })).status, 400);
  assert.equal((await answer(port, token, opened.key, id, { verdict: "antwoord" })).status, 400);
  assert.equal((await answer(port, token, opened.key, "n_onbekend", { verdict: "akkoord" })).status, 404);

  // A question has nothing to accept: it is answered or declined.
  const [question] = j(await post(port, token, [{ page: file, text: "Gaat het deck mee?" }])).notes.map((x) => x.id);
  assert.equal((await answer(port, token, opened.key, question, { verdict: "akkoord" })).status, 400);
  assert.equal((await answer(port, token, opened.key, question, { verdict: "aangepast", suggestion: "x" })).status, 400);
  assert.equal((await answer(port, token, opened.key, question, { verdict: "antwoord", reply: "Ja." })).status, 200);
  await answer(port, token, opened.key, question, {});

  await answer(port, token, opened.key, id, { verdict: "akkoord" });
  assert.equal((await state(port, token, opened.key)).unsent.replies, 1);
  await answer(port, token, opened.key, id, {});
  const s = await state(port, token, opened.key);
  assert.equal(s.unsent.replies, 0);
  assert.equal(s.notes[0].response, undefined);
});

test("posting notes validates text and page", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const txt = path.join(tmp, "notes.txt");
  fs.writeFileSync(txt, "x");
  assert.equal((await post(port, token, [])).status, 400);
  assert.equal((await post(port, token, [{ page: file, text: "  " }])).status, 400);
  assert.equal((await post(port, token, [{ page: txt, text: "x" }])).status, 400);
  assert.equal((await post(port, token, [{ page: path.join(tmp, "weg.md"), text: "x" }])).status, 400);
});

test("the notes command posts from stdin with a default author", async (t) => {
  const file = page();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const opened = await open(port, token, file);

  const child = spawn(process.execPath, [path.join(project, "src/cli.js"), "notes", file, "--author", "Fable"], {
    cwd: tmp,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stdin.end(JSON.stringify([{ quote: "De dekking is laag.", text: "Cijfer erbij?" }, { text: "Mooi stuk.", author: "ChatGPT" }]));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.match(out, /2 notes posted on rapport-\d+\.md/);

  const s = await state(port, token, opened.key);
  assert.deepEqual(s.notes.map((x) => x.author), ["Fable", "ChatGPT"]);
});
