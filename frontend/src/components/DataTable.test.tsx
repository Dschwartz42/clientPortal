import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type Column, DataTable } from './DataTable'

interface Row {
  id: string
  name: string
  value: string
}

const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'value', header: 'Value', render: (row) => `$${row.value}` },
]
const rows: Row[] = [
  { id: '1', name: 'Alpha', value: '10' },
  { id: '2', name: 'Beta', value: '20' },
]

describe('DataTable', () => {
  it('renders a row per item, using render when provided', () => {
    render(<DataTable columns={columns} rows={rows} />)
    const body = screen.getAllByRole('rowgroup')[1]
    expect(within(body).getAllByRole('row')).toHaveLength(2)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('$20')).toBeInTheDocument()
  })

  it('calls onSortChange when a sortable header is clicked, toggling direction', async () => {
    const onSortChange = vi.fn()
    const { rerender } = render(
      <DataTable columns={columns} rows={rows} sort="value" onSortChange={onSortChange} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith('name')

    rerender(<DataTable columns={columns} rows={rows} sort="name" onSortChange={onSortChange} />)
    await userEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith('-name')
  })

  it('does not make non-sortable headers clickable', () => {
    render(<DataTable columns={columns} rows={rows} onSortChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Value/ })).not.toBeInTheDocument()
  })

  it('sets aria-sort on the active sorted header only', () => {
    const { rerender } = render(
      <DataTable columns={columns} rows={rows} sort="name" onSortChange={vi.fn()} />,
    )
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: /Value/ })).not.toHaveAttribute('aria-sort')

    rerender(<DataTable columns={columns} rows={rows} sort="-name" onSortChange={vi.fn()} />)
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )

    rerender(<DataTable columns={columns} rows={rows} onSortChange={vi.fn()} />)
    expect(screen.getByRole('columnheader', { name: /Name/ })).not.toHaveAttribute('aria-sort')
  })

  it('shows emptyMessage when there are no rows', () => {
    render(<DataTable columns={columns} rows={[]} emptyMessage="No accounts match" />)
    expect(screen.getByText('No accounts match')).toBeInTheDocument()
  })

  it('shows a skeleton, not the empty message, while loading', () => {
    render(<DataTable columns={columns} rows={[]} loading emptyMessage="No accounts match" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByText('No accounts match')).not.toBeInTheDocument()
  })

  it('calls onRowClick with the row', async () => {
    const onRowClick = vi.fn()
    render(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />)
    await userEvent.click(screen.getByText('Beta'))
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
  })

  it('activates a clickable row with Enter from the keyboard', async () => {
    const onRowClick = vi.fn()
    render(<DataTable columns={columns} rows={rows} onRowClick={onRowClick} />)
    await userEvent.tab()
    const body = screen.getAllByRole('rowgroup')[1]
    const [firstRow] = within(body).getAllByRole('row')
    expect(firstRow).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
  })

  it('paginates: shows the range and disables Previous on page 1', async () => {
    const onPageChange = vi.fn()
    render(
      <DataTable
        columns={columns} rows={rows} page={1} pageSize={2} total={5}
        onPageChange={onPageChange}
      />,
    )
    expect(screen.getByText('Showing 1–2 of 5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('disables Next on the last page and clamps the range to the total', () => {
    render(
      <DataTable
        columns={columns} rows={rows.slice(0, 1)} page={3} pageSize={2} total={5}
        onPageChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Showing 5–5 of 5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
  })

  it('shows a sensible range when total is 0', () => {
    render(
      <DataTable
        columns={columns} rows={[]} page={1} pageSize={10} total={0} onPageChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Showing 0–0 of 0')).toBeInTheDocument()
    expect(screen.getByText(/Showing/)).toHaveTextContent(/^Showing 0–0 of 0$/)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('clamps the range when the page is past the last page', async () => {
    const onPageChange = vi.fn()
    render(
      <DataTable
        columns={columns} rows={[]} page={5} pageSize={2} total={5} onPageChange={onPageChange}
      />,
    )
    expect(screen.getByText('Showing 5–5 of 5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('disables the pager buttons while loading', () => {
    render(
      <DataTable
        columns={columns} rows={rows} loading page={2} pageSize={2} total={10}
        onPageChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  describe('interactive elements inside a clickable row', () => {
    function setup() {
      const onRowClick = vi.fn()
      const onInner = vi.fn()
      const cols: Column<Row>[] = [
        { key: 'name', header: 'Name' },
        {
          key: 'action',
          header: 'Action',
          render: (row) => (
            <button type="button" onClick={() => onInner(row.id)}>
              Edit {row.name}
            </button>
          ),
        },
      ]
      render(<DataTable columns={cols} rows={rows} onRowClick={onRowClick} />)
      return { onRowClick, onInner }
    }

    it('does not fire the row action when a cell button is clicked', async () => {
      const { onRowClick, onInner } = setup()
      await userEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }))
      expect(onInner).toHaveBeenCalledTimes(1)
      expect(onRowClick).not.toHaveBeenCalled()
    })

    it('does not fire the row action when Enter is pressed on a focused cell button', async () => {
      const { onRowClick, onInner } = setup()
      screen.getByRole('button', { name: 'Edit Alpha' }).focus()
      await userEvent.keyboard('{Enter}')
      expect(onInner).toHaveBeenCalledTimes(1)
      expect(onRowClick).not.toHaveBeenCalled()
    })

    it('still fires once for plain cell text', async () => {
      const { onRowClick } = setup()
      await userEvent.click(screen.getByText('Alpha'))
      expect(onRowClick).toHaveBeenCalledTimes(1)
      expect(onRowClick).toHaveBeenCalledWith(rows[0])
    })

    it('still fires once for Enter on the focused row', async () => {
      const { onRowClick } = setup()
      const body = screen.getAllByRole('rowgroup')[1]
      within(body).getAllByRole('row')[0].focus()
      await userEvent.keyboard('{Enter}')
      expect(onRowClick).toHaveBeenCalledTimes(1)
      expect(onRowClick).toHaveBeenCalledWith(rows[0])
    })
  })

  it.each([
    ['page', { pageSize: 2, total: 5, onPageChange: vi.fn() }],
    ['pageSize', { page: 1, total: 5, onPageChange: vi.fn() }],
    ['total', { page: 1, pageSize: 2, onPageChange: vi.fn() }],
    ['onPageChange', { page: 1, pageSize: 2, total: 5 }],
  ])('renders no pager when %s is missing', (_missing, props) => {
    render(<DataTable columns={columns} rows={rows} {...props} />)
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })
})
