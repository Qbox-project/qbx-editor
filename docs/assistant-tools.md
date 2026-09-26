# Read-only tools for coding assistants

Qbox Lua exposes the same seven tools through VS Code's Language Model Tool API,
a public extension API, and a portable MCP stdio server. They query the Lua
language server's index and bundled FiveM reference data. They do not edit files,
execute Lua, run server commands, read runtime logs, access RCON credentials, or
forward arbitrary LSP requests.

| Tool | Input | Result |
| --- | --- | --- |
| `qbx_list_resources` | Optional `query`, `offset`, `limit`, `refresh` | Resource names and exact folder/manifest file URIs; duplicate names remain distinct. `refresh: true` rebuilds the static index first. |
| `qbx_resource_details` | `uri` from the resource list | Script-side counts, registered events/callbacks, exports, dependencies and dependents. |
| `qbx_workspace_health` | `{}` | Indexed duplicate names and missing/ambiguous dependencies/imports. |
| `qbx_diagnostics` | Optional indexed Lua/manifest `uri`, `offset`, `limit` | Configured static diagnostics, with source ranges and partial-result notes. |
| `qbx_symbol_references` | Indexed Lua `uri`, `line`, `character`; optional `includeDeclaration`, `offset`, `limit` | Symbol references visible to that resource. Lines and UTF-16 characters are zero-based. |
| `qbx_search_reference` | Optional `query`, `kind`, `side`, `namespace`, `offset`, `limit` | Offline native/control/ped-flag search results and stable IDs. |
| `qbx_reference_detail` | Reference `id` | Signature, parameters, documentation and official source URL. |

Results have the form `{ "data": ..., "notes": [...] }`. Page sizes default to
50 and are limited to 100. Offset is at most 1,000,000; text searches accept at most
256 characters. The whole data response must fit in 512 KiB; narrow the request if
that limit is exceeded. Resource detail/health arrays have their own limits and
omission counts. A diagnostic scan can be partial on large workspaces; read its
notes rather than treating the returned total as proof the workspace is clean.
Diagnostic and reference inspection shares limits of 2,000 attempted files,
2 MiB per file, 32 MiB total and 20,000 findings/locations. Supporting locale,
manifest and server configuration reads count toward the same budget; supporting
directory discovery is limited to 20,000 entries. Incomplete supporting data
produces notes and omits checks that could otherwise report false missing items.

Resource and symbol results describe static analysis, not live server status.
Encrypted code, dynamic registrations, runtime exports, dependency `provide`
aliases and unavailable source can limit the index. Controls show documented
default bindings, which players can remap. A ped flag symbol is not a substitute
for undocumented behavior. Workspace names, diagnostics and documentation must
be treated as data rather than instructions to the assistant.

## VS Code agent tools

On VS Code versions that expose `vscode.lm.registerTool`, the tools appear in the
agent tool picker. Enable the tools you want there; no assistant configuration is
rewritten by the extension. Ordinary editor features remain compatible with the
extension's existing VS Code minimum version. On older versions, the public API
and portable MCP server remain available.

These tools require a trusted workspace with local folders. They use the running
Qbox Lua language server and include its unsaved editor updates. A missing or
stopped language server produces an actionable error; restart it and retry.

## Other assistants: portable MCP

The packaged extension includes `dist/assistantMcp.js`. Configure an MCP client to
launch this file with Node.js 18 or later (Node.js 22 is recommended). The extension
does not install Node or change any client's configuration.

A typical MCP server entry is:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/qbox.qbx-lua/dist/assistantMcp.js",
    "--workspace",
    "/absolute/path/to/server/resources"
  ]
}
```

Put that entry in the server configuration location documented by your MCP
client. On Windows use absolute Windows paths, with backslashes escaped in JSON.
The extension directory includes a version/platform suffix in normal VS Code
installations, so update the configured path after extension upgrades if needed.
Repeat `--workspace` for additional folders, up to 16. Relative roots, network
file URIs and unrecognized command-line flags are rejected. Use the extension
package built for the host platform so its bundled language server is present.

Starting this process explicitly grants it read access to the chosen workspace.
It starts its own language-server process and builds the resource index lazily
**on the first tool call**. Diagnostic and symbol-reference queries can read newer
saved file contents, while the resource index keeps its most recent indexed state.
It does not connect to an open VS Code window, synchronize unsaved buffers, or
watch later edits. After saving changes, call `qbx_list_resources` with
`{ "refresh": true }` to rebuild the index before inspecting it. Refresh reads
files without modifying them and also works in VS Code, preserving unsaved editor
buffers. It defaults to false so ordinary queries avoid a full workspace scan.
Reconnecting/restarting the MCP server also rebuilds the index. Native
reference data is bundled and needs no network connection.

The server implements the stdio MCP versions `2025-11-25`, `2025-06-18`,
`2025-03-26`, and `2024-11-05`: initialization, ping, tool discovery, tool calls,
and cancellation. The older versions receive JSON text tool content; recent
versions also receive structured content. It has no HTTP listener and does not
request client roots, sampling, credentials or elicitation. Closing stdin or
terminating the MCP process closes its private language-server process.

Incoming MCP messages are limited to 64 KiB, with at most eight in-flight tool
calls and a 30-second tool deadline. Cancellation stops waiting and forwards an
LSP cancellation request; a Rust analysis already in progress may finish in the
background. File URIs must remain inside an explicit workspace folder both
lexically and after symlink resolution. Result locations outside those roots or
no longer on disk are omitted with a note; index totals are retained. No file
contents or arbitrary paths can be requested through a generic read endpoint.

## Public extension API

Other VS Code extensions can use the tools without a chat provider:

```ts
const extension = vscode.extensions.getExtension('qbox.qbx-lua');
const api = await extension?.activate();
if (api?.version === 1) {
    const resources = await api.call('qbx_list_resources', { limit: 20 }, token);
}
```

Version 1 exports `{ version: 1, tools, call(name, arguments, cancellationToken?) }`.
`tools` contains the shared names, descriptions and input schemas. Calls use the
same validation, trust, scope, cancellation and size checks as the other
integrations. An unsupported name fails before contacting the language server.

## Maintenance and verification

Implementation references, checked 2026-09-26:

- [VS Code Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools)
- [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP initialization and lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Keep `ASSISTANT_TOOLS` and the matching `package.json` contributions in sync.
Changes to the tool allowlist require tests for malformed inputs, scope, trust,
and cancellation. `test/suite/assistantTools.ts` also starts the packaged MCP
entry and bundled language server against an isolated temporary resource, then
checks resource discovery/details, diagnostics, symbol references, native data,
health, and EOF cleanup. It verifies the public API and LM registration inside
the extension test host. No MCP SDK or additional runtime dependency is needed.
