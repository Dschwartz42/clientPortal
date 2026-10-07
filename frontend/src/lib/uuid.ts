const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a canonical 8-4-4-4-12 hexadecimal id. Anything else cannot be a server-issued id. */
export function isUuid(value: string): boolean {
  return UUID.test(value)
}
