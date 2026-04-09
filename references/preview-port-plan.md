# Preview Server Stable Auto-Port Plan

Date: 2026-04-09

## Goal

Make the default preview port stable per machine user instead of random:

- `--port <number>` keeps its current meaning: use or reuse that exact port.
- Without `--port`, derive a stable port from `username + hostname`.
- Keep the auto port in the range `18901-65535`.
- Reuse an existing `paper-figure` preview server on that derived port.
- If the derived port is occupied by another process, fail with a targeted error instead of falling back to a different port.

## Stable Auto-Port Behavior

Command:

```bash
node preview.mjs /path/to/fig.html
```

Behavior:

- Build an identity string as `${username}@${hostname}`.
- Hash it with `sha256`.
- Parse the first 8 hex characters as an unsigned integer.
- Map the value into `18901-65535` via modulo arithmetic.
- Probe `GET /--api/files` on that port.
- If the response matches the preview server API, reuse that server and print the figure URL.
- Otherwise try to bind that exact port.
- If bind fails with `EADDRINUSE`, print a clear error telling the caller to pass `--port` if they want to override the auto choice.

Reasoning:

- The same user on the same host gets a predictable preview URL.
- Existing preview state and file history can be reused across invocations on that machine/user pair.
- The default behavior stays deterministic; it does not silently move to a different port when the stable one is blocked.

## Explicit Port Behavior

Command:

```bash
node preview.mjs --port 19001 /path/to/fig.html
```

Behavior:

- Treat the requested port as authoritative.
- Reuse it if a `paper-figure` preview server is already running there.
- Otherwise attempt to bind that exact port.
- If another process is using it, fail with the existing explicit-port error.

## Required Code Changes

### 1. Stable port derivation

In `scripts/preview.mjs`:

- add a username helper that prefers `os.userInfo().username`
- fall back to `process.env.USER` / `process.env.USERNAME` when needed
- compute the auto-port identity from `username@hostname`
- derive the stable auto port with `crypto.createHash("sha256")`

### 2. Startup flow

Keep the current `acquirePortAndStartServer()` structure, but change `auto` mode:

- remove random candidate generation and retry loops
- probe the single derived auto port for a reusable preview server
- bind the derived auto port when no reusable server is present
- convert `EADDRINUSE` into a targeted auto-port error

### 3. Logging and UI text

Update:

- header comments in `scripts/preview.mjs`
- startup logs so `auto` mode is clearly described as stable-hash based
- debug info page so the displayed auto port matches the derived value
- `SKILL.md` preview instructions so they describe stable per-user/per-host auto ports

## Compatibility Notes

Behavior that changes:

- running `node preview.mjs fig.html` twice on the same user/host now resolves to the same port
- the second run reuses the existing preview server instead of starting a fresh one
- auto mode no longer retries other ports on conflict

Behavior that stays:

- `--port` remains the override mechanism for fixed URLs
- URL generation, hot reload, and preview-server reuse checks remain unchanged after startup

## Error Handling

- invalid `--port`: `Port must be an integer between 1 and 65535.`
- explicit port conflict: `Port 19001 is already in use. Choose another port or omit --port for automatic selection.`
- auto port conflict: `Auto port 23xxx derived from username@hostname is already in use by another process. Pass --port to override.`

## Acceptance Criteria

1. `node preview.mjs fig.html` starts successfully and prints a URL whose port is greater than `18900`.
2. Re-running `node preview.mjs fig.html` while the first server is still running reuses the same preview server port.
3. Running the command with a different figure file still reuses that same server and prints the correct figure URL.
4. `node preview.mjs --port 19001 fig.html` still starts or reuses `19001`.
5. If another process occupies the derived auto port, `node preview.mjs fig.html` exits with the targeted override message.
