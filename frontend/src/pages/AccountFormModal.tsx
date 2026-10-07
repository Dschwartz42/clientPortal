import { type FormEvent, useState } from 'react'
import { useCreateAccount, useUpdateAccount, useUsers } from '../api/hooks'
import { Button } from '../components/Button'
import { FormField } from '../components/FormField'
import { Modal } from '../components/Modal'
import { inputClass } from '../components/styles'
import type { Account, AccountStatus, Tier } from '../types/api'

interface Props {
  /** Present when editing; absent when creating. */
  account?: Account
  onClose: () => void
  onSaved: (account: Account) => void
}

function initialForm(account?: Account) {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
  return {
    name: account?.name ?? '',
    status: account?.status ?? ('active' as AccountStatus),
    tier: account?.tier ?? ('bronze' as Tier),
    monthly_value: account?.monthly_value ?? '',
    owner_user_id: account?.owner_user_id ?? '',
    opened_at: account?.opened_at ?? today,
  }
}

export function AccountFormModal({ account, onClose, onSaved }: Props) {
  const users = useUsers()
  const create = useCreateAccount()
  const update = useUpdateAccount(account?.id ?? '')
  const mutation = account ? update : create
  const [form, setForm] = useState(() => initialForm(account))

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate(
      { ...form, owner_user_id: form.owner_user_id || null },
      { onSuccess: (saved) => onSaved(saved) },
    )
  }

  return (
    <Modal title={account ? 'Edit account' : 'New account'} open onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        {mutation.isError && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {mutation.error.message}
          </p>
        )}
        <FormField label="Name">
          <input
            className={inputClass}
            required
            maxLength={200}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Tier">
            <select
              className={inputClass}
              value={form.tier}
              onChange={(e) => set('tier', e.target.value as Tier)}
            >
              <option value="bronze">Bronze</option>
              <option value="silver">Silver</option>
              <option value="gold">Gold</option>
            </select>
          </FormField>
          <FormField label="Status">
            <select
              className={inputClass}
              value={form.status}
              onChange={(e) => set('status', e.target.value as AccountStatus)}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="closed">Closed</option>
            </select>
          </FormField>
          <FormField label="Monthly value (USD)">
            <input
              className={inputClass}
              type="number"
              min="0"
              step="0.01"
              required
              value={form.monthly_value}
              onChange={(e) => set('monthly_value', e.target.value)}
            />
          </FormField>
          <FormField label="Opened">
            <input
              className={inputClass}
              type="date"
              required
              value={form.opened_at}
              onChange={(e) => set('opened_at', e.target.value)}
            />
          </FormField>
        </div>
        <FormField label="Owner">
          <select
            className={inputClass}
            value={form.owner_user_id}
            onChange={(e) => set('owner_user_id', e.target.value)}
          >
            <option value="">No owner</option>
            {users.data?.items
              .filter((user) => user.is_active)
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.full_name}
                </option>
              ))}
          </select>
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
