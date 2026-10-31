import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderChildren, ToolCallResult } from 'claude-code'

import type {
  CycleInfo,
  LinearIssue,
  Notice,
  PlanState,
  Snapshot,
  StageCount,
  Status,
} from '../types'

type Engine = EngineInterface

const PANE = 'linear-tasks'
const TITLE = 'Linear'
const DAY = 86_400_000
const REFRESH_MS = 5 * 60_000
// The folder choice that leaves the project for Claude to ask about.
const ASK = 'ask'
const PLAN_HEADING = '## Claude plan for'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const RANK: Record<string, number> = { triage: 0, backlog: 1, unstarted: 2, started: 3, completed: 4 }
const CLOSED = ['completed', 'canceled', 'duplicate']

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const snapshot = atom({ plugin: 'linear-tasks', key: 'snapshot' } as const, null as Snapshot | null, {
  shape: 'snap-1',
})
const status = atom({ plugin: 'linear-tasks', key: 'status' } as const, {
  isLoading: false,
  error: null,
} as Status)
const plans = atom({ plugin: 'linear-tasks', key: 'plans' } as const, {} as Record<string, PlanState>, {
  shape: 'plans-1',
})
const folders = atom({ plugin: 'linear-tasks', key: 'folders' } as const, {} as Record<string, string>)
const projects = atom({ plugin: 'linear-tasks', key: 'projects' } as const, [] as string[])
const stageView = atom({ plugin: 'linear-tasks', key: 'stageView' } as const, 'mine' as 'mine' | 'team')
const dismissed = atom({ plugin: 'linear-tasks', key: 'dismissed' } as const, [] as string[])
// Which rows show their details (folder, links, secondary actions). UI only.
const expanded = atom({ plugin: 'linear-tasks', key: 'expanded' } as const, [] as string[])
// Whether the pane is open, for the toggle above the prompt. UI only.
const paneOpen = atom({ plugin: 'linear-tasks', key: 'paneOpen' } as const, false)

// The Linear connector, how it is reached, and who is signed in there. A
// connector the desktop app hosts is not one `$.mcp.call` can dial, so `tool`
// mode calls its tools as the model does, by their full names.
let server: string | null = null
let mode: 'mcp' | 'tool' = 'mcp'
let me: { id: string; teams: { id: string }[] } | null = null
let inflight: Promise<void> | null = null
let projectsRoot = ''

// The Linear tools the panel reads outside a chat turn, where auto mode needs
// an allow rule for each.
const READS = ['get_user', 'list_issues', 'get_issue', 'list_cycles', 'list_issue_statuses', 'get_notifications']

