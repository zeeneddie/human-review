import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-report-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

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

/** `poll --ack` the way an agent does it; only the ack side effect matters here. */
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
function report() {
  const dir = path.join(tmp, `levering-${(n += 1)}`);
  fs.mkdirSync(dir);
  const files = {};
  for (const name of ["RAPPORT", "DECK", "SCORECARD"]) {
    files[name] = path.join(dir, `${name}.md`);
    fs.writeFileSync(files[name], `# ${name}\n\nTekst van ${name}.\n`);
  }
  return files;
}

async function openReport(port, token, files) {
  const opened = j(
    await request(port, token, {
      method: "POST",
      route: "/api/session",
      body: { target: files.RAPPORT, also: [files.DECK, files.SCORECARD] },
    })
  );
  const menu = j(await request(port, token, { route: `/api/page/${opened.key}?session=${opened.sessionId}` })).report;
  const keys = Object.fromEntries(menu.pages.map((p) => [p.filename.replace(".md", ""), p.key]));
  return { opened, keys };
}

const edit = (port, token, key, after) =>
  request(port, token, { method: "POST", route: `/api/page/${key}/edit`, body: { label: "p", kind: "edited", before: "Tekst", after } });

const send = (port, token, key, sessionId, scope) =>
  request(port, token, { method: "POST", route: `/api/page/${key}/send`, body: { sessionId, note: "", scope } });

const menuOf = async (port, token, key, sessionId) =>
  j(await request(port, token, { route: `/api/page/${key}?session=${sessionId}` })).report;

test("a report opens as one review with every file in the menu, in order", async (t) => {
  const files = report();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const { opened } = await openReport(port, token, files);
  const menu = await menuOf(port, token, opened.key, opened.sessionId);
  assert.deepEqual(menu.pages.map((p) => p.filename), ["RAPPORT.md", "DECK.md", "SCORECARD.md"]);
  assert.deepEqual(menu.pages.map((p) => p.status), ["leeg", "leeg", "leeg"]);
  assert.equal(menu.pages[0].active, true);
  assert.equal(menu.sentAny, false);
});

test("Verstuur pagina ships that page only; the rest stays open", async (t) => {
  const files = report();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const { opened, keys } = await openReport(port, token, files);

  await edit(port, token, keys.RAPPORT, "Nieuw rapport");
  await edit(port, token, keys.DECK, "Nieuw deck");
  assert.equal(j(await send(port, token, keys.DECK, opened.sessionId, "page")).ok, true);

  const batch = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(files.RAPPORT)}` }));
  assert.deepEqual(batch.pages.map((p) => path.basename(p.file)), ["DECK.md"]);
  assert.equal(batch.pages[0].edits[0].after, "Nieuw deck");

  const menu = await menuOf(port, token, keys.RAPPORT, opened.sessionId);
  const status = Object.fromEntries(menu.pages.map((p) => [p.filename, p.status]));
  assert.deepEqual(status, { "RAPPORT.md": "open", "DECK.md": "verstuurd", "SCORECARD.md": "leeg" });
  assert.equal(menu.sentAny, true);

  await ackAndAbandon(port, token, files.RAPPORT);
  const after = await menuOf(port, token, keys.RAPPORT, opened.sessionId);
  assert.equal(after.pages.find((p) => p.filename === "DECK.md").status, "verwerkt");
  assert.equal(after.pages.find((p) => p.filename === "RAPPORT.md").edits, 1, "the unsent page keeps its edit");
});

test("sending a second page before the agent picked up the first keeps both", async (t) => {
  const files = report();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const { opened, keys } = await openReport(port, token, files);

  await edit(port, token, keys.RAPPORT, "Nieuw rapport");
  await edit(port, token, keys.DECK, "Nieuw deck");
  // No agent is polling: the first batch waits, and the second replaces it.
  await send(port, token, keys.RAPPORT, opened.sessionId, "page");
  await send(port, token, keys.DECK, opened.sessionId, "page");

  const batch = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(files.RAPPORT)}` }));
  assert.deepEqual(batch.pages.map((p) => path.basename(p.file)).sort(), ["DECK.md", "RAPPORT.md"]);
  await ackAndAbandon(port, token, files.RAPPORT);
});

test("Verstuur rest ships every page still unsent, nothing already with the agent", async (t) => {
  const files = report();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());
  const { opened, keys } = await openReport(port, token, files);

  await edit(port, token, keys.RAPPORT, "Nieuw rapport");
  await send(port, token, keys.RAPPORT, opened.sessionId, "page");
  const first = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(files.RAPPORT)}` }));
  assert.deepEqual(first.pages.map((p) => path.basename(p.file)), ["RAPPORT.md"]);

  // The agent is working on RAPPORT; DECK and SCORECARD get feedback meanwhile.
  await new Promise((r) => setTimeout(r, 15));
  await edit(port, token, keys.DECK, "Nieuw deck");
  await edit(port, token, keys.SCORECARD, "Nieuwe scorecard");
  await send(port, token, keys.DECK, opened.sessionId, "all");

  await ackAndAbandon(port, token, files.RAPPORT);
  const rest = j(await request(port, token, { route: `/api/poll?target=${encodeURIComponent(files.RAPPORT)}` }));
  assert.deepEqual(rest.pages.map((p) => path.basename(p.file)).sort(), ["DECK.md", "SCORECARD.md"]);
  await ackAndAbandon(port, token, files.RAPPORT);

  const menu = await menuOf(port, token, keys.RAPPORT, opened.sessionId);
  assert.deepEqual(menu.pages.map((p) => p.status), ["verwerkt", "verwerkt", "verwerkt"]);
});

test("a report page must be an existing local html or markdown file", async (t) => {
  const files = report();
  const { port, token, dispose } = await start(0);
  t.after(() => dispose());

  const txt = path.join(path.dirname(files.RAPPORT), "notes.txt");
  fs.writeFileSync(txt, "nee");
  for (const bad of [txt, path.join(tmp, "bestaat-niet.md"), "http://localhost:3000/"]) {
    const res = await request(port, token, { method: "POST", route: "/api/session", body: { target: files.RAPPORT, also: [bad] } });
    assert.equal(res.status, 400, bad);
  }
});
