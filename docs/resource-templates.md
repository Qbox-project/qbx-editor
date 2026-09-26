# Resource templates

`src/resourceTemplates.ts` maintains three small, offline Lua starters. Each
generates exactly `fxmanifest.lua`, `shared/config.lua`, `client/main.lua` and
`server/main.lua`. The wizard previews all four files before creating a new
folder. Client and server entry files contain comments; the shared file creates
an empty `Config` table in each runtime.

| Template | Shared imports, in load order | Direct resource dependencies |
| --- | --- | --- |
| Plain Lua | `shared/config.lua` | None |
| Lua + ox_lib | `@ox_lib/init.lua`, `shared/config.lua` | `ox_lib` |
| Qbox | `@ox_lib/init.lua`, `@qbx_core/modules/lib.lua`, `shared/config.lua` | `ox_lib`, `qbx_core` |

The Qbox starter exposes the documented `qbx` utility table and ox_lib's `lib`.
Core functionality can be accessed through `exports.qbx_core`. Modules such as
player data can be added when the resource needs them. The templates add no
example events, commands, database calls, NUI files or runtime feature flags.
Dependencies must already be installed and configured on the server; the wizard
does not download dependencies or change `server.cfg`.

## Sources and compatibility

Reviewed on **2026-09-26** against these primary sources:

- [Cfx resource manifest documentation](https://docs.fivem.net/docs/scripting-reference/resource-manifest/)
  defines `cerulean`, `gta5`, shared/client/server script directives and dependency
  ordering. It states that Lua 5.4 is now the default and `lua54` is deprecated.
- [Overextended ox_lib usage](https://overextended.dev/docs/ox_lib#usage) documents
  the shared `@ox_lib/init.lua` import and the `lib` global.
- [Qbox lib module installation](https://docs.qbox.re/resources/qbx_core/modules/lib)
  requires `@qbx_core/modules/lib.lua` after the ox_lib initializer. Its older
  `lua54` instruction is superseded by the current Cfx runtime documentation.
- [Qbox core exports](https://docs.qbox.re/resources/qbx_core/exports/server) and
  [optional player-data module](https://docs.qbox.re/resources/qbx_core/modules/playerdata)
  distinguish core exports from the additional client `QBX.PlayerData` module.
- [Qbox lib source](https://github.com/Qbox-project/qbx_core/blob/main/modules/lib.lua)
  and [ox_lib initializer source](https://github.com/overextended/ox_lib/blob/main/init.lua)
  corroborate the import order and globals. The local showcase fixture copies
  were also inspected: `qbx_core` manifest version **1.24.0** and `ox_lib`
  manifest version **3.39.0**. These are reference versions, not a claim about
  dependencies installed on a user's server or minimum supported versions.
- [Microsoft file naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
  identify reserved device names. The wizard restricts new resource names to
  1–64 ASCII letters, digits, underscores or hyphens, preserves case, and rejects
  those reserved names. This portable subset also works with the extension's
  exact-resource console commands.

The generated skeletons are maintained here; dependency implementations and
documentation text are not vendored. The extension makes no online request when
generating or previewing a template. Manifest resource dependencies express load
ordering, not package versions or installation checks.

## Updating templates

1. Recheck the Cfx manifest reference and the primary library import documentation.
   Resolve conflicting runtime advice against Cfx's current documentation.
2. Inspect the imported module source and note the reviewed date and reference
   version above. Keep the startup contents small; add optional integrations only
   through a separately reviewed template change.
3. Update the pure generator and regression cases together. Check the exact four
   paths, manifest references, import order, declared dependencies, inert entry
   files, resource-name validation and safe preview fencing.
4. Run `npm run typecheck`, `npm run build` and `npm test`. When validating startup
   behavior, use an isolated test server with matching dependencies and record
   the versions actually tested. A generated preview or unit test does not verify
   the user's server setup.
