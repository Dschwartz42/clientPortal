// The token lives in memory and is mirrored to sessionStorage so a page refresh
// does not log the user out. Tradeoff vs. an httpOnly cookie: readable by any
// script on the page (XSS exposure), but no CSRF handling is needed.
const KEY = 'portal_token'
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

let token: string | null = read()

export function getToken(): string | null {
  return token
}

export function setToken(next: string | null): void {
  if (next === token) return
  token = next
  try {
    if (next === null) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, next)
  } catch {
    // Storage can be unavailable (private mode); the in-memory token still works.
  }
  // Run every listener even if one throws, then rethrow the first error.
  let failure: { error: unknown } | null = null
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
