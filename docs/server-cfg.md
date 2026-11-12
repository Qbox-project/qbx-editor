# server.cfg support

A file named `server.cfg` opens as **FiveM Server Config**. Other `.cfg` files
that hold server commands, such as the `resources.cfg` or `permissions.cfg` that
a `server.cfg` runs with `exec`, switch to the same language when they are
opened in a workspace with FiveM resources. To choose it yourself, use **Change
Language Mode** or add the file to `files.associations` with the language
`fivem-cfg`.

## While you type

- **Commands and variables:** `ensure`, `start`, `stop`, `restart`, `exec`,
  `set`, `sets`, `setr`, `add_ace`, `add_principal`, the endpoint commands and
  the server variables used most (`sv_hostname`, `sv_maxclients`,
  `sv_enforceGameBuild`, `onesync`, `sv_scriptHookAllowed` and others), each with
  a short explanation.
- **Values:** variables with a fixed set of values, such as `onesync` or
  `sv_entityLockdown`, offer those values.
- **Resources:** after `ensure`, `start`, `stop` or `restart`, the resources in
  the `resources` folder beside the file, and its category folders such as
  `[qbx]`. Without such a folder, every resource of the workspace is offered.
- **Files:** after `exec`, the other `.cfg` files in the same folder.

Hovering a command or variable shows its form and what it does; hovering a
resource name shows where it is and what it depends on. The target of an `exec`
is a link.

The list of variables is a selection. Resources register commands and variables
of their own, so a name the extension does not know is never reported.

## Checks

Problems appear as you type, with the source `fivem-cfg`:

| Finding | Severity |
| --- | --- |
| `exec` of a file that does not exist beside the configuration file. | Warning |
| `ensure` or `start` of a resource that is not in the `resources` folder beside the file, or of a category no resource is in. | Warning |
| A resource whose manifest depends on one that is not among those resources. It cannot start. | Warning |
| A resource started before a dependency that the file starts later. The server starts the dependency early; listing dependencies first keeps the order you read. | Information |
| A resource that depends on one the file never starts. The server starts it on demand. | Information |
| `ensure` of a resource that an earlier line already started, which restarts it. | Information |

Resource names are only checked when the file has a `resources` folder beside it
that is part of the workspace. A configuration file opened on its own, or one
whose resources live elsewhere, gets completion and hovers but no resource
findings. Dependencies are read from the `dependency` and `dependencies`
entries of each manifest; constraints such as `/server:5181` or `/onesync` are
not resources and are skipped.

Nothing is sent to a server, and no command is run.
