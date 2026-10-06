import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Account,
  AccountDetail,
  AccountInput,
  AnalyticsSummary,
  AuditEntry,
  InvitedUser,
  Paginated,
  Role,
  TimeseriesPoint,
  TopAccount,
  Transaction,
  User,
} from '../types/api'
import { apiFetch } from './client'

export type AccountListParams = {
  status?: string
  tier?: string
  search?: string
  sort?: string
  page?: number
  page_size?: number
}

export function useAccounts(params: AccountListParams) {
  return useQuery({
    queryKey: ['accounts', params],
    queryFn: () => apiFetch<Paginated<Account>>('/api/accounts', { params }),
    placeholderData: keepPreviousData,
  })
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: ['account', id],
    queryFn: () => apiFetch<AccountDetail>(`/api/accounts/${id}`),
  })
}

export function useAccountTransactions(id: string, page: number) {
  return useQuery({
    queryKey: ['account', id, 'transactions', page],
    queryFn: () =>
      apiFetch<Paginated<Transaction>>(`/api/accounts/${id}/transactions`, {
        params: { page, page_size: 10 },
      }),
    placeholderData: keepPreviousData,
  })
}

export function useAnalyticsSummary() {
  return useQuery({
    queryKey: ['analytics', 'summary'],
    queryFn: () => apiFetch<AnalyticsSummary>('/api/analytics/summary'),
  })
}

export function useTimeseries(
  metric: 'net_revenue' | 'new_accounts',
  interval: 'week' | 'month',
  from: string,
) {
  return useQuery({
    queryKey: ['analytics', 'timeseries', metric, interval, from],
    queryFn: () =>
      apiFetch<TimeseriesPoint[]>('/api/analytics/timeseries', {
        params: { metric, interval, from },
      }),
  })
}

export function useTopAccounts() {
  return useQuery({
    queryKey: ['analytics', 'top-accounts'],
    queryFn: () => apiFetch<TopAccount[]>('/api/analytics/top-accounts'),
  })
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch<Paginated<User>>('/api/users', { params: { page_size: 100 } }),
  })
}

export type AuditParams = { action?: string; page?: number }

export function useAuditLog(params: AuditParams) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: () => apiFetch<Paginated<AuditEntry>>('/api/audit-log', { params }),
    placeholderData: keepPreviousData,
  })
}

// A change to an account also changes analytics and adds an audit entry.
function useInvalidateAccounts() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(
      ['accounts', 'account', 'analytics', 'audit'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    )
}

export function useCreateAccount() {
  const invalidate = useInvalidateAccounts()
  return useMutation<Account, Error, AccountInput>({
    mutationFn: (body) => apiFetch<Account>('/api/accounts', { method: 'POST', body }),
    onSuccess: invalidate,
  })
}

export function useUpdateAccount(id: string) {
  const invalidate = useInvalidateAccounts()
  return useMutation<Account, Error, AccountInput>({
    mutationFn: (body) => apiFetch<Account>(`/api/accounts/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  })
}

function useInvalidateUsers() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(
      ['users', 'audit'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    )
}

export type InviteInput = { email: string; full_name: string; role: Role }

export function useInviteUser() {
  const invalidate = useInvalidateUsers()
  return useMutation<InvitedUser, Error, InviteInput>({
    mutationFn: (body) => apiFetch<InvitedUser>('/api/users', { method: 'POST', body }),
    onSuccess: invalidate,
  })
}

export type UserUpdateInput = { id: string; body: { role?: Role; is_active?: boolean } }

export function useUpdateUser() {
  const invalidate = useInvalidateUsers()
  return useMutation<User, Error, UserUpdateInput>({
    mutationFn: ({ id, body }) => apiFetch<User>(`/api/users/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  })
}
