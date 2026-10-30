import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startGateway } from './server.js';

const demo = createServer(async (req, res) => {
  const server = new Server({ name: 'mcpx-demo', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: 'Repeat a message for testing the gateway.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false } }]
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: request.params.arguments.message }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500).end('Demo MCP request failed');
    console.error(error);
  } finally {
    await server.close().catch(() => {});
  }
});

try {
  await new Promise((resolve, reject) => {
    demo.once('error', reject);
    demo.listen(0, '127.0.0.1', () => { demo.off('error', reject); resolve(); });
  });
  const endpoint = `http://127.0.0.1:${demo.address().port}/mcp`;
  const gateway = await startGateway({
    servers: [{ id: 'demo', endpoint, groups: ['dev'], allowTools: ['echo'], timeoutMs: 10000 }],
    access: { 'dev-token': { id: 'local-dev', groups: ['dev'] } },
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 4100)
  });
  console.log(`Gateway: http://127.0.0.1:${gateway.address.port}/mcp`);
  console.log('Development token: dev-token');
  console.log('Try search_tools with query "echo", then get_tool and call_tool.');
  console.log('Press Ctrl+C to stop.');
} catch (error) {
  demo.close();
  console.error(`mcpx dev: ${error.message}`);
  process.exitCode = 1;
}
