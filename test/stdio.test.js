import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadManifest } from '../src/gateway.js';
import { startGateway } from '../src/server.js';

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.js', import.meta.url));
const parse = result => JSON.parse(result.content[0].text);

test('stdio MCP receives multiple mapped environment variables and is callable through gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpx-stdio-'));
  const manifestPath = join(dir, 'servers.json');
  const config = { servers: [{ id: 'local', transport: 'stdio', command: process.execPath, args: [fixture], envFromEnv: { STDIO_TOKEN: 'PARENT_TOKEN', STDIO_REGION: 'PARENT_REGION' }, allowTools: ['env_check'], groups: ['dev'], timeoutMs: 10000 }] };
  await writeFile(manifestPath, JSON.stringify(config));
  assert.equal((await loadManifest(manifestPath))[0].transport, 'stdio');
  const gateway = await startGateway({ manifestPath, env: { PARENT_TOKEN: 'secret-123', PARENT_REGION: 'ap-southeast-1' }, access: { token: { id: 'tester', groups: ['dev'] } }, port: 0, auditPath: join(dir, 'audit.jsonl') });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.address.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer token' } } }));
    const matches = parse(await client.callTool({ name: 'search_tools', arguments: { query: 'env_check' } }));
    assert.equal(matches[0].tool_id, 'local/env_check');
    const tool = parse(await client.callTool({ name: 'get_tool', arguments: { tool_id: 'local/env_check' } }));
    const result = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'local/env_check', arguments: {}, schema_version: tool.schema_version } });
    assert.equal(result.content[0].text, 'secret-123:ap-southeast-1');
  } finally {
    await client.close();
    await new Promise(resolve => gateway.http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
