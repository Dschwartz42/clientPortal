import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
})
