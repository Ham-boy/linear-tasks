// Turns the trees preview.test.tsx printed into HTML pages that approximate
// how the Claude desktop app draws a mod's pane (dark theme, its element
// set), so headless Chrome can screenshot them.
//   node render.mjs <raw test output> <out dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , rawPath, outDir] = process.argv
const raw = readFileSync(rawPath, 'utf8')
mkdirSync(outDir, { recursive: true })

// The desktop app's dark theme, approximated from its UI.
const THEME = {
  text: '#e8e6e3',
  inverseText: '#1a1a19',
  dim: '#9c9a95',
  inactive: '#4a4945',
  subtle: '#8b8984',
  suggestion: '#7aa2f7',
  remember: '#7aa2f7',
  success: '#6cbf6f',
  error: '#e5584f',
  warning: '#e0a94a',
  merged: '#a78bfa',
  claude: '#d97757',
  permission: '#b1b9f9',
  planMode: '#5fb3b3',
  autoAccept: '#b48ead',
  promptBorder: '#4a4945',
  bashBorder: '#e5584f',
  ide: '#7aa2f7',
  diffAdded: '#2f5b34',
  diffRemoved: '#6b2d2b',
}
const color = c => (c in THEME ? THEME[c] : c)
const CELL_W = 8 // px per cell, horizontally
const CELL_H = 20 // px per row
const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
const space = (v, unit = CELL_W) => (typeof v === 'number' ? `${v * unit}px` : v in SPACE ? `${SPACE[v]}px` : v)
const size = (v, unit) => (typeof v === 'number' ? `${v * unit}px` : v)
const SIZES = { caption: 12, footnote: 13, body: 14, heading: 16, title: 18 }
const WEIGHTS = { regular: 400, medium: 500, semibold: 600, bold: 700 }
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function boxStyle(p) {
  const s = ['display:flex']
  if (p.display === 'none') s.push('display:none')
  s.push(`flex-direction:${p.flexDirection ?? 'row'}`)
  if (p.flexGrow !== undefined) s.push(`flex-grow:${p.flexGrow}`)
  s.push(`flex-shrink:${p.flexShrink ?? 1}`)
  if (p.flexWrap) s.push(`flex-wrap:${p.flexWrap}`)
  if (p.alignItems) s.push(`align-items:${p.alignItems}`)
  if (p.alignSelf) s.push(`align-self:${p.alignSelf}`)
  if (p.justifyContent) s.push(`justify-content:${p.justifyContent}`)
  const row = (p.flexDirection ?? 'row').startsWith('row')
  if (p.gap !== undefined) s.push(`column-gap:${space(p.gap)}`, `row-gap:${space(p.gap, CELL_H / 2)}`)
  if (p.columnGap !== undefined) s.push(`column-gap:${space(p.columnGap)}`)
  if (p.rowGap !== undefined) s.push(`row-gap:${space(p.rowGap, CELL_H / 2)}`)
  if (p.width !== undefined) s.push(`width:${size(p.width, CELL_W)}`)
  if (p.height !== undefined) s.push(`height:${size(p.height, row ? CELL_H / 2 : CELL_H / 2)}`)
  if (p.minWidth !== undefined) s.push(`min-width:${size(p.minWidth, CELL_W)}`)
  if (p.minHeight !== undefined) s.push(`min-height:${size(p.minHeight, CELL_H)}`)
  for (const [k, css] of [
    ['padding', 'padding'],
    ['paddingTop', 'padding-top'],
    ['paddingBottom', 'padding-bottom'],
    ['paddingLeft', 'padding-left'],
    ['paddingRight', 'padding-right'],
    ['margin', 'margin'],
    ['marginTop', 'margin-top'],
    ['marginBottom', 'margin-bottom'],
    ['marginLeft', 'margin-left'],
    ['marginRight', 'margin-right'],
  ]) {
    if (p[k] !== undefined) s.push(`${css}:${space(p[k], k.includes('Top') || k.includes('Bottom') ? CELL_H / 2 : CELL_W)}`)
  }
  if (p.paddingX !== undefined) s.push(`padding-left:${space(p.paddingX)}`, `padding-right:${space(p.paddingX)}`)
  if (p.paddingY !== undefined) s.push(`padding-top:${space(p.paddingY, CELL_H / 2)}`, `padding-bottom:${space(p.paddingY, CELL_H / 2)}`)
  if (p.marginX !== undefined) s.push(`margin-left:${space(p.marginX)}`, `margin-right:${space(p.marginX)}`)
  if (p.marginY !== undefined) s.push(`margin-top:${space(p.marginY, CELL_H / 2)}`, `margin-bottom:${space(p.marginY, CELL_H / 2)}`)
  if (p.borderStyle) {
    s.push(`border:1px ${p.borderStyle === 'dashed' ? 'dashed' : 'solid'} ${color(p.borderColor ?? '#3a3936')}`)
    s.push(`border-radius:${p.borderStyle === 'round' ? 10 : 4}px`)
  }
  if (p.backgroundColor) s.push(`background:${color(p.backgroundColor)}`)
  if (p.overflow === 'hidden') s.push('overflow:hidden')
  s.push('min-width:0')
  return s.join(';')
}

