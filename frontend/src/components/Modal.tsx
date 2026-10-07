import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from 'react'

interface Props {
  title: string
  open: boolean
  onClose: () => void
  /** false: neither Escape nor the backdrop closes it (only controls inside it can). Default true. */
  dismissible?: boolean
  children: ReactNode
}

export function Modal({ title, open, onClose, dismissible = true, children }: Props) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const pressStartedOnBackdrop = useRef(false)

  // Move focus into the dialog on open; restore it to the previous element on close/unmount.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [open])

  // When the content is swapped for a different view (the title changes), focus would
  // otherwise be left on a removed control, i.e. <body>. The dialog's name is re-announced.
  useEffect(() => {
    if (open) dialogRef.current?.focus()
  }, [open, title])

  useEffect(() => {
    if (!open || !dismissible) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismissible, onClose])

  // Close only for a press that started AND ended on the backdrop itself. A drag that
  // starts in the dialog (selecting text) and is released outside must not close it.
  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    pressStartedOnBackdrop.current = event.target === event.currentTarget
  }
  function onBackdropMouseUp(event: MouseEvent<HTMLDivElement>) {
    const complete = pressStartedOnBackdrop.current && event.target === event.currentTarget
    pressStartedOnBackdrop.current = false
    if (complete && dismissible) onClose()
  }

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-xl focus:outline-none"
      >
        <h2 id={titleId} className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}
