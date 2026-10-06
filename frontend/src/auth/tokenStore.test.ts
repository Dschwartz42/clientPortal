import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getToken, setToken, subscribe } from './tokenStore'

beforeEach(() => setToken(null))

describe('tokenStore', () => {
  it('notifies once when the same value is set twice', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    setToken('a')
    setToken('a')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('portal_token')).toBe('a')
    unsubscribe()
  })

  it('notifies on change and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    setToken('a')
    setToken(null)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setToken('b')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('runs every listener when one throws, then rethrows the first error', () => {
    const boom = new Error('boom')
    const first = vi.fn(() => {
      throw boom
    })
    const second = vi.fn()
    const offs = [subscribe(first), subscribe(second)]
    expect(() => setToken('a')).toThrow(boom)
    expect(second).toHaveBeenCalledTimes(1)
    expect(getToken()).toBe('a')
    offs.forEach((off) => off())
  })
})