function textStyle(p) {
  const s = []
  if (p.color) s.push(`color:${color(p.color)}`)
  else if (p.dimColor) s.push(`color:${THEME.dim}`)
  if (p.backgroundColor) s.push(`background:${color(p.backgroundColor)};padding:0 4px;border-radius:4px`)
  if (p.size) s.push(`font-size:${SIZES[p.size]}px`)
  const w = p.weight ?? (p.bold ? 'semibold' : undefined)
  if (w) s.push(`font-weight:${WEIGHTS[w]}`)
  if (p.mono) s.push('font-family:ui-monospace,Consolas,monospace')
  if (p.tabular) s.push('font-variant-numeric:tabular-nums')
  if (p.italic) s.push('font-style:italic')
  const deco = [p.underline && 'underline', p.strikethrough && 'line-through'].filter(Boolean)
  if (deco.length) s.push(`text-decoration:${deco.join(' ')}`)
  if (p.inverse) s.push(`background:${THEME.text};color:${THEME.inverseText}`)
  // TextProps.wrap: the truncate modes keep one line and cut it with an ellipsis.
  if (typeof p.wrap === "string" && p.wrap.startsWith("truncate")) s.push("white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block")
  return s.join(';')
}

function node(n, parent) {
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return esc(n)
  const p = n.props ?? {}
  const kids = (n.children ?? []).map(k => node(k, n.type)).join('')
  switch (n.type) {
    case 'Box':
      return `<div class="box" style="${boxStyle(p)}">${kids}</div>`
    case 'Text': {
      const tag = parent === 'Box' || parent === undefined ? 'div' : 'span'
      const trunc = typeof p.wrap === 'string' && p.wrap.startsWith('truncate') ? ' trunc' : ''
      return `<${tag} class="text${trunc}" style="${textStyle(p)}">${kids}</${tag}>`
    }
    case 'Button': {
      const cls = p.variant === 'primary' ? 'btn primary' : p.plain ? 'btn plain' : 'btn'
      const dim = p.dimColor ? ' style="color:' + THEME.dim + '"' : ''
      return `<button class="${cls}"${dim}>${kids || esc(p.label ?? '')}</button>`
    }
    case 'Link':
      return `<a class="link" href="${esc(p.href)}">${kids || esc(p.label ?? p.href)}</a>`
    case 'Select': {
      const opt = (p.options ?? []).find(o => o.value === p.value) ?? (p.options ?? [])[0]
      return `<label class="select">${p.label ? `<span class="select-label">${esc(p.label)}</span>` : ''}<span class="select-box">${esc(opt?.label ?? opt?.value ?? '')}<span class="chev">▾</span></span></label>`
    }
    case 'Input':
      return `<input class="input" value="${esc(p.value ?? '')}" placeholder="${esc(p.placeholder ?? '')}">`
    case 'Markdown':
      return `<div class="md">${esc(p.text ?? '')}</div>`
    case 'Code':
      return `<pre class="code">${esc(p.source ?? '')}</pre>`
    case 'Svg':
      return `<div class="svg">${p.source ?? ''}</div>`
    default:
      return `<div style="outline:1px dashed red">${esc(n.type)}${kids}</div>`
  }
}

