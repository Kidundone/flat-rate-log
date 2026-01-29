import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC_JS = "app.src.js";          // <-- change to your current source bundle name
const HTML_FILES = ["index.html", "more.html"];

function hashOf(buf) {
  return createHash("sha1").update(buf).digest("hex").slice(0, 10);
}

function replaceScriptSrc(html, newJsName) {
  // replaces any app.*.js reference
  return html.replace(/app\.[a-zA-Z0-9_-]+\.js(\?[^"']*)?/g, newJsName);
}

// --- Build ---
if (!existsSync(SRC_JS)) {
  console.error(`Missing source JS: ${SRC_JS}`);
  process.exit(1);
}

const jsBuf = readFileSync(SRC_JS);
const h = hashOf(jsBuf);
const outJs = `app.${h}.js`; // versioned filename
writeFileSync(outJs, jsBuf);

// Update HTML to point at the new filename
for (const f of HTML_FILES) {
  const html = readFileSync(f, "utf8");
  const updated = replaceScriptSrc(html, outJs);
  if (updated !== html) writeFileSync(f, updated);
}

// Optional: delete old app.<hash>.js files (keep the newest and the source)
const files = readdirSync(".").filter(n => /^app\.[a-f0-9]{10}\.js$/.test(n));
for (const f of files) {
  if (f !== outJs) unlinkSync(f);
}

console.log(`Built: ${outJs}`);
