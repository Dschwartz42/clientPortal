import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToken } from '../auth/tokenStore'
import type { Account } from '../types/api'
import { AccountFormModal } from './AccountFormModal'

const existing: Account = {
  id: 'acc-1',
  name: 'Alpha Co',
  status: 'paused',
  tier: 'silver',
  monthly_value: '250.00',
  owner_user_id: 'u2',
  opened_at: '2026-02-10',
  closed_at: null,
  created_at: '2026-02-10T00:00:00Z',
}

const users = [
  { id: 'u1', email: 'a@x.test', full_name: 'Ann Active', role: 'admin', is_active: true },
  { id: 'u2', email: 'b@x.test', full_name: 'Bob Active', role: 'member', is_active: true },
  { id: 'u3', email: 'c@x.test', full_name: 'Cy Inactive', role: 'member', is_active: false },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

type Write = (body: Record<string, unknown>, method: string, path: string) => Promise<Response> | Response

function stubApi(write: Write) {
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/users') {
      return json({ items: users, total: 3, page: 1, page_size: 100 })
    }
    return write(JSON.parse(String(init?.body ?? '{}')), init?.method ?? 'GET', url.pathname)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function writes(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname !== '/api/users')
}

function renderModal(props: { account?: Account; onSaved?: (a: Account) => void } = {}) {
  const onSaved = props.onSaved ?? vi.fn()
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccountFormModal account={props.account} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  )
  return { onSaved, onClose }
}

beforeEach(() => setToken('test-token'))
afterEach(() => setToken(null))

describe('AccountFormModal', () => {
  it('creates an account with a string monthly_value and a null owner', async () => {
    const created = { ...existing, id: 'new-1', name: 'Fresh Co' }
    const fetchMock = stubApi(() => json(created, 201))
    const { onSaved } = renderModal()
    const dialog = screen.getByRole('dialog', { name: 'New account' })
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Fresh Co')
    await userEvent.selectOptions(within(dialog).getByLabelText('Tier'), 'gold')
    await userEvent.type(within(dialog).getByLabelText('Monthly value (USD)'), '99.5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created))
    const [[input, init]] = writes(fetchMock)
    expect(new URL(String(input)).pathname).toBe('/api/accounts')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      name: 'Fresh Co',
      tier: 'gold',
      status: 'active',
      monthly_value: '99.5',
      owner_user_id: null,
    })
    expect(typeof body.monthly_value).toBe('string')
    expect(body.opened_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('pre-fills the fields in edit mode and sends PATCH', async () => {
    const fetchMock = stubApi(() => json({ ...existing, tier: 'gold' }))
    const { onSaved } = renderModal({ account: existing })
    const dialog = screen.getByRole('dialog', { name: 'Edit account' })
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Alpha Co')
    expect(within(dialog).getByLabelText('Tier')).toHaveValue('silver')
    expect(within(dialog).getByLabelText('Status')).toHaveValue('paused')
    expect(within(dialog).getByLabelText('Monthly value (USD)')).toHaveValue(250)
    expect(within(dialog).getByLabelText('Opened')).toHaveValue('2026-02-10')
    await waitFor(() => expect(within(dialog).getByLabelText('Owner')).toHaveValue('u2'))
    await userEvent.selectOptions(within(dialog).getByLabelText('Tier'), 'gold')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [[input, init]] = writes(fetchMock)
    expect(new URL(String(input)).pathname).toBe('/api/accounts/acc-1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: 'Alpha Co',
      tier: 'gold',
      status: 'paused',
      monthly_value: '250.00',
      owner_user_id: 'u2',
    })
  })

  it('shows an API validation error inside the modal and stays open', async () => {
    stubApi(() =>
      json({ error: { code: 'validation_error', message: 'monthly_value must be positive' } }, 422),
    )
    const { onSaved, onClose } = renderModal({ account: existing })
    const dialog = screen.getByRole('dialog', { name: 'Edit account' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('monthly_value must be positive')
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Edit account' })).toBeInTheDocument()
  })

  it('disables Save while the request is in flight', async () => {
    let release: (r: Response) => void = () => {}
    stubApi(() => new Promise<Response>((resolve) => (release = resolve)))
    renderModal({ account: existing })
    const dialog = screen.getByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const saving = await within(dialog).findByRole('button', { name: 'Saving…' })
    expect(saving).toBeDisabled()
    release(json(existing))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled())
  })

  it('lists only active users as owners', async () => {
    stubApi(() => json(existing))
    renderModal()
    const owner = within(screen.getByRole('dialog')).getByLabelText('Owner')
    expect(await within(owner).findByRole('option', { name: 'Ann Active' })).toBeInTheDocument()
    expect(within(owner).getByRole('option', { name: 'Bob Active' })).toBeInTheDocument()
    expect(within(owner).queryByRole('option', { name: 'Cy Inactive' })).not.toBeInTheDocument()
    expect(within(owner).getByRole('option', { name: 'No owner' })).toBeInTheDocument()
  })
})
