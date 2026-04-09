# D3 Style Guide for Academic Figures

Detailed code patterns and recipes for creating publication-quality academic figures with D3.js. This supplements the high-level guidance in SKILL.md.

## Table of Contents

1. [Font Setup](#font-setup)
2. [Color Palettes](#color-palettes)
3. [Axes and Grids (matplotlib style)](#axes-and-grids)
4. [Marker Shapes](#marker-shapes)
5. [Legend](#legend)
6. [Multi-Panel Layout](#multi-panel-layout)
7. [Covariance Ellipses](#covariance-ellipses)
8. [Annotation Cards with Connectors](#annotation-cards)
9. [Inset Panels with Beam Connectors](#inset-panels)
10. [Bar Charts](#bar-charts)
11. [Line Charts with Error Bands](#line-charts)
12. [Architecture Diagrams (TikZ style)](#architecture-diagrams)

---

## Font Setup

Always load Google Fonts with `display=block` to ensure fonts are fully loaded before Playwright renders. Use a `<link>` tag, not `@import`, because `@import` can delay font loading.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=block" rel="stylesheet">
```

Define a font constant for consistent use:

```javascript
const FONT = "Source Serif 4, Source Serif Pro, Georgia, serif";
```

For sans-serif figures:

```javascript
const FONT = "Source Sans 3, Source Sans Pro, system-ui, sans-serif";
```

---

## Color Palettes

### Muted qualitative (default for multi-category data)

```javascript
const PALETTE = {
  "Category A": "#1f77b4",  // muted blue
  "Category B": "#ff7f0e",  // muted orange
  "Category C": "#2ca02c",  // muted green
  "Category D": "#d62728",  // muted red
  "Category E": "#9467bd",  // muted purple
  "Category F": "#8c564b",  // muted brown
  "Category G": "#7f7f7f",  // gray
};
```

These are from d3.schemeTableau10, desaturated enough for print.

### Sequential (for heatmaps, continuous scales)

```javascript
const colorScale = d3.scaleSequential(d3.interpolateViridis).domain([0, maxVal]);
```

### Faded / highlight pattern

For panels that highlight a subset and fade everything else:

```javascript
const FADED = "#dcdcdc";
const FADED_EDGE = "#ececec";
```

---

## Axes and Grids

### matplotlib `simple_white` style

```javascript
const margin = { top: 6, right: 10, bottom: 25, left: 35 };
const w = 400, h = 300;
const iw = w - margin.left - margin.right;
const ih = h - margin.top - margin.bottom;

const x = d3.scaleLinear().domain([0, 100]).range([0, iw]);
const y = d3.scaleLinear().domain([0, 1]).range([ih, 0]);

const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

// Frame border
g.append("rect").attr("width", iw).attr("height", ih)
  .attr("fill", "none").attr("stroke", "#333").attr("stroke-width", 0.8);

// Grid lines (behind data)
const gridG = g.append("g");
x.ticks(6).forEach(t => {
  gridG.append("line").attr("x1", x(t)).attr("x2", x(t))
    .attr("y1", 0).attr("y2", ih)
    .attr("stroke", "#e8e8e8").attr("stroke-width", 0.5);
});
y.ticks(5).forEach(t => {
  gridG.append("line").attr("x1", 0).attr("x2", iw)
    .attr("y1", y(t)).attr("y2", y(t))
    .attr("stroke", "#e8e8e8").attr("stroke-width", 0.5);
});

// X axis
const xAxis = g.append("g").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6));
xAxis.select(".domain").attr("stroke", "#333").attr("stroke-width", 0.8);
xAxis.selectAll(".tick text").attr("font-size", "8px").attr("font-family", FONT).attr("fill", "#555");
xAxis.selectAll(".tick line").attr("stroke", "#999").attr("stroke-width", 0.5);

// Y axis
const yAxis = g.append("g").call(d3.axisLeft(y).ticks(5));
yAxis.select(".domain").attr("stroke", "#333").attr("stroke-width", 0.8);
yAxis.selectAll(".tick text").attr("font-size", "8px").attr("font-family", FONT).attr("fill", "#555");
yAxis.selectAll(".tick line").attr("stroke", "#999").attr("stroke-width", 0.5);

// Axis labels
g.append("text").attr("x", iw / 2).attr("y", ih + 22)
  .attr("text-anchor", "middle").attr("font-size", "10px")
  .attr("font-family", FONT).attr("fill", "#333").text("X Label");

g.append("text").attr("transform", "rotate(-90)")
  .attr("x", -ih / 2).attr("y", -28)
  .attr("text-anchor", "middle").attr("font-size", "10px")
  .attr("font-family", FONT).attr("fill", "#333").text("Y Label");
```

### No axes (for t-SNE, UMAP)

When axis values are meaningless, omit ticks and labels but keep the grid and frame:

```javascript
// Just grid + frame, no axis calls
g.append("rect").attr("width", iw).attr("height", ih)
  .attr("fill", "none").attr("stroke", "#333").attr("stroke-width", 0.8);
// grid lines as above, but no d3.axis* calls
```

---

## Marker Shapes

Use `d3.symbol()` for shape encoding. Define markers as an object for easy lookup:

```javascript
const MARKERS = {
  "Type A": { gen: d3.symbol().type(d3.symbolCircle), size: 28, sizeSmall: 18 },
  "Type B": { gen: d3.symbol().type(d3.symbolTriangle), size: 30, sizeSmall: 20 },
  "Type C": { gen: d3.symbol().type(d3.symbolSquare), size: 26, sizeSmall: 16 },
  "Type D": { gen: d3.symbol().type(d3.symbolSquare), size: 26, sizeSmall: 16, rotate: 45 },
  "Type E": { gen: d3.symbol().type(d3.symbolCross), size: 30, sizeSmall: 20 },
};
```

Drawing a marker:

```javascript
const m = MARKERS[d.type];
const path = m.gen.size(m.size)();
const rot = m.rotate ? ` rotate(${m.rotate})` : "";
g.append("path").attr("d", path)
  .attr("transform", `translate(${x(d.x)},${y(d.y)})${rot}`)
  .attr("fill", color).attr("fill-opacity", 0.7)
  .attr("stroke", "#fff").attr("stroke-width", 0.3);
```

### Special markers

**Star** (for "best" points):
```javascript
const starPath = d3.symbol().type(d3.symbolStar).size(72)();
```

**Rotated square / diamond** (hand-crafted for precise sizing):
```javascript
const s = 5;
const diamondPath = `M0,${-s} L${s},0 L0,${s} L${-s},0 Z`;
```

---

## Legend

Place inside the plot in a low-density corner:

```javascript
const legendW = 88, lh = 12;
const items = [/* {label, color, marker} */];
const legendH = items.length * lh + 10;
const legendX = iw - legendW - 4;
const legendY = ih - legendH - 4;

const legendG = g.append("g").attr("transform", `translate(${legendX},${legendY})`);

// Semi-transparent background
legendG.append("rect").attr("x", -6).attr("y", -5)
  .attr("width", legendW + 8).attr("height", legendH)
  .attr("fill", "rgba(255,255,255,0.92)")
  .attr("stroke", "#999").attr("stroke-width", 0.5);

// Section header
legendG.append("text").attr("x", 0).attr("y", 3)
  .attr("dominant-baseline", "central")
  .attr("font-size", "6.5px").attr("fill", "#999")
  .attr("font-weight", "600").attr("font-family", FONT)
  .text("SECTION TITLE");
```

Use small section headers (6.5px, uppercase, gray) to group legend entries by category.

---

## Multi-Panel Layout

For (a), (b), (c) panel figures:

```javascript
const panelW = 200, panelH = 180;
const gap = 10;
const totalW = 3 * panelW + 2 * gap;
const totalH = panelH + 20;  // +20 for panel labels below

const svg = d3.select("#chart").append("svg")
  .attr("width", totalW).attr("height", totalH);

["(a) First Panel", "(b) Second Panel", "(c) Third Panel"].forEach((title, i) => {
  const gPanel = svg.append("g")
    .attr("transform", `translate(${i * (panelW + gap)},0)`);

  // Draw panel content here using gPanel...

  // Panel label below
  gPanel.append("text")
    .attr("x", panelW / 2).attr("y", panelH + 14)
    .attr("text-anchor", "middle")
    .attr("font-size", "10px").attr("font-weight", "600")
    .attr("fill", "#333").attr("font-family", FONT)
    .text(title);
});
```

### Alignment principle

When panels share data, compute a shared domain once and pass it to each panel so axes align:

```javascript
const sharedXDomain = d3.extent(allData, d => d.x);
const sharedYDomain = d3.extent(allData, d => d.y);
// Each panel uses the same domain
```

---

## Covariance Ellipses

For visualizing clusters in scatter plots:

```javascript
function drawCovarianceEllipse(g, points, color, sigma = 2.5) {
  const cx = d3.mean(points, d => d[0]);
  const cy = d3.mean(points, d => d[1]);
  const n = points.length;

  let sxx = 0, syy = 0, sxy = 0;
  points.forEach(([px, py]) => {
    sxx += (px - cx) ** 2;
    syy += (py - cy) ** 2;
    sxy += (px - cx) * (py - cy);
  });
  sxx /= n; syy /= n; sxy /= n;

  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const l1 = trace / 2 + disc;
  const l2 = trace / 2 - disc;
  const angle = Math.atan2(sxy, l1 - syy) * 180 / Math.PI;

  const rw = sigma * Math.sqrt(l1);
  const rh = sigma * Math.sqrt(l2);

  g.append("ellipse")
    .attr("cx", cx).attr("cy", cy)
    .attr("rx", rw).attr("ry", rh)
    .attr("transform", `rotate(${angle},${cx},${cy})`)
    .attr("fill", "none")
    .attr("stroke", color)
    .attr("stroke-width", 0.9)
    .attr("stroke-dasharray", "5,3")
    .attr("opacity", 0.55);
}
```

---

## Annotation Cards

For annotating regions of a scatter plot with descriptive cards in a side panel:

```javascript
// Card with colored left accent bar
function drawAnnotationCard(g, x, y, w, h, title, desc, color) {
  // Background
  g.append("rect").attr("x", x).attr("y", y)
    .attr("width", w).attr("height", h)
    .attr("fill", "#fafafa").attr("stroke", "#ddd").attr("stroke-width", 0.5);

  // Thick colored left accent bar
  g.append("rect").attr("x", x).attr("y", y + 1)
    .attr("width", 3).attr("height", h - 2)
    .attr("fill", color).attr("opacity", 0.75);

  // Title
  g.append("text").attr("x", x + 8).attr("y", y + 14)
    .attr("font-size", "10px").attr("font-weight", "700")
    .attr("fill", color).attr("font-family", FONT)
    .text(title);

  // Description (pre-wrapped lines)
  desc.forEach((line, i) => {
    g.append("text").attr("x", x + 8).attr("y", y + 28 + i * 12)
      .attr("font-size", "8.5px").attr("fill", "#555")
      .attr("font-family", FONT).text(line);
  });
}
```

### Cubic Bezier S-curve connectors

Connect annotation cards to regions in the plot:

```javascript
function drawConnectorArc(svg, srcX, srcY, tgtX, tgtY, color) {
  const cp1X = srcX + (tgtX - srcX) * 0.4;
  const cp1Y = srcY;
  const cp2X = tgtX - (tgtX - srcX) * 0.4;
  const cp2Y = tgtY;

  svg.append("path")
    .attr("d", `M${srcX},${srcY} C${cp1X},${cp1Y} ${cp2X},${cp2Y} ${tgtX},${tgtY}`)
    .attr("fill", "none")
    .attr("stroke", color)
    .attr("stroke-width", 0.8)
    .attr("stroke-opacity", 0.4);

  // Small dot at source
  svg.append("circle")
    .attr("cx", srcX).attr("cy", srcY).attr("r", 1.5)
    .attr("fill", color).attr("fill-opacity", 0.5);
}
```

---

## Inset Panels

For zoom/detail insets connected to a main view with beam connectors (two curves + semi-transparent fill):

```javascript
function drawBeamConnector(g, mainRect, insetRect, color, opacity = 0.12) {
  // mainRect = {x, y, w, h} — the zoom region on the main panel
  // insetRect = {x, y, w, h} — the inset panel position

  // Connect top-left and bottom-left of main rect to top-left and bottom-left of inset
  const m = mainRect, ins = insetRect;

  const path = [
    `M${m.x + m.w},${m.y}`,                           // main top-right
    `C${(m.x + m.w + ins.x) / 2},${m.y}`,             // cp1
    ` ${(m.x + m.w + ins.x) / 2},${ins.y}`,           // cp2
    ` ${ins.x},${ins.y}`,                               // inset top-left
    `L${ins.x},${ins.y + ins.h}`,                       // inset bottom-left
    `C${(m.x + m.w + ins.x) / 2},${ins.y + ins.h}`,   // cp1
    ` ${(m.x + m.w + ins.x) / 2},${m.y + m.h}`,       // cp2
    ` ${m.x + m.w},${m.y + m.h}`,                       // main bottom-right
    `Z`,
  ].join(" ");

  g.append("path").attr("d", path)
    .attr("fill", color).attr("fill-opacity", opacity)
    .attr("stroke", color).attr("stroke-width", 0.6)
    .attr("stroke-opacity", 0.3);

  // Dashed outline on the zoom region
  g.append("rect")
    .attr("x", m.x).attr("y", m.y).attr("width", m.w).attr("height", m.h)
    .attr("fill", "none").attr("stroke", color)
    .attr("stroke-width", 1).attr("stroke-dasharray", "4,2");
}
```

---

## Bar Charts

### Grouped bar chart

```javascript
const categories = ["A", "B", "C"];
const groups = ["Method 1", "Method 2", "Method 3"];

const x0 = d3.scaleBand().domain(categories).range([0, iw]).paddingInner(0.2);
const x1 = d3.scaleBand().domain(groups).range([0, x0.bandwidth()]).padding(0.05);
const y = d3.scaleLinear().domain([0, maxVal]).range([ih, 0]);

categories.forEach(cat => {
  groups.forEach(grp => {
    g.append("rect")
      .attr("x", x0(cat) + x1(grp))
      .attr("y", y(val))
      .attr("width", x1.bandwidth())
      .attr("height", ih - y(val))
      .attr("fill", colorScale(grp))
      .attr("fill-opacity", 0.85);
  });
});
```

### Error bars

```javascript
function drawErrorBar(g, cx, y_mean, y_lo, y_hi, color) {
  const capW = 3;
  g.append("line").attr("x1", cx).attr("x2", cx)
    .attr("y1", y(y_hi)).attr("y2", y(y_lo))
    .attr("stroke", color).attr("stroke-width", 0.8);
  [y_lo, y_hi].forEach(v => {
    g.append("line").attr("x1", cx - capW).attr("x2", cx + capW)
      .attr("y1", y(v)).attr("y2", y(v))
      .attr("stroke", color).attr("stroke-width", 0.8);
  });
}
```

---

## Line Charts with Error Bands

```javascript
const line = d3.line().x(d => x(d.step)).y(d => y(d.mean));
const area = d3.area()
  .x(d => x(d.step))
  .y0(d => y(d.mean - d.std))
  .y1(d => y(d.mean + d.std));

// Error band (draw first, behind the line)
g.append("path").datum(data)
  .attr("d", area)
  .attr("fill", color)
  .attr("fill-opacity", 0.15);

// Mean line
g.append("path").datum(data)
  .attr("d", line)
  .attr("fill", "none")
  .attr("stroke", color)
  .attr("stroke-width", 1.5);
```

---

## Architecture Diagrams

### Grid-based layout

Define the layout as rows, columns, and gaps first. Every box position is derived from the grid — no hardcoded pixel coordinates scattered through the code.

```javascript
// ── Grid definition ──
// Change these constants to reshape the entire diagram.
const MARGIN = { top: 20, left: 20 };
const BOX_W = 110, BOX_H = 36;
const COL_GAP = 40, ROW_GAP = 50;

const col = i => MARGIN.left + i * (BOX_W + COL_GAP);
const row = j => MARGIN.top  + j * (BOX_H + ROW_GAP);

// ── Place boxes on the grid ──
const boxes = {
  query:    { x: col(0), y: row(0), w: BOX_W, h: BOX_H },
  encoder:  { x: col(1), y: row(0), w: BOX_W, h: BOX_H },
  vecStore: { x: col(2), y: row(0), w: BOX_W, h: BOX_H },
  llm:      { x: col(2), y: row(1), w: BOX_W, h: BOX_H },
  output:   { x: col(2), y: row(2), w: BOX_W, h: BOX_H },
};

// ── SVG sized from grid, not guessed ──
const numCols = 3, numRows = 3;
const svgW = MARGIN.left * 2 + numCols * BOX_W + (numCols - 1) * COL_GAP;
const svgH = MARGIN.top  * 2 + numRows * BOX_H + (numRows - 1) * ROW_GAP;

const svg = d3.select("#chart").append("svg")
  .attr("width", svgW).attr("height", svgH);
```

For boxes that don't align exactly on the grid (e.g., centered between two columns, or offset for a sub-row), express them as offsets from the grid:

```javascript
// Two encoders side by side, centered on column 1
const halfGap = 8;
const encW = (BOX_W - halfGap) / 2;  // narrower, two fit in one column
const sparseEnc = { x: col(1),                  y: row(1), w: encW, h: BOX_H };
const denseEnc  = { x: col(1) + encW + halfGap, y: row(1), w: encW, h: BOX_H };
```

### Fan-out / fan-in arrows

When one box connects to multiple targets (or vice versa), offset departure/arrival points so arrows don't overlap:

```javascript
// Fan-out from bottom edge to 3 targets: use 25%, 50%, 75% of width
const box = boxes.orchestrator;
const depX = [0.25, 0.5, 0.75].map(f => box.x + box.w * f);
const depY = box.y + box.h;
// Each departure point feeds into a separate polyline to its target
```

### TikZ-style boxes

```javascript
function drawBox(g, x, y, w, h, label, opts = {}) {
  const fill = opts.fill || "#f5f5f5";
  const stroke = opts.stroke || "#333";

  g.append("rect").attr("x", x).attr("y", y)
    .attr("width", w).attr("height", h)
    .attr("rx", 4).attr("ry", 4)
    .attr("fill", fill).attr("stroke", stroke)
    .attr("stroke-width", opts.strokeWidth || 0.8);

  g.append("text")
    .attr("x", x + w / 2).attr("y", y + h / 2)
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size", opts.fontSize || "10px")
    .attr("font-family", FONT)
    .attr("fill", "#333")
    .text(label);
}
```

### Arrows

```javascript
// Define arrowhead marker
svg.append("defs").append("marker")
  .attr("id", "arrow").attr("viewBox", "0 0 10 7")
  .attr("refX", 10).attr("refY", 3.5)
  .attr("markerWidth", 8).attr("markerHeight", 6)
  .attr("orient", "auto")
  .append("path").attr("d", "M0,0 L10,3.5 L0,7 Z")
  .attr("fill", "#555");

// Draw arrow between boxes
function drawArrow(g, x1, y1, x2, y2, opts = {}) {
  g.append("line")
    .attr("x1", x1).attr("y1", y1)
    .attr("x2", x2).attr("y2", y2)
    .attr("stroke", opts.stroke || "#555")
    .attr("stroke-width", opts.strokeWidth || 1)
    .attr("marker-end", "url(#arrow)");
}
```

### Edge anchors

Rather than hard-coding arrow coordinates, compute them from box positions. This keeps arrows correct when you move boxes around:

```javascript
// Given a box {x, y, w, h}, return the center point of an edge
function edgeAnchor(box, side) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  switch (side) {
    case "top":    return { x: cx, y: box.y };
    case "bottom": return { x: cx, y: box.y + box.h };
    case "left":   return { x: box.x, y: cy };
    case "right":  return { x: box.x + box.w, y: cy };
  }
}
```

### Smart routing

Choose the routing pattern based on which edges are connected. The goal: the final arrow segment is always perpendicular to the target edge.

```javascript
// Build waypoints for an arrow from src edge to dst edge.
// Returns an array of {x,y} points to feed into a polyline + marker-end.
function routeArrow(srcBox, srcSide, dstBox, dstSide) {
  const src = edgeAnchor(srcBox, srcSide);
  const dst = edgeAnchor(dstBox, dstSide);
  const srcH = (srcSide === "left" || srcSide === "right");
  const dstH = (dstSide === "left" || dstSide === "right");

  if (srcH === dstH) {
    // Same axis — straight if aligned, Z-shape if offset
    if (srcH) {
      if (Math.abs(src.y - dst.y) < 2) return [src, dst];
      const midX = (src.x + dst.x) / 2;
      return [src, {x: midX, y: src.y}, {x: midX, y: dst.y}, dst];
    } else {
      if (Math.abs(src.x - dst.x) < 2) return [src, dst];
      const midY = (src.y + dst.y) / 2;
      return [src, {x: src.x, y: midY}, {x: dst.x, y: midY}, dst];
    }
  }
  // Cross axis — L-shape
  if (srcH) return [src, {x: dst.x, y: src.y}, dst];
  return [src, {x: src.x, y: dst.y}, dst];
}

// Draw routed arrow as a polyline with arrowhead
function drawRoutedArrow(g, points, opts = {}) {
  const pathData = points.map((p, i) =>
    `${i === 0 ? "M" : "L"}${p.x},${p.y}`
  ).join(" ");
  g.append("path").attr("d", pathData)
    .attr("fill", "none")
    .attr("stroke", opts.stroke || "#555")
    .attr("stroke-width", opts.strokeWidth || 1)
    .attr("marker-end", "url(#arrow)");
}

// Usage:
const points = routeArrow(encoderBox, "right", decoderBox, "left");
drawRoutedArrow(g, points, { stroke: "#555" });
```

### Region boundaries

Dashed rounded rectangles that group related boxes into logical zones:

```javascript
function drawRegion(g, childBoxes, label, opts = {}) {
  const pad = opts.pad || 20;
  const labelH = opts.labelH || 18;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of childBoxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const rx = minX - pad, ry = minY - pad - labelH;
  const rw = maxX - minX + 2 * pad, rh = maxY - minY + 2 * pad + labelH;

  g.append("rect").attr("x", rx).attr("y", ry)
    .attr("width", rw).attr("height", rh)
    .attr("rx", 6).attr("ry", 6)
    .attr("fill", "none").attr("stroke", opts.stroke || "#999")
    .attr("stroke-width", 0.8)
    .attr("stroke-dasharray", "6,3");

  g.append("text").attr("x", rx + 8).attr("y", ry + 13)
    .attr("font-size", "9px").attr("font-weight", "600")
    .attr("fill", opts.stroke || "#999").attr("font-family", FONT)
    .text(label);
}

// Usage: draw child boxes first, then wrap them
drawRegion(g, [encoderBox, embeddingBox], "Encoder", { stroke: "#888" });
```

### Arrow legend

When a diagram uses multiple arrow colors or line styles, add a legend:

```javascript
function drawArrowLegend(g, x, y, items) {
  // items: [{label, stroke, dashed}]
  items.forEach((item, i) => {
    const ly = y + i * 18;
    const lineEnd = x + 30;
    g.append("line").attr("x1", x).attr("y1", ly)
      .attr("x2", lineEnd).attr("y2", ly)
      .attr("stroke", item.stroke).attr("stroke-width", 1)
      .attr("stroke-dasharray", item.dashed ? "5,3" : "none")
      .attr("marker-end", "url(#arrow)");
    g.append("text").attr("x", lineEnd + 6).attr("y", ly)
      .attr("dominant-baseline", "central")
      .attr("font-size", "8px").attr("fill", "#555")
      .attr("font-family", FONT).text(item.label);
  });
}
```

### Orthogonal routing (manual)

For cases where `routeArrow` doesn't fit and you need full manual control over waypoints:

```javascript
function drawOrthogonalPath(g, points, opts = {}) {
  const pathData = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  g.append("path").attr("d", pathData)
    .attr("fill", "none")
    .attr("stroke", opts.stroke || "#555")
    .attr("stroke-width", opts.strokeWidth || 1)
    .attr("marker-end", "url(#arrow)");
}
```

---

## Tooltip Pattern

For interactive development (stripped automatically in PDF):

```html
<div class="tooltip" id="tooltip" style="
  position:absolute; pointer-events:none;
  background:rgba(255,255,255,0.97); border:0.8px solid #999;
  padding:5px 8px; font-size:9.5px; line-height:1.5;
  opacity:0; transition:opacity 0.12s; max-width:240px; z-index:10;
"></div>
```

```javascript
const tooltip = d3.select("#tooltip");
points.on("mouseenter", (event, d) => {
  tooltip.html(`<b>${d.label}</b><br>Value: ${d.value.toFixed(3)}`)
    .style("opacity", 1)
    .style("left", (event.offsetX + 14) + "px")
    .style("top", (event.offsetY - 10) + "px");
}).on("mousemove", event => {
  tooltip.style("left", (event.offsetX + 14) + "px")
    .style("top", (event.offsetY - 10) + "px");
}).on("mouseleave", () => tooltip.style("opacity", 0));
```
