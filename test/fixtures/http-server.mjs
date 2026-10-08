// Stateless Streamable HTTP MCP server for tests. Requires a bearer token so the
// header path and the 401 path both get exercised. Prints its port on stdout.
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const description = process.env.FIXTURE_DESCRIPTION ?? "Look up an order by id.";

const http = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer test-token") {
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const server = new Server({ name: "http-fixture", version: "3.2.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "get_order", description, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, JSON.parse(raw));
});
http.listen(0, "127.0.0.1", () => console.log(String(http.address().port)));
