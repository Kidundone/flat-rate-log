import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC_JS = "app.src.js";          // <-- change to your current source bundle name
const HTML_FILES = ["index.html", "more.html"];
const SW_FILE = "sw.js";        // <-- change if yours is named differently

function hashOf(buf) {
  return createHash("sha1").update(buf).digest("hex").slice(0, 10);
}

function replaceScriptSrc(html, newJsName) {
  // replaces any app.*.js reference
  return html.replace(/app\.[a-zA-Z0-9_-]+\.js(\?[^"']*)?/g, newJsName);
}

function bumpSwVersion(swText, version) {
  // expects: const SW_VERSION = "....";
  if (!/const\s+SW_VERSION\s*=/.test(swText)) {
    // If you haven't added SW_VERSION yet, insert it near the top.
    return `const SW_VERSION = "${version}";\n` + swText;
  }
  return swText.replace(/const\s+SW_VERSION\s*=\s*"[^"]*"/, `const SW_VERSION = "${version}"`);
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

// Update SW version (so it drops old caches)
if (existsSync(SW_FILE)) {
  const sw = readFileSync(SW_FILE, "utf8");
  const version = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
  const updatedSw = bumpSwVersion(sw, version);
  if (updatedSw !== sw) writeFileSync(SW_FILE, updatedSw);
}

// Optional: delete old app.<hash>.js files (keep the newest and the source)
const files = readdirSync(".").filter(n => /^app\.[a-f0-9]{10}\.js$/.test(n));
for (const f of files) {
  if (f !== outJs) unlinkSync(f);
}

console.log(`Built: ${outJs}`);
