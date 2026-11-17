/**
 * Minimal XML reader for FCP7 (xmeml) timelines.
 *
 * The project has a zero-dependency rule, so this is a small hand-written parser
 * rather than a library. xmeml is simple, well-formed XML: elements, attributes,
 * text, comments and CDATA - enough for what we need, and it fails loudly on
 * anything unexpected instead of silently returning garbage.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    const v = ENTITIES[body]
    return v === undefined ? whole : v
  })
}

/** Parse XML text into { name, attrs, children, text } nodes. */
export function parseXml(source) {
  const src = String(source)
  let i = 0
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]

  const top = () => stack[stack.length - 1]

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      top().text += decode(src.slice(i))
      break
    }
    if (lt > i) top().text += decode(src.slice(i, lt))

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) throw new Error('XML 注释未闭合')
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end === -1) throw new Error('CDATA 未闭合')
      top().text += src.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2)
      if (end === -1) throw new Error('处理指令未闭合')
      i = end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2)
      if (end === -1) throw new Error('DOCTYPE 未闭合')
      i = end + 1
      continue
    }

    const gt = src.indexOf('>', lt)
    if (gt === -1) throw new Error('标签未闭合')
    let inner = src.slice(lt + 1, gt).trim()
    const selfClosing = inner.endsWith('/')
    if (selfClosing) inner = inner.slice(0, -1).trim()

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (top().name !== name) throw new Error('标签不匹配：</' + name + '> 遇到 <' + top().name + '>')
      stack.pop()
      i = gt + 1
      continue
    }

    const space = inner.search(/[\s]/u)
    const name = space === -1 ? inner : inner.slice(0, space)
    const attrText = space === -1 ? '' : inner.slice(space + 1)
    const attrs = {}
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/gu
    let m
    while ((m = attrRe.exec(attrText)) !== null) {
      attrs[m[1]] = decode(m[3] !== undefined ? m[3] : m[4])
    }
    const node = { name, attrs, children: [], text: '' }
    top().children.push(node)
    if (!selfClosing) stack.push(node)
    i = gt + 1
  }
  return root
}

/** First descendant with the given tag name (depth-first). */
export function find(node, name) {
  if (!node) return null
  for (const child of node.children) {
    if (child.name === name) return child
    const hit = find(child, name)
    if (hit) return hit
  }
  return null
}

/** All descendants with the given tag name. */
export function findAll(node, name, out = []) {
  if (!node) return out
  for (const child of node.children) {
    if (child.name === name) out.push(child)
    findAll(child, name, out)
  }
  return out
}

export function textOf(node, name, fallback = '') {
  const hit = find(node, name)
  return hit ? hit.text.trim() : fallback
}

export function numberOf(node, name, fallback = 0) {
  const raw = textOf(node, name, '')
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}
