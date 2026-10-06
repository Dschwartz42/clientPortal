export type Role = 'admin' | 'member'
export type AccountStatus = 'active' | 'paused' | 'closed'
export type Tier = 'bronze' | 'silver' | 'gold'

export interface Me {
  id: string
  email: string
  full_name: string
  role: Role
  org_id: string
  org_name: string
}

export interface LoginResponse {
  access_token: string
  user: Me
}

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface Account {
  id: string
  name: string
  status: AccountStatus
  tier: Tier
  monthly_value: string
  owner_user_id: string | null
  opened_at: string
  closed_at: string | null
  created_at: string
}

export interface AccountDetail extends Account {
  owner_name: string | null
  revenue_30d: string
}

export type AccountInput = {
  name?: string
  status?: AccountStatus
  tier?: Tier
  monthly_value?: string
  owner_user_id?: string | null
  opened_at?: string
}

export interface Transaction {
  id: string
  account_id: string
  type: 'charge' | 'refund' | 'credit'
  amount: string
  description: string | null
  occurred_at: string
}

export interface AnalyticsSummary {
  active_accounts: number
  total_monthly_value: string
  net_revenue_30d: string
  net_revenue_prev_30d: string
  net_revenue_change_pct: number | null
}

export interface TimeseriesPoint {
  period: string
  value: string | number
}

export interface TopAccount {
  account_id: string
  name: string
  tier: Tier
  net_revenue: string
}

export interface User {
  id: string
  email: string
  full_name: string
  role: Role
  is_active: boolean
  last_login_at: string | null
  created_at: string
}

export interface InvitedUser extends User {
  temporary_password: string
}

export interface AuditEntry {
  id: number
  actor_user_id: string
  actor_name: string | null
  action: string
  entity_type: string
  entity_id: string
  details: Record<string, unknown>
  created_at: string
}
