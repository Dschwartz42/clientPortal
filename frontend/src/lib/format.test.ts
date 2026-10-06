import { describe, expect, it } from 'vitest'
import { formatDate, formatPeriod, formatValue } from './format'

describe('formatValue', () => {
  it('formats money strings as currency', () => {
    expect(formatValue('184250.00', 'currency')).toBe('$184,250.00')
    expect(formatValue('-12.5', 'currency')).toBe('-$12.50')
  })

  it('formats numbers and percents', () => {
    expect(formatValue(1420, 'number')).toBe('1,420')
    expect(formatValue(9.54, 'percent')).toBe('9.5%')
  })

  it('renders a dash for values that are not numbers', () => {
    expect(formatValue('abc', 'currency')).toBe('—')
  })
})

describe('dates', () => {
  it('shows a date-only value as that calendar day in any timezone', () => {
    expect(formatDate('2026-03-01')).toBe('Mar 1, 2026')
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026')
  })

  it('labels a period by month and year', () => {
    expect(formatPeriod('2026-03-01')).toBe('Mar 26')
  })
})
