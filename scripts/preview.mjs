#!/usr/bin/env node
/**
 * Paper-mockup preview server for academic figures.
 *
 * Usage:
 *   node preview.mjs [--port 3000] [/path/to/figure.html]
 *
 * Then open the printed URL:
 *   http://127.0.0.1:<selected-port>/projects/paper/fig1.html
 *   Pass --port for a fixed port. Otherwise the script derives a stable
 *   port from username+hostname in the range greater than 18900.
 *
 * Features:
 * - Universal: URL path maps to ~/path file
 * - Paper mockup: three layout modes (ICLR full, ICML column, ICML full)
 * - Hot reload: watches the figure file and auto-reloads on change
 * - Fade toggle: switch between faded and normal text
 * - File history: dropdown to switch between recently viewed figures
 */
import http from "http";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { dirname, join, extname, basename, resolve, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_START_TIME = Date.now();
const AUTO_PORT_MIN = 18901;
const AUTO_PORT_MAX = 65535;
const AUTO_PORT_SPAN = AUTO_PORT_MAX - AUTO_PORT_MIN + 1;

function exitWithError(message) {
  console.error(message);
  process.exit(1);
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) {
    exitWithError("Port must be an integer between 1 and 65535.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    exitWithError("Port must be an integer between 1 and 65535.");
  }
  return port;
}

function currentUsername() {
  try {
    const username = os.userInfo().username;
    if (username) return username;
  } catch {
    // Fall through to environment-based fallback in restricted environments.
  }
  return process.env.USER || process.env.USERNAME || "unknown-user";
}

function autoPortIdentity() {
  const hostname = os.hostname() || "unknown-host";
  return `${currentUsername()}@${hostname}`;
}

function deriveStableAutoPort(identity) {
  const hashHex = crypto.createHash("sha256").update(identity).digest("hex");
  const hashPrefix = hashHex.slice(0, 8);
  const hashValue = Number.parseInt(hashPrefix, 16) >>> 0;
  return AUTO_PORT_MIN + (hashValue % AUTO_PORT_SPAN);
}

// ── Parse args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let requestedPort = null;
let resolvedPort = null;
let initialFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") {
    if (!args[i + 1]) {
      exitWithError("Port must be an integer between 1 and 65535.");
    }
    requestedPort = parsePort(args[i + 1]);
    i++;
  }
  else if (!initialFile) initialFile = resolve(args[i]);
}
const portMode = requestedPort === null ? "auto" : "explicit";
const autoPortKey = autoPortIdentity();
const resolvedAutoPort = portMode === "auto" ? deriveStableAutoPort(autoPortKey) : null;

function describePortMode() {
  return portMode === "auto"
    ? "auto (stable sha256(username@hostname))"
    : "explicit";
}

// ── MIME types ───────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".json": "application/json", ".js": "text/javascript",
  ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

// ── File history tracking ────────────────────────────────────────────────
const fileHistory = []; // [{ path, relPath, addedAt }]
function trackFile(absPath) {
  if (fileHistory.some(f => f.path === absPath)) return;
  const relPath = relative(os.homedir(), absPath);
  fileHistory.push({ path: absPath, relPath, addedAt: Date.now() });
}

// ── SSE: track connected clients per file ────────────────────────────────
const sseClients = new Map(); // filePath → Set<res>
const watchers = new Map();   // targetPath → cleanup()

function broadcastReload(filePath) {
  const clients = sseClients.get(filePath);
  if (!clients) return;
  for (const res of clients) {
    res.write("data: reload\n\n");
  }
}

function watchFile(filePath) {
  if (watchers.has(filePath)) return;
  const listener = (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
      broadcastReload(filePath);
    }
  };
  fs.watchFile(filePath, { interval: 200 }, listener);
  watchers.set(filePath, () => fs.unwatchFile(filePath, listener));
}

// Also watch sibling files (JSON data, CSS, etc.) in the same directory
function watchDir(dirPath) {
  if (watchers.has(dirPath)) return;
  try {
    const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
      // Notify all clients watching files in this directory
      for (const [filePath] of sseClients) {
        if (dirname(filePath) === dirPath) {
          broadcastReload(filePath);
        }
      }
    });
    watchers.set(dirPath, () => watcher.close());
  } catch { /* ignore */ }
}

