import { describe, expect, it } from 'vitest'
import { isUuid } from './uuid'

describe('isUuid', () => {
  it('accepts lower and upper case', () => {
    expect(isUuid('3f2c1a9e-5b7d-4c8e-9a10-1b2c3d4e5f60')).toBe(true)
    expect(isUuid('3F2C1A9E-5B7D-4C8E-9A10-1B2C3D4E5F60')).toBe(true)
  })
  it.each([
    ['wrong length', '3f2c1a9e-5b7d-4c8e-9a10-1b2c3d4e5f6'],
    ['path traversal', '../users'],
    ['empty', ''],
    ['trailing junk', '3f2c1a9e-5b7d-4c8e-9a10-1b2c3d4e5f60/x'],
    ['trailing newline', '3f2c1a9e-5b7d-4c8e-9a10-1b2c3d4e5f60\n'],
    ['non-hex', 'zf2c1a9e-5b7d-4c8e-9a10-1b2c3d4e5f60'],
  ])('rejects %s', (_name, value) => {
    expect(isUuid(value)).toBe(false)
  })
})
