import type { Format } from '../lib/format'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact' })
const compactCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
})

/** Short axis-tick label for a value in the given format. */
export function formatTick(value: number, format: Format): string {
  if (format === 'currency') return compactCurrency.format(value)
  if (format === 'percent') return `${compact.format(value)}%`
  return compact.format(value)
}