// ── Mockup HTML generator ────────────────────────────────────────────────
// dirToken is base64url(figDir) — embedded in the URL path so relative
// fetches inside the iframe (e.g. d3.json("data.json")) resolve correctly.
function generateMockupHTML(figFileName, dirToken, currentRelPath, fileHistory) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Paper Mockup — ${figFileName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=STIX+Two+Text:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #e0e0e0;
    display: flex; flex-direction: column; align-items: center;
    min-height: 100vh; padding: 40px 0 20px 0;
    font-family: system-ui, -apple-system, sans-serif;
  }

  /* ── Controls ─────────────────────────────────────────────── */
  .toolbar {
    display: flex; align-items: center;
    margin-bottom: 12px;
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    justify-content: center; padding: 2px 0;
  }
  .tabs {
    display: flex; gap: 8px; align-items: center;
    background: #d0d0d0; border-radius: 8px; padding: 3px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  .tab-buttons {
    display: flex; gap: 4px;
  }
  .tab {
    padding: 8px 18px; border: none; background: transparent;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; font-weight: 500; color: #555;
    cursor: pointer; border-radius: 6px; transition: all 0.15s;
    white-space: nowrap;
  }
  .tab:hover { color: #222; background: rgba(255,255,255,0.5); }
  .tab.active { background: #fff; color: #111; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .fade-label {
    font-size: 12px; color: #666;
    cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 4px;
    padding: 8px 14px; border: none; background: transparent;
    border-left: 1px solid rgba(0,0,0,0.1);
    border-radius: 6px; transition: all 0.15s;
    white-space: nowrap;
  }
  .fade-label:hover { color: #222; background: rgba(255,255,255,0.5); }
  .fade-label input { cursor: pointer; margin: 0; }

  .file-select {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: #555;
    cursor: pointer;
    border-radius: 6px;
    max-width: 200px;
    text-overflow: ellipsis;
  }
  .file-select:hover { color: #222; background: rgba(255,255,255,0.5); }
  .file-select:focus { outline: none; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .file-separator {
    width: 1px;
    height: 20px;
    background: rgba(0,0,0,0.1);
    margin: 0 4px;
    align-self: center;
  }

  /* ── Color variables ──────────────────────────────────────── */
  :root { --tc: #222; --tl: #555; }
  :root.text-faded { --tc: #bbb; --tl: #ccc; }

  /* ── Paper page ───────────────────────────────────────────── */
  .paper {
    background: #fff;
    box-shadow: 0 2px 16px rgba(0,0,0,0.15);
    position: relative; overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
  .text-area { position: absolute; overflow: hidden; }

  /* ── LaTeX typography (10pt/11pt Times) ────────────────────
   * 10pt = 13.33px, 11pt = 14.67px, 12pt = 16px, 14pt = 18.67px */
  .paper-body {
    font-family: "STIX Two Text", "Times New Roman", "Nimbus Roman", Times, serif;
    font-size: 13.33px; line-height: 14.67px;
    color: var(--tc); text-align: justify;
    hyphens: auto; -webkit-hyphens: auto;
  }
  .paper-title {
    font-size: 18.67px; line-height: 22px;
    font-weight: 700; text-align: center;
    color: var(--tc); margin-bottom: 6px;
  }
  .paper-authors {
    font-size: 13.33px; line-height: 16px;
    text-align: center; color: var(--tl); margin-bottom: 16px;
  }
  .paper-abstract-label {
    font-size: 16px; font-weight: 700;
    text-align: center; color: var(--tc);
    margin-bottom: 4px; font-variant: small-caps;
  }
  .paper-abstract {
    font-size: 13.33px; line-height: 14.67px;
    color: var(--tc); text-align: justify;
    margin: 0 48px 12px 48px;
  }
  .paper-section {
    font-size: 16px; line-height: 19px;
    font-weight: 700; color: var(--tc);
    margin: 14px 0 6px 0;
  }
  .paper-subsection {
    font-size: 13.33px; line-height: 16px;
    font-weight: 700; color: var(--tc);
    margin: 10px 0 4px 0;
  }
  .paper-p { margin-bottom: 2px; text-indent: 16px; }
  .paper-p:first-child, .paper-p.no-indent { text-indent: 0; }

  /* ── Figure ───────────────────────────────────────────────── */
  .fig-container {
    margin: 10px 0;
    display: flex; flex-direction: column; align-items: center;
  }
  .fig-wrapper {
    overflow: hidden; position: relative;
  }
  .fig-wrapper iframe {
    border: none; display: block; background: #fff;
    position: absolute; top: 0; left: 0;
    transform-origin: top left;
  }
  .fig-caption {
    font-family: "STIX Two Text", "Times New Roman", Times, serif;
    font-size: 13.33px; line-height: 14.67px;
    color: var(--tc); text-align: left;
    margin-top: 6px; width: 100%; text-indent: 16px;
  }
  .fig-caption b { font-weight: 700; }

  .col-container { display: flex; gap: 0; }
  .col { overflow: hidden; }
  .fig-only-shell {
    background: #fff;
    box-shadow: 0 2px 16px rgba(0,0,0,0.15);
    padding: 12px;
    user-select: none;
    -webkit-user-select: none;
  }
</style>
</head>
<body>

<div class="toolbar">
  <div class="tabs">
    <select id="file-select" class="file-select">
      ${fileHistory.map(f => {
        const selected = f.relPath === currentRelPath ? ' selected' : '';
        const exists = fs.existsSync(f.path);
        return `<option value="${f.relPath}"${selected}${exists ? '' : ' disabled'}>${basename(f.path)}${exists ? '' : ' (missing)'}</option>`;
      }).join('')}
    </select>
    <div class="file-separator"></div>
    <div class="tab-buttons" id="tabs"></div>
    <label class="fade-label"><input type="checkbox" id="fade-toggle"> Fade text</label>
  </div>
</div>
<div id="paper-container"></div>

<script>
/* ── Layout definitions (CSS px at 96 DPI) ───────────────────────────── */
const LAYOUTS = {
  "iclr-full": {
    label: "Full Width",
    pageW: 816, pageH: 1056, textW: 528, textH: 864,
    marginLeft: 144, marginTop: 96, columns: 1, figWidth: 528,
  },
  "icml-column": {
    label: "Single Column",
    pageW: 816, pageH: 1056, textW: 648, textH: 864,
    marginLeft: 84, marginTop: 96, columns: 2, colSep: 24,
    figWidth: 312,
  },
  "icml-full": {
    label: "Full Two-Column",
    pageW: 816, pageH: 1056, textW: 648, textH: 864,
    marginLeft: 84, marginTop: 96, columns: 2, colSep: 24,
    figWidth: 648,
  },
  "figure-only": {
    label: "Figure Only",
    figWidth: 900,
  },
};

const FIG_SRC = "/f/${dirToken}/${figFileName}";
const CURRENT_FILE_NAME = "${figFileName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";
const CURRENT_REL_PATH = "${currentRelPath}";
const CURRENT_ABS_PATH = "${join(os.homedir(), currentRelPath).replace(/\\/g, '\\\\')}";
const INSPECTOR_SVG_TARGET_SELECTOR = "rect,circle,path,text,line,ellipse,polygon,polyline,image";
const INSPECTOR_HTML_TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figcaption", "caption", "td", "th", "a", "button", "label"]);
const INSPECTOR_TEXT_LEAF_TAGS = new Set(["div", "span"]);
const INSPECTOR_HTML_MEDIA_TAGS = new Set(["img"]);
const INSPECTOR_HTML_CONTAINER_TAGS = new Set(["div", "section", "article", "aside", "figure"]);
const INSPECTOR_HTML_IGNORED_TAGS = new Set(["html", "head", "body", "script", "style", "link", "meta", "title"]);
const INSPECTOR_INLINE_TEXT_TAGS = new Set(["a", "abbr", "b", "br", "code", "em", "i", "mark", "small", "span", "strong", "sub", "sup", "u", "wbr"]);
const INSPECTOR_CONTAINER_LABEL_SELECTOR = "h1,h2,h3,h4,h5,h6,figcaption,caption,label,.label,.sub-title,.sec-title,.ftitle";
const INSPECTOR_GLOW_BLUE = "#2563eb";
const INSPECTOR_GLOW_GREEN = "#16a34a";
const INSPECTOR_DRAG_THRESHOLD = 6;
const INSPECTOR_SELECTION_FILL = "rgba(37, 99, 235, 0.14)";
const INSPECTOR_SELECTION_STROKE = "rgba(37, 99, 235, 0.75)";

/* ── Lorem ipsum ─────────────────────────────────────────────────────── */
const L = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
  "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
  "Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper.",
  "Nulla consequat massa quis enim. Donec pede justo, fringilla vel, aliquet nec, vulputate eget, arcu. In enim justo, rhoncus ut, imperdiet a, venenatis vitae, justo. Nullam dictum felis eu pede mollis pretium.",
  "Cras ultricies mi eu turpis hendrerit fringilla. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae. Fusce id purus. Ut varius tincidunt libero. Phasellus dolor.",
  "Maecenas tempus, tellus eget condimentum rhoncus, sem quam semper libero, sit amet adipiscing sem neque sed ipsum. Nam quam nunc, blandit vel, luctus pulvinar, hendrerit id, lorem.",
  "Aenean commodo ligula eget dolor. Aenean massa. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus. Donec quam felis, ultricies nec, pellentesque eu, pretium quis, sem.",
  "Etiam ultricies nisi vel augue. Curabitur ullamcorper ultricies nisi. Nam eget dui. Etiam rhoncus. Maecenas tempus, tellus eget condimentum rhoncus, sem quam semper libero.",
  "Integer tincidunt. Cras dapibus. Vivamus elementum semper nisi. Aenean vulputate eleifend tellus. Aenean leo ligula, porttitor eu, consequat vitae, eleifend ac, enim.",
  "Praesent blandit laoreet nibh. Fusce convallis metus id felis luctus adipiscing. Pellentesque egestas, neque sit amet convallis pulvinar, justo nulla eleifend augue, ac auctor orci leo non est.",
  "Sed fringilla mauris sit amet nibh. Donec sodales sagittis magna. Sed consequat, leo eget bibendum sodales, augue velit cursus nunc, quis gravida magna mi a libero. Fusce vulputate eleifend sapien.",
  "Quisque rutrum. Aenean imperdiet. Etiam ultricies nisi vel augue. Curabitur ullamcorper ultricies nisi. Nam eget dui. Etiam rhoncus.",
];
const ABS = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor sit amet, ante. Donec eu libero sit amet quam egestas semper.";

function p(t,c){return '<p class="paper-p'+(c?' '+c:'')+'">' + t + '</p>';}
function sec(n,t){return '<div class="paper-section">'+n+' '+t+'</div>';}
function sub(n,t){return '<div class="paper-subsection">'+n+' '+t+'</div>';}
function ps(s,n){let h='';for(let i=0;i<n;i++){const a=L[(s+i)%L.length];const b=L[(s+i+4)%L.length];h+=p(a+' '+b,i===0?'no-indent':'');}return h;}

function escapeCssIdentifier(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => String.fromCharCode(92) + ch);
}

function escapeAttributeValue(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function getMeaningfulDataAttributes(el) {
  return Array.from(el.attributes).filter((attr) => {
    if (!attr.name.startsWith("data-")) return false;
    return !!(attr.value && attr.value.trim());
  });
}

function getNthOfType(el) {
  let index = 1;
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index++;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function buildDataAttributeSelector(el) {
  return getMeaningfulDataAttributes(el)
    .map((attr) => "[" + attr.name + '="' + escapeAttributeValue(attr.value) + '"]')
    .join("");
}

function normalizeInspectorName(value) {
  return String(value || "").trim().replace(/\\s+/g, " ");
}

function getInspectorVisibleText(el) {
  return normalizeInspectorName(typeof el.innerText === "string" ? el.innerText : el.textContent);
}

function hasOnlyInlineTextDescendants(el) {
  return Array.from(el.children).every((child) => {
    const childTag = child.tagName ? child.tagName.toLowerCase() : "";
    if (!INSPECTOR_INLINE_TEXT_TAGS.has(childTag)) return false;
    return hasOnlyInlineTextDescendants(child);
  });
}

function isInspectorTextLeaf(el) {
  const tag = el.tagName.toLowerCase();
  if (!INSPECTOR_TEXT_LEAF_TAGS.has(tag)) return false;
  if (!getInspectorVisibleText(el)) return false;
  return hasOnlyInlineTextDescendants(el);
}

function prefersTextInspectorName(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "text") return true;
  if (INSPECTOR_HTML_TEXT_TAGS.has(tag)) return true;
  return isInspectorTextLeaf(el);
}

function isInspectorVisible(el) {
  if (!el || !el.isConnected) return false;
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const style = current.ownerDocument.defaultView.getComputedStyle(current);
    if (!style) break;
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number.parseFloat(style.opacity || "1") === 0) return false;
    if (style.pointerEvents === "none") return false;
    current = current.parentElement;
  }
  return true;
}

function hasVisiblePaint(style) {
  if (!style) return false;
  return style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
    style.backgroundColor !== "transparent";
}

function hasVisibleBorder(style) {
  if (!style) return false;
  return ["Top", "Right", "Bottom", "Left"].some((side) => {
    const borderStyle = style["border" + side + "Style"];
    const borderWidth = Number.parseFloat(style["border" + side + "Width"] || "0");
    const borderColor = style["border" + side + "Color"];
    if (!borderStyle || borderStyle === "none") return false;
    if (!(borderWidth > 0)) return false;
    return borderColor !== "rgba(0, 0, 0, 0)" && borderColor !== "transparent";
  });
}

function isInspectorHtmlContainerTarget(el) {
  if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return false;
  const tag = el.tagName.toLowerCase();
  if (!INSPECTOR_HTML_CONTAINER_TAGS.has(tag)) return false;
  if (!el.classList.length) return false;
  if (el.children.length === 0) return false;
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  if (!style) return false;
  const hasBoxDecoration = hasVisibleBorder(style) || style.boxShadow !== "none" || hasVisiblePaint(style);
  if (!hasBoxDecoration) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 24 && rect.height >= 24;
}

function isInspectorSvgTarget(el) {
  return el.namespaceURI === "http://www.w3.org/2000/svg" &&
    !!(el.matches && el.matches(INSPECTOR_SVG_TARGET_SELECTOR));
}

function isInspectorHtmlTarget(el) {
  if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return false;
  const tag = el.tagName.toLowerCase();
  if (INSPECTOR_HTML_IGNORED_TAGS.has(tag)) return false;
  if (el.id) return true;
  if (getMeaningfulDataAttributes(el).length > 0) return true;
  if (INSPECTOR_HTML_MEDIA_TAGS.has(tag)) return true;
  if (INSPECTOR_HTML_TEXT_TAGS.has(tag)) return !!getInspectorVisibleText(el);
  if (isInspectorHtmlContainerTarget(el)) return true;
  return isInspectorTextLeaf(el);
}

function isInspectorTarget(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (!isInspectorVisible(el)) return false;
  return isInspectorSvgTarget(el) || isInspectorHtmlTarget(el);
}

function buildInspectorName(el) {
  const tag = el.tagName.toLowerCase();

  if (prefersTextInspectorName(el)) {
    const textContent = getInspectorVisibleText(el);
    if (textContent) return textContent;
  }

  if (tag === "img") {
    const alt = normalizeInspectorName(el.getAttribute("alt"));
    if (alt) return alt;
  }

  const dataName = el.getAttribute("data-name");
  if (dataName && dataName.trim()) return normalizeInspectorName(dataName);

  for (const attr of getMeaningfulDataAttributes(el)) {
    if (attr.name === "data-name") continue;
    return normalizeInspectorName(attr.value);
  }

  if (isInspectorHtmlContainerTarget(el) && el.querySelector) {
    const labelEl = el.querySelector(INSPECTOR_CONTAINER_LABEL_SELECTOR);
    if (labelEl) {
      const labelText = getInspectorVisibleText(labelEl);
      if (labelText) return labelText;
    }
  }

  const firstClass = Array.from(el.classList).find(Boolean);
  if (firstClass) return normalizeInspectorName(firstClass);

  return tag;
}

function getSelectorPart(el) {
  const dataSelector = buildDataAttributeSelector(el);
  if (el.id) return "#" + escapeCssIdentifier(el.id) + dataSelector;

  const tag = el.tagName.toLowerCase();
  const firstClass = Array.from(el.classList).find(Boolean);
  let selector = tag;
  if (firstClass) selector += "." + escapeCssIdentifier(firstClass);
  if (!dataSelector) selector += ":nth-of-type(" + getNthOfType(el) + ")";
  return selector + dataSelector;
}

function buildInspectorSelector(doc, target) {
  const parts = [];
  let current = target;
  const stopAt = doc.body || doc.documentElement;

  while (current && current !== stopAt && current !== doc.documentElement) {
    const part = getSelectorPart(current);
    parts.unshift(part);
    current = current.parentElement;
  }

  let selector = 'html[file="' + escapeAttributeValue(CURRENT_FILE_NAME) + '"]';
  if (doc.body && (current === doc.body || doc.body.contains(target))) selector += " > body";
  if (parts.length) selector += " > " + parts.join(" > ");
  return selector;
}

function compareInspectorTargetsInDocumentOrder(a, b) {
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function buildInspectorCopyItems(doc, targets) {
  return targets.map((target) => {
    const selector = buildInspectorSelector(doc, target);
    const name = buildInspectorName(target);
    return {
      name,
      selector,
      copyText: "[" + name + "](" + selector + ")",
    };
  });
}

function postInspectorCopy(doc, targets) {
  const items = buildInspectorCopyItems(doc, targets);
  if (!items.length) return;
  window.parent.postMessage({
    type: "inspector-copy",
    items,
    selector: items[0].selector,
    copyText: items.map((item) => item.copyText).join("\\n"),
  }, "*");
}

function clearInspectorFlashTimer(state) {
  if (state.removeTimer) {
    clearTimeout(state.removeTimer);
    state.removeTimer = null;
  }
}

function pruneInspectorTargets(targets) {
  const nextTargets = new Set();
  for (const target of targets) {
    if (target && target.isConnected) nextTargets.add(target);
  }
  return nextTargets;
}

function updateInspectorEffects(state) {
  if (state.hoverTarget && !state.hoverTarget.isConnected) state.hoverTarget = null;
  state.selectionTargets = pruneInspectorTargets(state.selectionTargets);
  state.flashTargets = pruneInspectorTargets(state.flashTargets);

  const trackedTargets = new Set(state.baseInlineFilterByTarget.keys());
  if (state.hoverTarget) trackedTargets.add(state.hoverTarget);
  for (const target of state.selectionTargets) trackedTargets.add(target);
  for (const target of state.flashTargets) trackedTargets.add(target);

  for (const target of trackedTargets) {
    if (!target || !target.isConnected) {
      state.baseInlineFilterByTarget.delete(target);
      continue;
    }
    if (!state.baseInlineFilterByTarget.has(target)) {
      state.baseInlineFilterByTarget.set(target, target.style.filter);
    }
    const baseFilter = state.baseInlineFilterByTarget.get(target) || "";
    const glowColor = state.flashTargets.has(target)
      ? INSPECTOR_GLOW_GREEN
      : ((state.hoverTarget === target || state.selectionTargets.has(target)) ? INSPECTOR_GLOW_BLUE : null);
    const filters = [];
    if (baseFilter) filters.push(baseFilter);
    if (glowColor) filters.push(buildInspectorGlow(glowColor));
    if (filters.length) target.style.filter = filters.join(" ");
    else {
      if (baseFilter) target.style.filter = baseFilter;
      else target.style.removeProperty("filter");
      state.baseInlineFilterByTarget.delete(target);
    }
  }
}

function buildInspectorGlow(color) {
  return [
    "drop-shadow(0 0 1px " + color + ")",
    "drop-shadow(0 0 4px " + color + ")",
    "drop-shadow(0 0 8px " + color + ")",
  ].join(" ");
}

function setInspectorHoverTarget(state, target) {
  const nextTarget = target && target.isConnected ? target : null;
  if (state.hoverTarget === nextTarget) return;
  state.hoverTarget = nextTarget;
  updateInspectorEffects(state);
}

function setInspectorSelectionTargets(state, targets) {
  state.selectionTargets = new Set(targets);
  updateInspectorEffects(state);
}

function clearInspectorSelectionTargets(state) {
  if (!state.selectionTargets.size) return;
  state.selectionTargets.clear();
  updateInspectorEffects(state);
}

function flashInspectorTargets(state, targets) {
  clearInspectorFlashTimer(state);
  state.flashTargets = new Set(targets.filter((target) => target && target.isConnected));
  updateInspectorEffects(state);
  if (!state.flashTargets.size) return;
  state.removeTimer = setTimeout(() => {
    state.flashTargets.clear();
    state.removeTimer = null;
    updateInspectorEffects(state);
  }, 300);
}

function ensureInspectorSelectionOverlay(doc) {
  if (doc.__inspectorSelectionOverlay) return doc.__inspectorSelectionOverlay;

  const overlayRoot = doc.createElement("div");
  overlayRoot.__inspectorInternal = true;
  overlayRoot.style.position = "fixed";
  overlayRoot.style.inset = "0";
  overlayRoot.style.pointerEvents = "none";
  overlayRoot.style.zIndex = "2147483647";
  overlayRoot.style.display = "none";

  const box = doc.createElement("div");
  box.__inspectorInternal = true;
  box.style.position = "absolute";
  box.style.border = "1px solid " + INSPECTOR_SELECTION_STROKE;
  box.style.background = INSPECTOR_SELECTION_FILL;
  box.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.45) inset";

  overlayRoot.appendChild(box);
  (doc.body || doc.documentElement).appendChild(overlayRoot);
  doc.__inspectorSelectionOverlay = { root: overlayRoot, box };
  return doc.__inspectorSelectionOverlay;
}

function updateInspectorSelectionOverlay(doc, rect) {
  const overlay = ensureInspectorSelectionOverlay(doc);
  overlay.root.style.display = "block";
  overlay.box.style.left = rect.left + "px";
  overlay.box.style.top = rect.top + "px";
  overlay.box.style.width = rect.width + "px";
  overlay.box.style.height = rect.height + "px";
}

function hideInspectorSelectionOverlay(doc) {
  const overlay = ensureInspectorSelectionOverlay(doc);
  overlay.root.style.display = "none";
  overlay.box.style.width = "0";
  overlay.box.style.height = "0";
}

function buildInspectorSelectionRect(startX, startY, currentX, currentY) {
  const left = Math.min(startX, currentX);
  const top = Math.min(startY, currentY);
  const right = Math.max(startX, currentX);
  const bottom = Math.max(startY, currentY);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function rectContainsRect(outer, inner) {
  if (!(outer.width > 0 && outer.height > 0)) return false;
  if (!(inner.width > 0 && inner.height > 0)) return false;
  return outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom;
}

function getInspectorElementDepth(el) {
  let depth = 0;
  let current = el;
  while (current && current.parentElement) {
    depth++;
    current = current.parentElement;
  }
  return depth;
}

function getLowestCommonAncestor(elements) {
  if (!elements.length) return null;
  let current = elements[0];
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const containsAll = elements.every((el) => current.contains(el));
    if (containsAll) return current;
    current = current.parentElement;
  }
  return null;
}

function collectInspectorSelectionTargets(doc, rect) {
  const enclosedElements = [];
  for (const el of doc.querySelectorAll("*")) {
    if (el.__inspectorInternal) continue;
    const bounds = el.getBoundingClientRect();
    if (!rectContainsRect(rect, bounds)) continue;
    if (!isInspectorVisible(el)) continue;
    enclosedElements.push({ el, depth: getInspectorElementDepth(el) });
  }

  enclosedElements.sort((a, b) => b.depth - a.depth);

  const deepestElements = [];
  for (const { el } of enclosedElements) {
    if (deepestElements.some((existing) => el.contains(existing))) continue;
    deepestElements.push(el);
  }

  const commonAncestor = getLowestCommonAncestor(deepestElements);
  return commonAncestor ? [commonAncestor] : [];
}

function disableInspectorUserSelect(doc, state) {
  const root = doc.documentElement;
  state.drag.originalUserSelect = root.style.userSelect;
  state.drag.originalWebkitUserSelect = root.style.webkitUserSelect;
  root.style.userSelect = "none";
  root.style.webkitUserSelect = "none";
}

function restoreInspectorUserSelect(doc, state) {
  const root = doc.documentElement;
  root.style.userSelect = state.drag.originalUserSelect;
  root.style.webkitUserSelect = state.drag.originalWebkitUserSelect;
  state.drag.originalUserSelect = "";
  state.drag.originalWebkitUserSelect = "";
}

function releaseInspectorPointerCapture(state) {
  const captureTarget = state.drag.captureTarget;
  const pointerId = state.drag.pointerId;
  if (!captureTarget || pointerId === null) {
    state.drag.captureTarget = null;
    return;
  }
  try {
    if (!captureTarget.hasPointerCapture || captureTarget.hasPointerCapture(pointerId)) {
      captureTarget.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore release failures when the pointer capture state has already been cleared.
  }
  state.drag.captureTarget = null;
}

function clearInspectorDragFrame(doc, state) {
  if (!state.drag.frameHandle) return;
  doc.defaultView.cancelAnimationFrame(state.drag.frameHandle);
  state.drag.frameHandle = null;
}

function updateInspectorDragSelection(doc, state) {
  if (!state.drag.isDragging) return;
  const rect = buildInspectorSelectionRect(
    state.drag.startX,
    state.drag.startY,
    state.drag.currentX,
    state.drag.currentY
  );
  updateInspectorSelectionOverlay(doc, rect);
  setInspectorSelectionTargets(state, collectInspectorSelectionTargets(doc, rect));
}

function queueInspectorDragSelectionUpdate(doc, state) {
  if (state.drag.frameHandle) return;
  state.drag.frameHandle = doc.defaultView.requestAnimationFrame(() => {
    state.drag.frameHandle = null;
    updateInspectorDragSelection(doc, state);
  });
}

function startInspectorDrag(doc, state) {
  state.drag.isDragging = true;
  setInspectorHoverTarget(state, null);
  clearInspectorFlashTimer(state);
  state.flashTargets.clear();
  updateInspectorEffects(state);
  disableInspectorUserSelect(doc, state);
  queueInspectorDragSelectionUpdate(doc, state);
}

function finishInspectorDrag(doc, state, shouldCopy) {
  const selectedTargets = Array.from(state.selectionTargets).sort(compareInspectorTargetsInDocumentOrder);
  clearInspectorDragFrame(doc, state);
  hideInspectorSelectionOverlay(doc);
  clearInspectorSelectionTargets(state);
  restoreInspectorUserSelect(doc, state);

  if (shouldCopy && selectedTargets.length) {
    postInspectorCopy(doc, selectedTargets);
    flashInspectorTargets(state, selectedTargets);
  } else {
    clearInspectorFlashTimer(state);
    state.flashTargets.clear();
    updateInspectorEffects(state);
  }

  releaseInspectorPointerCapture(state);
  state.drag.pointerId = null;
  state.drag.isDragging = false;
  state.drag.startX = 0;
  state.drag.startY = 0;
  state.drag.currentX = 0;
  state.drag.currentY = 0;
}

function bindInspectorDocumentInteractions(doc, state) {
  if (doc.__inspectorInteractionsBound) return;

  doc.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (state.drag.pointerId !== null) return;
    state.drag.suppressNextClick = false;
    state.drag.pointerId = event.pointerId;
    state.drag.startX = event.clientX;
    state.drag.startY = event.clientY;
    state.drag.currentX = event.clientX;
    state.drag.currentY = event.clientY;
    state.drag.isDragging = false;
    state.drag.captureTarget = null;
    if (event.target && typeof event.target.setPointerCapture === "function") {
      try {
        event.target.setPointerCapture(event.pointerId);
        state.drag.captureTarget = event.target;
      } catch {
        state.drag.captureTarget = null;
      }
    }
  }, true);

  doc.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.drag.pointerId) return;
    state.drag.currentX = event.clientX;
    state.drag.currentY = event.clientY;
    if (!state.drag.isDragging) {
      const dx = state.drag.currentX - state.drag.startX;
      const dy = state.drag.currentY - state.drag.startY;
      if (Math.hypot(dx, dy) < INSPECTOR_DRAG_THRESHOLD) return;
      startInspectorDrag(doc, state);
    }
    event.preventDefault();
    queueInspectorDragSelectionUpdate(doc, state);
  }, true);

  const finishPointerSession = (event, shouldCopy) => {
    if (event.pointerId !== state.drag.pointerId) return;
    const wasDragging = state.drag.isDragging;
    if (wasDragging) {
      event.preventDefault();
      event.stopPropagation();
      state.drag.suppressNextClick = true;
      finishInspectorDrag(doc, state, shouldCopy);
    } else {
      releaseInspectorPointerCapture(state);
      state.drag.pointerId = null;
      state.drag.captureTarget = null;
    }
  };

  doc.addEventListener("pointerup", (event) => {
    finishPointerSession(event, true);
  }, true);

  doc.addEventListener("pointercancel", (event) => {
    finishPointerSession(event, false);
  }, true);

  doc.addEventListener("dragstart", (event) => {
    if (state.drag.pointerId === null && !state.drag.isDragging) return;
    event.preventDefault();
  }, true);

  doc.addEventListener("click", (event) => {
    if (!state.drag.suppressNextClick) return;
    state.drag.suppressNextClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  doc.__inspectorInteractionsBound = true;
}

function bindInspectorTarget(el, state) {
  if (!el || el.__inspectorBound) return;
  el.__inspectorBound = true;
  el.style.cursor = "pointer";
  el.addEventListener("mouseenter", () => {
    if (state.drag.isDragging) return;
    setInspectorHoverTarget(state, el);
  });
  el.addEventListener("mouseleave", () => {
    if (state.drag.isDragging) return;
    if (state.hoverTarget === el) setInspectorHoverTarget(state, null);
  });
  el.addEventListener("click", (e) => {
    if (state.drag.suppressNextClick) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const doc = el.ownerDocument;
      if (!doc) return;
      postInspectorCopy(doc, [el]);
      flashInspectorTargets(state, [el]);
    } catch (err) {
      console.warn("[mockup] inspector click failed:", err);
      clearInspectorFlashTimer(state);
      state.flashTargets.clear();
      updateInspectorEffects(state);
    }
  });
}

function bindInspectorTargetsInSubtree(root, state) {
  if (!root) return;
  if (root.nodeType === Node.ELEMENT_NODE && isInspectorTarget(root)) bindInspectorTarget(root, state);
  if (root.querySelectorAll) {
    for (const el of root.querySelectorAll("*")) {
      if (isInspectorTarget(el)) bindInspectorTarget(el, state);
    }
  }
}

function setupInspector(doc) {
  if (!doc.__inspectorState) {
    doc.__inspectorState = {
      removeTimer: null,
      hoverTarget: null,
      selectionTargets: new Set(),
      flashTargets: new Set(),
      baseInlineFilterByTarget: new Map(),
      drag: {
        pointerId: null,
        captureTarget: null,
        isDragging: false,
        suppressNextClick: false,
        startX: 0,
        startY: 0,
        currentX: 0,
        currentY: 0,
        frameHandle: null,
        originalUserSelect: "",
        originalWebkitUserSelect: "",
      },
    };
  }
  const state = doc.__inspectorState;

  bindInspectorTargetsInSubtree(doc.documentElement, state);
  bindInspectorDocumentInteractions(doc, state);
  ensureInspectorSelectionOverlay(doc);

  if (!doc.__inspectorObserver) {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          bindInspectorTargetsInSubtree(node, state);
        }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    doc.__inspectorObserver = observer;
  }
}

