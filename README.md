# mcpx Gateway

An MCP Gateway that connects Streamable HTTP and stdio MCP servers. Clients can connect to its HTTP `/mcp` endpoint or launch it as a stdio MCP server. Both modes expose `search_tools`, `get_tool`, and `call_tool`. It uses MCP TypeScript SDK 1.32.2 and the `2025-11-25` protocol family supported by that SDK.

## Getting started

Requires Node.js 20 or later.

Run a local demo without any other MCP server:

```bash
npm install
npm run dev
```

This starts a sample `demo/echo` MCP tool and the Gateway at `http://127.0.0.1:4100/mcp`. Use the header `Authorization: Bearer dev-token` for this local demo only.

To connect your own MCP servers:

```bash
npm install
cp config/servers.example.json config/servers.json
export MCPX_ACCESS='{"dev-token":{"id":"alice","groups":["engineering"]}}'
npm start
```

The example manifest shows five configurations: a local HTTP server, an internal HTTPS server, an issue tracker with multiple headers, a finance server with restricted group access, and a local stdio server. Its domains, paths, and tool names are placeholders. **Remove entries you have not configured**, then update the remaining entries to match your MCP servers before starting the Gateway.

The Gateway permits `http://` only for loopback endpoints; other HTTP upstreams must use `https://`. If you set `credentialEnv`, define the named environment variable, for example `export DOCS_MCP_TOKEN='...'`. Keep tokens out of the manifest. Each server's `groups` must match a group assigned to the caller in `MCPX_ACCESS`.

### Multiple environment values for HTTP upstreams

Use `headersFromEnv` to map multiple environment variables to HTTP headers. The `issue_tracker` entry demonstrates this:

```json
{
  "credentialEnv": "ISSUES_MCP_TOKEN",
  "headersFromEnv": {
    "X-Workspace-Id": "ISSUES_WORKSPACE_ID",
    "X-Client-Id": "ISSUES_CLIENT_ID"
  }
}
```

```bash
export ISSUES_MCP_TOKEN='your-token'
export ISSUES_WORKSPACE_ID='your-workspace'
export ISSUES_CLIENT_ID='your-client-id'
```

`credentialEnv` sends `Authorization: Bearer <token>`. `headersFromEnv` sends each value in the named header. All referenced variables must be set before that upstream can be used. Their values are not written to the audit log.

### stdio MCP servers

The Gateway starts the process specified by `command` and communicates with it over stdin/stdout. `command` and optional `cwd` must be absolute paths. `args` is an array and is never interpreted by a shell. Use `command -v node` to find your Node.js executable, then adjust the example:

```json
{
  "id": "local_files",
  "transport": "stdio",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/files-mcp-server.js"],
  "envFromEnv": {
    "FILES_API_KEY": "LOCAL_FILES_API_KEY",
    "FILES_WORKSPACE": "LOCAL_FILES_WORKSPACE"
  },
  "allowTools": ["list_files", "read_file"],
  "groups": ["engineering"]
}
```

```bash
export LOCAL_FILES_API_KEY='your-key'
export LOCAL_FILES_WORKSPACE='/path/to/workspace'
```

In `envFromEnv`, each key is the variable name the child process receives; its value is the variable name defined in the Gateway's environment. The child receives the MCP SDK's limited default environment plus these mapped values, not the Gateway's entire environment. The current implementation starts a new process for each tool listing or call, so stateless servers work best. It does not yet isolate child processes in a container or sandbox. Run only trusted executables under an appropriately restricted system account.

### Connecting a client

For a client that supports remote MCP, use `http://127.0.0.1:4100/mcp` and the HTTP header `Authorization: Bearer <token from MCPX_ACCESS>`.

### Running the Gateway as a stdio MCP server

Set `MCPX_MANIFEST` to an absolute path and `MCPX_STDIO_GROUPS` to the groups this local client may access. The Gateway uses the same manifest, tool discovery, and call routing as HTTP mode. It does not require `MCPX_ACCESS` because the local MCP host launches the process and owns its stdin/stdout connection.

Example MCP host configuration (replace both absolute paths):

```json
{
  "mcpServers": {
    "mcpx": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcpx/src/stdio.js"],
      "env": {
        "MCPX_MANIFEST": "/absolute/path/to/mcpx/config/servers.json",
        "MCPX_STDIO_GROUPS": "engineering",
        "MCPX_STDIO_ID": "local-user",
        "MCPX_AUDIT": "/absolute/path/to/mcpx/audit.jsonl"
      }
    }
  }
}
```

If an upstream uses `credentialEnv` or `envFromEnv`, also pass those environment variables to the Gateway process through your host's secure environment settings. Run `command -v node` to find the Node.js executable. `npm run start:stdio` is the equivalent command for a terminal or process manager. stdout is reserved for MCP messages; startup errors go to stderr. The configured groups are a local trust setting, not authentication for untrusted callers.

`GET /health` reports Gateway and upstream status without authentication. Keep it on an internal network or block external access. The Gateway binds to `127.0.0.1` by default. You can set `HOST`, `PORT`, `MCPX_MANIFEST`, and `MCPX_AUDIT`.

Run the integration tests with `npm test`. They require permission to bind loopback ports.

## Current scope

- The manifest is JSON and is read at startup; restart the Gateway after changing it.
- The tool catalog is refreshed at startup. There is no admin API or background refresh yet.
- HTTP and stdio are supported on both the client-facing and upstream sides. Expanded tool mode, OAuth, and approval for write operations remain future work.
- HTTP authentication uses bearer tokens from `MCPX_ACCESS`. Stdio mode trusts the launching host and uses `MCPX_STDIO_GROUPS` for access scope. Put the HTTP Gateway behind your organization's reverse proxy or identity provider for real deployments.
- The audit log is JSONL and stores metadata only, not tool arguments or results.

See [MCP_GATEWAY_DESIGN.md](MCP_GATEWAY_DESIGN.md) for the architecture and planned work.
