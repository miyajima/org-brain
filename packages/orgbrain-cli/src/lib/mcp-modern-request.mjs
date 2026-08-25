export const MCP_PROTOCOL_VERSION = "2026-07-28";

export function modernMcpHeaders(method, name = null) {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {})
  };
}

export function modernMcpRequest({ id, method, name = null, params = {}, clientName = "orgbrain-cli" }) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...(params._meta && typeof params._meta === "object" ? params._meta : {}),
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: clientName,
          version: "0.1.0"
        }
      },
      ...(name ? { name } : {})
    }
  };
}
