import { createHash, randomUUID } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import Ajv from 'ajv';

const ajv = new Ajv({ strict: false, allErrors: true });
const TOOL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVER_ID = /^[A-Za-z0-9_.-]+$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'connection']);

export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function loadManifest(path) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(data.servers)) throw new Error('Manifest needs servers array');
  const ids = new Set();
  for (const server of data.servers) {
    if (!SERVER_ID.test(server.id ?? '') || ids.has(server.id)) throw new Error(`Invalid or duplicate server id: ${server.id}`);
    ids.add(server.id);
    server.transport ??= 'streamable_http';
    if (server.transport === 'streamable_http') {
      const url = new URL(server.endpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error(`Server ${server.id} must use HTTPS or loopback HTTP`);
      }
      if (server.envFromEnv !== undefined) throw new Error(`envFromEnv is only for stdio server ${server.id}`);
    } else if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || !isAbsolute(server.command)) throw new Error(`stdio command for ${server.id} must be an absolute path`);
      if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(x => typeof x === 'string'))) throw new Error(`Invalid stdio args for ${server.id}`);
      if (server.cwd !== undefined && (typeof server.cwd !== 'string' || !isAbsolute(server.cwd))) throw new Error(`stdio cwd for ${server.id} must be an absolute path`);
      if (server.credentialEnv || server.headersFromEnv) throw new Error(`HTTP credentials are not valid for stdio server ${server.id}`);
      if (server.envFromEnv !== undefined) {
        if (!server.envFromEnv || Array.isArray(server.envFromEnv) || typeof server.envFromEnv !== 'object') throw new Error(`Invalid envFromEnv for ${server.id}`);
        for (const [childName, parentName] of Object.entries(server.envFromEnv)) {
          if (!ENV_NAME.test(childName) || typeof parentName !== 'string' || !ENV_NAME.test(parentName)) throw new Error(`Invalid envFromEnv mapping for ${server.id}`);
        }
      }
    } else {
      throw new Error(`Unsupported transport for ${server.id}: ${server.transport}`);
    }
    if (!Array.isArray(server.groups) || !server.groups.every(x => typeof x === 'string')) throw new Error(`Invalid groups for ${server.id}`);
    if (!Array.isArray(server.allowTools) || !server.allowTools.every(x => typeof x === 'string')) throw new Error(`Invalid allowTools for ${server.id}`);
    if (server.credentialEnv && !ENV_NAME.test(server.credentialEnv)) throw new Error(`Invalid credentialEnv for ${server.id}`);
    if (server.headersFromEnv !== undefined) {
      if (!server.headersFromEnv || Array.isArray(server.headersFromEnv) || typeof server.headersFromEnv !== 'object') throw new Error(`Invalid headersFromEnv for ${server.id}`);
      for (const [header, envName] of Object.entries(server.headersFromEnv)) {
        const lower = header.toLowerCase();
        if (!HEADER_NAME.test(header) || lower.startsWith('mcp-') || RESERVED_HEADERS.has(lower) || (server.credentialEnv && lower === 'authorization')) throw new Error(`Invalid header ${header} for ${server.id}`);
        if (typeof envName !== 'string' || !ENV_NAME.test(envName)) throw new Error(`Invalid environment variable for header ${header} in ${server.id}`);
      }
    }
    server.timeoutMs = Math.min(Math.max(server.timeoutMs ?? 10000, 1000), 60000);
  }
  return data.servers;
}

export class Gateway {
  constructor(servers, { auditPath = 'audit.jsonl', env = process.env } = {}) {
    this.servers = servers;
    this.auditPath = auditPath;
    this.env = env;
    this.tools = new Map();
    this.health = new Map();
  }

