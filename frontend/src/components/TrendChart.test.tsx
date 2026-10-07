import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrendChart } from './TrendChart'

describe('TrendChart', () => {
  it('renders empty and two-point data without throwing', () => {
    const sized = (node: ReactNode) => (
      <div style={{ width: 400, height: 256 }}>{node}</div>
    )
    const { rerender, container } = render(sized(<TrendChart data={[]} />))
    expect(container.firstChild).toBeInTheDocument()
    rerender(
      sized(
        <TrendChart
          data={[
            { period: '2026-01-01', value: '100.50' },
            { period: '2026-02-01', value: 200 },
          ]}
        />,
      ),
    )
    expect(container.firstChild).toBeInTheDocument()
    rerender(sized(<TrendChart type="bar" format="currency" data={[]} />))
    expect(container.firstChild).toBeInTheDocument()
  })
})
