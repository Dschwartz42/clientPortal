const day = (date: Date) => date.toISOString().slice(0, 10)

/**
 * The twelve most recent COMPLETE calendar months in UTC, as API dates: `from` is the
 * first day of the month twelve months before the current UTC month, `to` the last day
 * of the previous UTC month. The current month is partial and would plot as a false drop.
 */
export function lastFullMonthsRange(now: Date): { from: string; to: string } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return {
    from: day(new Date(Date.UTC(year, month - 12, 1))),
    // Day 0 of this month is the last day of the previous one (handles leap years).
    to: day(new Date(Date.UTC(year, month, 0))),
  }
}
