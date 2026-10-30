import { isAbsolute } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Gateway, loadManifest } from './gateway.js';
import { createMcpServer } from './server.js';

export async function startStdioGateway({ manifestPath = process.env.MCPX_MANIFEST, groups = process.env.MCPX_STDIO_GROUPS, principalId = process.env.MCPX_STDIO_ID ?? 'local-stdio', auditPath = process.env.MCPX_AUDIT ?? 'audit.jsonl', env = process.env } = {}) {
  if (!manifestPath || !isAbsolute(manifestPath)) throw new Error('MCPX_MANIFEST must be an absolute path for stdio mode');
  const permittedGroups = typeof groups === 'string' ? groups.split(',').map(value => value.trim()).filter(Boolean) : groups;
  if (!Array.isArray(permittedGroups) || !permittedGroups.length || !permittedGroups.every(value => typeof value === 'string')) {
    throw new Error('Set MCPX_STDIO_GROUPS to one or more comma-separated groups');
  }
  const gateway = new Gateway(await loadManifest(manifestPath), { auditPath, env });
  await gateway.refresh();
  const server = createMcpServer(gateway, { id: principalId, groups: permittedGroups });
  await server.connect(new StdioServerTransport());
  return { server, gateway };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startStdioGateway().catch(error => { console.error(`mcpx stdio: ${error.message}`); process.exitCode = 1; });
}
