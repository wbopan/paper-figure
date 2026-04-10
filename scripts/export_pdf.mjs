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

// ── Gradient flattening helpers ─────────────────────────────────────────
// Replace every SVG <linearGradient>/<radialGradient>-filled element with
// an <image> containing a canvas-rasterized PNG. Runs entirely in-page; no
// foreignObject is used, so the canvas is never tainted and toDataURL works.
async function flattenSvgGradients(page) {
  await page.evaluate(async () => {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const XLINK_NS = "http://www.w3.org/1999/xlink";
    const svgs = document.querySelectorAll("svg");

    for (const svg of svgs) {
      const gradIds = new Set();
      svg.querySelectorAll("linearGradient, radialGradient").forEach(g => {
        if (g.id) gradIds.add(g.id);
      });
      if (gradIds.size === 0) continue;

      // Collect every def-like element so the standalone SVG can resolve
      // url(#id) references on the cloned target.
      const defParts = [];
      svg.querySelectorAll(
        "defs, linearGradient, radialGradient, pattern, clipPath, mask, filter, symbol"
      ).forEach(el => {
        if (el.tagName.toLowerCase() === "defs") {
          defParts.push(el.innerHTML);
        } else if (!el.closest("defs")) {
          defParts.push(el.outerHTML);
        }
      });
      const defsContent = defParts.join("");

      const refMatch = (v) => {
        if (!v) return null;
        const m = /url\(\s*["']?#([^)"'\s]+)/.exec(v);
        return m ? m[1] : null;
      };
      const usesGrad = (el) => {
        const ids = [
          refMatch(el.getAttribute("fill")),
          refMatch(el.getAttribute("stroke")),
          refMatch(el.getAttribute("style")),
        ];
        return ids.some(id => id && gradIds.has(id));
      };

      const targets = Array.from(svg.querySelectorAll("*")).filter(usesGrad);

      for (const el of targets) {
        let bbox;
        try { bbox = el.getBBox(); } catch { continue; }
        if (!bbox || bbox.width <= 0 || bbox.height <= 0) continue;

        const transform = el.getAttribute("transform") || "";
        const clone = el.cloneNode(true);
        clone.removeAttribute("transform");

        const standalone =
          `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" ` +
          `width="${bbox.width}" height="${bbox.height}" ` +
          `viewBox="${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}">` +
          `<defs>${defsContent}</defs>` +
          clone.outerHTML +
          `</svg>`;

        const blob = new Blob([standalone], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
          });
          // Cap oversampling so huge elements don't exhaust canvas memory.
          const MAX_DIM = 8000;
          const scale = Math.min(3, MAX_DIM / Math.max(bbox.width, bbox.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(bbox.width * scale));
          canvas.height = Math.max(1, Math.ceil(bbox.height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/png");

          const image = document.createElementNS(SVG_NS, "image");
          image.setAttribute("x", bbox.x);
          image.setAttribute("y", bbox.y);
          image.setAttribute("width", bbox.width);
          image.setAttribute("height", bbox.height);
          image.setAttributeNS(XLINK_NS, "xlink:href", dataUrl);
          image.setAttribute("href", dataUrl);
          if (transform) image.setAttribute("transform", transform);
          el.parentNode.insertBefore(image, el);
          el.remove();
        } catch (e) {
          console.warn("SVG gradient rasterization failed:", e);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    }
  });
}

// Replace every CSS linear/radial/conic-gradient background with an embedded
// PNG. We render a short-lived off-document ghost div carrying only the
// gradient, screenshot it via Playwright (which captures the exact browser
// rendering), and set the original element's background-image to the data URI.
async function flattenCssGradients(page) {
  const gradients = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll("*");
    let counter = 0;
    for (const el of all) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage;
      if (!bg || bg === "none") continue;
      if (!/(linear|radial|conic)-gradient/.test(bg)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const id = `__pf_grad_${counter++}__`;
      el.setAttribute("data-pf-grad", id);
      results.push({
        id,
        w: rect.width,
        h: rect.height,
        bg,
        size: cs.backgroundSize || "100% 100%",
        pos: cs.backgroundPosition || "0 0",
        repeat: cs.backgroundRepeat || "no-repeat",
      });
    }
    return results;
  });

  if (gradients.length === 0) return;

  for (const g of gradients) {
    await page.evaluate((g) => new Promise((resolve) => {
      const ghost = document.createElement("div");
      ghost.id = "__pf_grad_ghost__";
      ghost.style.cssText = [
        "position: absolute",
        "left: 0",
        "top: 0",
        `width: ${g.w}px`,
        `height: ${g.h}px`,
        `background-image: ${g.bg}`,
        `background-size: ${g.size}`,
        `background-position: ${g.pos}`,
        `background-repeat: ${g.repeat}`,
        "pointer-events: none",
        "z-index: 2147483647",
        "box-shadow: none",
        "border: none",
        "margin: 0",
        "padding: 0",
      ].join(";");
      document.body.appendChild(ghost);
      // Two rAFs to ensure the ghost has actually painted before screenshot.
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }), g);

    let dataUrl = null;
    try {
      const handle = await page.$("#__pf_grad_ghost__");
      if (handle) {
        const buf = await handle.screenshot({ omitBackground: true, type: "png" });
        await handle.dispose();
        dataUrl = "data:image/png;base64," + buf.toString("base64");
      }
    } catch (e) {
      console.warn(`CSS gradient rasterization failed for ${g.id}:`, e.message);
    }

    await page.evaluate(({ id, dataUrl }) => {
      document.getElementById("__pf_grad_ghost__")?.remove();
      if (!dataUrl) return;
      const target = document.querySelector(`[data-pf-grad="${id}"]`);
      if (!target) return;
      // Use the `background` shorthand to fully clobber any stylesheet
      // `background: linear-gradient(...)` declaration, then restore the
      // other background-* longhands explicitly.
      target.style.background = `url("${dataUrl}")`;
      target.style.backgroundSize = "100% 100%";
      target.style.backgroundRepeat = "no-repeat";
      target.style.backgroundPosition = "0 0";
      target.removeAttribute("data-pf-grad");
    }, { id: g.id, dataUrl });
  }
}

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

// ── Flatten gradients ────────────────────────────────────────────────────
// Chromium's page.pdf() serializes SVG gradients and CSS gradients as PDF
// axial/radial shading objects. These shadings are poorly supported by many
// PDF viewers (macOS Preview, Skim, arXiv's in-browser previewer, some
// LaTeX tooling), appearing as black or missing regions. We rasterize every
// gradient-bearing element into an embedded PNG before exporting so the
// resulting PDF contains no shading objects.
//
// Two code paths:
//   1. SVG <linearGradient>/<radialGradient>: in-browser canvas rasterization
//      of the gradient-using element, replacement with <image href="data:...">.
//   2. CSS linear/radial/conic-gradient on HTML backgrounds: Playwright
//      screenshots an off-document ghost div rendering just the gradient,
//      then swaps the element's background-image to the resulting PNG.
//
// If no gradients exist, both paths are no-ops.
await flattenSvgGradients(page);
await flattenCssGradients(page);
await new Promise(r => setTimeout(r, 100));

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
