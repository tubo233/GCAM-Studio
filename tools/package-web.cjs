// Portable web distribution: only Node built-ins, no exe or Python needed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'frontend/dist')
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : entry.isFile() ? [full] : []
  }).sort()
}
const relative = p => path.relative(root, p).split(path.sep).join('/')
const names = ['package.json', 'package-lock.json', 'frontend/index.html', 'frontend/tsconfig.json', 'frontend/vite.config.ts', ...files(path.join(root, 'frontend/src')).map(relative).sort()]
const digest = crypto.createHash('sha256')
for (const name of names) {
  let content = fs.readFileSync(path.join(root, name))
  if (['.json', '.html', '.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.svg'].includes(path.extname(name).toLowerCase())) content = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'))
  digest.update(name); digest.update('\0'); digest.update(content); digest.update('\0')
}
const source = digest.digest('hex')
const hashes = Object.fromEntries(files(dist).filter(p => path.basename(p) !== '.studio-build.json').map(p => [path.relative(dist, p).split(path.sep).join('/'), sha(fs.readFileSync(p))]))
if (!hashes['index.html'] || !Object.keys(hashes).some(n => n.startsWith('assets/'))) throw Error('Web build is incomplete')
fs.writeFileSync(path.join(dist, '.studio-build.json'), JSON.stringify({ source, files: hashes }))
const crcTable = Array.from({ length: 256 }, (_, i) => { for (let b = 0; b < 8; b++) i = i & 1 ? 0xedb88320 ^ (i >>> 1) : i >>> 1; return i >>> 0 })
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
const local = [], central = []
let offset = 0
for (const file of files(dist)) {
  const name = Buffer.from(relative(file))
  const raw = fs.readFileSync(file), compressed = zlib.deflateRawSync(raw, { level: 6 }), crc = crc32(raw)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12)
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26)
  const index = Buffer.alloc(46)
  index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(8, 10); index.writeUInt16LE(33, 14)
  index.writeUInt32LE(crc, 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(raw.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42)
  local.push(header, name, compressed); central.push(index, name)
  offset += header.length + name.length + compressed.length
}
const directory = Buffer.concat(central), end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
const archive = Buffer.concat([...local, directory, end])
fs.mkdirSync(path.join(root, 'distribution'), { recursive: true })
fs.writeFileSync(path.join(root, 'distribution/web.zip'), archive)
fs.writeFileSync(path.join(root, 'distribution/web.json'), JSON.stringify({ schema: 1, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, source, sha256: sha(archive) }, null, 2) + '\n')
console.log('Bundled verified web assets for source updates.')
