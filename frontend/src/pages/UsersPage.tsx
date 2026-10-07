import { type FormEvent, useState } from 'react'
import { useInviteUser, useUpdateUser, useUsers } from '../api/hooks'
import { useAuth } from '../auth/AuthContext'
import { Button } from '../components/Button'
import { type Column, DataTable } from '../components/DataTable'
import { ErrorState } from '../components/ErrorState'
import { FormField } from '../components/FormField'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { inputClass } from '../components/styles'
import { formatDateTime } from '../lib/format'
import type { InvitedUser, Role, User } from '../types/api'

function InviteModal({ onClose }: { onClose: () => void }) {
  const invite = useInviteUser()
  const [form, setForm] = useState({ email: '', full_name: '', role: 'member' as Role })
  const [invited, setInvited] = useState<InvitedUser | null>(null)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    invite.mutate(form, { onSuccess: setInvited })
  }

  if (invited) {
    return (
      <Modal title="User invited" open onClose={onClose}>
        <p className="text-sm text-slate-600">
          Give {invited.full_name} this temporary password. It is shown only once.
        </p>
        <code className="mt-3 block rounded-md bg-slate-100 p-3 text-center text-base">
          {invited.temporary_password}
        </code>
        <div className="mt-4 flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Invite user" open onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        {invite.isError && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {invite.error.message}
          </p>
        )}
        <FormField label="Full name">
          <input
            className={inputClass}
            required
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
        </FormField>
        <FormField label="Email">
          <input
            className={inputClass}
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </FormField>
        <FormField label="Role">
          <select
            className={inputClass}
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
          >
            <option value="member">Member (read-only)</option>
            <option value="admin">Admin</option>
          </select>
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function UsersPage() {
  const { user: me } = useAuth()
  const users = useUsers()
  const update = useUpdateUser()
  const [inviting, setInviting] = useState(false)

  const columns: Column<User>[] = [
    { key: 'full_name', header: 'Name' },
    { key: 'email', header: 'Email' },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <select
          className={`${inputClass} max-w-32`}
          aria-label={`Role for ${row.full_name}`}
          value={row.role}
          disabled={update.isPending}
          onChange={(e) => update.mutate({ id: row.id, body: { role: e.target.value as Role } })}
        >
          <option value="admin">Admin</option>
          <option value="member">Member</option>
        </select>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <div className="flex items-center gap-2">
          <StatusBadge status={row.is_active ? 'active' : 'inactive'} />
          {row.id !== me?.id && (
            <Button
              variant="secondary"
              disabled={update.isPending}
              onClick={() => update.mutate({ id: row.id, body: { is_active: !row.is_active } })}
            >
              {row.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </div>
      ),
    },
    {
      key: 'last_login_at',
      header: 'Last login',
      render: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : 'Never'),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Users</h1>
        <Button onClick={() => setInviting(true)}>Invite user</Button>
      </div>

      {/* Rule violations (last admin, self-deactivation) come back from the API as 409s. */}
      {update.isError && <ErrorState message={update.error.message} />}

      {users.isError ? (
        <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={users.data?.items ?? []}
          rowKey={(row) => row.id}
          loading={users.isPending}
          emptyMessage="No users yet."
        />
      )}

      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </div>
  )
}
