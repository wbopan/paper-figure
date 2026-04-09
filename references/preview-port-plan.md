# Preview Server Dynamic Port Plan

Date: 2026-04-09

## Goal

Add a new preview-server startup mode for `paper-figure`:

- When the user passes `--port <number>`, start or reuse the preview server on that exact port.
- When the user does not pass `--port`, start a new preview server on a random available port greater than `18900`.
- Avoid the current fixed-port collision on `18900`.

## Current Behavior

The current implementation is partly aligned with the new requirement, but not fully:

- `scripts/preview.mjs` already parses `--port` and otherwise defaults to `18900`.
- `scripts/preview.mjs` currently reuses an already running preview server on the chosen port by probing `GET /--api/files`.
- `scripts/preview.mjs` prints URLs using the global `port` variable, so the startup path assumes the port is known before `listen()`.
- `SKILL.md` documents `18900` as the default preview port and explicitly describes the reuse behavior.

Relevant code today:

- `scripts/preview.mjs:28-36`
- `scripts/preview.mjs:898-953`
- `SKILL.md:57-65`

## Proposed User-Facing Behavior

### 1. Explicit Port

Command:

```bash
node preview.mjs --port 19001 /path/to/fig.html
```

Behavior:

- Treat `19001` as authoritative.
- If a `paper-figure` preview server is already running on that port, reuse it and print the new figure URL.
- If the port is occupied by another process, fail fast with a clear error and exit non-zero.
- Do not silently fall back to another port when the user explicitly requested one.

Reasoning:

- Explicit port means the caller wants a predictable URL.
- Silent fallback would make automation and bookmarks unreliable.

### 2. Automatic Port

Command:

```bash
node preview.mjs /path/to/fig.html
```

Behavior:

- Choose a random port in the range `18901-65535`.
- Start a fresh preview server on that port.
- Print the selected port and the full preview URL.
- Do not probe or reuse an existing server by default.

Reasoning:

- The default path should optimize for collision avoidance, not server reuse.
- A fresh server per invocation is the least surprising behavior once the port becomes dynamic.

## Recommended Port Allocation Strategy

Use a bind-and-retry approach instead of probe-then-bind.

### Algorithm

1. If `--port` is provided:
   - Validate it is an integer in `1-65535`.
   - Probe `GET /--api/files` on that port.
   - If the probe succeeds and the response looks like the preview server API, reuse it.
   - Otherwise try to bind the HTTP server to that exact port.
   - On `EADDRINUSE`, print a targeted error and exit `1`.

2. If `--port` is omitted:
   - Randomly choose a candidate in `18901-65535`.
   - Attempt to bind.
   - On `EADDRINUSE`, retry with another random candidate.
   - Stop after a bounded number of attempts, such as `20`, then exit with an explicit failure message.

### Why not `listen(0)`?

`listen(0)` would avoid collisions, but it does not guarantee the selected port is greater than `18900`. The requirement is specific enough that the script should enforce the lower bound itself.

## Required Code Changes

### 1. Separate requested port from resolved port

In `scripts/preview.mjs`, replace the current single `port` variable with:

- `requestedPort`
- `resolvedPort`
- `portMode` with values like `explicit` or `auto`

Why:

- URL generation, debug page rendering, and log output should use the actual bound port, not the default placeholder.

### 2. Refactor server startup into an async helper

Introduce a startup helper such as:

```js
async function acquirePortAndStartServer()
```

Responsibilities:

- decide whether this is `explicit` or `auto` mode
- optionally probe for a reusable preview server
- bind the HTTP server
- set `resolvedPort`
- return the final base URL

### 3. Create the HTTP server through a factory

The current file creates `const server = http.createServer(...)` once. For retry-based startup, it is cleaner to use:

```js
function createPreviewServer() {
  return http.createServer(handler);
}
```

Why:

- retrying after `EADDRINUSE` is simpler when each bind attempt owns a fresh server instance
- the request handler can read `resolvedPort` from outer scope

### 4. Replace fixed-port messaging

Update:

- header comments in `scripts/preview.mjs`
- startup logs
- any help text that still hardcodes `18900`

New log shape should be closer to:

```text
Preview server running at http://127.0.0.1:24731
Port mode: auto
Figure: /abs/path/to/fig.html
Open: http://127.0.0.1:24731/...
```

### 5. Update `fileUrl()` and debug page

`fileUrl()` and `generateDebugHTML()` must use `resolvedPort`.

This matters because:

- auto mode will not know the final port until bind succeeds
- any stale use of the old default `18900` would break the printed URLs

### 6. Update skill documentation

Revise `SKILL.md` so it no longer claims:

- the server runs on port `18900` by default
- the URL will always be `http://127.0.0.1:18900/...`

Recommended wording:

- "Pass `--port <n>` for a fixed port."
- "Without `--port`, the script starts on a random available port greater than `18900` and prints the URL."
- "If you explicitly request a port and a preview server is already running there, the command reuses it."

## Compatibility Notes

### Behavior that changes

- Running `node preview.mjs fig.html` twice will now produce two different preview server ports.
- File history will be per-process in auto mode instead of being implicitly shared through the fixed port.

### Behavior that stays

- `--port` remains the mechanism for stable URLs.
- Hot reload, file switching, and figure URL generation stay unchanged after the server is running.

## Error Handling

Recommended failures:

- invalid `--port`: `Port must be an integer between 1 and 65535.`
- explicit port in use by another process: `Port 19001 is already in use. Choose another port or omit --port for automatic selection.`
- auto mode exhausted retries: `Failed to allocate a preview port above 18900 after 20 attempts.`

## Acceptance Criteria

The feature is complete when all of the following are true:

1. `node preview.mjs fig.html` starts successfully and prints a URL whose port is greater than `18900`.
2. Re-running `node preview.mjs fig.html` while the first server is still running starts a second server on a different port.
3. `node preview.mjs --port 19001 fig.html` starts on `19001`.
4. Re-running `node preview.mjs --port 19001 fig.html` reuses the existing preview server on `19001` if it is a `paper-figure` preview server.
5. If another process occupies `19001`, `node preview.mjs --port 19001 fig.html` exits with a clear error.
6. The printed `Open:` URL is always reachable and matches the bound port.
7. `SKILL.md` examples and prose no longer mention a fixed default port.

## Suggested Implementation Order

1. Refactor port state to `requestedPort` and `resolvedPort`.
2. Extract server creation and bind logic.
3. Implement auto-port retry flow for ports above `18900`.
4. Reintroduce explicit-port reuse check on top of the new startup flow.
5. Update log output and helper functions to use `resolvedPort`.
6. Update `SKILL.md`.
7. Run manual smoke tests for auto mode, explicit mode, and conflict mode.
