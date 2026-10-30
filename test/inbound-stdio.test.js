import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const gatewayEntry = fileURLToPath(new URL('../bin/mcpx-gateway.js', import.meta.url));
const upstreamEntry = fileURLToPath(new URL('./fixtures/stdio-server.js', import.meta.url));
const parse = result => JSON.parse(result.content[0].text);

test('stdio client discovers and calls a stdio upstream through the gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpx-inbound-stdio-'));
  const manifestPath = join(dir, 'servers.json');
  await writeFile(manifestPath, JSON.stringify({ servers: [{
    id: 'local', transport: 'stdio', command: process.execPath, args: [upstreamEntry],
    envFromEnv: { STDIO_TOKEN: 'PARENT_TOKEN', STDIO_REGION: 'PARENT_REGION' },
    allowTools: ['env_check'], groups: ['dev'], timeoutMs: 10000
  }] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [gatewayEntry],
    env: { ...getDefaultEnvironment(), MCPX_MANIFEST: manifestPath, MCPX_STDIO_GROUPS: 'dev', MCPX_AUDIT: join(dir, 'audit.jsonl'), PARENT_TOKEN: 'stdio-secret', PARENT_REGION: 'eu-west-1' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'inbound-stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 10000 });
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['search_tools', 'get_tool', 'call_tool']);
    const found = parse(await client.callTool({ name: 'search_tools', arguments: { query: 'env_check' } }));
    assert.equal(found[0].tool_id, 'local/env_check');
    const tool = parse(await client.callTool({ name: 'get_tool', arguments: { tool_id: 'local/env_check' } }));
    const result = await client.callTool({ name: 'call_tool', arguments: { tool_id: 'local/env_check', arguments: {}, schema_version: tool.schema_version } });
    assert.equal(result.content[0].text, 'stdio-secret:eu-west-1');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
