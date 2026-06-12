import createClient, { Client, HttpBinEndpoint, type HttpTransport } from "./httpbinClient.js"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

test("builds endpoint paths", () => {
  expect(HttpBinEndpoint.status(204)).toBe("/status/204")
})

test("uses injected transport without network calls", async () => {
  const transport: HttpTransport = {
    fetch: async () => response({ args: { name: "ada" }, headers: {}, method: "GET", url: "https://httpbin.org/get" })
  }
  const client = createClient(transport)
  const aliasClient = new Client(transport)

  await expect(client.getJson({ query: { name: "ada" } })).resolves.toMatchObject({ args: { name: "ada" } })
  await expect(aliasClient.status(200)).resolves.toBe(true)
})
