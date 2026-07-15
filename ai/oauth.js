// Drift AI — OAuth sign-in flows for providers that support native apps.
// RFC 8252 pattern: authorization happens in the SYSTEM browser (injected
// openExternal), the callback lands on a one-shot loopback HTTP server bound
// to 127.0.0.1 only — exact path match, single use, 180s timeout — with
// PKCE S256 and a per-attempt state. Never log or echo codes/tokens.

const http = require('http')
const crypto = require('crypto')

// net.fetch rides Chromium's network stack (proxy-aware); plain fetch is the
// fallback outside Electron (tests).
let net = null
try { net = require('electron').net } catch {}
const doFetch = (url, opts) => (net && net.fetch ? net.fetch(url, opts) : fetch(url, opts))

const TIMEOUT_MS = 180000
const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CHATGPT_REDIRECT = 'http://localhost:1455/auth/callback'
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token'

const b64url = (buf) => buf.toString('base64url')
const makeVerifier = () => b64url(crypto.randomBytes(48)) // 64 chars, inside RFC 7636's 43-128
const makeChallenge = (v) => b64url(crypto.createHash('sha256').update(v).digest())
const makeState = () => b64url(crypto.randomBytes(16))

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

// The page the user's browser lands on after the callback. Self-contained,
// inline styles only — Drift's warm dark glass look.
function page(ok, detail) {
  const heading = ok ? 'You&#8217;re connected' : 'Connection failed'
  const sub = ok
    ? 'Return to Drift — you can close this tab.'
    : escapeHtml(detail || 'Something went wrong — return to Drift and try again.')
  return '<!doctype html><html><head><meta charset="utf-8"><title>Drift</title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(120% 90% at 20% 0%,#241a26 0%,#17121a 60%);' +
    'font-family:-apple-system,system-ui,sans-serif;color:#f4f1ec">' +
    '<div style="text-align:center;max-width:420px;padding:44px 52px;border-radius:24px;' +
    'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.10);' +
    'box-shadow:0 24px 60px rgba(0,0,0,0.45)">' +
    '<div style="font-size:32px;color:#ffb469">' + (ok ? '✦' : '✕') + '</div>' +
    '<div style="margin:14px 0 8px;font-size:21px;font-weight:600">' + heading + '</div>' +
    '<div style="font-size:14px;line-height:1.5;color:#a79fb3">' + sub + '</div>' +
    '</div></body></html>'
}

async function postJson(url, body) {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    let msg = ''
    try {
      const err = await res.json()
      msg = (err.error && err.error.message) || err.error_description ||
        (typeof err.error === 'string' ? err.error : '')
    } catch {}
    throw new Error('Sign-in exchange failed (' + res.status + (msg ? ': ' + msg : '') + ')')
  }
  return res.json()
}

const startServer = (port) => new Promise((resolve, reject) => {
  const server = http.createServer()
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    server.removeListener('error', reject)
    resolve(server)
  })
})

// One callback, then done: exchange(query) runs BEFORE the browser gets its
// response so the page can honestly say connected vs failed. cancel() lets
// the caller abort (e.g. the browser refused to open) without waiting out
// the timeout.
function receiveCallback(server, pathname, exchange, timeoutMs = TIMEOUT_MS) {
  let cancel
  const promise = new Promise((resolve, reject) => {
    let settled = false
    let handling = false
    const finish = (err, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (server.closeAllConnections) server.closeAllConnections()
      err ? reject(err) : resolve(result)
    }
    cancel = (err) => finish(err)
    const timer = setTimeout(() => finish(new Error('Sign-in timed out — try again')), timeoutMs)
    server.on('error', (err) => finish(err))
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      // Exact-path GET only; strays (favicon etc.) must not consume the
      // one-shot callback.
      if (req.method !== 'GET' || u.pathname !== pathname || handling || settled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }
      handling = true
      const params = Object.fromEntries(u.searchParams)
      Promise.resolve()
        .then(() => exchange(params))
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
          // Settle only after the page flushes — closeAllConnections in
          // finish() would otherwise cut the response off mid-send.
          res.end(page(true), () => finish(null, result))
        })
        .catch((err) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
          res.end(page(false, err.message), () => finish(err))
        })
    })
  })
  return { promise, cancel }
}

