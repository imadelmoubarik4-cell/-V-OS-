// Inserts the server-rendered page and its JSON-LD into the built index.html.
// Usage: node scripts/prerender.mjs <client outDir> <ssr outDir>
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [dist = "dist", ssrDir = "dist-server"] = process.argv.slice(2);
const { render, jsonLd } = await import(pathToFileURL(path.resolve(ssrDir, "entry-server.js")).href);

const file = path.join(dist, "index.html");
let html = fs.readFileSync(file, "utf8");
if (!html.includes('<div id="root"></div>')) throw new Error("prerender: #root not found or already filled");

const ld = JSON.stringify(jsonLd()).replace(/</g, "\\u003c");
html = html
  .replace('<div id="root"></div>', `<div id="root">${render()}</div>`)
  .replace("</head>", `    <script type="application/ld+json">${ld}</script>\n  </head>`);

fs.writeFileSync(file, html);
fs.rmSync(ssrDir, { recursive: true, force: true });
console.log(`prerender: wrote ${file} (${Math.round(html.length / 1024)} kB)`);
