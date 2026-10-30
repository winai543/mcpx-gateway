import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startGateway } from '../src/server.js';

async function sample(label) {
  let inputSchema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const seenHeaders = [];
  const http = createServer(async (req, res) => {
    seenHeaders.push(req.headers);
    const server = new Server({ name: `sample-${label}`, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: `Echo from ${label}`, inputSchema }] }));
    server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `${label}:${request.params.arguments.value}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    await server.close();
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { http, endpoint: `http://127.0.0.1:${http.address().port}/mcp`, seenHeaders, changeSchema(schema) { inputSchema = schema; } };
}

async function connect(endpoint, token) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

function data(result) { return JSON.parse(result.content[0].text); }

test('finds, authorizes, validates, and routes colliding tool names', async () => {
  const a = await sample('A');
  const b = await sample('B');
  const dir = await mkdtemp(join(tmpdir(), 'mcpx-test-'));
  const manifestPath = join(dir, 'servers.json');
  const auditPath = join(dir, 'audit.jsonl');
  await writeFile(manifestPath, JSON.stringify({ servers: [
    { id: 'a', endpoint: a.endpoint, allowTools: ['echo'], groups: ['engineering'] },
    { id: 'b', endpoint: b.endpoint, allowTools: ['echo'], groups: ['finance'], credentialEnv: 'B_TOKEN', headersFromEnv: { 'X-Workspace-Id': 'B_WORKSPACE', 'X-Client-Id': 'B_CLIENT' } }
  ] }));
  const gateway = await startGateway({ manifestPath, auditPath, port: 0, env: { B_TOKEN: 'test-secret', B_WORKSPACE: 'workspace-1', B_CLIENT: 'client-1' }, access: { good: { id: 'alice', groups: ['engineering', 'finance'] }, limited: { id: 'bob', groups: ['engineering'] } } });
  const endpoint = `http://127.0.0.1:${gateway.address.port}/mcp`;
  let client;
  let limited;
  try {
    client = await connect(endpoint, 'good');
    limited = await connect(endpoint, 'limited');
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['search_tools', 'get_tool', 'call_tool']);
    const found = data(await client.callTool({ name: 'search_tools', arguments: { query: 'echo' } }));
    assert.deepEqual(found.map(x => x.tool_id), ['a/echo', 'b/echo']);
    const onlyA = data(await limited.callTool({ name: 'search_tools', arguments: { query: 'echo' } }));
    assert.deepEqual(onlyA.map(x => x.tool_id), ['a/echo']);
    const denied = await limited.callTool({ name: 'get_tool', arguments: { tool_id: 'b/echo' } });
    assert.equal(denied.isError, true);
    assert.equal(data(denied).code, 'NOT_FOUND');
    const tool = data(await client.callTool({ name: 'get_tool', arguments: { tool_id: 'b/echo' } }));
    const result = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'b/echo', arguments: { value: 'hello' }, schema_version: tool.schema_version } });
    assert.equal(result.content[0].text, 'B:hello');
    const badSchema = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'b/echo', arguments: { value: 'x' }, schema_version: 'old' } });
    assert.equal(data(badSchema).code, 'SCHEMA_CHANGED');
    const badArgs = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'b/echo', arguments: { value: 42 }, schema_version: tool.schema_version } });
    assert.equal(data(badArgs).code, 'INVALID_ARGUMENTS');
    b.changeSchema({ type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false });
    const changed = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'b/echo', arguments: { value: 'x' }, schema_version: tool.schema_version } });
    assert.equal(data(changed).code, 'SCHEMA_CHANGED');
    const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 4);
    assert.equal(audit[0].tool_id, 'b/echo');
    assert.equal('arguments' in audit[0], false);
    assert.ok(b.seenHeaders.length > 0);
    for (const headers of b.seenHeaders) {
      assert.equal(headers.authorization, 'Bearer test-secret');
      assert.equal(headers['x-workspace-id'], 'workspace-1');
      assert.equal(headers['x-client-id'], 'client-1');
    }
    assert.equal((await readFile(auditPath, 'utf8')).includes('test-secret'), false);
    await assert.rejects(connect(endpoint, 'wrong'));
  } finally {
    await client?.close();
    await limited?.close();
    await new Promise(resolve => gateway.http.close(resolve));
    await new Promise(resolve => a.http.close(resolve));
    await new Promise(resolve => b.http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
