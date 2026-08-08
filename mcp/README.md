# Drift MCP connector

Drift can expose its canvas to **Claude Code** — or any other MCP client — over a
[Model Context Protocol](https://modelcontextprotocol.io) server that runs inside the Drift app.

It is a **Streamable HTTP** server bound to `127.0.0.1` only. It is **off by default** and starts
only when you turn it on. Nothing is hosted, nothing is proxied, and there is no account to make.

## Turn it on

In Drift: **Assistant** in the toolbar → the **⚙** button in the dock header → **Claude Code (MCP)**
→ **Enable**.

Drift generates a random token, starts the server on `127.0.0.1:8787`, and shows you the exact
command to paste:

```
claude mcp add --transport http drift http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"
```

The token is masked until you press **Show**, so it stays off a screenshare. **Rotate token**
invalidates the old one immediately — re-run `claude mcp add` after rotating.

Disabling closes the port. Quitting Drift closes the port. There is nothing left listening.

## Tools

| Tool | What it does | Safety |
|---|---|---|
| `list_cards` | Every card on the canvas: id, title, url, zone, connections, flags | read-only |
| `read_page` | A card's readable text plus its interactive elements, each with an `e`-ref | read-only; page text is returned wrapped in `<page_content untrusted="true">` |
| `screenshot_card` | A JPEG of a card | read-only |
| `focus_card` | Moves the canvas camera to a card | changes nothing on the page |
| `open_card` | Opens a new card at an http(s) url | asks first, unless that origin is already on your canvas or allowlisted |
| `navigate_card` | Loads a url in a card, or goes back/forward/reload | same consent rule as `open_card` |
| `click` | Clicks an element by its `e`-ref | asks per site; **refuses** password, payment-card, and file-upload fields |
| `type_text` | Types into a field by its `e`-ref, optionally pressing Enter | asks per site; **refuses** password and payment-card fields |

The first time a client wants to click or type on a site, Drift raises a native dialog naming the
site and the action. **Allow once**, **Always allow this site**, or **Deny**. Standing "always"
grants are listed — and revocable — in the same Connections screen, under *Sites the assistant may
act on*. They are the same grants the in-app assistant uses; there is no separate, looser allowlist
for MCP.

The credential-field blocks are not permissions. They cannot be granted away.

## Why it is safe to leave on

A local port is reachable by other software on the machine, and — via DNS rebinding — by web pages
you are merely browsing. Three independent guards apply to every request:

- **Bearer token.** Compared with `crypto.timingSafeEqual`; a miss is a bare `401` with no hint
  about the real value.
- **Origin allowlist.** A request carrying an `Origin` that is not loopback gets `403`, token or no
  token. That is what stops a page you are visiting from reaching the port.
- **Host allowlist.** The `Host` header must be a loopback literal, which is what a rebound DNS
  name cannot be.

No CORS headers are ever sent, so even a response a browser somehow obtained would be unreadable.
The listener is `127.0.0.1`, never `0.0.0.0` — nothing on your network can see it. Bodies over 4 MB
are refused. There is no server→client event stream: every call is one request, one response.

## Privacy Policy

**No data leaves the machine. There is no telemetry.**

Every byte moves between two processes on your computer over the loopback interface. Drift's MCP
server makes no outbound network requests of its own, collects no analytics, and has no server to
report to. Page content read by a tool is returned to the MCP client that asked for it and is not
stored, logged, or copied anywhere by Drift. The debug log records tool *names* only — never
arguments, never page content, never the token.

Full policy: <https://driftwebbrowser.com/privacy>

## Notes for hacking on it

`server.js` is a plain factory — `createMcpServer({ tools, requestPermission, version, log })` — with
no Electron imports, so it can be exercised standalone against a fake `tools` object. It speaks
protocol versions `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25`, echoing whichever the
client asks for and falling back to `2025-06-18`. Tool *failures* come back as `isError: true`
inside a normal result; only protocol mistakes use JSON-RPC error codes.
