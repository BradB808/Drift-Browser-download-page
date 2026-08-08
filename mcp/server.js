// Drift MCP — exposes the assistant's own tools (ai/tools.js) to Claude Code and
// any other MCP client over a loopback-only Streamable-HTTP endpoint.
//
// The whole surface is one path, POST /mcp on 127.0.0.1. There is no server→
// client SSE stream: every tool call is a plain request/response, which the
// spec allows and which keeps this file small enough to reason about.
//
// Threat model. The port lives on the same machine as the user's browser, so
// the attacker we actually care about is a WEB PAGE the user is visiting — it
// can issue cross-origin requests (and, via DNS rebinding, requests that look
// same-origin) at 127.0.0.1. Three independent guards stop it: a bearer token
// compared in constant time, an Origin allowlist, and a Host allowlist. We also
// never emit CORS headers, so even an authenticated response is unreadable to a
// page. There is no browser client to break by omitting them.
//
// No Electron imports on purpose — this file is a pure factory over a `tools`
// object, so it can be unit-tested (and reviewed) without booting an app.

const http = require('http')
const crypto = require('crypto')

// Versions we know how to speak. An unknown request falls back to the version
// this file was written against rather than parroting something we don't
// implement.
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
const FALLBACK_PROTOCOL = '2025-06-18'

const MAX_BODY = 4 * 1024 * 1024
const MAX_TEXT = 100000

// Origins a loopback server may legitimately hear from. Anything else is a page
// on the open web probing the port.
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/
// Host must be a loopback LITERAL — a rebound DNS name (evil.example resolving
// to 127.0.0.1) arrives with its own hostname here, which is what we reject.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

