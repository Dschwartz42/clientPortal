import { describe, expect, it } from 'vitest'
import { formatTick } from './chartFormat'

describe('formatTick', () => {
  it('formats currency ticks compactly', () => {
    expect(formatTick(120000, 'currency')).toBe('$120K')
    expect(formatTick(2500000, 'currency')).toBe('$2.5M')
  })
  it('formats percent ticks with a percent sign', () => {
    expect(formatTick(12, 'percent')).toBe('12%')
  })
  it('formats number ticks compactly', () => {
    expect(formatTick(120000, 'number')).toBe('120K')
  })
})