function figHTML(fw) {
  // Cache-bust: append timestamp so iframe always reloads
  const src = FIG_SRC + "?t=" + Date.now();
  return '<div class="fig-container">' +
    '<div class="fig-wrapper" id="fig-wrapper" data-target-w="' + fw + '">' +
      '<iframe id="fig-iframe" src="' + src + '" scrolling="no"></iframe>' +
    '</div>' +
    '<div class="fig-caption"><b>Figure 1:</b> Placeholder caption describing the figure content. ' +
    'Best results per column in bold. Marker shapes indicate architectural variants. ' +
    'Error bars denote standard deviation across random seeds, and the schematic highlights the main computational stages used in the proposed pipeline for comparison against baseline systems.</div></div>';
}

function figOnlyHTML(fw) {
  const src = FIG_SRC + "?t=" + Date.now();
  return '<div class="fig-container">' +
    '<div class="fig-wrapper" id="fig-wrapper" data-target-w="' + fw + '">' +
      '<iframe id="fig-iframe" src="' + src + '" scrolling="no"></iframe>' +
    '</div></div>';
}

function getDocumentDimensions(doc) {
  const root = doc.documentElement;
  const body = doc.body;
  const width = Math.max(
    root ? root.scrollWidth : 0,
    root ? root.clientWidth : 0,
    body ? body.scrollWidth : 0,
    body ? body.clientWidth : 0
  );
  const height = Math.max(
    root ? root.scrollHeight : 0,
    root ? root.clientHeight : 0,
    body ? body.scrollHeight : 0,
    body ? body.clientHeight : 0
  );
  return { width, height };
}

