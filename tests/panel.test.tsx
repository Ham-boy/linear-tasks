import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'linear-tasks',
  component: 'Pane',
  requestId: 'linear-tasks',
  props: {
    title: 'Linear',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-30T10:00:00Z')

const STATUSES = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'In Review', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
]

const MINE = [
  { id: 'ENG-55', title: 'Build search indexer', status: 'In Progress', statusType: 'started', priority: { value: 0, name: 'No priority' }, url: 'https://linear.app/k/issue/ENG-55/a', gitBranchName: 'h/eng-55', project: null },
  { id: 'ENG-9', title: 'API gateway: load test', status: 'Todo', statusType: 'unstarted', priority: { value: 2, name: 'High' }, url: 'https://linear.app/k/issue/ENG-9/b', gitBranchName: 'h/eng-9', project: 'Platform' },
  { id: 'ENG-17', title: 'Image upload service', status: 'Todo', statusType: 'unstarted', priority: { value: 3, name: 'Medium' }, url: 'https://linear.app/k/issue/ENG-17/c', gitBranchName: 'h/eng-17', project: null },
  { id: 'ENG-54', title: 'Tune alert thresholds', status: 'Done', statusType: 'completed', priority: { value: 0, name: 'No priority' }, url: 'https://linear.app/k/issue/ENG-54/d', gitBranchName: 'h/eng-54', project: null },
]

const CYCLE_ISSUES = [
  { id: 'ENG-55', status: 'In Progress', statusType: 'started', assigneeId: 'u1' },
  { id: 'ENG-9', status: 'Todo', statusType: 'unstarted', assigneeId: 'u1' },
  { id: 'ENG-33', status: 'In Progress', statusType: 'started', assigneeId: 'u2' },
  { id: 'ENG-51', status: 'Done', statusType: 'completed', assigneeId: 'u2' },
]

function answer(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'get_user':
      return { id: 'u1', name: 'Test', teams: [{ id: 't1', name: 'Team', key: 'ENG' }] }
    case 'list_issues':
      return { issues: args.assignee === 'me' ? MINE : CYCLE_ISSUES, hasNextPage: false }
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
          { id: 'n1', title: 'Search: load test', subtitle: 'Alex commented: needs a second look', url: 'https://linear.app/k/issue/ENG-33/x#comment-1', archivedAt: null, snoozedUntilAt: null },
        ],
      }
    default:
      throw new Error(`unexpected tool ${tool}`)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function engine(on: any, prompts: string[] = []) {
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [{ name: 'web-app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('tool.list', () => ({ value: [{ name: 'mcp__lin__list_cycles', description: '', mcp: true }] }))
  on('mcp.call', (_: unknown, e: { tool: string; args: Record<string, unknown> }) => ({
    value: { content: [{ type: 'text', text: JSON.stringify(answer(e.tool, e.args)) }], isError: false },
  }))
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('tool.call', () => ({ result: {} }))
}

test('the panel shows the cycle, what needs you and the queue, on every surface', async ($, on) => {
  engine(on)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ type: 'Text', text: /^Cycle 2$/ }))?.text).toBe('Cycle 2')
    expect(await ui.find({ type: 'Text', text: /10 days left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 of 4 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Needs you\s+2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs a second look/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Blocking ENG-17/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Blocked by ENG-9/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 open/ })).toBeDefined()
    await ui.unmount()
  }
})

test('Create plan sends Claude a planning prompt, and a plan comment unlocks Implement', async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'plan:ENG-55' })

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Linear issue ENG-55')
  expect(prompts[0]).toContain('## Claude plan for ENG-55')
  expect(await ui.find({ type: 'Text', text: /Planning…/ })).toBeDefined()

  const comment = { tool: 'mcp__lin__save_comment', issueId: 'ENG-55', body: '## Claude plan for ENG-55\n\n1. Do it' }
  await $.tool.call(comment as never)
  await ui.press({ key: 'impl:ENG-55' })

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('Implement the plan for Linear issue ENG-55')
  expect(prompts[1]).toContain('h/eng-55')
  await ui.unmount()
})

test('a picked folder goes into the prompt', { options: { projectsRoot: 'C:/projects' } }, async ($, on) => {
  const prompts: string[] = []
  engine(on, prompts)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // The folder sits in the row's details, opened by its disclosure.
  await ui.press({ key: 'more:ENG-9' })
  await ui.select({ key: 'folder:ENG-9', value: 'web-app' })
  await ui.press({ key: 'plan:ENG-9' })

  expect(prompts[0]).toContain('web-app')
  await ui.unmount()
})

test('a connector $.mcp.call cannot dial is reached through its tools', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('tool.list', () => ({ value: [{ name: 'mcp__lin__list_cycles', description: '', mcp: true }] }))
  on('mcp.call', () => {
    throw new Error('no server named lin')
  })
  on('tool.call', (_: unknown, e: Record<string, unknown>) => {
    const { tool, tool_use_id: _id, ...args } = e
    const name = String(tool).replace(/^mcp__lin__/, '')

    return { result: {}, text: JSON.stringify(answer(name, args)) }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ type: 'Text', text: /^Cycle 2$/ }))?.text).toBe('Cycle 2')
  expect(await ui.find({ type: 'Text', text: /3 open/ })).toBeDefined()
  await ui.unmount()
})

test('without Linear the panel says how to connect it', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [] }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Text', text: /Connect it with \/mcp/ })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'linear-tasks',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

test('the button above the prompt shows and hides the panel, with what needs you', async ($, on) => {
  engine(on)
  on('clock.after', () => ({ value: undefined }))
  let isUp = false
  const opened: string[] = []
  on('ui.panes', () => ({ value: isUp ? [{ id: 'linear-tasks', title: 'Linear', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    isUp = true
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isUp = false

    return { value: undefined }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    isUp = false
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'refresh' })
    const band = await $.ui.mount({ ...BAND, surface })

    expect(await band.find({ type: 'Button', text: /Show Linear/ })).toBeDefined()
    expect(await band.find({ type: 'Button', text: /2 need you/ })).toBeDefined()

    await band.press({ key: 'linear-toggle' })
    expect(opened.at(-1)).toBe('linear-tasks')
    expect(await band.find({ type: 'Button', text: /Hide Linear/ })).toBeDefined()

    await band.press({ key: 'linear-toggle' })
    expect(isUp).toBe(false)
    expect(await band.find({ type: 'Button', text: /Show Linear/ })).toBeDefined()
    await band.unmount()
    await pane.unmount()
  }
})
