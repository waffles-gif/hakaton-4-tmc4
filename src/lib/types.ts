export type Permission =
  | 'files:read'
  | 'files:refine'
  | 'refiners:read'
  | 'refiners:write'
  | 'media:upload'
  | 'incidents:read'
  | 'incidents:create'
  | 'team:manage'

export interface Me {
  id: number
  email: string
  displayName: string
  team: { code: string; name: string }
  role: { code: string; name: string }
  permissions: Permission[]
  clearance: { granted: boolean; grantedAt: string | null }
}

export interface Check {
  name: string
  passed: boolean
  detail: string
}

export interface IntegrationsStatus {
  deploy: {
    origin: string | null
    verifiedAt: string | null
    lastBuildSeen: string | null
    lastBuildSeenAt: string | null
    pendingChallenge: { origin: string; expiresAt: string } | null
  }
  storage: {
    provider: 'SUPABASE' | 'CLOUDINARY' | null
    verifiedAt: string | null
    checks: Check[]
  }
  clearance: { granted: boolean; grantedAt: string | null }
}

export interface ClearanceRound {
  number: number
  startsAt: string
  drawAt: string
  drawnAt: string | null
  resultsPublishedAt: string | null
}

export interface Clearance {
  granted: boolean
  grantedAt: string | null
  checks: Check[]
  checkedAt: string | null
  workspace: { kind: 'DEV' | 'EVAL'; chaosLevel: 0 | 1 | 2 }
  roster: { members: { name: string; code: string }[]; complete: boolean; locked: boolean }
  round: {
    approved: boolean
    approvedAt: string | null
    approvedRound: number | null
    nextRoundAt: string | null
    nextRound: ClearanceRound | null
    drawnMember: { round: number; name: string; code: string; startsAt: string } | null
    attempts: {
      round: number
      startsAt: string
      member: { name: string; code: string }
      result: 'PASSED' | 'FAILED' | 'ABSENT' | null
      gradedAt: string | null
    }[]
    schedule: ClearanceRound[]
  }
}

export interface ClearanceCheckResult {
  granted: boolean
  grantedAt: string | null
  checks: Check[]
}
