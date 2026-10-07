import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MetricCard } from './MetricCard'

describe('MetricCard', () => {
  it('formats the value', () => {
    render(<MetricCard label="Monthly value" value="184250.00" format="currency" />)
    expect(screen.getByText('Monthly value')).toBeInTheDocument()
    expect(screen.getByText('$184,250.00')).toBeInTheDocument()
  })

  it('shows a positive change in green', () => {
    render(<MetricCard label="Revenue" value="100" change={9.54} />)
    const change = screen.getByText('▲ 9.5%')
    expect(change).toHaveClass('text-green-600')
  })

  it('shows a negative change in red', () => {
    render(<MetricCard label="Revenue" value="100" change={-3.2} />)
    const change = screen.getByText('▼ 3.2%')
    expect(change).toHaveClass('text-red-600')
  })

  it('shows no change indicator when the change is null or missing', () => {
    const { rerender } = render(<MetricCard label="Revenue" value="100" change={null} />)
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
    rerender(<MetricCard label="Revenue" value="100" />)
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  it('shows no change indicator when the change is not finite', () => {
    const { rerender } = render(<MetricCard label="Revenue" value="100" change={NaN} />)
    expect(screen.queryByText(/%|NaN/)).not.toBeInTheDocument()
    rerender(<MetricCard label="Revenue" value="100" change={Infinity} />)
    expect(screen.queryByText(/%|NaN|Infinity/)).not.toBeInTheDocument()
  })

  it('shows a skeleton instead of the value while loading', () => {
    render(<MetricCard label="Revenue" value="100" loading />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('100')).not.toBeInTheDocument()
  })
})