/* ── Build tabs ──────────────────────────────────────────────────────── */
const tabsEl = document.getElementById("tabs");
for (const [key, layout] of Object.entries(LAYOUTS)) {
  const btn = document.createElement("button");
  btn.className = "tab"; btn.dataset.layout = key; btn.textContent = layout.label;
  btn.onclick = () => renderMockup(key);
  tabsEl.appendChild(btn);
}

/* ── Render ───────────────────────────────────────────────────────────── */
let currentLayout = "iclr-full";

function renderMockup(layoutKey) {
  currentLayout = layoutKey;
  const lo = LAYOUTS[layoutKey];
  const container = document.getElementById("paper-container");
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.layout === layoutKey));

  if (layoutKey === "figure-only") {
    container.innerHTML = '<div class="fig-only-shell">' + figOnlyHTML(lo.figWidth) + '</div>';
    setupIframe();
    return;
  }

  const { pageW, pageH, textW, textH, marginLeft, marginTop, figWidth } = lo;
  let html = "";

  if (lo.columns === 1) {
    html =
      '<div class="text-area paper-body" style="left:'+marginLeft+'px;top:'+marginTop+'px;width:'+textW+'px;height:'+textH+'px;">' +
        '<div class="paper-title">Lorem Ipsum Dolor Sit Amet Consectetur<br>Adipiscing Elit Sed Do Eiusmod</div>' +
        '<div class="paper-authors">Anonymous Authors</div>' +
        '<div class="paper-abstract-label">Abstract</div>' +
        '<div class="paper-abstract">'+ABS+'</div>' +
        figHTML(figWidth) +
        sec("1","Introduction") + ps(0,3) +
        ps(3,2) + sec("2","Related Work") + ps(5,3) +
        sub("2.1","Memory-Augmented Agents") + ps(8,3) +
        sec("3","Method") + ps(0,4) +
      '</div>';
  } else if (figWidth >= textW * 0.9) {
    const cw = (textW - lo.colSep) / 2;
    html =
      '<div class="text-area paper-body" style="left:'+marginLeft+'px;top:'+marginTop+'px;width:'+textW+'px;height:'+textH+'px;">' +
        figHTML(figWidth) +
        '<div class="col-container" style="gap:'+lo.colSep+'px;">' +
          '<div class="col" style="width:'+cw+'px;">'+sec("4","Results")+ps(0,3)+sub("4.1","Main Results")+ps(3,4)+sub("4.2","Ablation Study")+ps(7,3)+'</div>' +
          '<div class="col" style="width:'+cw+'px;">'+ps(2,3)+sec("5","Analysis")+ps(5,4)+sub("5.1","Structural Diversity")+ps(9,3)+'</div>' +
        '</div></div>';
  } else {
    const cw = (textW - lo.colSep) / 2;
    html =
      '<div class="text-area paper-body" style="left:'+marginLeft+'px;top:'+marginTop+'px;width:'+textW+'px;height:'+textH+'px;">' +
        '<div class="col-container" style="gap:'+lo.colSep+'px;">' +
          '<div class="col" style="width:'+cw+'px;">'+figHTML(figWidth)+ps(0,2)+ps(2,2)+sub("4.2","Ablation Study")+ps(4,3)+'</div>' +
          '<div class="col" style="width:'+cw+'px;">'+sec("4","Results")+ps(6,3)+sub("4.1","Main Results")+ps(9,3)+ps(0,3)+'</div>' +
        '</div></div>';
  }

  container.innerHTML = '<div class="paper" style="width:'+pageW+'px;height:'+pageH+'px;">'+html+'</div>';
  setupIframe();
}

