import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'env_check', description: 'Check forwarded environment values', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: `${process.env.STDIO_TOKEN}:${process.env.STDIO_REGION}` }] }));
await server.connect(new StdioServerTransport());
