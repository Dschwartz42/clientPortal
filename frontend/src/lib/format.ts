export type Format = 'currency' | 'number' | 'percent'

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const plain = new Intl.NumberFormat('en-US')

export function formatValue(value: string | number, format: Format): string {
  if (typeof value === 'string' && value.trim() === '') return '—'
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return '—'
  if (format === 'currency') return currency.format(n)
  if (format === 'percent') return `${n.toFixed(1)}%`
  return plain.format(n)
}

// "2026-03-01" parsed by Date is midnight UTC, which is the previous day west of UTC.
// Build date-only values from their parts so they stay on the calendar day they name.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function parse(iso: string): Date | null {
  let date: Date
  if (DATE_ONLY.test(iso)) {
    const [year, month, day] = iso.split('-').map(Number)
    date = new Date(year, month - 1, day)
  } else {
    date = new Date(iso)
  }
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDate(iso: string): string {
  return parse(iso)?.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) ?? '—'
}

export function formatDateTime(iso: string): string {
  return parse(iso)?.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) ?? '—'
}

export function formatPeriod(iso: string): string {
  return parse(iso)?.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) ?? '—'
}
