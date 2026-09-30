/**
 * The editor page (Bewerken) inside the review frame. It lives on the other
 * loopback hostname, like the reviewed page, so it never holds the API token:
 * every check and save goes to the review chrome by postMessage.
 *
 * Grafisch: Toast UI edits the page; saves send the editor's baseline (b0)
 * and its current Markdown (b1), and the server writes only the blocks that
 * changed. Bron: a plain textarea holding the file itself, saved as typed.
 */
import Editor, { stableBaseline } from "/vendor/editor.js";

const data = JSON.parse(document.getElementById("data").textContent);
const CHROME_ORIGIN = `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`;
const post = (msg) => parent.postMessage({ ...msg, key: data.key }, CHROME_ORIGIN);
const $ = (id) => document.getElementById(id);

let hash = data.hash;
let b0 = null;
let editor = null;
let locked = false;
let saving = false;
let again = false;
let timer = null;
let flushWaiters = [];

function banner(text) {
  $("banner").textContent = text || "";
  $("banner").style.display = text ? "block" : "none";
}

/** Not editable here: say why, and keep the text readable. */
function lock(reason) {
  locked = true;
  clearTimeout(timer);
  document.body.classList.add("locked");
  const pm = document.querySelector(".ProseMirror");
  if (pm) pm.setAttribute("contenteditable", "false");
  banner(`Deze pagina kan hier niet veilig grafisch bewerkt worden: ${reason}. Gebruik Bron om het bestand zelf te bewerken.`);
  post({ type: "ed:locked", reason });
}

function current() {
  return data.mode === "bron" ? $("bron").value : editor.getMarkdown();
}

/** One save in flight at a time; typing during a save queues exactly one more. */
function save() {
  clearTimeout(timer);
  if (locked) return settleFlush();
  if (saving) {
    again = true;
    return undefined;
  }
  if (data.mode === "bron") {
    saving = true;
    post({ type: "ed:source", text: current(), hash });
    return undefined;
  }
  const b1 = current();
  if (b1 === b0) return settleFlush();
  saving = true;
  post({ type: "ed:save", b0, b1, hash });
  return undefined;
}

function settleFlush() {
  const waiters = flushWaiters;
  flushWaiters = [];
  for (const done of waiters) done();
  post({ type: "ed:flushed" });
}

function scheduleSave() {
  if (locked) return;
  clearTimeout(timer);
  timer = setTimeout(save, 700);
  post({ type: "ed:dirty" });
}

if (data.mode === "bron") {
  const area = $("bron");
  area.hidden = false;
  $("editor").hidden = true;
  area.value = data.text;
  area.addEventListener("input", scheduleSave);
  area.focus();
  post({ type: "ed:ready", mode: "bron" });
} else {
  editor = new Editor({
    el: $("editor"),
    initialEditType: "wysiwyg",
    initialValue: data.text,
    frontMatter: false,
    usageStatistics: false,
    hideModeSwitch: true,
    toolbarItems: [],
    height: "100%",
  });
  b0 = stableBaseline(() => editor.getMarkdown(), (md) => editor.setMarkdown(md, false));
  // Loading the baseline twice put the cursor at the end; start at the top.
  editor.moveCursorToStart(false);
  for (const el of document.querySelectorAll(".toastui-editor-ww-container, .toastui-editor-main, .ProseMirror")) el.scrollTop = 0;
  if (b0 === null) lock("de editor komt op deze pagina niet tot rust");
  else post({ type: "ed:check", b0 });
  editor.on("change", scheduleSave);
}

window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== CHROME_ORIGIN) return;
  const msg = event.data || {};
  switch (msg.type) {
    case "ed:checked":
      hash = msg.hash || hash;
      if (!msg.ok) lock(msg.reason || "de blokken van de editor en het bestand lopen niet gelijk");
      else post({ type: "ed:ready", mode: "grafisch" });
      break;
    case "ed:saved":
      hash = msg.hash;
      if (typeof msg.b1 === "string") b0 = msg.b1;
      saving = false;
      banner("");
      if (again) {
        again = false;
        save();
      } else settleFlush();
      break;
    case "ed:failed":
      saving = false;
      banner(msg.error || "Opslaan is mislukt.");
      settleFlush();
      // The file moved under us: start again from what is on disk.
      if (msg.reload) setTimeout(() => location.reload(), 1500);
      break;
    case "ed:exec":
      if (!editor || locked) break;
      try {
        editor.exec(msg.cmd, msg.payload);
      } catch (err) {
        post({ type: "ed:execFailed", cmd: msg.cmd, error: String(err && err.message) });
      }
      editor.focus();
      break;
    case "ed:flush":
      flushWaiters.push(() => {});
      save();
      break;
    default:
  }
});
