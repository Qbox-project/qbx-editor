# Contributing

The VS Code adapter, syntax injections and editor setup examples live here.
Language analysis belongs in [qbx-lua-ls](https://github.com/Qbox-project/qbx-lua-ls)
or the shared [qbx-lint](https://github.com/Qbox-project/qbx-lint) crates.

## Development setup

Use Node.js 22, npm and a current stable Rust toolchain. Follow the
[source setup in the README](README.md#build-from-source) to clone all three
repositories beside one another. From the `qbx-editor` directory, run:

```sh
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
test VS Code profile. Supported package targets are listed in the README.

## Issues and pull requests

Include the editor and extension versions, operating system, and a small resource
that reproduces the problem. For indexing or startup issues, include the relevant
**Qbox Lua: Show Output** log. Remove private paths, tokens and resource data before
sharing logs or fixtures.

Describe what the change fixes and which checks you ran. For editor configuration
examples, distinguish syntax checks from testing in the actual editor. Keep the
setup guide and settings documentation in step with behavior changes.

## Releases

Keep the package version, lockfile and changelog in step. Release tags use `v` followed by
that version, such as `v1.0.0`; the workflow rejects a tag that does not match the package.

Release the matching tag in `qbx-lint` first, then `qbx-lua-ls`, then `qbx-editor`. The server
and editor release workflows check out that same tag in their dependencies. Each workflow
builds all supported platforms before attaching the files and checksums to a GitHub Release.
The editor workflow does not publish to an extension marketplace.
