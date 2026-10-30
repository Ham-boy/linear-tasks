export type LinearIssue = {
  id: string
  title: string
  status: string
  statusType: string
  priority: number
  priorityName: string
  url: string
  branch: string
  project: string | null
  blocks: { id: string; title: string }[]
  blockedBy: string[]
}

export type StageCount = { name: string; type: string; count: number }

export type CycleInfo = {
  number: number
  startsAt: string
  endsAt: string
  teamTotal: number
  teamDone: number
  mineTotal: number
  mineDone: number
}

export type Notice = {
  id: string
  issueId: string
  title: string
  detail: string
  url: string
}

export type Snapshot = {
  fetchedAt: number
  issues: LinearIssue[]
  doneCount: number
  cycle: CycleInfo | null
  notices: Notice[]
  stagesMine: StageCount[]
  stagesTeam: StageCount[]
}

export type PlanState = {
  phase: 'planning' | 'planned' | 'implementing'
  since: number
}

export type Status = { isLoading: boolean; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'linear-tasks': {
      snapshot: Shaped<Snapshot | null>
      status: Status
      plans: Shaped<Record<string, PlanState>>
      folders: Record<string, string>
      projects: string[]
      stageView: 'mine' | 'team'
      dismissed: string[]
      expanded: string[]
      paneOpen: boolean
    }
  }
}
