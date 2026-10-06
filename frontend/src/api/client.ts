import { getToken, setToken } from '../auth/tokenStore'

const DEFAULT_BASE_URL = 'http://localhost:8000'

/** Falls back to the default for unset/blank values and trims trailing slashes. */
export function resolveBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  return trimmed === '' ? DEFAULT_BASE_URL : trimmed
}

const BASE_URL = resolveBaseUrl(import.meta.env.VITE_API_URL)

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type Params = Record<string, string | number | null | undefined>

interface Options {
  method?: string
  body?: unknown
  params?: Params
  /** false for login: no token is sent and a 401 does not end the session. */
  auth?: boolean
}

export async function apiFetch<T>(path: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, params = {}, auth = true } = options

  const url = new URL(path, BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const sentWith = auth ? getToken() : null
  if (sentWith) headers.Authorization = `Bearer ${sentWith}`

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server. Please try again.')
  }

  // A 401 ends only the session the request was sent with, never a newer one.
  if (response.status === 401 && sentWith !== null && getToken() === sentWith) setToken(null)
  if (response.status === 204) return undefined as T

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'unknown_error',
      data?.error?.message ?? `Request failed (${response.status})`,
    )
  }
  return data as T
}