async function connectOpenRouter({ openExternal }) {
  const verifier = makeVerifier()
  const server = await startServer(0)
  const callbackUrl = 'http://127.0.0.1:' + server.address().port + '/callback'
  // OpenRouter's PKCE flow has no state parameter; per RFC 9700 the PKCE
  // challenge plus the random single-use port covers CSRF here.
  const authUrl = 'https://openrouter.ai/auth?callback_url=' + encodeURIComponent(callbackUrl) +
    '&code_challenge=' + makeChallenge(verifier) + '&code_challenge_method=S256'
  const cb = receiveCallback(server, '/callback', async (q) => {
    if (!q.code) throw new Error('OpenRouter returned no code')
    const out = await postJson('https://openrouter.ai/api/v1/auth/keys', {
      code: q.code,
      code_verifier: verifier,
      code_challenge_method: 'S256'
    })
    if (!out || typeof out.key !== 'string') throw new Error('OpenRouter returned no key')
    return { key: out.key }
  })
  try { await openExternal(authUrl) } catch { cb.cancel(new Error('Could not open the browser for sign-in')) }
  return cb.promise
}

// Decode (not verify — we only mine our own token for its claims) a JWT payload.
const jwtPayload = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch { return null }
}

function chatgptTokens(tok, prev) {
  if (!tok || !tok.access_token) throw new Error('Token response was missing an access token')
  const auth = (jwtPayload(tok.access_token) || {})['https://api.openai.com/auth'] || {}
  const id = jwtPayload(tok.id_token) || {}
  return {
    access: tok.access_token,
    // Rotation may omit the refresh token — keep the previous one then.
    refresh: tok.refresh_token || (prev && prev.refresh) || null,
    expiresAt: Date.now() + (Number(tok.expires_in) > 0 ? Number(tok.expires_in) : 3600) * 1000,
    accountId: auth.chatgpt_account_id || (prev && prev.accountId) || null,
    email: id.email || (prev && prev.email) || null
  }
}

async function connectChatGPT({ openExternal }) {
  const verifier = makeVerifier()
  const state = makeState()
  let server
  try {
    // The Codex public client's registered redirect is fixed to port 1455;
    // we still bind 127.0.0.1 only (localhost resolves there).
    server = await startServer(1455)
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') throw new Error('Port 1455 is in use — close other Codex sign-ins and retry')
    throw err
  }
  const u = new URL('https://auth.openai.com/oauth/authorize')
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', CHATGPT_CLIENT_ID)
  u.searchParams.set('redirect_uri', CHATGPT_REDIRECT)
  u.searchParams.set('scope', 'openid profile email offline_access')
  u.searchParams.set('code_challenge', makeChallenge(verifier))
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  u.searchParams.set('id_token_add_organizations', 'true')
  u.searchParams.set('codex_cli_simplified_flow', 'true')
  u.searchParams.set('originator', 'drift')
  const cb = receiveCallback(server, '/auth/callback', async (q) => {
    if (q.error) throw new Error('Sign-in was denied (' + q.error + ')')
    if (q.state !== state) throw new Error('Sign-in state mismatch — try again')
    if (!q.code) throw new Error('Sign-in returned no code')
    return chatgptTokens(await postJson(CHATGPT_TOKEN_URL, {
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: CHATGPT_REDIRECT,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: verifier
    }), null)
  })
  try { await openExternal(u.toString()) } catch { cb.cancel(new Error('Could not open the browser for sign-in')) }
  return cb.promise
}

// Callers own single-flight: one in-flight refresh per account, persist the
// rotated tokens before releasing — concurrent refreshes look like token
// theft to providers that rotate refresh tokens.
async function refreshChatGPT(tokens) {
  if (!tokens || !tokens.refresh) throw new Error('No ChatGPT refresh token — sign in again')
  return chatgptTokens(await postJson(CHATGPT_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CHATGPT_CLIENT_ID,
    refresh_token: tokens.refresh
  }), tokens)
}

module.exports = { connectOpenRouter, connectChatGPT, refreshChatGPT }
