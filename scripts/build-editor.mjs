// Bundle the Markdown editor (Toast UI + its ProseMirror modules) into one
// browser file the review page can load. Generated, not committed: runs on
// `npm install` (prepare) and with `npm run build:editor`.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src", "vendor");
fs.mkdirSync(out, { recursive: true });
await build({
  // The editor, plus the one baseline routine the server's gate relies on.
  stdin: { contents: 'export { default } from "@toast-ui/editor";\nexport { stableBaseline } from "./src/md-splice.js";', resolveDir: root, loader: "js" },
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  outfile: path.join(out, "editor.js"),
  legalComments: "eof",
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "node_modules/@toast-ui/editor/dist/toastui-editor.css"), path.join(out, "editor.css"));
console.log("editor bundled:", fs.statSync(path.join(out, "editor.js")).size, "bytes");
