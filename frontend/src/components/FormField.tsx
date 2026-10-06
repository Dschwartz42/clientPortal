import type { ReactNode } from 'react'

/** Wraps one control in a <label>, so the label text is its accessible name. */
export function FormField({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-red-600">{error}</span>}
    </label>
  )
}