function setupIframe() {
  const iframe = document.getElementById("fig-iframe");
  const wrapper = document.getElementById("fig-wrapper");
  if (!iframe || !wrapper) { console.warn("[mockup] no iframe or wrapper found"); return; }
  const targetW = parseFloat(wrapper.dataset.targetW);
  console.log("[mockup] setupIframe: targetW=" + targetW + ", src=" + iframe.src);

  iframe.onerror = (e) => console.error("[mockup] iframe load error:", e);

  iframe.onload = () => {
    console.log("[mockup] iframe onload fired, src=" + iframe.src);
    console.log("[mockup] iframe.contentDocument exists:", !!iframe.contentDocument);
    if (iframe.contentDocument) {
      iframe.contentDocument.documentElement.setAttribute("file", CURRENT_FILE_NAME);
      setupInspector(iframe.contentDocument);
    }
    // D3 renders the SVG asynchronously after the HTML loads,
    // so we poll until the SVG element appears in the iframe DOM.
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      try {
        const doc = iframe.contentDocument;
        if (!doc) { console.warn("[mockup] poll #" + attempts + ": no contentDocument (cross-origin?)"); clearInterval(poll); fallback(); return; }
        doc.documentElement.setAttribute("file", CURRENT_FILE_NAME);
        const svg = doc.querySelector("svg");
        if (!svg && attempts < 50) {
          if (attempts % 10 === 0) console.log("[mockup] poll #" + attempts + ": waiting for SVG...");
          return; // keep waiting (up to ~5s)
        }
        clearInterval(poll);
        if (!svg) {
          const dims = getDocumentDimensions(doc);
          if (!dims.width || !dims.height) { console.warn("[mockup] no SVG and document has no dimensions after " + attempts + " attempts"); fallback(); return; }
          const scale = targetW / dims.width;
          console.log("[mockup] sizing from document: " + dims.width + "x" + dims.height + " (attempt #" + attempts + ")");
          wrapper.style.width = targetW + "px";
          wrapper.style.height = (dims.height * scale) + "px";
          iframe.style.width = dims.width + "px";
          iframe.style.height = dims.height + "px";
          iframe.style.transform = "scale(" + scale + ")";
          return;
        }
        // Fix viewBox to include all content (strokes/borders may extend beyond declared dimensions)
        const bbox = svg.getBBox();
        const pad = 2;
        const vbX = bbox.x - pad, vbY = bbox.y - pad;
        const vbW = bbox.width + pad * 2, vbH = bbox.height + pad * 2;
        svg.setAttribute("viewBox", vbX + " " + vbY + " " + vbW + " " + vbH);
        svg.setAttribute("width", vbW);
        svg.setAttribute("height", vbH);
        const svgW = vbW;
        const svgH = vbH;
        console.log("[mockup] SVG found: " + svgW + "x" + svgH + " (after viewBox fix, attempt #" + attempts + ")");
        if (!svgW || !svgH) { console.warn("[mockup] SVG has no dimensions"); fallback(); return; }
        const scale = targetW / svgW;
        console.log("[mockup] scaling: " + scale.toFixed(3) + "x → " + targetW + "x" + (svgH*scale).toFixed(0));
        wrapper.style.width = targetW + "px";
        wrapper.style.height = (svgH * scale) + "px";
        iframe.style.width = svgW + "px";
        iframe.style.height = svgH + "px";
        iframe.style.transform = "scale(" + scale + ")";
      } catch(e) {
        console.error("[mockup] poll error:", e);
        clearInterval(poll);
        fallback();
      }
    }, 100);

    function fallback() {
      console.warn("[mockup] using fallback sizing");
      wrapper.style.width = targetW + "px";
      iframe.style.width = targetW + "px";
      iframe.style.height = "400px";
      wrapper.style.height = "400px";
    }
  };
}

