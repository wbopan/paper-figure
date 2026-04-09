#!/usr/bin/env node
/**
 * Export an academic figure HTML to a tight-cropped PDF/PNG/JPG via Playwright.
 *
 * Usage:
 *   node export_pdf.mjs <figure.html> [output.pdf|output.png|output.jpg]
 *
 * Requirements:
 *   npm install -g playwright
 *
 * The script:
 * 1. Starts a local HTTP server (avoids file:// CORS issues with d3.json etc.)
 * 2. Launches headless Chromium via Playwright
 * 3. Waits for document.fonts.ready + 1s settle time
 * 4. Reads the SVG bounding box and exports a tight-cropped file
 */
import http from "http";
import fs from "fs";
import { dirname, join, extname, basename, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node export_pdf.mjs <figure.html> [output.pdf]");
  process.exit(1);
}

const figPath = resolve(args[0]);
const figDir = dirname(figPath);
const figBase = basename(figPath, extname(figPath));
const outPath = args[1] ? resolve(args[1]) : join(figDir, `${figBase}.pdf`);
const outExt = extname(outPath).toLowerCase();

if (!fs.existsSync(figPath)) {
  console.error(`File not found: ${figPath}`);
  process.exit(1);
}

// ── Try to import Playwright ────────────────────────────────────────────
let chromiumMod;
try {
  chromiumMod = await import("playwright");
} catch {
  console.error("Playwright not found. Install it globally with:");
  console.error("  npm install -g playwright");
  process.exit(1);
}
const { chromium } = chromiumMod;

// ── MIME types ───────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".json": "application/json", ".js": "text/javascript",
  ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf",
};

// ── Local HTTP server (serves the figure directory) ─────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const filePath = join(figDir, url.pathname === "/" ? basename(figPath) : decodeURIComponent(url.pathname));
  const ext = extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const figURL = `http://127.0.0.1:${port}/${basename(figPath)}`;

console.log(`Serving ${figDir} on port ${port}`);
console.log(`Loading ${figURL} ...`);

// ── Playwright: load, wait for fonts, measure SVG, export PDF ───────────
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(figURL, { waitUntil: "networkidle", timeout: 30000 });
await page.emulateMedia({ media: "screen" });

// Wait for web fonts to fully load
await page.evaluate(() => document.fonts.ready);

// Extra settle time for rendering (fonts, D3 transitions)
await new Promise(r => setTimeout(r, 1000));

// Get tight content bounds and force the page box to a single exact sheet.
const box = await page.evaluate(() => {
  const svg = document.querySelector("svg");
  if (!svg) return null;
  document.documentElement.style.margin = "0";
  document.documentElement.style.padding = "0";
  document.documentElement.style.width = "fit-content";
  document.documentElement.style.height = "fit-content";
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.overflow = "hidden";
  document.body.style.width = "fit-content";
  document.body.style.height = "fit-content";
  const svgRect = svg.getBoundingClientRect();
  return {
    width: Math.ceil(parseFloat(svg.getAttribute("width")) || svgRect.width),
    height: Math.ceil(parseFloat(svg.getAttribute("height")) || svgRect.height),
  };
});

if (!box || !box.width || !box.height) {
  console.error("Could not find an SVG element with width/height attributes.");
  console.error("Make sure your D3 figure sets explicit width and height on the <svg> element.");
  await browser.close();
  server.close();
  process.exit(1);
}

// Use getBBox to find actual rendered content bounds (may extend beyond declared SVG dimensions
// due to strokes, dashed borders, arrowheads, etc. at edges).
// Then set a viewBox that captures everything, with a small safety pad.
const PAD = 2;
const actualBox = await page.evaluate((pad) => {
  const svg = document.querySelector("svg");
  if (!svg) return null;
  const bbox = svg.getBBox();
  const vbX = bbox.x - pad;
  const vbY = bbox.y - pad;
  const vbW = bbox.width + pad * 2;
  const vbH = bbox.height + pad * 2;
  // Set viewBox to include all content; update width/height to match
  svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  svg.setAttribute("width", vbW);
  svg.setAttribute("height", vbH);
  return { width: Math.ceil(vbW), height: Math.ceil(vbH) };
}, PAD);

const pdfWidth = actualBox ? actualBox.width : box.width;
const pdfHeight = actualBox ? actualBox.height : box.height;

await page.setViewportSize({ width: pdfWidth, height: pdfHeight });
await new Promise(r => setTimeout(r, 200));

if (outExt === ".pdf") {
  await page.pdf({
    path: outPath,
    width: `${pdfWidth}px`,
    height: `${pdfHeight}px`,
    printBackground: true,
    preferCSSPageSize: false,
    pageRanges: "1",
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
} else if (outExt === ".jpg" || outExt === ".jpeg") {
  await page.screenshot({
    path: outPath,
    type: "jpeg",
    quality: 95,
    clip: { x: 0, y: 0, width: pdfWidth, height: pdfHeight },
  });
} else if (outExt === ".png") {
  await page.screenshot({
    path: outPath,
    type: "png",
    clip: { x: 0, y: 0, width: pdfWidth, height: pdfHeight },
  });
} else {
  console.error(`Unsupported output format: ${outExt || "(none)"}`);
  console.error("Use .pdf, .png, .jpg, or .jpeg");
  await browser.close();
  server.close();
  process.exit(1);
}

await browser.close();
server.close();

console.log(`Exported: ${outPath} (${pdfWidth} x ${pdfHeight} px)`);
