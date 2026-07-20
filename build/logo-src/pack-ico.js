// Pack PNGs into a Windows .ico (PNG-compressed entries, Vista+). Node only.
// Run: node build/logo-src/pack-ico.js
const fs = require('fs')
const path = require('path')
const OUT = path.join(__dirname, 'png')
const sizes = [16, 32, 48, 64, 128, 256]
const pngs = sizes.map(s => ({ s, buf: fs.readFileSync(path.join(OUT, `icon_${s}.png`)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)      // reserved
header.writeUInt16LE(1, 2)      // type = icon
header.writeUInt16LE(pngs.length, 4)

const entries = []
let offset = 6 + pngs.length * 16
for (const { s, buf } of pngs) {
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0)   // width (0 = 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1)   // height
  e.writeUInt8(0, 2)                  // color palette
  e.writeUInt8(0, 3)                  // reserved
  e.writeUInt16LE(1, 4)               // color planes
  e.writeUInt16LE(32, 6)              // bits per pixel
  e.writeUInt32LE(buf.length, 8)      // size of image data
  e.writeUInt32LE(offset, 12)         // offset of image data
  offset += buf.length
  entries.push(e)
}

const ico = Buffer.concat([header, ...entries, ...pngs.map(p => p.buf)])
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico)
console.log('wrote icon.ico (' + ico.length + ' bytes, ' + pngs.length + ' sizes)')
