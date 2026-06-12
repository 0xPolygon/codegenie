export interface HttpTransport {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
}

export type HttpBinPayload = {
  args: Record<string, string>
  data?: string
  headers: Record<string, string>
  method: string
  url: string
}

export type RequestOptions = {
  query?: Record<string, string>
  headers?: Record<string, string>
  timeoutMs?: number
  onRetry?: (attempt: { count: number; status?: number }) => void
}

export type Decoder = (response: Response, shape: { expectJson: boolean; endpoint: string }) => Promise<HttpBinPayload>

export class HttpBinClient {
  readonly baseUrl = "https://httpbin.org"
  private readonly token: string | undefined
  protected retryCount = 1

  constructor(private readonly transport: HttpTransport, token?: string) {
    this.token = token
  }

  decorateRequest = (request: Request, metadata: { endpoint: string; attempt: number }) => request

  async getJson(options: RequestOptions = {}): Promise<HttpBinPayload> {
    const request = this.buildRequest("/get", options)
    return this.send(request, { expectJson: true, endpoint: "/get" })
  }

  async postJson(payload: { message: string; tags: string[] }, options: RequestOptions = {}): Promise<HttpBinPayload> {
    const request = this.buildRequest("/post", {
      ...options,
      headers: { ...options.headers, "Content-Type": "application/json" }
    }, JSON.stringify(payload))
    return this.send(request, { expectJson: true, endpoint: "/post" })
  }

  public async status(code: number): Promise<boolean> {
    const request = this.buildRequest(`/status/${code}`, {})
    const response = await this.transport.fetch(request)
    return response.status === code
  }

  private buildRequest(endpoint: string, options: RequestOptions, body?: string): Request {
    const url = new URL(endpoint, this.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }
    const init: RequestInit = {
      method: body === undefined ? "GET" : "POST",
      headers: this.createHeaders(options.headers)
    }
    if (body !== undefined) {
      init.body = body
    }
    const request = new Request(url, init)
    return this.decorateRequest(request, { endpoint, attempt: 1 })
  }

  protected createHeaders(headers: Record<string, string> = {}): Headers {
    const merged = new Headers(headers)
    if (this.token) {
      merged.set("Authorization", `Bearer ${this.token}`)
    }
    return merged
  }

  private async send(request: Request, decoderOptions: { expectJson: boolean; endpoint: string }): Promise<HttpBinPayload> {
    const response = await this.transport.fetch(request)
    return decodeHttpBin(response, decoderOptions)
  }
}

export async function decodeHttpBin(response: Response, shape: { expectJson: boolean; endpoint: string }): Promise<HttpBinPayload> {
  if (!shape.expectJson) {
    throw new Error(`unexpected non-json response for ${shape.endpoint}`)
  }
  return response.json() as Promise<HttpBinPayload>
}

export namespace HttpBinEndpoint {
  export function status(code: number): string {
    return `/status/${code}`
  }

  export const anything = (name: string) => `/anything/${name}`
}

const fetchTransport: HttpTransport = {
  fetch: (input, init) => fetch(input, init)
}

class RetryClock {
  now(): number {
    return Date.now()
  }
}

export { HttpBinClient as Client, RetryClock as Clock }

export default (transport: HttpTransport = fetchTransport) => new HttpBinClient(transport)
