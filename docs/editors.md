# Editor setup

`qbx-editor` contains the VS Code adapter, a Zed extension and configuration
examples for other editors. They use the [qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls)
language server.

| Editor | Current status |
| --- | --- |
| VS Code | Extension package with an automated integration suite. See the [installation guide](../README.md#install-in-vs-code). |
| Neovim 0.11+ | Configuration example below; not integration-tested in Neovim. |
| Zed | Extension in [`integrations/zed`](../integrations/zed); see [Zed](#zed) below. Not integration-tested in Zed. |
| Helix | Configuration example below; not integration-tested in Helix. |
| Other LSP clients | Need client-specific configuration or an adapter, followed by validation. |
| JetBrains IDEs | Need a compatible LSP integration or a dedicated adapter; none is shipped here. |

A `.vsix` is the VS Code adapter, not a universal editor package. Other clients
run the standalone server. JetBrains describes its adapter API in the
[IntelliJ Platform LSP documentation](https://plugins.jetbrains.com/docs/intellij/language-server-protocol.html).

## Zed

The CfxLua extension is not in the Zed extension registry; install it as a dev
extension:

1. Install Rust through [rustup](https://rustup.rs). Zed compiles the extension
   with it and adds the WebAssembly target itself.
2. Clone this repository.
3. In Zed, run **zed: install dev extension** and select `integrations/zed`.
4. Run **zed: open settings** and add this line inside the outer braces:

   ```json
   "file_types": { "CfxLua": ["lua"] },
   ```

5. Restart Zed.

The extension adds a CfxLua language and starts `qbx-lua-ls` for it. The
`file_types` line makes every `.lua` file CfxLua, even when Zed's Lua or EmmyLua
extension is installed, so LuaLS and EmmyLua never start. Zed may still offer
the Lua extension when you open a `.lua` file; it is not needed. To keep another
Lua setup for non-FiveM projects, put the line in `.zed/settings.json` inside the
server or resource folder instead.

The server comes from `lsp.qbx-lua-ls.binary.path` when set, then `qbx-lua-ls` on
`PATH`, and otherwise the latest
[qbx-lua-ls release](https://github.com/Qbox-project/qbx-lua-ls/releases) for
Windows x64, Linux x64/ARM64 or macOS x64/ARM64 is downloaded automatically.
Server releases are picked up on the next Zed start. To update the extension
itself, pull this repository, click **Rebuild** on CfxLua in the extensions page
and restart Zed; Zed can keep the old server stopped until it restarts.

Everything else is optional. Zed leaves inlay hints and semantic highlighting
off by default, and server options go in `initialization_options`:

```json
{
  "lsp": {
    "qbx-lua-ls": {
      "initialization_options": {
        "library": [],
        "diagnostics": { "enable": true, "workspace": true }
      }
    }
  },
  "inlay_hints": { "enabled": true },
  "semantic_tokens": "combined"
}
```

Zed starts one server for each folder you open rather than for each
`fxmanifest.lua`. Run **editor: restart language server** after changing
`library`. Syntax highlighting uses the standard Lua Tree-sitter grammar, so
compound assignment such as `+=` may be colored as an error; diagnostics come from
the server only. Use **zed: open log**, or start `zed --foreground` from a
terminal, to see download or startup errors.

## Obtain the server

Download the archive for your operating system and architecture from
[qbx-lua-ls releases](https://github.com/Qbox-project/qbx-lua-ls/releases).
Extract the executable before configuring the editor.

To build locally, follow the [source setup](../README.md#build-from-source) to
clone the sibling repositories, then run this from the `qbx-editor` root:

```sh
cargo build --release --locked --manifest-path ../qbx-lua-ls/Cargo.toml
```

The built executable is `../qbx-lua-ls/target/release/qbx-lua-ls` (`qbx-lua-ls.exe`
on Windows). Add its directory to `PATH`, or use its absolute path in the client
configuration. `qbx-lua-ls --version` should work in the editor's environment.
The server speaks LSP over standard input/output when launched with no arguments.

## Neovim 0.11+

Copy [`integrations/neovim/qbx.lua`](../integrations/neovim/qbx.lua) to
`lua/qbx.lua` inside your Neovim configuration directory and add this to `init.lua`:

```lua
require('qbx')
```

The example starts a server only for Lua files beneath `fxmanifest.lua` or
`__resource.lua`, with one connection per resource root. Add absolute library
folders in `init_opts.library` if dependencies live outside that resource.
Disable other Lua servers for these buffers to avoid duplicate results.

Open a resource's Lua file and run `:checkhealth vim.lsp`. Try `K` for hover,
`grn` for rename, `<C-x><C-o>` for completion, and
`:lua vim.lsp.buf.format()` for formatting. These use Neovim's built-in client;
no `nvim-lspconfig` plugin is required. See the
[Neovim LSP manual](https://neovim.io/doc/user/lsp.html) for client configuration
and UI options.

## Helix

Merge [`integrations/helix/languages.toml`](../integrations/helix/languages.toml)
into `.helix/languages.toml` in the resource directory. It selects
`qbx-lua-ls` for Lua and uses the manifest files as root markers. From that resource
directory, run `hx --health lua` in a terminal to inspect server discovery, then open Helix.
The example's `library` list accepts absolute folders for external dependencies.

The example replaces the resource's Lua server list. Remove another explicit
`formatter` setting if formatting should use the language server. See the
[Helix language configuration documentation](https://docs.helix-editor.com/languages.html)
for configuration merging and supported LSP features.

## Options and current limits

The server options correspond to the VS Code `qbxLua` settings, but
`initializationOptions` is a **flat object**. Neovim calls it `init_opts`;
Helix calls it `language-server.<name>.config`; Zed calls it
`lsp.qbx-lua-ls.initialization_options`:

```json
{
  "library": ["/absolute/path/to/server/resources"],
  "diagnostics": {
    "enable": true,
    "workspace": true,
    "rules": { "unused-local": "warning" }
  },
  "inlayHints": { "enable": true },
  "semanticTokens": { "enable": true }
}
```

Do not send dotted keys such as `qbxLua.library`, or a `qbxLua` wrapper, in
initialization options. A `workspace/didChangeConfiguration` notification may
use either the flat settings object or `{ "qbxLua": { ... } }`. Restart the
server after changing library folders or workspace roots; roots are selected
during initialization. Formatting and lint configuration also use `qbxlint.toml`.

Completion, diagnostics, navigation, rename and formatting use ordinary LSP
methods, subject to each client's supported features. The VS Code status bar,
snippet browser, commands and CfxLua TextMate grammar belong to its adapter.
Connecting another client does not install that grammar; its Lua syntax parser
may still flag CfxLua syntax even when the server accepts it.

Clients that do not send watched-file changes can miss edits made outside the
editor. Restart the server to refresh the workspace, or integrate the custom
`qbx/reindex` request. The optional `qbx/status`, `qbx/fileInfo` and `qbx/snippets`
requests also need client UI code. These examples do not add that UI.