/* ── Fade toggle ─────────────────────────────────────────────────────── */
document.getElementById("fade-toggle").addEventListener("change", function() {
  document.documentElement.classList.toggle("text-faded", this.checked);
});
document.documentElement.classList.toggle("text-faded", document.getElementById("fade-toggle").checked);

window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.type !== "inspector-copy") return;
  const clipboardText = typeof data.copyText === "string"
    ? data.copyText
    : (typeof data.selector === "string" ? data.selector : null);
  if (!clipboardText) return;
  try {
    await navigator.clipboard.writeText(clipboardText);
  } catch (err) {
    console.warn("[mockup] clipboard write failed:", err);
  }
});

/* ── File select dropdown ────────────────────────────────────────────── */
document.getElementById('file-select').addEventListener('change', function() {
  window.location.href = '/' + this.value;
});
// Refresh file list on focus
document.getElementById('file-select').addEventListener('focus', async function() {
  try {
    const res = await fetch('/--api/files');
    const files = await res.json();
    const sel = this;
    const currentVal = sel.value;
    sel.innerHTML = '';
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = f.relPath;
      opt.textContent = f.basename + (f.exists ? '' : ' (missing)');
      opt.disabled = !f.exists;
      if (f.relPath === currentVal) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch(e) { console.warn('Failed to refresh file list:', e); }
});

/* ── Hot reload via SSE ──────────────────────────────────────────────── */
const evtSrc = new EventSource("/--events?path=" + encodeURIComponent(CURRENT_ABS_PATH));
evtSrc.onmessage = () => {
  // Re-render current layout (reloads iframe with cache-bust)
  renderMockup(currentLayout);
};

/* ── Initial render ──────────────────────────────────────────────────── */
renderMockup(currentLayout);
</script>
</body>
</html>`;
}

// ── Debug info page ─────────────────────────────────────────────────────
function generateDebugHTML(notFoundPath = null) {
  const now = Date.now();
  const uptimeMs = now - SERVER_START_TIME;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  const uptimeStr = (days > 0 ? `${days}d ` : '') +
    `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;

  const filesRows = fileHistory.length === 0
    ? '<tr><td colspan="3" style="color:#999;text-align:center;padding:12px;">No files opened yet</td></tr>'
    : fileHistory.map(f => {
        const exists = fs.existsSync(f.path);
        const openedAt = new Date(f.addedAt).toLocaleString();
        return `<tr>
          <td><a href="/${f.relPath}" style="color:#2563eb;text-decoration:none;">${f.relPath}</a></td>
          <td>${openedAt}</td>
          <td>${exists ? '<span style="color:#16a34a;">exists</span>' : '<span style="color:#dc2626;">missing</span>'}</td>
        </tr>`;
      }).join('');
  const displayPort = resolvedPort ?? requestedPort ?? resolvedAutoPort ?? "pending";
  const autoPortRows = portMode === "auto"
    ? `<dt>Auto port key</dt><dd>${autoPortKey}</dd>
      <dt>Auto port</dt><dd>${resolvedAutoPort}</dd>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Paper Figure Preview — Debug Info</title>
<meta http-equiv="refresh" content="5">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; padding: 40px; color: #333; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 24px; color: #111; }
  .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .info-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; font-size: 14px; }
  .info-grid dt { color: #666; font-weight: 500; }
  .info-grid dd { color: #111; font-family: "SF Mono", Menlo, monospace; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #888; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 8px; border-bottom: 1px solid #f0f0f0; font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
  .hint { font-size: 12px; color: #999; margin-top: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>Paper Figure Preview Server</h1>
  ${notFoundPath ? `<div class="card" style="border-left:4px solid #dc2626;"><h2 style="color:#dc2626;">404 Not Found</h2><p style="font-size:14px;color:#555;margin-top:4px;font-family:monospace;">${notFoundPath}</p><p style="font-size:13px;color:#888;margin-top:8px;">File not found or not an .html file. Use a path relative to <code>~</code>, e.g. <code>/repos/paper/fig1.html</code></p></div>` : ''}
  <div class="card">
    <h2>Server Info</h2>
    <dl class="info-grid">
      <dt>Hostname</dt><dd>${os.hostname()}</dd>
      <dt>Platform</dt><dd>${os.platform()} ${os.arch()}</dd>
      <dt>Node.js</dt><dd>${process.version}</dd>
      <dt>Port</dt><dd>${displayPort}</dd>
      <dt>Port mode</dt><dd>${describePortMode()}</dd>
      ${autoPortRows}
      <dt>Started at</dt><dd>${new Date(SERVER_START_TIME).toLocaleString()}</dd>
      <dt>Uptime</dt><dd>${uptimeStr}</dd>
      <dt>PID</dt><dd>${process.pid}</dd>
      <dt>Working dir</dt><dd>${process.cwd()}</dd>
      <dt>Active watchers</dt><dd>${watchers.size}</dd>
      <dt>SSE clients</dt><dd>${[...sseClients.values()].reduce((n, s) => n + s.size, 0)}</dd>
    </dl>
  </div>
  <div class="card">
    <h2>Opened Files (${fileHistory.length})</h2>
    <table>
      <thead><tr><th>Path (relative to ~)</th><th>Opened at</th><th>Status</th></tr></thead>
      <tbody>${filesRows}</tbody>
    </table>
    <p class="hint">Auto-refreshes every 5 seconds. Open a figure by navigating to /<em>home-relative-path</em>.html</p>
  </div>
</div>
</body>
</html>`;
}