// The error for a refused read: a first line, then one allow rule per line.
function allowRules(prefix: string) {
  return ['Linear needs allow rules.', ...READS.map(tool => `mcp__${prefix}__${tool}`)].join('\n')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function linear($: Engine, tool: string, args: Record<string, unknown>): Promise<any> {
  if (!server) throw new Error('Linear is not connected')
  let text: string
  if (mode === 'tool') {
    // The tool's name is only known at run time, so the call is typed loosely.
    const input = { tool: `mcp__${server}__${tool}`, ...args }
    // The generated table of every connected MCP tool is too large for tsc to
    // instantiate `$.tool.call` against (TS2589); the call is typed by hand here.
    // @ts-ignore
    const result = (await $.tool.call(input as never)) as unknown as ToolCallResult
    if (result.deny !== undefined) throw new Error(`${tool}: refused: ${result.deny}`)
    text = result.text ?? ''
    if (result.isError) throw new Error(`${tool}: ${text.slice(0, 200)}`)
  } else {
    const result = await $.mcp.call(server, tool, args)
    text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    if (result.isError) throw new Error(`${tool}: ${text.slice(0, 200)}`)
  }

  return JSON.parse(text)
}

async function connect($: Engine): Promise<string | null> {
  const tools = await $.tool.list().catch(() => [])
  const found = tools
    .map(tool => tool.name)
    .filter(name => name.startsWith('mcp__') && name.endsWith('__list_cycles'))
    .map(name => name.slice('mcp__'.length, -'__list_cycles'.length))
  const cached = await $.store.get('server')
  const named = [...new Set([...(typeof cached === 'string' ? [cached] : []), ...found, 'claude.ai Linear', 'Linear'])]
  const attempts: { server: string; mode: 'mcp' | 'tool' }[] = [
    ...named.map(name => ({ server: name, mode: 'mcp' as const })),
    ...found.map(name => ({ server: name, mode: 'tool' as const })),
  ]
  const failures: string[] = []
  let refused: string | null = null
  for (const attempt of attempts) {
    server = attempt.server
    mode = attempt.mode
    try {
      const user = await linear($, 'get_user', { query: 'me' })
      if (user?.id) {
        me = { id: user.id, teams: user.teams ?? [] }
        await $.store.set('server', attempt.server)

        return null
      }
      failures.push(`${attempt.mode} ${attempt.server}: no user`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The connector answered but the permission check said no.
      if (/ refused: /.test(message)) refused ??= attempt.server
      failures.push(`${attempt.mode} ${attempt.server}: ${message}`.slice(0, 160))
    }
  }
  server = null

  if (found.length === 0) return "Linear isn't connected in this session. Connect it with /mcp, then press Refresh."
  if (refused) return allowRules(refused)

  return `Couldn't reach Linear. ${failures.join(' · ')}`
}

function stages(statuses: { name: string; type: string }[], issues: { status: string; statusType: string }[]) {
  const list: StageCount[] = statuses
    .filter(s => s.type in RANK)
    .map(s => ({ name: s.name, type: s.type, count: 0 }))
  for (const issue of issues) {
    let stage = list.find(s => s.name === issue.status)
    if (!stage && issue.statusType in RANK) {
      stage = { name: issue.status, type: issue.statusType, count: 0 }
      list.push(stage)
    }
    if (stage) stage.count += 1
  }

  return list.sort((a, b) => (RANK[a.type] ?? 0) - (RANK[b.type] ?? 0) || a.name.localeCompare(b.name))
}

function refresh($: Engine): Promise<void> {
  inflight ??= load($).finally(() => {
    inflight = null
  })

  return inflight
}

async function load($: Engine) {
  await update($, status, s => ({ ...s, isLoading: true }))
  try {
    if (!me) {
      const failure = await connect($)
      if (failure) throw new Error(failure)
    }
    const user = me!
    const mine = await linear($, 'list_issues', {
      assignee: 'me',
      limit: 250,
      fields: ['id', 'title', 'status', 'statusType', 'priority', 'url', 'gitBranchName', 'project'],
    })
    const all: { id: string; status: string; statusType: string }[] = mine.issues ?? []
    const done = new Set(all.filter(i => CLOSED.includes(i.statusType)).map(i => i.id))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const open: any[] = (mine.issues ?? []).filter((i: { statusType: string }) => !CLOSED.includes(i.statusType))
    const relations = await Promise.all(
      open.map(i => linear($, 'get_issue', { id: i.id, fields: ['id', 'relations'] }).catch(() => null)),
    )
    const issues: LinearIssue[] = open.map((i, n) => {
      const rel = relations[n]?.relations ?? {}

      return {
        id: i.id,
        title: i.title,
        status: i.status,
        statusType: i.statusType,
        priority: i.priority?.value ?? 0,
        priorityName: i.priority?.name ?? '',
        url: i.url,
        branch: i.gitBranchName ?? '',
        project: i.project ?? null,
        blocks: (rel.blocks ?? [])
          .filter((b: { id: string }) => !done.has(b.id))
          .map((b: { id: string; title: string }) => ({ id: b.id, title: b.title })),
        blockedBy: (rel.blockedBy ?? []).map((b: { id: string }) => b.id).filter((id: string) => !done.has(id)),
      }
    })

    const team = user.teams[0]
    const statuses = team ? await linear($, 'list_issue_statuses', { team: team.id }).catch(() => []) : []
    let cycle: CycleInfo | null = null
    let stagesTeam: StageCount[] = []
    for (const t of user.teams) {
      const cycles = await linear($, 'list_cycles', { teamId: t.id, type: 'current' }).catch(() => [])
      const current = Array.isArray(cycles) ? cycles[0] : null
      if (!current) continue
      const res = await linear($, 'list_issues', {
        team: t.id,
        cycle: String(current.number),
        limit: 250,
        fields: ['id', 'status', 'statusType', 'assigneeId'],
      })
      const inCycle: { status: string; statusType: string; assigneeId: string | null }[] = res.issues ?? []
      const ours = inCycle.filter(i => i.assigneeId === user.id)
      cycle = {
        number: current.number,
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        teamTotal: inCycle.length,
        teamDone: inCycle.filter(i => i.statusType === 'completed').length,
        mineTotal: ours.length,
        mineDone: ours.filter(i => i.statusType === 'completed').length,
      }
      stagesTeam = stages(statuses, inCycle)
      break
    }

    const now = await $.clock.now()
    const inbox = await linear($, 'get_notifications', { unreadOnly: true, limit: 50 }).catch(() => null)
    const notices: Notice[] = []
    for (const n of inbox?.notifications ?? []) {
      const issueId = /\/issue\/([A-Za-z]+-\d+)/.exec(n.url ?? '')?.[1]
      const snoozed = n.snoozedUntilAt && Date.parse(n.snoozedUntilAt) > now
      if (!issueId || n.archivedAt || snoozed) continue
      notices.push({ id: n.id, issueId, title: n.title ?? '', detail: n.subtitle ?? '', url: n.url })
    }

    if (projectsRoot) {
      const entries = await $.fs.list(projectsRoot).catch(() => [])
      const dirs = entries.filter(d => d.kind === 'dir' && !d.name.startsWith('.')).map(d => d.name)
      await update($, projects, () => dirs.sort((a, b) => a.localeCompare(b)))
    }

    await update($, snapshot, () => ({
      fetchedAt: now,
      issues,
      doneCount: done.size,
      cycle,
      notices,
      stagesMine: stages(statuses, all),
      stagesTeam,
    }))
    await update($, status, () => ({ isLoading: false, error: null }))
  } catch (err) {
    me = null
    let message = err instanceof Error ? err.message : String(err)
    // A later read refused after `get_user` was allowed: some rules are missing.
    if (server && / refused: /.test(message)) message = allowRules(server)
    await update($, status, () => ({ isLoading: false, error: message }))
  }
}

async function loadStored($: Engine) {
  const stored = {
    plans: await $.store.get('plans'),
    folders: await $.store.get('folders'),
    dismissed: await $.store.get('dismissed'),
  }
  if (stored.plans && typeof stored.plans === 'object') {
    await update($, plans, () => stored.plans as Record<string, PlanState>)
  }
  if (stored.folders && typeof stored.folders === 'object') {
    await update($, folders, () => stored.folders as Record<string, string>)
  }
  if (Array.isArray(stored.dismissed)) await update($, dismissed, () => stored.dismissed as string[])
}

async function setPlan($: Engine, id: string, state: PlanState | null) {
  const next = await update($, plans, p => {
    const copy = { ...p }
    if (state) copy[id] = state
    else delete copy[id]

    return copy
  })
  await $.store.set('plans', next)
}

async function folderOf($: Engine, id: string): Promise<string | null> {
  const name = (await read($, folders))[id]

  return name && name !== ASK && projectsRoot ? `${projectsRoot}/${name}` : null
}

function where(folder: string | null) {
  return folder
    ? `The code for this issue lives in ${folder}. Work there, using absolute paths.`
    : 'I have not said which local project folder this issue belongs to: ask me before exploring any code.'
}

function planPrompt(issue: LinearIssue, folder: string | null) {
  return [
    `Create an implementation plan for Linear issue ${issue.id}: "${issue.title}".`,
    '',
    `1. Read the issue with the Linear tools: its description, comments and relations.`,
    `2. ${where(folder)} Explore it read-only to ground the plan.`,
    '3. Write a concrete, step-by-step plan: the files to change, the approach, risks, and how to test it.',
    `4. Post the plan as a comment on ${issue.id} with save_comment. The comment's first line must be "${PLAN_HEADING} ${issue.id}".`,
    '',
    'This is planning only: do not change any code or any field of the issue.',
  ].join('\n')
}

function implementPrompt(issue: LinearIssue, folder: string | null) {
  return [
    `Implement the plan for Linear issue ${issue.id}: "${issue.title}".`,
    '',
    `1. Read the latest comment on ${issue.id} whose first line is "${PLAN_HEADING} ${issue.id}". If there is none, stop and tell me.`,
    `2. ${where(folder)}${issue.branch ? ` If it is a git repository, work on the branch \`${issue.branch}\`, creating it from the default branch if needed.` : ''}`,
    "3. Implement the plan step by step, then run the project's tests or checks.",
    '4. Report what changed, the test results, and anything left.',
    '',
    'Do not push, open a pull request, or change the Linear issue without asking me first.',
  ].join('\n')
}

function noticePrompt(n: Notice) {
  return [
    `A Linear notification on ${n.issueId} ("${n.title}") is waiting on me: ${n.detail}`,
    '',
    "Read the issue and its latest comments, then tell me what's being asked of me and what I should do next.",
    'Do not post anything to Linear.',
  ].join('\n')
}

async function startPlan($: Engine, issue: LinearIssue) {
  await setPlan($, issue.id, { phase: 'planning', since: await $.clock.now() })
  await $.prompt.submit({ text: planPrompt(issue, await folderOf($, issue.id)) })
}

async function startImplement($: Engine, issue: LinearIssue) {
  await setPlan($, issue.id, { phase: 'implementing', since: await $.clock.now() })
  await $.prompt.submit({ text: implementPrompt(issue, await folderOf($, issue.id)) })
}

async function dismiss($: Engine, id: string) {
  const next = await update($, dismissed, list => [...list, id].slice(-200))
  await $.store.set('dismissed', next)
}

async function pickFolder($: Engine, id: string, value: string) {
  const next = await update($, folders, map => ({ ...map, [id]: value }))
  await $.store.set('folders', next)
}

function ago(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  return `${Math.floor(minutes / 60)}h ago`
}

function day(ms: number) {
  const date = new Date(ms)

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

function stageColor(stage: StageCount): Color {
  if (stage.type === 'completed') return 'success'
  // Amber is kept for warnings (pace, blocking); work under way is a calm blue.
  if (stage.type === 'started') return /review/i.test(stage.name) ? 'merged' : 'suggestion'
  if (stage.type === 'unstarted') return 'subtle'
  if (stage.type === 'triage') return 'subtle'

  return 'inactive'
}

function byQueue(a: LinearIssue, b: LinearIssue) {
  const blocked = Number(a.blockedBy.length > 0) - Number(b.blockedBy.length > 0)
  const rank = (RANK[b.statusType] ?? 0) - (RANK[a.statusType] ?? 0)
  // Priority 0 is "none": it sorts after Low (4).
  const priority = (a.priority || 5) - (b.priority || 5)

  return blocked || rank || priority || a.id.localeCompare(b.id)
}

// Drawing helpers (pure).

// Approximate CSS pixels per character cell on the graphical surfaces; an Svg
// wider than its slot is scaled down to it, so this only needs to be close.
const CELL_PX = 7.8
// An Svg is drawn as an image and cannot follow the theme, so its colors are
// mid tones that read on both a dark and a light background.
const HEX: Record<string, string> = {
  success: '#5fae64',
  warning: '#d99a3a',
  merged: '#9b7ff0',
  subtle: '#8b8984',
  suggestion: '#6f97ec',
  inactive: '#6b6a66',
}
const TRACK = '<rect x="0" y="5" width="W" height="6" rx="3" fill="#8b8984" fill-opacity="0.28"/>'

function stageGlyph(type: string) {
  if (type === 'completed') return '●'
  if (type === 'started') return '◐'
  if (type === 'unstarted') return '○'
  if (type === 'triage') return '◇'

  return '◌'
}

// A thin progress bar, `share` of it filled.
function meterSvg(cells: number, share: number) {
  const w = Math.max(40, Math.round(cells * CELL_PX))
  const fill = Math.round(w * Math.min(1, Math.max(0, share)))
  const parts = [TRACK.replace('W', String(w))]
  if (fill > 0) parts.push(`<rect x="0" y="5" width="${Math.max(6, fill)}" height="6" rx="3" fill="${HEX.success}"/>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="16" viewBox="0 0 ${w} 16">${parts.join('')}</svg>`
}

// Cut a text to `max` characters at a word, with an ellipsis.
function clip(text: string, max: number) {
  if (text.length <= max) return text
  const cut = text.slice(0, Math.max(1, max - 1))
  const space = cut.lastIndexOf(' ')

  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, '')}…`
}

// "Alex Kim commented: Updated, needs a second look" → the author by first name,
// then the words quoted, the whole held to `max` characters. The longest
// form that keeps the quote whole wins: "Alex commented: …", then "Alex: …";
// when neither fits, the quote is cut at a word.
function quoteNotice(detail: string, max: number) {
  const at = detail.indexOf(': ')
  const words = at > 0 && at <= 60 ? detail.slice(at + 2).trim().replace(/^["“]|["”]$/g, '') : ''
  if (!words) return clip(detail, max)
  const who = detail.slice(0, at).trim()
  const first = who.split(/\s+/)[0] ?? who
  const verb = /\s(commented|replied|mentioned you|reacted)\b/i.exec(who)?.[1]
  const forms = verb ? [`${first} ${verb}`, first] : [first]
  for (const form of forms) {
    const line = `${form}: “${words}”`
    if (line.length <= max) return line
  }

  return `${first}: “${clip(words, Math.max(8, max - first.length - 4))}”`
}

// One bar split into the stages' shares, a small gap between them.
function stackSvg(cells: number, segments: { value: number; color: string }[]) {
  const w = Math.max(40, Math.round(cells * CELL_PX))
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1
  const shown = segments.filter(s => s.value > 0)
  const gap = 2
  const room = w - gap * Math.max(0, shown.length - 1)
  let x = 0
  const rects = shown.map(s => {
    const width = Math.max(3, Math.round((s.value / total) * room))
    const rect = `<rect x="${x}" y="2" width="${Math.min(width, w - x)}" height="8" rx="2" fill="${HEX[s.color] ?? HEX.subtle}"/>`
    x += width + gap

    return rect
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="12" viewBox="0 0 ${w} 12">${rects.join('')}</svg>`
}

// The status error, split into a calm title, what to do, the raw detail (one
// line per row), and what Copy puts on the clipboard, if anything.
function explain(error: string): { title: string; body: string; detail: string; copy: string } {
  if (/^Linear isn't connected/.test(error)) {
    return { title: "Linear isn't connected", body: error.replace(/^[^.]*\.\s*/, ''), detail: '', copy: '' }
  }
  if (/^Linear needs allow rules/.test(error)) {
    const rules = error.split('\n').slice(1)

    return {
      title: "Allow the panel's Linear reads",
      body: 'The panel reads Linear outside a chat turn, so auto mode needs an allow rule for each read. Add these to permissions.allow in ~/.claude/settings.json, then press Refresh.',
      detail: rules.join('\n'),
      copy: rules.map(rule => `"${rule}"`).join(',\n'),
    }
  }
  if (/^Couldn't reach Linear/.test(error)) {
    return {
      title: "Couldn't reach Linear",
      body: 'Check the Linear connector with /mcp, then press Refresh.',
      detail: error.replace(/^Couldn't reach Linear\.\s*/, ''),
      copy: '',
    }
  }

  return { title: "Couldn't load your issues", body: 'Press Refresh to try again.', detail: error, copy: '' }
}

// What Needs you counts: unhidden notices, issues blocking others, plans ready.
function needCount(snap: Snapshot, planMap: Record<string, PlanState>, gone: string[]) {
  const notices = snap.notices.filter(n => !gone.includes(n.id)).length
  const flagged = snap.issues.filter(i => i.blocks.length > 0 || planMap[i.id]?.phase === 'planned').length

  return notices + flagged
}

async function openPane($: Engine) {
  await $.ui.open({ id: PANE, title: TITLE, columns: 60 })
  await update($, paneOpen, () => true)
  $.clock.after(1, () => void refresh($))
}

// Opens the pane, or closes it when it is already open. Returns whether it is open now.
async function togglePane($: Engine): Promise<boolean> {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isUp) {
    await openPane($)

    return true
  }
  await $.ui.close({ id: PANE })
  // The plugin's own close skips its own `ui.close` hook, so set the label here.
  await update($, paneOpen, () => false)

  return false
}

export const register: Register = (on, options) => {
  projectsRoot = String(options.projectsRoot ?? '').replace(/[\\/]+$/, '')

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'linear', description: 'Show or hide your Linear tasks panel' })
    await loadStored($)
    // The pane stays closed until the toggle or /linear opens it; a first load
    // still runs so the toggle can say what needs you.
    $.clock.after(1, () => void refresh($))
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'linear' }, async $ => {
    const isOpen = await togglePane($)

    return { text: isOpen ? 'Linear panel opened.' : 'Linear panel closed.' }
  })

  // Keeps the toggle's label right when the pane closes by any route (its ✕ too).
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, paneOpen, () => false)

    return result
  })

  // A one-click toggle above the prompt, with what needs you.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Button, Text } = $.ui.resolve(e)
    const isOpen = await read($, paneOpen)
    const snap = await read($, snapshot)
    const needs = snap ? needCount(snap, await read($, plans), await read($, dismissed)) : 0

    return (
      <Button key="linear-toggle" plain onPress={() => void togglePane($)}>
        {isOpen ? 'Hide Linear' : 'Show Linear'}
        {needs > 0 ? <Text color="warning"> · {needs === 1 ? '1 needs you' : `${needs} need you`}</Text> : ''}
      </Button>
    )
  })

  // A plan comment Claude posts moves its issue to "plan ready".
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!String(e.tool).endsWith('__save_comment')) return result
    const body = (e as Record<string, unknown>).body
    const planned = typeof body === 'string' ? /^##\s*Claude plan for ([A-Za-z]+-\d+)/m.exec(body)?.[1] : undefined
    if (planned && !(result as { isError?: boolean }).isError) {
      const id = planned.toUpperCase()
      await setPlan($, id, { phase: 'planned', since: await $.clock.now() })
      void $.ui.toast(`Plan for ${id} is ready`)
    }

    return result
  }).catch(($, e, next) => next(e))

  // A turn the panel started that ends without a plan clears its "planning"
  // mark; an implementing run returns to "plan ready".
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const now = await $.clock.now()
    const startedAt = now - e.durationMs
    const current = await read($, plans)
    let isChanged = false
    for (const [id, state] of Object.entries(current)) {
      if (state.since > startedAt) continue
      if (state.phase === 'planning') {
        await setPlan($, id, null)
        isChanged = true
      } else if (state.phase === 'implementing') {
        await setPlan($, id, { phase: 'planned', since: now })
        isChanged = true
      }
    }
    if (isChanged) $.clock.after(1, () => void refresh($))

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const Select = 'Select' in els ? els.Select : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
    const columns = e.props.bodyColumns ?? 40
    // Below this width labels get shorter; the layout stays the same.
    const isNarrow = columns < 46

    const snap = await read($, snapshot)
    const st = await read($, status)
    const planMap = await read($, plans)
    const folderMap = await read($, folders)
    const dirs = await read($, projects)
    const view = await read($, stageView)
    const gone = await read($, dismissed)
    const open = await read($, expanded)
    const now = await $.clock.now()

    // How long a run the panel started has been going, at minute precision.
    const since = (at: number) => {
      const minutes = Math.floor((now - at) / 60_000)
      if (minutes < 1) return ''

      return minutes < 60 ? ` ${minutes}m` : ` ${Math.floor(minutes / 60)}h`
    }

    const toggle = (key: string) =>
      void update($, expanded, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))

    // Quiet, but reads as a control; while a refresh runs the slot says so.
    const refreshControl = st.isLoading ? (
      <Text dimColor>Refreshing…</Text>
    ) : (
      <Button key="refresh" plain label="↻ Refresh" onPress={() => void refresh($)} />
    )

    // Not loaded yet: a calm message, and the way out when it failed.
    if (!snap) {
      if (!st.error) {
        return (
          <Box flexDirection="row" alignItems="center" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor>Loading your Linear issues…</Text>
            </Box>
            {!st.isLoading && refreshControl}
          </Box>
        )
      }
      const why = explain(st.error)

      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">{why.title}</Text>
          <Text dimColor>{why.body}</Text>
          {why.detail !== '' && (
            <Box flexDirection="column">
              {why.detail.split('\n').map(line => (
                <Text key={line} dimColor size="caption">
                  {line}
                </Text>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            {st.isLoading ? (
              <Text dimColor>Refreshing…</Text>
            ) : (
              <Button key="refresh" label="↻ Refresh" onPress={() => void refresh($)} />
            )}
            {why.copy !== '' && (
              <Button key="copy-rules" label="Copy rules" onPress={() => void $.ui.copy({ text: why.copy, surface: e.surface })} />
            )}
          </Box>
        </Box>
      )
    }

    // A thin bar: Svg where the surface has it, block characters on the terminal.
    const meterBar = (share: number, alt: string) => {
      if (Svg) return <Svg source={meterSvg(columns, share)} alt={alt} />
      const width = Math.max(6, columns - 2)
      const filled = Math.round(width * Math.min(1, Math.max(0, share)))

      return (
        <Text>
          <Text color="success">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)}</Text>
        </Text>
      )
    }

    const heading = (label: string, count: number | null, right: RenderChildren = null) => (
      <Box flexDirection="row" alignItems="center" gap={2}>
        <Box flexGrow={1}>
          <Text weight="semibold">
            {label}
            {count !== null && <Text dimColor weight="regular">{`  ${count}`}</Text>}
          </Text>
        </Box>
        {right}
      </Box>
    )

    // One row shape for both lists: the title line is the row's own Button
    // (it opens the details), a caption under it, and one action on the right.
    const row = (spec: {
      key: string
      title: string
      isDim?: boolean
      line: RenderChildren
      action: RenderChildren
      details: RenderChildren
    }) => {
      const isOpen = open.includes(spec.key)

      return (
        <Box flexDirection="row" gap={2} alignItems="flex-start">
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row">
              <Button key={`more:${spec.key}`} plain onPress={() => toggle(spec.key)}>
                <Text dimColor={spec.isDim} wrap="truncate-end">
                  {spec.title}
                </Text>
                <Text dimColor>{isOpen ? ' ▾' : ' ▸'}</Text>
              </Button>
            </Box>
            {spec.line}
            {isOpen && (
              <Box flexDirection="column" gap={1} paddingTop={1} paddingLeft={2}>
                {spec.details}
              </Box>
            )}
          </Box>
          <Box flexShrink={0}>{spec.action}</Box>
        </Box>
      )
    }

    // Needs you: a boxed button, the action is urgent there. Up next: a quiet
    // one in the same slot, as are the planning and implementing states.
    // A quiet action is inset by a boxed button's own padding, so the labels
    // of both kinds end on one edge.
    const inset = (node: RenderChildren) => (
      <Box paddingRight={e.surface === 'terminal' ? 2 : 'md'}>{node}</Box>
    )
    const action = (issue: LinearIssue, isQuiet: boolean): RenderChildren => {
      const plan = planMap[issue.id]
      if (plan?.phase === 'planning') return inset(<Text dimColor>{`Planning…${since(plan.since)}`}</Text>)
      if (plan?.phase === 'implementing') return inset(<Text dimColor>{`Implementing…${since(plan.since)}`}</Text>)
      if (plan?.phase === 'planned') {
        const button = (
          <Button
            key={`impl:${issue.id}`}
            label={isNarrow ? 'Implement' : 'Implement plan'}
            variant={isQuiet ? undefined : 'primary'}
            plain={isQuiet || undefined}
            dimColor={isQuiet || undefined}
            onPress={() => void startImplement($, issue)}
          />
        )

        return isQuiet ? inset(button) : button
      }
      const button = (
        <Button
          key={`plan:${issue.id}`}
          label={isNarrow ? 'Plan' : 'Create plan'}
          plain={isQuiet || undefined}
          dimColor={isQuiet || undefined}
          onPress={() => void startPlan($, issue)}
        />
      )

      return isQuiet ? inset(button) : button
    }

    const folderPicker = (issue: LinearIssue) => {
      const value = folderMap[issue.id] ?? ASK
      const names = dirs.includes(value) || value === ASK ? dirs : [value, ...dirs]
      if (!Select) {
        return <Text dimColor>{value === ASK ? 'Folder: Claude will ask' : `Folder: ${value}`}</Text>
      }

      return (
        <Select
          key={`folder:${issue.id}`}
          label="Folder"
          value={value}
          options={[{ value: ASK, label: 'Let Claude ask' }, ...names.map(name => ({ value: name, label: name }))]}
          onSelect={picked => void pickFolder($, issue.id, picked)}
        />
      )
    }

    // Secondary actions in details share one look: Linear opens as a link, an
    // in-app action is a plain Button drawn in the same link color.
    const linkish = (key: string, label: string, onPress: () => void) => (
      <Button key={key} plain onPress={onPress}>
        <Text color="suggestion">{label}</Text>
      </Button>
    )
    const detailActions = (items: RenderChildren) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={3} alignItems="center">
        {items}
      </Box>
    )

    const details = (issue: LinearIssue) => {
      const isPlanned = planMap[issue.id]?.phase === 'planned'

      return (
        <Box flexDirection="column" gap={1}>
          {folderPicker(issue)}
          {detailActions([
            <Link href={issue.url} label={isPlanned ? 'Review plan in Linear ↗' : 'Open in Linear ↗'} />,
            isPlanned && linkish(`plan:${issue.id}`, 'Plan again', () => void startPlan($, issue)),
          ])}
        </Box>
      )
    }

    // Every caption reads: reason or status · priority · project · id.
    const sep = <Text dimColor> · </Text>
    // Non-breaking spaces keep the id on the line of the word before it.
    const idTail = (id: string) => <Text dimColor>{`\u00a0·\u00a0${id}`}</Text>
    const meta = (issue: LinearIssue) => {
      const isBlocked = issue.blockedBy.length > 0

      return (
        <Text size="caption" wrap="truncate-end">
          {isBlocked && <Text color="warning">Blocked by {issue.blockedBy.join(', ')}</Text>}
          {isBlocked && sep}
          <Text color={stageColor({ name: issue.status, type: issue.statusType, count: 0 })}>
            {stageGlyph(issue.statusType)}
          </Text>
          <Text dimColor> {issue.status}</Text>
          {issue.priority > 0 && (
            <Text color={issue.priority === 1 ? 'error' : undefined} dimColor={issue.priority > 2}>
              {` · ${issue.priorityName}`}
            </Text>
          )}
          {issue.project && <Text dimColor> · {issue.project}</Text>}
          {idTail(issue.id)}
        </Text>
      )
    }

    // Cycle
    const c = snap.cycle
    let cycleSection = (
      <Box flexDirection="row" alignItems="center" gap={2}>
        <Box flexGrow={1}>
          <Text dimColor>No active cycle</Text>
        </Box>
        {refreshControl}
      </Box>
    )
    if (c) {
      const start = Date.parse(c.startsAt)
      const end = Date.parse(c.endsAt)
      const totalDays = Math.max(1, Math.round((end - start) / DAY))
      const dayOf = Math.min(totalDays, Math.max(1, Math.floor((now - start) / DAY) + 1))
      const left = Math.max(0, Math.ceil((end - now) / DAY))
      const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)))
      // What an even pace would have done by now.
      const due = (total: number) => Math.round(total * elapsed)
      // Pace is judged on your own cycle issues, or the team's when you have none.
      const isBehind = c.mineTotal ? c.mineDone < due(c.mineTotal) : c.teamDone < due(c.teamTotal)
      const meter = (label: string, done: number, total: number) => (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={2}>
            <Box flexGrow={1}>
              <Text dimColor>{label}</Text>
            </Box>
            <Text tabular>
              {done} of {total} done
              <Text dimColor>{` · ${due(total)} due by now`}</Text>
            </Text>
          </Box>
          {meterBar(total ? done / total : 0, `${label}: ${done} of ${total} done, ${due(total)} due by now`)}
        </Box>
      )
      // Linear's cycle bounds sit at midnight; half a day in reads the right date anywhere.
      cycleSection = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection="row" alignItems="center" gap={2}>
              <Text size="heading" weight="semibold">
                Cycle {c.number}
              </Text>
              <Box flexGrow={1}>
                <Text dimColor>
                  {day(start + DAY / 2)} – {day(end - DAY / 2)}
                </Text>
              </Box>
              {refreshControl}
            </Box>
            <Box flexDirection="row" alignItems="center" gap={2}>
              <Box flexGrow={1}>
                <Text>
                  <Text weight="medium">{left === 1 ? '1 day left' : `${left} days left`}</Text>
                  {!isNarrow && <Text dimColor>{` · day ${dayOf} of ${totalDays}`}</Text>}
                </Text>
              </Box>
              {isBehind ? <Text color="warning">▲ Behind pace</Text> : <Text color="success">✓ On track</Text>}
            </Box>
          </Box>
          <Box flexDirection="column" gap={1}>
            {meter('You', c.mineDone, c.mineTotal)}
            {meter('Team', c.teamDone, c.teamTotal)}
          </Box>
        </Box>
      )
    }

    // A failed refresh over loaded data: say so quietly, keep showing the data.
    const staleNote = st.error ? (
      <Box flexDirection="row" gap={1}>
        <Text color="warning">▲</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text>{`Couldn't refresh. Last updated ${ago(now - snap.fetchedAt)}.`}</Text>
          <Text dimColor size="caption" wrap="truncate-end">
            {st.error}
          </Text>
        </Box>
      </Box>
    ) : null

    // Needs you: what someone (or Claude) is waiting on. Each issue shows once:
    // those listed here are left out of Up next.
    const notices = snap.notices.filter(n => !gone.includes(n.id))
    const flagged = snap.issues.filter(i => i.blocks.length > 0 || planMap[i.id]?.phase === 'planned')
    const flaggedIds = new Set(flagged.map(i => i.id))
    const needCount = notices.length + flagged.length
    // A notice may take two caption lines beside its button. The cells left of
    // "Ask Claude" hold about 1.15 caption characters each; its id takes the rest.
    const noticeRoom = (n: Notice) => Math.max(24, Math.floor(2 * (columns - 14) * 1.15) - n.issueId.length - 4)
    const needs = (
      <Box flexDirection="column" gap={1}>
        {heading('Needs you', needCount)}
        {needCount === 0 && <Text dimColor>Nothing is waiting on you.</Text>}
        {notices.map(n =>
          row({
            key: `notice:${n.id}`,
            title: n.title,
            line: (
              <Text size="caption">
                <Text dimColor>{quoteNotice(n.detail, noticeRoom(n))}</Text>
                {idTail(n.issueId)}
              </Text>
            ),
            action: (
              <Button key={`ask:${n.id}`} label="Ask Claude" onPress={() => void $.prompt.submit({ text: noticePrompt(n) })} />
            ),
            details: detailActions([
              <Link href={n.url} label="Open in Linear ↗" />,
              linkish(`dismiss:${n.id}`, 'Hide', () => void dismiss($, n.id)),
            ]),
          }),
        )}
        {flagged.map(issue => {
          const isPlanned = planMap[issue.id]?.phase === 'planned'
          const blocks = issue.blocks.map(b => b.id).join(', ')
          const firstTitle = issue.blocks.length === 1 ? issue.blocks[0]!.title : ''

          return row({
            key: issue.id,
            title: issue.title,
            line: (
              <Text size="caption" wrap="truncate-end">
                {isPlanned && <Text color="success">✓ Plan ready to review</Text>}
                {isPlanned && issue.blocks.length > 0 && sep}
                {issue.blocks.length > 0 && <Text color="warning">Blocking {blocks}</Text>}
                {firstTitle !== '' && <Text dimColor> {firstTitle}</Text>}
                {idTail(issue.id)}
              </Text>
            ),
            action: action(issue, false),
            details: details(issue),
          })
        })}
      </Box>
    )

    // Up next
    const queue = snap.issues.filter(i => !flaggedIds.has(i.id)).sort(byQueue)
    const work = (
      <Box flexDirection="column" gap={1}>
        {heading('Up next', queue.length)}
        {queue.length === 0 && <Text dimColor>Nothing else is assigned to you.</Text>}
        {queue.map(issue =>
          row({
            key: issue.id,
            title: issue.title,
            isDim: issue.blockedBy.length > 0,
            line: meta(issue),
            action: action(issue, true),
            details: details(issue),
          }),
        )}
      </Box>
    )

    // By stage
    const stageList = (view === 'mine' ? snap.stagesMine : snap.stagesTeam).filter(s => s.count > 0)
    const stageTotal = stageList.reduce((sum, s) => sum + s.count, 0)
    const tab = (key: string, label: string, isOn: boolean, value: 'mine' | 'team') => (
      <Button key={key} plain dimColor={!isOn} onPress={() => void update($, stageView, () => value)}>
        <Text weight={isOn ? 'semibold' : 'regular'}>{label}</Text>
      </Button>
    )
    const perRow = columns >= 54 ? 3 : 2
    const byStage = (
      <Box flexDirection="column" gap={1}>
        {heading(
          'By stage',
          null,
          <Box flexDirection="row" gap={2}>
            {tab('view:mine', 'Yours', view === 'mine', 'mine')}
            {tab('view:team', 'Team cycle', view === 'team', 'team')}
          </Box>,
        )}
        {stageTotal === 0 ? (
          <Text dimColor>{view === 'team' ? 'No active cycle for the team.' : 'No issues yet.'}</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {Svg ? (
              <Svg
                source={stackSvg(columns, stageList.map(s => ({ value: s.count, color: String(stageColor(s)) })))}
                alt={stageList.map(s => `${s.name} ${s.count}`).join(', ')}
              />
            ) : (
              <Text>
                {stageList.map(s => (
                  <Text color={stageColor(s)}>{'█'.repeat(Math.max(1, Math.round((s.count / stageTotal) * (columns - 2))))}</Text>
                ))}
              </Text>
            )}
            <Box flexDirection="row" flexWrap="wrap">
              {stageList.map(s => (
                <Box width={Math.floor((columns - 2) / perRow)}>
                  <Text size="caption">
                    <Text color={stageColor(s)}>{stageGlyph(s.type)}</Text>
                    <Text dimColor> {s.name} </Text>
                    <Text weight="medium" tabular>
                      {s.count}
                    </Text>
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    )

    const footer = (
      <Text dimColor size="caption">
        {snap.issues.length} open
        {snap.doneCount > 0 ? ` · ${snap.doneCount} closed not shown` : ''}
        {` · updated ${ago(now - snap.fetchedAt)}`}
      </Text>
    )

    return (
      <Box flexDirection="column" gap={2}>
        {cycleSection}
        {staleNote}
        {needs}
        {work}
        {byStage}
        {footer}
      </Box>
    )
  })
}
