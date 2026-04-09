---
name: paper-figure
description: Create and edit publication-quality academic paper figures using D3.js + HTML/SVG, with live paper-mockup preview and PDF/PNG export via Playwright. Use this skill whenever the user wants to: create a new figure or diagram for a paper; edit, tweak, or update an existing HTML/SVG figure or D3 visualization; change colors, fonts, layout, dimensions, or styling; fix visual issues or alignment problems; adjust data, labels, or legends; redesign or polish a figure for submission. Trigger on: "figure for paper", "edit the figure", "fix the chart", "update the plot", "change the colors", "resize the figure", "modify the diagram", "D3 figure", "HTML figure", "SVG figure", "tikz-style", "matplotlib-style", "visualize results", any mention of editing an existing .html file that contains a chart/figure/diagram. Covers scatter plots, bar charts, line charts, architecture diagrams, flow diagrams, comparison panels, embedding landscapes, ablation plots, heatmaps, and any visual for a research paper.
---

# Paper Figure

Create and edit publication-quality figures for academic papers using D3.js, with live preview and PDF/PNG export.

## Why D3.js instead of matplotlib or TikZ?

D3 gives you full control over every SVG element while running in a browser with live reload. Unlike matplotlib, you can interactively refine positioning, fonts, and layout without re-running a script. Unlike TikZ, you get instant visual feedback and access to web fonts. The final output is a PDF that looks indistinguishable from native LaTeX figures.

## Tech Stack

- **Rendering**: D3.js v7 + inline SVG in a single HTML file
- **Fonts**: Google Fonts via `<link>` with `display=block` (ensures fonts load before render)
- **Preview**: Bundled Node.js server that shows the figure inside a paper-mockup page
- **Export**: Bundled Node.js script using Playwright for HTML-to-PDF conversion
- **Do NOT use**: Plotly, Recharts, Chart.js, or any charting library. Raw D3 only.

## Workflow

### 1. Data Preparation

If the figure needs data processing (embeddings, t-SNE, aggregation), write a Python script that outputs a JSON file. Keep rendering logic out of Python — Python produces data, D3 consumes it.

### 2. Create the Figure HTML

Write a single self-contained HTML file. Structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Fig N — Description</title>
  <!-- Google Font with display=block for reliable PDF export -->
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;600;700&display=block" rel="stylesheet">
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #fff; font-family: "Source Serif 4", Georgia, serif; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    // Load data, build scales, draw SVG
  </script>
</body>
</html>
```

**Font choice**: Source Serif 4 is the default — it pairs well with LaTeX's Computer Modern and renders reliably in Playwright. For sans-serif figures, use Source Sans 3.

**Semantic `data-*` markers are required**: add short `data-*` labels to every meaningful SVG group and leaf element. Use figure-local names; do not invent a heavy naming scheme.

Examples:
- Scatter plot: points layer `g` might use `data-layer="points"`, and each point might use `data-series="Ours"` and `data-point-id="0"`.
- Legend: a legend row might use `data-legend-item="Baseline A"`.
- Architecture diagram: a box might use `data-node="retriever"` and an arrow might use `data-edge="retriever-to-reranker"`.
- Inspector output example: `[Ours:0](html[file="figure.html"] > svg[data-figure="example"] > g[data-layer="points"] > path.point[data-series="Ours"][data-point-id="0"])`.

### 3. Preview in Paper Context

Run the bundled preview server to see how the figure will look in an actual paper:

```bash
node <skill-path>/scripts/preview.mjs <figure.html>
```

Pass `--port <n>` if you want a fixed preview port. Without `--port`, the script derives a stable preview port from the current `username + hostname`, maps it into the range greater than `18900`, and prints the URL. If a `paper-figure` preview server is already running on that derived port, the command reuses it; otherwise it starts a server there. If you explicitly request a port and a `paper-figure` preview server is already running there, the command also reuses it. After starting, **show the preview URL to the user** so they can click to open it in their browser — the URL looks like `http://127.0.0.1:<selected-port>/projects/paper/fig1.html` — the path is relative to your home directory, no encoding needed.