function activeRequestPort() {
  return resolvedPort ?? requestedPort ?? resolvedAutoPort ?? AUTO_PORT_MIN;
}

function requireResolvedPort() {
  if (resolvedPort === null) {
    throw new Error("Preview server port has not been resolved yet.");
  }
  return resolvedPort;
}

function baseUrlForPort(port) {
  return `http://127.0.0.1:${port}`;
}

// ── HTTP server ──────────────────────────────────────────────────────────
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${activeRequestPort()}`);
  const pathname = url.pathname;
  const fileParam = url.searchParams.get("file");

  console.log(`[${new Date().toISOString().slice(11,19)}] ${req.method} ${pathname}`);

  // ── Root: debug info page ─────────────────────────────────
  if (pathname === "/" && !fileParam) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateDebugHTML());
    return;
  }

  // ── Internal API routes (--prefixed) ───────────────────────
  if (pathname === "/--api/files") {
    const files = fileHistory.map(f => ({
      relPath: f.relPath,
      basename: basename(f.path),
      exists: fs.existsSync(f.path),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  // ── SSE endpoint for hot reload ────────────────────────────
  if (pathname === "/--events") {
    const fileParam = url.searchParams.get("path");
    if (!fileParam) { res.writeHead(400); res.end(); return; }
    const figPath = resolve(fileParam);
    const figDir = dirname(figPath);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("data: connected\n\n");
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    if (!sseClients.has(figPath)) sseClients.set(figPath, new Set());
    sseClients.get(figPath).add(res);

    watchFile(figPath);
    watchDir(figDir);

    req.on("close", () => {
      clearInterval(heartbeat);
      const clients = sseClients.get(figPath);
      if (clients) { clients.delete(res); }
    });
    return;
  }

  // ── Serve figure files: /f/<base64url(dir)>/filename ────────
  // The directory is encoded in the URL so relative fetches from
  // inside the iframe (e.g. d3.json("data.json")) resolve correctly.
  if (pathname.startsWith("/f/")) {
    const rest = pathname.slice(3); // "<token>/filename..."
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) { res.writeHead(400); res.end("Bad path"); return; }

    const token = rest.slice(0, slashIdx);
    const relPath = decodeURIComponent(rest.slice(slashIdx + 1));
    let figDir;
    try {
      figDir = Buffer.from(token, "base64url").toString("utf-8");
    } catch {
      res.writeHead(400); res.end("Bad token"); return;
    }

    const filePath = join(figDir, relPath);
    const ext = extname(filePath);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.log(`  → 404 ${filePath}`);
        res.writeHead(404); res.end("Not found: " + relPath); return;
      }
      console.log(`  → 200 ${filePath} (${data.length} bytes)`);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
    return;
  }

  // ── Serve mockup: ?file= fallback or home-relative path ────
  const figPath = fileParam ? resolve(fileParam) : join(os.homedir(), decodeURIComponent(pathname));
  if (figPath.endsWith(".html") && fs.existsSync(figPath)) {
    trackFile(figPath);
    const dirToken = Buffer.from(dirname(figPath)).toString("base64url");
    const currentRelPath = relative(os.homedir(), figPath);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(generateMockupHTML(basename(figPath), dirToken, currentRelPath, fileHistory));
    return;
  }

  // ── Fallback: show debug page with 404 note ────────────────
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end(generateDebugHTML(pathname));
}

function createPreviewServer() {
  return http.createServer(handleRequest);
}

// ── URL helper ──────────────────────────────────────────────────────────
function fileUrl(absPath) {
  const port = requireResolvedPort();
  const relPath = relative(os.homedir(), absPath);
  // If relative path escapes home dir (starts with ..), use ?file= fallback
  if (relPath.startsWith("..")) {
    return `http://127.0.0.1:${port}/?file=${encodeURIComponent(absPath)}`;
  }
  return `http://127.0.0.1:${port}/${relPath}`;
}

