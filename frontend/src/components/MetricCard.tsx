import { type Format, formatValue } from '../lib/format'
import { LoadingSkeleton } from './LoadingSkeleton'

interface Props {
  label: string
  value: string | number
  /** Percentage change vs. the previous period. null/undefined hides the indicator. */
  change?: number | null
  format?: Format
  loading?: boolean
}

export function MetricCard({ label, value, change, format = 'number', loading = false }: Props) {
  const delta = typeof change === 'number' && Number.isFinite(change) ? change : null
  const direction = delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down'
  const color = { flat: 'text-slate-500', up: 'text-green-600', down: 'text-red-600' }[direction]
  const arrow = { flat: '•', up: '▲', down: '▼' }[direction]

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      {loading ? (
        <div className="mt-3">
          <LoadingSkeleton rows={1} />
        </div>
      ) : (
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{formatValue(value, format)}</span>
          {delta !== null && (
            <span className={`text-sm font-medium ${color}`}>
              {arrow} {Math.abs(delta).toFixed(1)}%
            </span>
          )}
        </div>
      )}
    </div>
  )
}
