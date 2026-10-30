import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Gateway, GatewayError, loadManifest } from './gateway.js';

const definitions = [
  { name: 'search_tools', description: 'Find tools available to you by keyword.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, server: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'get_tool', description: 'Get the input schema and version for a tool returned by search_tools.', inputSchema: { type: 'object', properties: { tool_id: { type: 'string' } }, required: ['tool_id'], additionalProperties: false } },
  { name: 'call_tool', description: 'Call a tool returned by search_tools using its current schema version.', inputSchema: { type: 'object', properties: { tool_id: { type: 'string' }, arguments: { type: 'object' }, schema_version: { type: 'string' } }, required: ['tool_id', 'arguments', 'schema_version'], additionalProperties: false } }
];

function principalFor(header, access) {
  if (!header?.startsWith('Bearer ')) return null;
  const token = Buffer.from(header.slice(7));
  for (const [key, principal] of Object.entries(access)) {
    const expected = Buffer.from(key);
    if (token.length === expected.length && timingSafeEqual(token, expected)) return principal;
  }
  return null;
}

export function createMcpServer(gateway, principal) {
  const server = new Server({ name: 'mcpx-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === 'search_tools') return { content: [{ type: 'text', text: JSON.stringify(gateway.search(args, principal)) }] };
      if (name === 'get_tool') return { content: [{ type: 'text', text: JSON.stringify(gateway.getTool(args.tool_id, principal)) }] };
      if (name === 'call_tool') {
        const result = await gateway.call(args, principal);
        return { content: result.content, structuredContent: result.structuredContent, isError: result.isError, _meta: { 'mcpx/request_id': result.request_id } };
      }
      throw new GatewayError('NOT_FOUND', 'Gateway tool not found');
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'INTERNAL_ERROR', message: error.message }) }], isError: true };
    }
  });
  return server;
}

export async function startGateway({ manifestPath = process.env.MCPX_MANIFEST ?? 'config/servers.json', servers, access = JSON.parse(process.env.MCPX_ACCESS ?? '{}'), env = process.env, port = Number(process.env.PORT ?? 4100), host = process.env.HOST ?? '127.0.0.1', auditPath = process.env.MCPX_AUDIT ?? 'audit.jsonl' } = {}) {
  if (!Object.keys(access).length) throw new Error('Set MCPX_ACCESS before npm start, or run npm run dev for a local demo. See README.md.');
  for (const principal of Object.values(access)) if (!principal.id || !Array.isArray(principal.groups)) throw new Error('Each principal needs id and groups');
  let configuredServers = servers;
  if (!configuredServers) {
    try { configuredServers = await loadManifest(manifestPath); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Manifest ${manifestPath} is missing. Copy config/servers.example.json to config/servers.json and edit the endpoint.`);
      throw error;
    }
  }
  const gateway = new Gateway(configuredServers, { auditPath, env });
  await gateway.refresh();
  const http = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', upstreams: Object.fromEntries(gateway.health) }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch { /* Invalid Origin is rejected. */ }
      if (!sameOrigin) { res.writeHead(403).end(); return; }
    }
    const principal = principalFor(req.headers.authorization, access);
    if (!principal) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const server = createMcpServer(gateway, principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
      console.error(error);
    } finally {
      await server.close().catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.off('error', reject); resolve(); });
  });
  return { http, gateway, address: http.address() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startGateway().then(({ address }) => console.log(`mcpx listening on http://${address.address}:${address.port}/mcp`)).catch(error => { console.error(`mcpx: ${error.message}`); process.exitCode = 1; });
}
