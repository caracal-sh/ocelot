#!/usr/bin/env node
// Adds (or replaces) one release in Ocelot's Sparkle appcast and writes the file back. Pure Node, no dependencies.
//
// The appcast lives alone on the orphan `updates` branch. Items are newest first (by build number), at most --keep (20).
// Where an enclosure points depends on whether the repo is private (--needs-auth YES, the default, matching
// OCELOT_UPDATE_NEEDS_AUTH in project.yml):
//   YES  the GitHub *API* URL of the release asset, which the app downloads with the user's token (UpdateService.swift);
//        needs --asset-id.
//   NO   the public release download URL https://github.com/<repo>/releases/download/v<version>/Ocelot-<version>.dmg,
//        fetched without a token; no asset id.
// Release notes are inline HTML in <description>.
//
//   appcast.mjs --init --repo owner/name --out appcast.xml    # empty, valid feed
//   appcast.mjs --out appcast.xml [--existing appcast.xml] --version 0.2.0 --build 57 --min-os 14.0 \
//       --repo owner/name [--needs-auth YES|NO] [--asset-id 123456789] --length 12345678 --signature <base64> \
//       [--notes-file notes.md] [--pub-date "Mon, 09 Nov 2026 12:00:00 +0000"] [--keep 20]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`)
    const key = a.slice(2)
    if (key === 'init') out.init = true
    else {
      if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`)
      out[key] = argv[++i]
    }
  }
  return out
}

/** `YES`/`NO` (any case, also true/false/1/0); anything else, or nothing, means a private repo. */
export function parseNeedsAuth(value) {
  return !['no', 'false', '0'].includes(String(value ?? '').trim().toLowerCase())
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Markdown subset GitHub's generated notes use: headings, bullet lists, paragraphs, **bold**, `code`, links, bare URLs.
function inline(text) {
  let s = esc(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => (pre.endsWith('"') || pre.endsWith('>') ? m : `${pre}<a href="${url}">${url}</a>`))
  return s
}

export function markdownToHtml(md) {
  const html = []
  let list = false
  const closeList = () => { if (list) { html.push('</ul>'); list = false } }
  let para = []
  const flush = () => { if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = [] } }
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    let m
    if (!line.trim()) { flush(); closeList(); continue }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flush(); closeList()
      const level = Math.min(m[1].length + 1, 6)
      html.push(`<h${level}>${inline(m[2])}</h${level}>`)
    } else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flush()
      if (!list) { html.push('<ul>'); list = true }
      html.push(`<li>${inline(m[1])}</li>`)
    } else {
      closeList()
      para.push(line.trim())
    }
  }
  flush(); closeList()
  return html.join('\n')
}

/** The enclosure URL: the API asset URL for a private repo (token needed), the public download URL otherwise. */
export function enclosureUrl(o) {
  return o.needsAuth === false
    ? `https://github.com/${o.repo}/releases/download/v${o.version}/Ocelot-${o.version}.dmg`
    : `https://api.github.com/repos/${o.repo}/releases/assets/${o.assetId}`
}

export function buildItem(o) {
  const url = enclosureUrl(o)
  const notes = o.notesHtml ? `\n      <description><![CDATA[${o.notesHtml.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></description>` : ''
  return [
    '    <item>',
    `      <title>Ocelot ${esc(o.version)}</title>`,
    `      <pubDate>${esc(o.pubDate)}</pubDate>`,
    `      <sparkle:version>${esc(o.build)}</sparkle:version>`,
    `      <sparkle:shortVersionString>${esc(o.version)}</sparkle:shortVersionString>`,
    `      <sparkle:minimumSystemVersion>${esc(o.minOS)}</sparkle:minimumSystemVersion>${notes}`,
    `      <enclosure url="${esc(url)}" length="${esc(o.length)}" type="application/octet-stream" sparkle:edSignature="${esc(o.signature)}"/>`,
    '    </item>',
  ].join('\n')
}

const itemBlocks = (xml) => xml.match(/ *<item>[\s\S]*?<\/item>/g) ?? []
const itemTag = (block, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1]

export function renderFeed(items, repo) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<rss version="2.0" xmlns:sparkle="${NS}">`,
    '  <channel>',
    '    <title>Ocelot</title>',
    `    <link>https://github.com/${repo}</link>`,
    '    <description>Ocelot updates</description>',
    '    <language>en</language>',
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}

/** Existing items (verbatim) minus the one being replaced, plus the new one, newest build first, capped. */
export function mergeItems(existingXml, newItem, newBuild, newVersion, keep) {
  const kept = itemBlocks(existingXml).filter((b) => itemTag(b, 'sparkle:version') !== String(newBuild) && itemTag(b, 'sparkle:shortVersionString') !== newVersion)
  const all = newItem ? [{ build: Number(newBuild), block: newItem }, ...kept.map((b) => ({ build: Number(itemTag(b, 'sparkle:version')), block: b }))] : kept.map((b) => ({ build: Number(itemTag(b, 'sparkle:version')), block: b }))
  all.sort((a, b) => b.build - a.build)
  return all.slice(0, keep).map((x) => x.block)
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  if (!a.out) throw new Error('--out is required')
  if (!a.repo || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(a.repo)) throw new Error('--repo must be owner/name')
  if (a.init) {
    writeFileSync(a.out, renderFeed([], a.repo))
    return
  }
  const needsAuth = parseNeedsAuth(a['needs-auth'])
  for (const k of ['version', 'build', 'min-os', 'length', 'signature']) if (!a[k]) throw new Error(`--${k} is required`)
  if (needsAuth && !/^\d+$/.test(a['asset-id'] ?? '')) throw new Error(`--asset-id must be the numeric GitHub asset id for a private repo, got ${a['asset-id']}`)
  if (!/^\d+$/.test(a.length)) throw new Error('--length must be the DMG size in bytes')
  if (!/^[A-Za-z0-9+/]{86}==$/.test(a.signature)) throw new Error('--signature is not an EdDSA signature (88 base64 characters)')
  const existing = a.existing && existsSync(a.existing) ? readFileSync(a.existing, 'utf8') : ''
  const notes = a['notes-file'] && existsSync(a['notes-file']) ? readFileSync(a['notes-file'], 'utf8') : ''
  const item = buildItem({
    version: a.version,
    build: a.build,
    minOS: a['min-os'],
    repo: a.repo,
    assetId: a['asset-id'],
    needsAuth,
    length: a.length,
    signature: a.signature,
    pubDate: a['pub-date'] ?? new Date().toUTCString().replace('GMT', '+0000'),
    notesHtml: notes.trim() ? markdownToHtml(notes) : '',
  })
  writeFileSync(a.out, renderFeed(mergeItems(existing, item, a.build, a.version, Number(a.keep ?? 20)), a.repo))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main() } catch (e) { console.error(`error: ${e.message}`); process.exit(1) }
}
