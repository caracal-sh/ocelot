#!/usr/bin/env node
// A stand-in for GitHub, for testing the updater without publishing a release. It enforces what GitHub enforces and
// the app must do. Two modes, matching OCELOT_UPDATE_NEEDS_AUTH:
//
// Private repo (default):
//   GET /<repo>/updates/appcast.xml                      needs Authorization: Bearer <token> (raw.githubusercontent.com; Accept is
//                                                        whatever Sparkle sends, application/rss+xml)
//   GET /repos/<repo>/releases/assets/<id>               needs Authorization and Accept: application/octet-stream
//                                                        (any other Accept gets the asset's JSON, like GitHub), then 302 to
//   GET http://localhost:<port>/blob/<random>             the "CDN": a different host than 127.0.0.1, so URLSession must have
//                                                        dropped Authorization (the real CDN answers 400 when it is present)
//
// Public repo (--public): no token anywhere. A request that carries an Authorization header is refused with 400, because the
// app must not send one.
//   GET /<repo>/updates/appcast.xml                      the appcast
//   GET /<repo>/releases/download/v<x>/Ocelot-<x>.dmg    302 to the blob "CDN" below (GitHub redirects to
//                                                        release-assets.githubusercontent.com)
//   GET http://localhost:<port>/blob/<random>             the DMG
//
// Every request is logged as one JSON line (the Authorization value is never written, only whether it was there).
//
//   updater-test-server.mjs --appcast appcast.xml --dmg Ocelot-0.1.1.dmg --asset-id 4242 [--port 0] [--log requests.jsonl] [--repo owner/name]
//   updater-test-server.mjs --public --appcast appcast.xml --dmg Ocelot-0.1.1.dmg [--port 0] [--log requests.jsonl] [--repo owner/name]
// Prints `listening http://127.0.0.1:<port>` when ready.
import { createServer } from 'node:http'
import { createReadStream, readFileSync, statSync, appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (!a.startsWith('--')) return acc
    const next = all[i + 1]
    return [...acc, [a.slice(2), next === undefined || next.startsWith('--') ? true : next]]
  }, []),
)
const isPublic = args.public === true
for (const k of isPublic ? ['appcast', 'dmg'] : ['appcast', 'dmg', 'asset-id']) if (!args[k]) { console.error(`--${k} is required`); process.exit(1) }
const repo = args.repo ?? 'caracal-sh/ocelot'
const dmgName = basename(args.dmg)
const version = /^Ocelot-(.+)\.dmg$/.exec(dmgName)?.[1]
if (isPublic && !version) { console.error(`--dmg must be named Ocelot-<version>.dmg, got ${dmgName}`); process.exit(1) }
const logFile = args.log
const blobs = new Set()

const log = (entry) => {
  const line = JSON.stringify(entry)
  console.log(line)
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const hasAuth = /^Bearer \S+$/.test(req.headers.authorization ?? '')
  const accept = req.headers.accept ?? ''
  const entry = { method: req.method, host: req.headers.host, path: url.pathname + url.search, authorization: req.headers.authorization ? 'present' : 'absent', accept, userAgent: req.headers['user-agent'] }
  const reply = (status, headers, body) => {
    log({ ...entry, status })
    res.writeHead(status, headers)
    res.end(body)
  }
  const redirectToBlob = () => {
    const id = randomBytes(8).toString('hex')
    blobs.add(id)
    return reply(302, { location: `http://localhost:${server.address().port}/blob/${id}?sig=test` })
  }

  if (isPublic && req.headers.authorization) {
    return reply(400, { 'content-type': 'text/plain' }, 'Public mode: the app must not send an Authorization header.')
  }

  if (url.pathname === `/${repo}/updates/appcast.xml`) {
    if (!isPublic && !hasAuth) return reply(404, { 'content-type': 'text/plain' }, '404: Not Found')
    return reply(200, { 'content-type': 'text/plain; charset=utf-8' }, readFileSync(args.appcast))
  }
  if (isPublic && url.pathname === `/${repo}/releases/download/v${version}/${dmgName}`) return redirectToBlob()
  if (!isPublic && url.pathname === `/repos/${repo}/releases/assets/${args['asset-id']}`) {
    if (!hasAuth) return reply(404, { 'content-type': 'application/json' }, '{"message":"Not Found"}')
    if (accept !== 'application/octet-stream') return reply(200, { 'content-type': 'application/json' }, JSON.stringify({ id: Number(args['asset-id']), name: dmgName, note: 'Accept was not application/octet-stream: GitHub answers with JSON' }))
    return redirectToBlob()
  }
  if (url.pathname.startsWith('/blob/')) {
    if (req.headers.authorization) return reply(400, { 'content-type': 'text/plain' }, 'Only one auth mechanism allowed; the CDN URL is pre-signed.')
    if (!blobs.has(url.pathname.slice(6))) return reply(403, {}, 'bad signature')
    const size = statSync(args.dmg).size
    log({ ...entry, status: 200, bytes: size })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'content-disposition': `attachment; filename=${dmgName}` })
    return createReadStream(args.dmg).pipe(res)
  }
  return reply(404, { 'content-type': 'application/json' }, '{"message":"Not Found"}')
})

server.listen(Number(args.port ?? 0), '127.0.0.1', () => console.log(`listening http://127.0.0.1:${server.address().port}`))
