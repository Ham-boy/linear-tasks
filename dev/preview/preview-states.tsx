// Renders the linear-tasks pane in several states with realistic data and
// prints each drawn tree between markers, for preview/run.sh to turn into
// screenshots. Not part of the mod's own tests: run.sh copies it in.
import { test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-30T10:20:00+02:00')

const pane = (bodyColumns: number) =>
  ({
    plugin: 'linear-tasks',
    component: 'Pane',
    requestId: 'linear-tasks',
    surface: 'desktop',
    props: {
      title: 'Linear',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 120 },
      view: {},
    },
  }) as const

const STATUSES = [
  { name: 'In Review', type: 'started' },
  { name: 'Canceled', type: 'canceled' },
  { name: 'In Progress', type: 'started' },
  { name: 'Duplicate', type: 'duplicate' },
  { name: 'Done', type: 'completed' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'Backlog', type: 'backlog' },
]

const P = (value: number) => ({ value, name: ['No priority', 'Urgent', 'High', 'Medium', 'Low'][value] })
const issue = (id: string, title: string, status: string, statusType: string, priority: number, project: string | null) => ({
  id,
  title,
  status,
  statusType,
  priority: P(priority),
  url: `https://linear.app/acme/issue/${id}/x`,
  gitBranchName: `samlee/${id.toLowerCase()}-x`,
  project,
})

const MINE = [
  issue('ENG-58', 'Job runs tracker and alerts', 'Todo', 'unstarted', 0, null),
  issue('ENG-55', 'Build search indexer', 'In Progress', 'started', 0, null),
  issue('ENG-54', 'Tune alert thresholds', 'Done', 'completed', 0, null),
  issue('ENG-39', 'Migrate billing accounts', 'Done', 'completed', 1, 'Billing'),
  issue('ENG-19', 'Analytics dashboard', 'Done', 'completed', 1, 'Dashboards'),
  issue('ENG-56', 'Weekly metrics review', 'In Progress', 'started', 0, null),
  issue('ENG-9', 'API gateway: load test', 'Todo', 'unstarted', 2, 'Platform'),
  issue('ENG-16', 'Settings: hide advanced controls', 'Todo', 'unstarted', 3, 'Platform'),
  issue('ENG-17', 'Image upload service', 'Todo', 'unstarted', 3, 'Platform'),
  issue('ENG-10', 'Status dashboard', 'Todo', 'unstarted', 3, 'Dashboards'),
  issue('ENG-8', 'Web app: load test', 'Todo', 'unstarted', 2, 'Platform'),
]

const c = (id: string, statusType: string, status: string, who: string) => ({ id, status, statusType, assigneeId: who })
const CYCLE = [
  ...['ENG-51', 'ENG-50', 'ENG-33'].map(id => c(id, 'started', 'In Progress', 'alex')),
  c('ENG-55', 'started', 'In Progress', 'me'),
  c('ENG-56', 'started', 'In Progress', 'me'),
  ...['ENG-58', 'ENG-9', 'ENG-16', 'ENG-10', 'ENG-8'].map(id => c(id, 'unstarted', 'Todo', 'me')),
  ...Array.from({ length: 21 }, (_, n) => c(`ENG-1${n}x`, 'unstarted', 'Todo', 'other')),
]

function answer(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'get_user':
      return { id: 'me', name: 'Sam Lee', teams: [{ id: 't1', name: 'Acme', key: 'ENG' }] }
    case 'list_issues':
      return { issues: args.assignee === 'me' ? MINE : CYCLE, hasNextPage: false }
    case 'get_issue':
      if (args.id === 'ENG-9') return { id: 'ENG-9', relations: { blocks: [{ id: 'ENG-17', title: 'Image upload service' }], blockedBy: [] } }
      if (args.id === 'ENG-17') return { id: 'ENG-17', relations: { blocks: [], blockedBy: [{ id: 'ENG-9', title: 'API gateway: load test' }] } }
      return { id: args.id, relations: { blocks: [], blockedBy: [] } }
    case 'list_issue_statuses':
      return STATUSES
    case 'list_cycles':
      return [{ id: 'c2', number: 2, startsAt: '2026-10-25T22:00:00.000Z', endsAt: '2026-11-08T22:00:00.000Z', isCurrent: true }]
    case 'get_notifications':
      return {
        notifications: [
          {
            id: 'n1',
            title: 'Search: load test',
            subtitle: 'Alex Kim commented: Updated, needs a second look',
            url: 'https://linear.app/acme/issue/ENG-33/search-load-test#comment-1',
            archivedAt: null,
            snoozedUntilAt: null,
          },
        ],
      }
    default:
      throw new Error(`unexpected tool ${tool}`)
  }
}

const STORE: Record<string, unknown> = {
  plans: { 'ENG-55': { phase: 'planned', since: NOW - 3_600_000 }, 'ENG-56': { phase: 'planning', since: NOW - 60_000 } },
  folders: { 'ENG-55': 'web-app', 'ENG-9': 'api-gateway', 'ENG-16': 'search' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engine(on: any, linear: 'ok' | 'down' = 'ok', withStore = true) {
  on('clock.now', () => ({ value: NOW }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: withStore ? STORE[e.key] : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: ['web-app', 'api-gateway', 'search', 'admin-console', 'status-page', 'docs', 'mobile-app'].map(name => ({
      name,
      kind: 'dir',
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('tool.list', () => ({ value: linear === 'ok' ? [{ name: 'mcp__lin__list_cycles', description: '', mcp: true }] : [] }))
  on('mcp.call', (_: unknown, e: { tool: string; args: Record<string, unknown> }) =>
    linear === 'ok'
      ? { value: { content: [{ type: 'text', text: JSON.stringify(answer(e.tool, e.args)) }], isError: false } }
      : { value: { content: [{ type: 'text', text: 'not connected' }], isError: true } },
  )
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'linear' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dump(name: string, ui: any) {
  try {
    console.log(`@@TREE:${name}@@${JSON.stringify(await ui.drawn())}@@END@@`)
  } catch (err) {
    console.log(`@@ERROR:${name}@@${err instanceof Error ? err.message : String(err)}@@END@@`)
  }
}

test('preview: loaded', async ($, on) => {
  engine(on)
  // session.start loads the stored plans and folders, as in a real session.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(pane(56))
  await ui.press({ key: 'refresh' })
  await dump('loaded', ui)
  await ui.press({ key: 'view:team' }).catch(() => undefined)
  await dump('loaded-team-stages', ui)
  // A row opened to its details (folder, links); added for the redesign.
  await ui.press({ key: 'more:ENG-8' }).catch(() => undefined)
  await ui.press({ key: 'more:ENG-55' }).catch(() => undefined)
  await dump('expanded', ui)
  await ui.unmount()
})

test('preview: narrow', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount(pane(38))
  await ui.press({ key: 'refresh' })
  await dump('narrow', ui)
  await ui.unmount()
})

test('preview: loading', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(pane(56))
  await dump('loading', ui)
  await ui.unmount()
})

test('preview: not connected', async ($, on) => {
  engine(on, 'down', false)
  const ui = await $.ui.mount(pane(56))
  await ui.press({ key: 'refresh' })
  await dump('not-connected', ui)
  await ui.unmount()
})
