import { describe, expect, it } from 'vitest'
import { lastFullMonthsRange } from './dateRange'

describe('lastFullMonthsRange', () => {
  it.each([
    ['2026-03-15T12:00:00Z', '2025-03-01', '2026-02-28'],
    ['2026-03-01T00:30:00Z', '2025-03-01', '2026-02-28'],
    ['2024-03-10T00:00:00Z', '2023-03-01', '2024-02-29'],
    ['2026-01-05T00:00:00Z', '2025-01-01', '2025-12-31'],
    ['2026-12-31T23:59:59Z', '2025-12-01', '2026-11-30'],
  ])('now %s gives %s to %s (UTC)', (now, from, to) => {
    expect(lastFullMonthsRange(new Date(now))).toEqual({ from, to })
  })
})