This shows the figure embedded in a paper mockup with three layout modes (switchable via tabs):

| Mode | Width | Simulates |
|------|-------|-----------|
| **ICLR full** | 5.5 in (396pt) | Single-column venue, `\textwidth` |
| **ICML column** | 3.25 in (234pt) | Two-column venue, `\columnwidth` |
| **ICML full** | 6.75 in (486pt) | Two-column venue, `figure*` spanning both columns |

The mockup renders gray placeholder text around the figure so you can judge sizing, font weight, and whitespace in context. Use this to iterate on the figure before exporting.

### 4. Export to PDF

```bash
node <skill-path>/scripts/export_pdf.mjs <figure.html> [output.pdf]
```

The export script:
1. Starts a local HTTP server (avoids `file://` CORS issues with `d3.json()`)
2. Launches headless Chromium via Playwright
3. Waits for `document.fonts.ready` + settles for 1 second
4. Reads the SVG bounding box and exports a tight-cropped PDF

Output defaults to the same directory as the input with a `.pdf` extension.

### 5. Visual QA

Your first render is almost never correct. Before declaring a figure done, run a visual inspection — ideally by spawning a subagent with fresh eyes.

**How to capture the figure for inspection**: use the export script to produce a PDF or PNG — do NOT open a browser. The export script uses headless Chromium internally, so no browser window is needed:

```bash
node <skill-path>/scripts/export_pdf.mjs <figure.html> <output.pdf>
```

Then have the QA subagent read the exported image file directly (the Read tool can display images). This is faster and works in headless environments.

**Subagent prompt** (adapt as needed):

> Visually inspect the figure at [path to exported PDF/PNG]. Assume there are issues — find them.
>
> Check for: arrows that look wrong (curved when they should be straight, arrowheads at wrong angles, arrows crossing through unrelated boxes), text too small to read, labels far from what they describe, unbalanced layout (cramped in one area, empty in another), region boundaries that don't enclose their content, unclear flow direction (can't tell where the pipeline starts/ends), missing legend when multiple arrow styles are used, misaligned boxes or labels, low-contrast text, content cut off at edges.
>
> For each issue, state the element/location and suggest a concrete fix.

**Verification loop**: generate → export → visually inspect exported image → list issues → fix → re-export and re-inspect. Repeat until a full pass reveals no new issues. Do not skip this step — a figure that has never been visually inspected is not finished.

### 6. Insert into LaTeX

Create a `\begin{figure}` or `\begin{figure*}` wrapper:

```latex
\begin{figure*}[t]
  \centering
  \includegraphics[width=\textwidth]{figures/my-figure.pdf}
  \caption{\textbf{Title.} Description.}
  \label{fig:my-figure}
\end{figure*}
```

## Visual Style Guide

The goal is figures that look like they belong in a top-venue paper. Two reference aesthetics depending on figure type:

### Data Plots (matplotlib `simple_white` style)

For scatter plots, line charts, bar charts, heatmaps — anything with axes and data points.

- **Background**: pure white, no fill behind plot area
- **Frame**: thin (0.8px) dark border (`#333`) around the plot area
- **Grid**: light gray lines (`#e8e8e8`, 0.5px) — visible but never competing with data
- **Axis ticks/labels**: only when values are meaningful. Omit for dimensionality-reduced spaces (t-SNE, UMAP) where numeric values carry no meaning
- **Font sizes**: axis labels 10px, tick labels 8-9px, panel titles 10-11px bold, legend 7-8px
- **Colors**: use a muted qualitative palette. Good defaults: d3.schemeTableau10 or hand-picked muted tones. Avoid saturated primaries.
- **Markers**: 3-5px radius for scatter; use d3.symbol() for shape encoding (circle, triangle, square, cross, star). Keep marker sizes consistent.
- **Legend**: place inside the plot in a low-density corner with a semi-transparent white background box

### Architecture / Flow Diagrams (TikZ style)