  async withClient(server, fn) {
    let transport;
    if (server.transport === 'stdio') {
      const childEnv = getDefaultEnvironment();
      for (const [childName, parentName] of Object.entries(server.envFromEnv ?? {})) {
        const value = this.env[parentName];
        if (!value) throw new GatewayError('UPSTREAM_CREDENTIAL_MISSING', `Environment variable ${parentName} is missing for ${server.id}`);
        childEnv[childName] = value;
      }
      transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], cwd: server.cwd, env: childEnv, stderr: 'ignore' });
    } else {
      const token = server.credentialEnv ? this.env[server.credentialEnv] : undefined;
      if (server.credentialEnv && !token) throw new GatewayError('UPSTREAM_CREDENTIAL_MISSING', `Credential unavailable for ${server.id}`);
      const headers = new Headers();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      for (const [header, envName] of Object.entries(server.headersFromEnv ?? {})) {
        const value = this.env[envName];
        if (!value) throw new GatewayError('UPSTREAM_CREDENTIAL_MISSING', `Environment variable ${envName} is missing for ${server.id}`);
        headers.set(header, value);
      }
      transport = new StreamableHTTPClientTransport(new URL(server.endpoint), {
        requestInit: { headers, redirect: 'error' }
      });
    }
    const client = new Client({ name: 'mcpx-gateway', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: server.timeoutMs });
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async refreshServer(server) {
    try {
        const found = await this.withClient(server, async client => {
          const all = [];
          let cursor;
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout: server.timeoutMs });
            all.push(...page.tools);
            cursor = page.nextCursor;
          } while (cursor);
          return all;
        });
        const next = new Map(this.tools);
        for (const id of next.keys()) if (id.startsWith(`${server.id}/`)) next.delete(id);
        for (const tool of found) {
          if (!server.allowTools.includes(tool.name)) continue;
          const id = `${server.id}/${tool.name}`;
          if (!TOOL_ID.test(id)) continue;
          const schemaVersion = `sha256:${createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex')}`;
          next.set(id, { id, server, tool, schemaVersion, validate: ajv.compile(tool.inputSchema) });
        }
        this.tools = next;
        this.health.set(server.id, { ok: true, checkedAt: new Date().toISOString() });
    } catch (error) {
      this.health.set(server.id, { ok: false, checkedAt: new Date().toISOString(), error: error.message });
      throw error;
    }
  }

  async refresh() {
    for (const server of this.servers) {
      try { await this.refreshServer(server); } catch { /* Keep last known catalog entry for diagnostics. */ }
    }
  }

  permitted(entry, principal) {
    return entry.server.groups.some(group => principal.groups.includes(group));
  }

  lookup(toolId, principal) {
    const entry = this.tools.get(toolId);
    if (!entry || !this.permitted(entry, principal)) throw new GatewayError('NOT_FOUND', 'Tool not found');
    return entry;
  }

  search({ query, limit = 5, server: serverId }, principal) {
    if (typeof query !== 'string' || !query.trim()) throw new GatewayError('INVALID_INPUT', 'query is required');
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const entry of this.tools.values()) {
      if (!this.permitted(entry, principal) || (serverId && entry.server.id !== serverId)) continue;
      const name = entry.tool.name.toLowerCase();
      const title = (entry.tool.title ?? '').toLowerCase();
      const description = (entry.tool.description ?? '').toLowerCase();
      const score = terms.reduce((n, term) => n + (name === term ? 10 : name.includes(term) ? 5 : title.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0);
      if (score > 0) matches.push({ score, tool_id: entry.id, title: entry.tool.title ?? entry.tool.name, description: (entry.tool.description ?? '').slice(0, 240), server_id: entry.server.id, schema_version: entry.schemaVersion });
    }
    return matches.sort((a, b) => b.score - a.score || a.tool_id.localeCompare(b.tool_id)).slice(0, Math.min(Math.max(limit, 1), 20));
  }

  getTool(toolId, principal) {
    const entry = this.lookup(toolId, principal);
    return { tool_id: entry.id, name: entry.tool.name, title: entry.tool.title, description: entry.tool.description, inputSchema: entry.tool.inputSchema, outputSchema: entry.tool.outputSchema, annotations: entry.tool.annotations, schema_version: entry.schemaVersion };
  }

  async call({ tool_id: toolId, arguments: args = {}, schema_version: schemaVersion }, principal) {
    const requestId = randomUUID();
    const started = Date.now();
    let status = 'error';
    try {
      const entry = this.lookup(toolId, principal);
      try { await this.refreshServer(entry.server); } catch { throw new GatewayError('UPSTREAM_ERROR', `Upstream unavailable; request_id=${requestId}`); }
      const current = this.lookup(toolId, principal);
      if (schemaVersion !== current.schemaVersion) throw new GatewayError('SCHEMA_CHANGED', 'Tool schema changed; call get_tool again');
      if (!current.validate(args)) throw new GatewayError('INVALID_ARGUMENTS', ajv.errorsText(current.validate.errors));
      const result = await this.withClient(current.server, client => client.callTool({ name: current.tool.name, arguments: args }, undefined, { timeout: current.server.timeoutMs }));
      status = result.isError ? 'tool_error' : 'ok';
      return { ...result, request_id: requestId };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('UPSTREAM_ERROR', `Upstream call failed; request_id=${requestId}`);
    } finally {
      await appendFile(this.auditPath, JSON.stringify({ request_id: requestId, at: new Date().toISOString(), caller: principal.id, tool_id: toolId, status, latency_ms: Date.now() - started }) + '\n');
    }
  }
}