// Titles and behaviour hints per tool. Clients show these to the model (and to
// the user in permission UI), so the destructive/openWorld flags are part of
// the safety story, not decoration.
const TOOL_META = {
  list_cards: {
    title: 'List canvas cards',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  read_page: {
    title: 'Read a card\'s page',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  screenshot_card: {
    title: 'Screenshot a card',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  focus_card: {
    title: 'Focus a card',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  open_card: {
    title: 'Open a new card',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  navigate_card: {
    title: 'Navigate a card',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  click: {
    title: 'Click on a page',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  type_text: {
    title: 'Type into a page',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }
}

// A tool we don't have an entry for is still listed — hiding it would be worse —
// but it is described with the most cautious hints we have, so a client that
// auto-approves read-only tools can never be tricked into auto-approving a new
// one by us forgetting to update the table.
const UNKNOWN_META = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}

const msgOf = (e) => String((e && e.message) || e)

function stringify(v) {
  try {
    const s = JSON.stringify(v)
    return typeof s === 'string' ? s : String(v)
  } catch { return String(v) }
}

function clip(s) {
  const t = String(s == null ? '' : s)
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + ' …[truncated]' : t
}

const textBlock = (s) => ({ type: 'text', text: clip(s) })

// Equal-length check first: timingSafeEqual THROWS on a length mismatch, and the
// length of the token is not the secret — its bytes are.
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function bearerOf(req) {
  const h = req.headers['authorization']
  if (typeof h !== 'string') return ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : ''
}

function originOk(origin) {
  // No Origin at all is a non-browser client (curl, an MCP CLI) — pages always
  // send one on cross-origin requests. A literal 'null' is a sandboxed/file
  // context, which cannot read our response anyway.
  if (origin === undefined || origin === null) return true
  const v = String(origin).trim()
  if (!v || v === 'null') return true
  return LOOPBACK_ORIGIN.test(v)
}

function hostOk(host) {
  // Absent Host can't be a rebinding attack (rebinding works precisely BY
  // putting the attacker's hostname here), so an HTTP/1.0 client still works.
  if (host === undefined || host === null || host === '') return true
  return LOOPBACK_HOST.test(String(host).trim())
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result }
}

function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }
}

function createMcpServer({ tools, requestPermission, version, log } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  // Fail closed: with no way to ask a human, the answer to "may I click this?"
  // is no, not yes.
  const askPermission = typeof requestPermission === 'function'
    ? requestPermission
    : () => Promise.resolve('no')
  const serverVersion = typeof version === 'string' && version ? version : '0.0.0'

  let server = null
  let boundPort = null
  let token = ''

  // ---------- responses ----------

  function send(res, status, body, headers, hangUp) {
    if (res.writableEnded) return
    const text = body === undefined ? '' : stringify(body)
    const head = Object.assign({ 'Content-Length': Buffer.byteLength(text) }, headers || {})
    if (text) head['Content-Type'] = 'application/json'
    res.writeHead(status, head)
    // Flush first, THEN hang up — destroying the socket before the write lands
    // hands the client a truncated response instead of the status we wanted it
    // to read.
    res.end(text, () => { if (hangUp) res.destroy() })
  }

  // ---------- tools ----------

  function definitions() {
    if (!tools || typeof tools.definitions !== 'function') return []
    const defs = tools.definitions()
    return Array.isArray(defs) ? defs : []
  }

  function listTools() {
    return definitions().map(d => {
      const meta = TOOL_META[d.name] || UNKNOWN_META
      const schema = (d.input_schema && typeof d.input_schema === 'object') ? d.input_schema : {}
      return {
        name: d.name,
        title: meta.title || d.name,
        description: d.description || '',
        // Rename to the MCP spelling, and never ship a schema without a
        // properties map: several clients throw on `{ type: 'object' }` alone.
        inputSchema: Object.assign({ type: 'object' }, schema, {
          properties: (schema.properties && typeof schema.properties === 'object') ? schema.properties : {}
        }),
        annotations: Object.assign({}, meta.annotations)
      }
    })
  }

  // ai/tools.js returns one of three shapes and never throws; translate each
  // into MCP content. A tool FAILING is a successful JSON-RPC response with
  // isError set — only protocol mistakes get JSON-RPC error codes, otherwise the
  // model never sees the message telling it how to recover.
  function mapResult(out) {
    if (typeof out === 'string') return { content: [textBlock(out)], isError: false }
    if (out && typeof out === 'object') {
      if (typeof out.content === 'string') {
        return { content: [textBlock(out.content)], isError: !!out.is_error }
      }
      if (Array.isArray(out.content)) {
        const blocks = out.content.map(b => {
          if (b && b.type === 'image') {
            return { type: 'image', data: String(b.data == null ? '' : b.data), mimeType: b.media_type || 'image/jpeg' }
          }
          if (b && b.type === 'text') return textBlock(b.text)
          return textBlock(stringify(b))
        })
        return { content: blocks, isError: false }
      }
    }
    return { content: [textBlock(stringify(out))], isError: true }
  }

  async function callTool(params) {
    const name = params.name
    if (typeof name !== 'string' || !name) return { error: [-32602, 'tools/call needs a tool name'] }
    if (!definitions().some(d => d.name === name)) return { error: [-32602, 'Unknown tool: ' + name] }
    const args = params.arguments
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      return { error: [-32602, 'tools/call arguments must be an object'] }
    }
    // Log the verb only — arguments carry page text and whatever the user is
    // typing into a site.
    say('mcp tools/call ' + name)
    // chatId null / no signal: an MCP call has no chat transcript to render into
    // and no Escape brake behind it — the dialog in ai/index.js is the brake.
    const out = await tools.execute(name, args || {}, {
      requestPermission: askPermission,
      chatId: null,
      signal: undefined
    })
    return { result: mapResult(out) }
  }

  // ---------- JSON-RPC ----------

  async function handleOne(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return rpcErr(null, -32600, 'invalid request')
    const notification = !('id' in m)
    const id = notification ? null : m.id
    const method = typeof m.method === 'string' ? m.method : ''
    if (!method) return notification ? null : rpcErr(id, -32600, 'invalid request: no method')

    // notifications/initialized, notifications/cancelled and friends are
    // one-way. Answer `{}` in the (non-conforming) case a client stamped an id
    // on one, so it can't sit waiting for a reply that spec says never comes.
    if (method.startsWith('notifications/')) return notification ? null : rpcOk(id, {})
    if (notification) return null

    if (m.params !== undefined && (m.params === null || typeof m.params !== 'object' || Array.isArray(m.params))) {
      return rpcErr(id, -32602, 'params must be an object')
    }
    const params = m.params || {}

    try {
      if (method === 'initialize') {
        const want = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return rpcOk(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : FALLBACK_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'drift', title: 'Drift', version: serverVersion }
        })
      }
      if (method === 'ping') return rpcOk(id, {})
      if (method === 'tools/list') {
        // We never paginate — the whole list is eight entries — so a cursor is
        // accepted and ignored, and no nextCursor comes back.
        return rpcOk(id, { tools: listTools() })
      }
      if (method === 'tools/call') {
        const out = await callTool(params)
        return out.error ? rpcErr(id, out.error[0], out.error[1]) : rpcOk(id, out.result)
      }
      return rpcErr(id, -32601, 'unknown method: ' + method)
    } catch (e) {
      return rpcErr(id, -32603, 'internal error: ' + msgOf(e))
    }
  }

  async function handleRpc(res, raw) {
    let parsed
    try { parsed = JSON.parse(raw) }
    catch { return send(res, 400, rpcErr(null, -32700, 'parse error')) }

    if (Array.isArray(parsed)) {
      if (!parsed.length) return send(res, 400, rpcErr(null, -32600, 'invalid request: empty batch'))
      const out = []
      // Sequential on purpose: two tool calls in flight at once would stack two
      // modal permission dialogs on the user.
      for (const m of parsed) {
        const r = await handleOne(m)
        if (r) out.push(r)
      }
      if (!out.length) return send(res, 202, undefined)
      return send(res, 200, out)
    }

    const r = await handleOne(parsed)
    if (!r) return send(res, 202, undefined)
    send(res, 200, r)
  }

  // ---------- HTTP ----------

  function readBody(req, res, done) {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY) return tooLarge(res)
    const chunks = []
    let size = 0
    let over = false
    req.on('data', c => {
      if (over) return
      size += c.length
      if (size > MAX_BODY) { over = true; tooLarge(res); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!over) done(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', () => { over = true })
  }

  function tooLarge(res) {
    // Hang up after answering: the client is still pushing megabytes and we
    // have no reason to drain them.
    send(res, 413, rpcErr(null, -32600, 'request body too large'), null, true)
  }

  function onRequest(req, res) {
    let pathname = '/'
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname } catch {}

    if (pathname !== '/mcp') return send(res, 404, { error: 'not found' })

    // Rebinding guards run before auth so a hostile page gets the same 403
    // whether or not it somehow learned the token.
    if (!hostOk(req.headers['host'])) return send(res, 403, { error: 'forbidden' })
    if (!originOk(req.headers['origin'])) return send(res, 403, { error: 'forbidden' })

    if (req.method === 'GET') {
      // No server→client stream on this endpoint; 405 is how the spec says to
      // decline it, and clients fall back to plain POST.
      return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST' })
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' })

    if (!tokenMatches(bearerOf(req), token)) {
      // No WWW-Authenticate header: it would send MCP clients off into an OAuth
      // discovery dance we don't implement. And no hint about the real token.
      return send(res, 401, rpcErr(null, -32001, 'unauthorized'))
    }

    readBody(req, res, raw => {
      handleRpc(res, raw).catch(e => send(res, 500, rpcErr(null, -32603, 'internal error: ' + msgOf(e))))
    })
  }

  // ---------- lifecycle ----------

  function stop() {
    const srv = server
    server = null
    boundPort = null
    token = ''
    if (!srv) return Promise.resolve()
    return new Promise(resolve => {
      // A connected client parks a keep-alive socket on the port between calls,
      // and close() waits for every socket to go idle — without this, stopping
      // the server hangs until the client happens to disconnect.
      if (srv.closeAllConnections) srv.closeAllConnections()
      srv.close(() => resolve())
    })
  }

  async function start(opts) {
    const o = opts || {}
    if (!tools || typeof tools.execute !== 'function') throw new Error('the MCP server needs a tools object')
    const tok = typeof o.token === 'string' ? o.token.trim() : ''
    // Refuse to bind without a token. An unauthenticated tool endpoint would let
    // any process on the machine drive the user's browser.
    if (!tok) throw new Error('the MCP server needs a token')
    const want = Number(o.port)
    if (!Number.isInteger(want) || want < 0 || want > 65535) throw new Error('bad port: ' + o.port)

    // Restarting on a new port must not orphan the old listener.
    await stop()

    return new Promise((resolve, reject) => {
      const srv = http.createServer(onRequest)
      const onError = err => {
        srv.removeListener('error', onError)
        reject(err && err.code === 'EADDRINUSE'
          ? new Error('port ' + want + ' is already in use')
          : new Error(msgOf(err)))
      }
      srv.once('error', onError)
      // 127.0.0.1 ONLY — binding 0.0.0.0 would hand the user's browser to
      // anything on their network (or their coffee-shop wifi).
      srv.listen(want, '127.0.0.1', () => {
        srv.removeListener('error', onError)
        // Past listen, an error is a single broken socket; it must not take the
        // app down with an unhandled 'error' event.
        srv.on('error', e => say('mcp server error: ' + msgOf(e)))
        server = srv
        token = tok
        const addr = srv.address()
        boundPort = addr && addr.port
        say('mcp listening on 127.0.0.1:' + boundPort)
        resolve({ port: boundPort, url: 'http://127.0.0.1:' + boundPort + '/mcp' })
      })
    })
  }

  return {
    start,
    stop,
    isRunning: () => !!server && server.listening,
    port: () => boundPort
  }
}

module.exports = { createMcpServer }
