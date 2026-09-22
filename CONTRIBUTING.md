# Contributing

The VS Code adapter, syntax injections and editor setup examples live here.
Language analysis belongs in [qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls)
or the shared [qbx-lint](https://github.com/Qbox-project/qbx-lint) crates.

## Development setup

Use Node.js 22, npm and a current stable Rust toolchain. Clone all three
repositories beside one another; the language server uses sibling Cargo paths:

```sh
git clone https://github.com/Qbox-project/qbx-lint.git
git clone https://github.com/Qbox-project/qbx-lua-ls.git
git clone https://github.com/Qbox-project/qbx-editor.git
cd qbx-editor
npm ci
npm run server
npm run build
```

`npm run server` builds and copies the sibling server. Run it again after changing
server code. To copy an existing binary instead, use
`npm run server -- /absolute/path/to/qbx-lua-ls` (with `.exe` on Windows).

Open this repository in VS Code and press **F5** to launch the Extension
Development Host. Open a FiveM resource folder there. `npm run watch` rebuilds
the extension as you edit TypeScript; reload the development host to use the changes.

## Checks

Before submitting a code change, run:

```sh
npm run typecheck
npm run build
npm test
```

`npm test` compiles the tests and launches an isolated VS Code instance against
the sibling server repository's resource fixtures. The first run may download
VS Code and requires a working desktop session, or a virtual display on Linux.
The server binary must be built before running the integration tests.

Add a regression case under `test/suite/` for extension behavior changes. If a
change spans the server, also run its tests from this directory:

```sh
cargo test --locked --manifest-path ../qbx-lua-ls/Cargo.toml
```

For packaging changes, run `npm run package -- --target <platform>` with a
server binary built for that same platform, then install the resulting VSIX in a
test VS Code profile. Package targets are `win32-x64`, `linux-x64`, `linux-arm64`,
`darwin-x64` and `darwin-arm64`. Selecting a target does not cross-compile the server.

For Marketplace workflow changes, run `python -m unittest discover -s scripts -p 'test_*.py'`.
These checks cover incomplete releases, wrong platform/extension metadata, missing
server binaries and corrupted release assets.

## Issues and pull requests

Include the editor and extension versions, operating system, and a small resource
that reproduces the problem. For indexing or startup issues, include the relevant
**Qbox Lua: Show Output** log. Remove private paths, tokens and resource data before
sharing logs or fixtures.

Describe what the change fixes and which checks you ran. For editor configuration
examples, distinguish syntax checks from testing in the actual editor. Keep the
setup guide and settings documentation in step with behavior changes.
