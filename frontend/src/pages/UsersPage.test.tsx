import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState } from '../auth/AuthContext'
import { setToken } from '../auth/tokenStore'
import { UsersPage } from './UsersPage'

function user(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@acme.test`,
    full_name: `Name ${id}`,
    role: 'member',
    is_active: true,
    last_login_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const ME = user('u1', { role: 'admin', last_login_at: '2026-03-01T20:30:00Z' })
const BOB = user('u2')
const CAROL = user('u3', { role: 'admin', is_active: false })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

function errorBody(code: string, message: string, status: number) {
  return json({ error: { code, message } }, status)
}

type Write = (url: URL, init: RequestInit) => Response | Promise<Response>

function stubApi(options: { list?: () => Response; write?: Write } = {}) {
  const fetchMock = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/users' && (init.method ?? 'GET') === 'GET') {
      return options.list
        ? options.list()
        : json({ items: [ME, BOB, CAROL], total: 3, page: 1, page_size: 100 })
    }
    if (options.write) return options.write(url, init)
    return errorBody('not_found', 'nope', 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function writes(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([input, init]) => ({
      url: new URL(String(input)),
      method: init!.method!,
      body: JSON.parse(String(init!.body)) as Record<string, unknown>,
    }))
}

function renderPage() {
  const value: AuthState = {
    user: {
      id: 'u1',
      email: 'u1@acme.test',
      full_name: 'Name u1',
      role: 'admin',
      org_id: 'o1',
      org_name: 'Acme',
    },
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: async () => {},
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={value}>
          <MemoryRouter>
            <UsersPage />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    ),
  }
}

const INVITED = {
  ...user('u9', { full_name: 'New Person', email: 'new@acme.test' }),
  temporary_password: 'Sup3r-Secret-pw',
}

async function submitInvite() {
  await userEvent.click(screen.getByRole('button', { name: 'Invite user' }))
  const dialog = screen.getByRole('dialog', { name: 'Invite user' })
  await userEvent.type(within(dialog).getByLabelText('Full name'), 'New Person')
  await userEvent.type(within(dialog).getByLabelText('Email'), 'new@acme.test')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }))
  return dialog
}

const backdropOf = (dialog: HTMLElement) => dialog.parentElement as HTMLElement

function rowOf(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) })
}

beforeEach(() => setToken('test-token'))
afterEach(() => setToken(null))

describe('UsersPage', () => {
  it('lists users with name, email, role, status and last login', async () => {
    stubApi()
    renderPage()
    expect(await screen.findByText('Name u2')).toBeInTheDocument()
    expect(screen.getByText('u2@acme.test')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByLabelText('Role for Name u1')).toHaveValue('admin')
    expect(screen.getByLabelText('Role for Name u2')).toHaveValue('member')
    expect(within(rowOf('Name u3')).getByText('inactive')).toBeInTheDocument()
    expect(within(rowOf('Name u2')).getByText('active')).toBeInTheDocument()
    expect(within(rowOf('Name u1')).getByText('Mar 1, 2026, 12:30 PM')).toBeInTheDocument()
    expect(within(rowOf('Name u2')).getByText('Never')).toBeInTheDocument()
  })

  it('gives the current user no Deactivate button', async () => {
    stubApi()
    renderPage()
    await screen.findByText('Name u2')
    expect(within(rowOf('Name u1')).queryByRole('button')).not.toBeInTheDocument()
    expect(within(rowOf('Name u2')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
  })

  it('sends the new role when a role is changed', async () => {
    const fetchMock = stubApi({ write: () => json({ ...BOB, role: 'admin' }) })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.selectOptions(screen.getByLabelText('Role for Name u2'), 'admin')
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1))
    const [call] = writes(fetchMock)
    expect(call.method).toBe('PATCH')
    expect(call.url.pathname).toBe('/api/users/u2')
    expect(call.body).toEqual({ role: 'admin' })
  })

  it('sends is_active as a real boolean for Deactivate and Reactivate', async () => {
    const fetchMock = stubApi({ write: () => json(BOB) })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.click(within(rowOf('Name u2')).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1))
    await waitFor(() =>
      expect(within(rowOf('Name u3')).getByRole('button', { name: 'Reactivate' })).toBeEnabled(),
    )
    await userEvent.click(within(rowOf('Name u3')).getByRole('button', { name: 'Reactivate' }))
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(2))
    const [first, second] = writes(fetchMock)
    expect(first.url.pathname).toBe('/api/users/u2')
    expect(first.body).toEqual({ is_active: false })
    expect(second.url.pathname).toBe('/api/users/u3')
    expect(second.body).toEqual({ is_active: true })
  })

  it('shows the API message when a change is rejected, and clears it after a later success', async () => {
    let calls = 0
    stubApi({
      write: () => {
        calls += 1
        return calls === 1
          ? errorBody('last_admin', 'An organization must have at least one active admin', 409)
          : json(BOB)
      },
    })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.selectOptions(screen.getByLabelText('Role for Name u1'), 'member')
    expect(
      await screen.findByText('An organization must have at least one active admin'),
    ).toBeInTheDocument()
    await userEvent.click(within(rowOf('Name u2')).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(calls).toBe(2))
    await waitFor(() =>
      expect(
        screen.queryByText('An organization must have at least one active admin'),
      ).not.toBeInTheDocument(),
    )
  })

  it('disables the row controls while a change is in flight', async () => {
    let release: (response: Response) => void = () => {}
    stubApi({ write: () => new Promise<Response>((resolve) => (release = resolve)) })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.click(within(rowOf('Name u2')).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() =>
      expect(within(rowOf('Name u2')).getByRole('button', { name: 'Deactivate' })).toBeDisabled(),
    )
    expect(within(rowOf('Name u3')).getByRole('button', { name: 'Reactivate' })).toBeDisabled()
    expect(screen.getByLabelText('Role for Name u2')).toBeDisabled()
    expect(screen.getByLabelText('Role for Name u1')).toBeDisabled()
    release(json(BOB))
    await waitFor(() => expect(screen.getByLabelText('Role for Name u2')).toBeEnabled())
  })

  it('invites a user, shows the temporary password once, and drops it on Done', async () => {
    const fetchMock = stubApi({
      write: () => json({ ...user('u9', { full_name: 'New Person', email: 'new@acme.test' }), temporary_password: 'Sup3r-Secret-pw' }, 201),
    })
    const { queryClient } = renderPage()
    await screen.findByText('Name u2')
    await userEvent.click(screen.getByRole('button', { name: 'Invite user' }))
    const dialog = screen.getByRole('dialog', { name: 'Invite user' })
    await userEvent.type(within(dialog).getByLabelText('Full name'), 'New Person')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'new@acme.test')
    await userEvent.selectOptions(within(dialog).getByLabelText('Role'), 'admin')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }))

    const done = await screen.findByRole('dialog', { name: 'User invited' })
    expect(within(done).getByText('Sup3r-Secret-pw')).toBeInTheDocument()
    const [call] = writes(fetchMock)
    expect(call.method).toBe('POST')
    expect(call.url.pathname).toBe('/api/users')
    expect(call.body).toEqual({ email: 'new@acme.test', full_name: 'New Person', role: 'admin' })

    await userEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Sup3r-Secret-pw')
    expect(window.location.href).not.toContain('Sup3r')
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('Sup3r')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('Sup3r')
    // The mutation cache must not keep the password once the modal's observer is gone.
    await waitFor(() =>
      expect(
        JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state)),
      ).not.toContain('Sup3r'),
    )
  })

  it('keeps the "User invited" view open on Escape and backdrop clicks until Done', async () => {
    stubApi({ write: () => json(INVITED, 201) })
    renderPage()
    await screen.findByText('Name u2')
    await submitInvite()
    const done = await screen.findByRole('dialog', { name: 'User invited' })
    await userEvent.keyboard('{Escape}')
    await userEvent.click(backdropOf(done))
    expect(screen.getByRole('dialog', { name: 'User invited' })).toBeInTheDocument()
    expect(screen.getByText('Sup3r-Secret-pw')).toBeInTheDocument()
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('moves focus into the dialog when the invite form is replaced by the password view', async () => {
    stubApi({ write: () => json(INVITED, 201) })
    renderPage()
    await screen.findByText('Name u2')
    await submitInvite()
    const done = await screen.findByRole('dialog', { name: 'User invited' })
    expect(done).toContainElement(document.activeElement as HTMLElement)
  })

  it('cannot be closed while the invitation is in flight, and still shows the password after', async () => {
    let release: (response: Response) => void = () => {}
    stubApi({ write: () => new Promise<Response>((resolve) => (release = resolve)) })
    renderPage()
    await screen.findByText('Name u2')
    const dialog = await submitInvite()
    expect(await within(dialog).findByRole('button', { name: 'Inviting…' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(backdropOf(dialog))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Invite user' })).toBeInTheDocument()
    release(json(INVITED, 201))
    const done = await screen.findByRole('dialog', { name: 'User invited' })
    expect(within(done).getByText('Sup3r-Secret-pw')).toBeInTheDocument()
  })

  it('keeps the invite modal open with the typed values when the email is taken', async () => {
    stubApi({ write: () => errorBody('email_taken', 'That email is already registered', 409) })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.click(screen.getByRole('button', { name: 'Invite user' }))
    const dialog = screen.getByRole('dialog', { name: 'Invite user' })
    await userEvent.type(within(dialog).getByLabelText('Full name'), 'Dup Person')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dup@acme.test')
    await userEvent.selectOptions(within(dialog).getByLabelText('Role'), 'admin')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }))

    expect(await within(dialog).findByText('That email is already registered')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Invite user' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Full name')).toHaveValue('Dup Person')
    expect(within(dialog).getByLabelText('Email')).toHaveValue('dup@acme.test')
    expect(within(dialog).getByLabelText('Role')).toHaveValue('admin')
    expect(within(dialog).getByRole('button', { name: 'Invite' })).toBeEnabled()
  })

  it('disables the Invite button while the invitation is in flight', async () => {
    let release: (response: Response) => void = () => {}
    stubApi({ write: () => new Promise<Response>((resolve) => (release = resolve)) })
    renderPage()
    await screen.findByText('Name u2')
    await userEvent.click(screen.getByRole('button', { name: 'Invite user' }))
    const dialog = screen.getByRole('dialog', { name: 'Invite user' })
    await userEvent.type(within(dialog).getByLabelText('Full name'), 'Slow Person')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'slow@acme.test')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invite' }))
    expect(await within(dialog).findByRole('button', { name: 'Inviting…' })).toBeDisabled()
    release(errorBody('email_taken', 'taken', 409))
    expect(await within(dialog).findByRole('button', { name: 'Invite' })).toBeEnabled()
  })

  it('shows the loading state, then the empty state', async () => {
    stubApi({ list: () => json({ items: [], total: 0, page: 1, page_size: 100 }) })
    renderPage()
    expect(screen.queryByText('No users yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(await screen.findByText('No users yet.')).toBeInTheDocument()
  })

  it('shows an error state with Try again', async () => {
    let calls = 0
    stubApi({
      list: () => {
        calls += 1
        return calls === 1
          ? errorBody('server_error', 'Users exploded', 500)
          : json({ items: [BOB], total: 1, page: 1, page_size: 100 })
      },
    })
    renderPage()
    expect(await screen.findByText('Users exploded')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Name u2')).toBeInTheDocument()
    expect(screen.queryByText('Users exploded')).not.toBeInTheDocument()
  })
})
