#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../src/server.js';
import { startStdioGateway } from '../src/stdio.js';

function usage() {
  return `mcpx-gateway [stdio|http] [--manifest PATH] [--groups GROUPS]

Modes:
  stdio    Run as a local MCP server (default)
  http     Listen for Streamable HTTP requests at /mcp

Options:
  --manifest PATH   JSON upstream manifest; use an absolute path in MCP hosts
  --groups GROUPS   Comma-separated groups for stdio mode
  --help            Show this help
  --version         Show the package version

HTTP mode requires MCPX_ACCESS. Stdio mode requires MCPX_STDIO_GROUPS
or --groups. See README.md for configuration examples.`;
}

function parseArgs(args) {
  let mode = 'stdio';
  let manifestPath;
  let groups;
  let showHelp = false;
  let showVersion = false;
  let modeSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') showHelp = true;
    else if (arg === '--version' || arg === '-v') showVersion = true;
    else if (arg === '--manifest') {
      if (!args[i + 1]) throw new Error('--manifest requires a path');
      manifestPath = resolve(args[++i]);
    } else if (arg === '--groups') {
      if (!args[i + 1]) throw new Error('--groups requires a value');
      groups = args[++i];
    } else if ((arg === 'stdio' || arg === 'http') && !modeSeen) {
      mode = arg;
      modeSeen = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (mode === 'http' && groups !== undefined) throw new Error('--groups is only valid in stdio mode');
  return { mode, manifestPath, groups, showHelp, showVersion };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) { console.log(usage()); return; }
  if (options.showVersion) {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(packageJson.version);
    return;
  }
  if (options.mode === 'stdio') {
    await startStdioGateway({ manifestPath: options.manifestPath ?? process.env.MCPX_MANIFEST, groups: options.groups ?? process.env.MCPX_STDIO_GROUPS });
  } else {
    const { address } = await startGateway({ manifestPath: options.manifestPath ?? process.env.MCPX_MANIFEST });
    console.log(`mcpx listening on http://${address.address}:${address.port}/mcp`);
  }
}

main().catch(error => { console.error(`mcpx-gateway: ${error.message}`); process.exitCode = 1; });