For system diagrams, pipelines, data flow, algorithm illustrations.

- **Boxes**: rounded rectangles (rx=4), thin border (0.8-1px), light fill (#f5f5f5 or pastel tints)
- **Arrows**: straight or orthogonal paths, arrowhead at end, 1-1.2px stroke
- **Labels**: centered in boxes, 10-11px. Edge labels 8-9px.
- **Spacing**: consistent gap between boxes throughout the diagram
- **Legend**: when the diagram uses multiple arrow colors or line styles (solid vs dashed), add a small legend in a corner explaining what each style means. Without a legend, readers are left guessing.

#### Grid-based layout (do this first)

Before writing any drawing code, define the grid. Architecture diagrams look bad when box positions are hardcoded pixel-by-pixel, because it's nearly impossible to keep spacing consistent or adapt when things change. Instead, define the layout as rows, columns, and gaps, then compute every position from those variables. **Never hardcode pixel coordinates** — every x/y value should trace back to a grid constant, a `col()`/`row()` call, or an arithmetic expression involving those.

**Step 1: Decide the flow direction and grid shape.** Most diagrams are left-to-right or top-to-bottom. Sketch the logical structure: how many rows, how many columns, which boxes go where.

**Step 2: Define grid constants.** All spacing comes from shared variables.

```javascript
const MARGIN = 20;
const BOX_W = 100, BOX_H = 36;
const COL_GAP = 40, ROW_GAP = 50;

const col = i => MARGIN + i * (BOX_W + COL_GAP);
const row = j => MARGIN + j * (BOX_H + ROW_GAP);
```

**Step 3: Place ALL boxes using the grid** — not just the main layer. When a diagram has multiple layers (e.g., agents on row 1, tools on row 2), define a sub-grid for child elements that still respects the column boundaries of the main grid. For example, if two small tool boxes sit under one agent, derive their widths from the column width rather than introducing an independent `TOOL_W` that can break alignment:

```javascript
// Sub-elements under column 1: split the column width
const subW = (BOX_W - 8) / 2;  // two boxes with 8px gap, fitting inside the column
const toolA = { x: col(1),              y: row(2), w: subW, h: 28 };
const toolB = { x: col(1) + subW + 8,  y: row(2), w: subW, h: 28 };
```

This keeps sub-elements aligned with the column they belong to. Avoid the pattern of computing child positions from a parent's center point with independent widths — that causes children to spill outside their column and collide with neighbors.

**Step 4: Size the SVG from the grid,** not the other way around. Calculate total width and height from the number of rows/columns plus margins.

**Fan-out / fan-in**: when one box connects to multiple targets, offset the departure/arrival points along the box edge so the arrows don't overlap (e.g., `box.x + box.w * 0.25`, `0.5`, `0.75` for 3 targets).

See [references/style-guide.md](references/style-guide.md) for a complete D3 code example of grid-based layout.

#### Arrow routing

Misrouted arrows — starting from box centers, arriving at diagonal angles, crossing through unrelated boxes — are the most common defect in architecture diagrams. Think in terms of **edge anchors**: every arrow starts and ends at the center of a box edge (top, bottom, left, right), never from the box center or an arbitrary point.

**Approach angle rule**: the final segment of every arrow must be perpendicular to the target edge it connects to. An arrow arriving at a box's left edge should travel horizontally; an arrow arriving at a top edge should travel vertically. If the arrowhead points diagonally into an edge, the flow direction becomes ambiguous.

**Routing patterns** based on which edges are connected:
- **Same axis, aligned** (e.g., right→left, both at same y): straight line.
- **Same axis, offset** (e.g., right→left, different y): Z-shaped path — go halfway horizontally, jog vertically, then continue horizontally.
- **Cross axis** (e.g., bottom→left): L-shaped path — go vertically to the target's y, then horizontally into the target edge. Always needs at least one waypoint.

When two parallel paths converge into the same target, arrange the source nodes so the one connecting to the nearer side is physically closer. Sketch arrow paths mentally before placing boxes — if arrows would cross, swap node positions.

#### Region boundaries

When a diagram has logical zones (e.g., "Local" vs "Cloud", "Encoder" vs "Decoder"), draw them as dashed rounded rectangles that tightly wrap their child elements. Size the region just large enough to contain its children plus a small label — avoid large empty areas inside region boxes. Draw the region boundary behind (before) its children in the SVG so child boxes render on top.

See [references/style-guide.md](references/style-guide.md) for D3 code patterns for edge anchors, smart routing, and region boundaries.

### Multi-Panel Figures

When a figure has sub-panels (a), (b), (c):

- **Panel labels**: bold, placed below each panel, centered: `(a) Description`
- **Alignment**: panels should share the same vertical baseline for their plot areas
- **Shared scales**: if panels share an axis, use the same domain/range and align grid lines

### Inset / Zoom Panels

When a figure includes magnified insets or detail panels connected to a main view:

- **Beam connectors**: draw two cubic Bezier curves from the zoom region boundary to the inset panel edges, fill the area between them with a semi-transparent color to create a spotlight/cone effect
- **Dashed outlines**: mark the zoom region on the main panel with a dashed rectangle or ellipse
- **Highlight vs fade**: show context points faded (`#dcdcdc`, low opacity), highlighted subset in full color

### Annotation Panels

When a figure needs text annotations pointing to regions:

- **Cards**: small boxes with a thin border (`#ddd`) and a thick colored left accent bar (3px)
- **Connectors**: cubic Bezier S-curves from the card to the annotated region, with a small dot at the anchor point
- **Layout**: stack cards vertically in a side panel, evenly spaced

## Layout Principles

- **Set explicit SVG dimensions** — never rely on responsive/viewport sizing. The SVG `width` and `height` attributes determine the PDF page size.
- **Size for the target column width**. For a `figure*` in ICML, a total SVG width of 700-900px works well at `\textwidth`. For a single ICML column figure, 340-400px.
- **Minimize whitespace** around the plot area. Use small margins (6-10px top/right, 20-25px bottom for labels, 8-10px left).
- **Panel titles go below panels**, not above — this matches the convention where the `\caption{}` sits below the figure.

## Common Patterns

### Loading External Data

```javascript
d3.json("data.json").then(data => {
  // build figure
}).catch(err => {
  document.body.innerHTML = `<pre style="color:red">Error: ${err}
Serve with: python -m http.server 8080</pre>`;
});
```

Always include the error fallback — it catches the common mistake of opening the HTML via `file://` when the figure loads JSON.

### Tooltips (for interactive preview, stripped in PDF)

```javascript
const tooltip = d3.select("#tooltip"); // a div with position:absolute
points.on("mouseenter", (event, d) => {
  tooltip.html(`<b>${d.label}</b><br>Score: ${d.score.toFixed(3)}`)
    .style("opacity", 1)
    .style("left", (event.offsetX + 14) + "px")
    .style("top", (event.offsetY - 10) + "px");
}).on("mouseleave", () => tooltip.style("opacity", 0));
```

Tooltips are useful during development for inspecting data points. They don't appear in the PDF export.

### Covariance Ellipses (for cluster visualization)

Compute from point cloud: center, eigenvalues, rotation angle, then draw with `<ellipse>` and `transform=rotate(angle,cx,cy)`. Use dashed stroke, no fill. See [references/style-guide.md](references/style-guide.md) for the full recipe.

## Bundled Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/preview.mjs` | Paper-mockup live preview server | `node preview.mjs <figure.html>` |
| `scripts/export_pdf.mjs` | HTML-to-PDF/PNG export via Playwright | `node export_pdf.mjs <figure.html> [out.pdf]` |

Both scripts are self-contained Node.js files. The export script requires Playwright (`npm install -g playwright` to install globally).

## References

- [references/style-guide.md](references/style-guide.md) — Detailed D3 code patterns for matplotlib/TikZ aesthetics, marker shapes, color palettes, and common recipes
