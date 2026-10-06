const colors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  paused: 'bg-amber-100 text-amber-800',
  closed: 'bg-slate-200 text-slate-700',
  inactive: 'bg-slate-200 text-slate-700',
}

export function StatusBadge({ status }: { status: string }) {
  const color = colors[status] ?? 'bg-slate-100 text-slate-700'
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  )
}
