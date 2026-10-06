import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Panel } from './Panel'

function Harness({
  queryFn,
  isEmpty,
}: {
  queryFn: () => Promise<string[]>
  isEmpty?: (data: string[]) => boolean
}) {
  const query = useQuery({ queryKey: ['panel-test'], queryFn })
  return (
    <Panel title="Items" query={query} isEmpty={isEmpty}>
      {(data) => <ul>{data.map((item) => <li key={item}>{item}</li>)}</ul>}
    </Panel>
  )
}

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('Panel', () => {
  it('shows the skeleton while pending', () => {
    renderWithClient(<Harness queryFn={() => new Promise<string[]>(() => {})} />)
    expect(screen.getByText('Items')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows the error message and refetches on Try again', async () => {
    const queryFn = vi.fn<() => Promise<string[]>>().mockRejectedValue(new Error('Boom'))
    renderWithClient(<Harness queryFn={queryFn} />)
    expect(await screen.findByText('Boom')).toBeInTheDocument()
    expect(queryFn).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Boom')).toBeInTheDocument()
  })

  it('shows the empty text when isEmpty is true', async () => {
    renderWithClient(<Harness queryFn={() => Promise.resolve([])} isEmpty={(d) => d.length === 0} />)
    expect(await screen.findByText('Nothing to show yet.')).toBeInTheDocument()
  })

  it('renders the children with the data otherwise', async () => {
    renderWithClient(
      <Harness queryFn={() => Promise.resolve(['one', 'two'])} isEmpty={(d) => d.length === 0} />,
    )
    expect(await screen.findByText('one')).toBeInTheDocument()
    expect(screen.getByText('two')).toBeInTheDocument()
    expect(screen.queryByText('Nothing to show yet.')).not.toBeInTheDocument()
  })
})
