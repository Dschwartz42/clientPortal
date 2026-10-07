import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal title="Edit" open={false} onClose={vi.fn()}>
        body
      </Modal>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('is a modal dialog named by its title', () => {
    render(
      <Modal title="Edit account" open onClose={vi.fn()}>
        body
      </Modal>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Edit account' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open onClose={onClose}>
        body
      </Modal>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on backdrop click but not on clicks inside the dialog', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open onClose={onClose}>
        <p>inside</p>
      </Modal>,
    )
    await userEvent.click(screen.getByText('inside'))
    await userEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    await userEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog on open', () => {
    render(
      <Modal title="Edit" open onClose={vi.fn()}>
        <p>body</p>
      </Modal>,
    )
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('returns focus to the opener after closing', async () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal title="Edit" open={open} onClose={() => setOpen(false)}>
            <p>body</p>
          </Modal>
        </>
      )
    }
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await userEvent.click(opener)
    expect(screen.getByRole('dialog')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('does not steal focus back on re-render', async () => {
    const { rerender } = render(
      <Modal title="Edit" open onClose={vi.fn()}>
        <input aria-label="field" />
      </Modal>,
    )
    await userEvent.click(screen.getByLabelText('field'))
    rerender(
      <Modal title="Edit" open onClose={vi.fn()}>
        <input aria-label="field" />
      </Modal>,
    )
    expect(screen.getByLabelText('field')).toHaveFocus()
  })

  it('does not close when a drag starts inside the dialog and is released on the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open onClose={onClose}>
        <p>inside</p>
      </Modal>,
    )
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(screen.getByText('inside'))
    fireEvent.mouseUp(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes when both mousedown and mouseup happen on the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open onClose={onClose}>
        <p>inside</p>
      </Modal>,
    )
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(backdrop)
    fireEvent.mouseUp(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on a mouseup that had no mousedown on the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open onClose={onClose}>
        <p>inside</p>
      </Modal>,
    )
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseUp(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores Escape and the backdrop when dismissible is false', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit" open dismissible={false} onClose={onClose}>
        <p>inside</p>
      </Modal>,
    )
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('moves focus to the dialog when the title changes', async () => {
    function Host({ title }: { title: string }) {
      return (
        <Modal title={title} open onClose={vi.fn()}>
          <button>first</button>
        </Modal>
      )
    }
    const { rerender } = render(<Host title="One" />)
    screen.getByRole('button', { name: 'first' }).focus()
    rerender(<Host title="Two" />)
    expect(screen.getByRole('dialog', { name: 'Two' })).toHaveFocus()
  })
})