function isReusableFilesPayload(payload) {
  return Array.isArray(payload) && payload.every((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof entry.relPath === "string" &&
    typeof entry.basename === "string" &&
    typeof entry.exists === "boolean"
  );
}

function probeReusablePreviewServer(port) {
  const baseUrl = baseUrlForPort(port);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get(`${baseUrl}/--api/files`, { timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          finish(false);
          return;
        }
        try {
          finish(isReusableFilesPayload(JSON.parse(body || "null")));
        } catch {
          finish(false);
        }
      });
    });

    req.on("error", () => {
      finish(false);
    });
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
  });
}

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(server);
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);

    try {
      server.listen(port, "127.0.0.1");
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

let previewServer = null;

async function acquirePortAndStartServer() {
  if (portMode === "explicit") {
    const port = requestedPort;
    if (await probeReusablePreviewServer(port)) {
      resolvedPort = port;
      return { baseUrl: baseUrlForPort(port), reused: true };
    }

    const candidateServer = createPreviewServer();
    try {
      await listenOnPort(candidateServer, port);
      previewServer = candidateServer;
      resolvedPort = port;
      return { baseUrl: baseUrlForPort(port), reused: false };
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        throw new Error(`Port ${port} is already in use. Choose another port or omit --port for automatic selection.`);
      }
      throw error;
    }
  }

  const port = resolvedAutoPort;
  if (await probeReusablePreviewServer(port)) {
    resolvedPort = port;
    return { baseUrl: baseUrlForPort(port), reused: true };
  }

  const candidateServer = createPreviewServer();
  try {
    await listenOnPort(candidateServer, port);
    previewServer = candidateServer;
    resolvedPort = port;
    return { baseUrl: baseUrlForPort(port), reused: false };
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      throw new Error(`Auto port ${port} derived from ${autoPortKey} is already in use by another process. Pass --port to override.`);
    }
    throw error;
  }
}

function printStartupSummary(baseUrl, reused) {
  console.log(`Preview server ${reused ? "already running" : "running"} at ${baseUrl}`);
  console.log(`Port mode: ${describePortMode()}`);
  if (portMode === "auto") {
    console.log(`Auto port key: ${autoPortKey}`);
  }

  if (initialFile) {
    console.log(`Figure: ${initialFile}`);
    console.log(`Open: ${fileUrl(initialFile)}`);
  } else {
    console.log(`Open with: ${baseUrl}/<home-relative-path-to-figure.html>`);
  }

  console.log(`Hot reload enabled — edits auto-refresh.\n`);
}

async function main() {
  try {
    const { baseUrl, reused } = await acquirePortAndStartServer();
    printStartupSummary(baseUrl, reused);
    if (reused) {
      process.exit(0);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
