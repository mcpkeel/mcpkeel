// Legacy HTTP+SSE MCP server for tests. Prints its port on stdout.
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const sessions = new Map();

const http = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/sse") {
    const server = new Server({ name: "sse-fixture", version: "0.9.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "ping", description: "Check that the service is up.", inputSchema: { type: "object", properties: {} } }],
    }));
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => sessions.delete(transport.sessionId));
    await server.connect(transport);
  } else if (req.method === "POST" && url.pathname === "/messages") {
    const transport = sessions.get(url.searchParams.get("sessionId"));
    if (!transport) return void res.writeHead(404).end();
    await transport.handlePostMessage(req, res);
  } else {
    res.writeHead(404).end();
  }
});
http.listen(0, "127.0.0.1", () => console.log(http.address().port));
