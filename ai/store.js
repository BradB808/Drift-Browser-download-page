// Drift AI — settings, secrets and chat persistence.
// Secrets are encrypted with the OS keychain via safeStorage and written to
// drift-ai.json as base64 ciphertext; plaintext only ever lives in
// main-process memory. Chats live in drift-ai-chats.json (local artifacts,
// nothing leaves the machine). Construct the store after app 'ready' —
// safeStorage on macOS uses the wrong keychain item name before then.

const fs = require('fs')
const path = require('path')

const defaultMeta = () => ({
  prefs: { provider: null, model: null, actionsEnabled: true },
  custom: { baseUrl: '', label: '' },
  allowlist: {}
})

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function createAiStore({ userDataDir, safeStorage, headless }) {
  const aiFile = path.join(userDataDir || '', 'drift-ai.json')
  const chatsFile = path.join(userDataDir || '', 'drift-ai-chats.json')
  // headless (selftest) keeps everything in memory — neither the profile nor
  // the keychain is ever touched, and secrets stay plaintext in `plain`.
  const disk = !headless

  const canEncrypt = () => {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable()) } catch { return false }
  }

  const data = disk ? readJson(aiFile, {}) : {}
  let secrets = (data && typeof data.secrets === 'object' && data.secrets) || {}
  const meta = Object.assign(defaultMeta(), (data && typeof data.meta === 'object' && data.meta) || {})
  const plain = new Map() // name -> decrypted value, so the keychain is hit at most once per secret

  let chats = disk ? readJson(chatsFile, []) : []
  if (!Array.isArray(chats)) chats = []

  // tmp+rename so a crash mid-write can't truncate the file — readJson would
  // silently swallow the corrupt JSON and the data would look "gone".
  const writeAtomic = (file, json) => {
    try {
      fs.writeFileSync(file + '.tmp', json)
      fs.renameSync(file + '.tmp', file)
    } catch {}
  }

  const persist = () => {
    if (!disk) return
    writeAtomic(aiFile, JSON.stringify({ secrets, meta }, null, 2))
  }

  const MAX_CHATS = 100

  // What goes to disk: image blocks (screenshots, ~100KB+ of base64 each) are
  // session-only — persisting them would balloon the file and make every
  // coalesced save a main-thread stringify of megabytes. Oldest chats fall off
  // past MAX_CHATS.
  const chatsForDisk = () => {
    const slim = chats.map(c => ({
      ...c,
      messages: (c.messages || []).map(m => ({
        ...m,
        content: (Array.isArray(m.content) ? m.content : []).map(b => {
          if (b && b.type === 'image') return { type: 'text', text: '[screenshot — not saved]' }
          if (b && b.type === 'tool_result' && Array.isArray(b.content)) {
            return {
              ...b,
              content: b.content.map(x => (x && x.type === 'image' ? { type: 'text', text: '[screenshot — not saved]' } : x))
            }
          }
          return b
        })
      }))
    }))
    return slim.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, MAX_CHATS)
  }

  // Chat saves stream in on every turn — coalesce them into one async write.
  let chatTimer = null
  const persistChats = () => {
    if (!disk || chatTimer) return
    chatTimer = setTimeout(() => {
      chatTimer = null
      const json = JSON.stringify(chatsForDisk())
      fs.writeFile(chatsFile + '.tmp', json, (err) => {
        if (err) return
        fs.rename(chatsFile + '.tmp', chatsFile, () => {})
      })
    }, 250)
  }

  // Quit path: a pending debounce or in-flight async write dies with the
  // process — force the write synchronously.
  const flush = () => {
    if (!disk || !chatTimer) return
    clearTimeout(chatTimer)
    chatTimer = null
    writeAtomic(chatsFile, JSON.stringify(chatsForDisk()))
  }

  const getSecret = (name) => {
    if (plain.has(name)) return plain.get(name)
    const enc = secrets[name]
    if (!enc || !canEncrypt()) return null
    try {
      const v = safeStorage.decryptString(Buffer.from(enc, 'base64'))
      plain.set(name, v)
      return v
    } catch {
      // Keychain reset or signature change — drop the ciphertext so the UI
      // re-prompts instead of failing forever.
      delete secrets[name]
      persist()
      return null
    }
  }

  const setSecret = (name, value) => {
    if (typeof name !== 'string' || !name) return
    if (value == null || value === '') {
      plain.delete(name)
      if (name in secrets) { delete secrets[name]; persist() }
      return
    }
    if (headless) { plain.set(name, String(value)); return }
    if (!canEncrypt()) return // nothing stored; getMeta reports encryptionAvailable:false
    try {
      secrets[name] = safeStorage.encryptString(String(value)).toString('base64')
      plain.set(name, String(value))
      persist()
    } catch {}
  }

  // encryptionAvailable is computed live (headless holds secrets in memory,
  // so saves always work there) and never persisted.
  const getMeta = () => Object.assign({}, meta, { encryptionAvailable: headless ? true : canEncrypt() })

  const setMeta = (patch) => {
    if (!patch || typeof patch !== 'object') return
    Object.assign(meta, patch)
    delete meta.encryptionAvailable
    persist()
  }

  const listChats = () => chats
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, provider: c.provider, model: c.model }))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))

  const getChat = (id) => chats.find((c) => c.id === id) || null

  // A turn that is still streaming keeps saving its chat object — deleting that
  // chat must stick, so deletions leave a tombstone that saveChat honors.
  const deleted = new Set()

  const saveChat = (chat) => {
    if (!chat || typeof chat.id !== 'string' || deleted.has(chat.id)) return
    const i = chats.findIndex((c) => c.id === chat.id)
    if (i >= 0) chats[i] = chat
    else chats.push(chat)
    persistChats()
  }

  const deleteChat = (id) => {
    deleted.add(id)
    chats = chats.filter((c) => c.id !== id)
    persistChats()
  }

  const clearChats = () => {
    for (const c of chats) deleted.add(c.id)
    chats = []
    persistChats()
  }

  return { getSecret, setSecret, getMeta, setMeta, listChats, getChat, saveChat, deleteChat, clearChats, flush }
}

module.exports = { createAiStore }