const paneWidth = name => (/narrow/.test(name) ? 38 * 7.8 + 44 : 480)
const page = (name, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>
*{box-sizing:border-box}
html,body{margin:0;background:#1a1a19;color:${THEME.text};font:14px/1.45 "Segoe UI",system-ui,sans-serif}
.pane{width:480px;border-left:1px solid #2e2d2b;min-height:100vh}
.chrome{display:flex;align-items:center;height:44px;padding:0 12px 0 24px;border-bottom:1px solid #2e2d2b;font-size:14px}
.chrome .t{flex:1}.chrome .i{color:${THEME.dim};margin-left:14px;font-size:16px}
.body{padding:16px 22px 24px 22px}
.text{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.btn{font:inherit;font-size:13.5px;color:${THEME.text};background:#33322f;border:1px solid #3d3c39;border-radius:8px;padding:3px 12px;line-height:20px;white-space:nowrap;cursor:pointer;flex-shrink:0}
.btn.primary{background:${THEME.text};color:#1a1a19;border-color:${THEME.text}}
.btn.plain{background:none;border:none;padding:0}
/* A plain Button is the documented list-row pattern: no chrome, body-size text, and it may shrink so a truncating Text inside it can cut. */
.btn.plain > .text:not(.trunc){flex-shrink:0}
.btn.plain{display:inline-flex;align-items:baseline;min-width:0;max-width:100%;flex-shrink:1;text-align:left;font-size:14px;line-height:inherit}
.link{color:${THEME.suggestion};text-decoration:none;white-space:nowrap;align-self:center}
.select{display:inline-flex;align-items:center;gap:6px;font-size:13.5px}
.select-label{color:${THEME.dim}}
.select-box{display:inline-flex;align-items:center;gap:8px;background:#262624;border:1px solid #3d3c39;border-radius:8px;padding:3px 10px;line-height:20px;white-space:nowrap}
.chev{color:${THEME.dim};font-size:11px}
.input{font:inherit;background:#262624;border:1px solid #3d3c39;border-radius:8px;color:${THEME.text};padding:4px 10px}
.trunc .text{white-space:inherit}
.svg{display:flex;min-width:0;max-width:100%}.svg svg{max-width:100%;height:auto}
.md{white-space:pre-wrap}.code{font-family:Consolas,monospace;background:#232321;padding:8px;border-radius:6px}
</style></head><body><div class="pane" style="width:${paneWidth(name)}px"><div class="chrome"><span class="t">Linear</span><span class="i">⤢</span><span class="i">✕</span></div><div class="body">${body}</div></div></body></html>`

const re = /@@(TREE|ERROR):([\w-]+)@@([\s\S]*?)@@END@@/g
const made = []
for (const [, kind, name, payload] of raw.matchAll(re)) {
  if (kind === 'ERROR') {
    writeFileSync(join(outDir, `${name}.error.txt`), payload)
    writeFileSync(join(outDir, `${name}.html`), page(name, `<div style="color:${THEME.error}">Render refused: ${esc(payload)}</div>`))
  } else {
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(JSON.parse(payload), null, 1))
    writeFileSync(join(outDir, `${name}.html`), page(name, node(JSON.parse(payload))))
  }
  made.push(name)
}
console.log(made.join('\n'))
