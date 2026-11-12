# Resource data checks and the locale matrix

Two reports read the files of your resources directly. Neither needs the
language server, a running FXServer or a network connection, and neither
changes a file.

## Check Resource Data

Run **FiveM: Check Resource Data**:

- from the Command Palette or the **Tools** view: every resource of the
  workspace, compared with each other;
- from a resource's **FiveM** menu (Explorer, the Resources view, an editor of
  one of its files) or from the tool list behind the status bar item: that
  resource alone.

The report lists problems first, each with the file and line to open. Findings
about manifests and metadata files also appear in the Problems panel, with the
source `fivem-data`. An open report runs again when you save a `.meta` file or a
manifest; **Check again** runs it on request.

### What is checked

| Area | Finding |
| --- | --- |
| Data files | A `data_file` whose path or glob matches no file in the resource. |
| Data files | A data file that no `files` entry sends to clients. The server lists it, clients never receive it, and the game loads nothing. Files under `stream/` are sent without a `files` entry. |
| Data files | A `data_file` type one or two letters away from a type the game reads, such as `VEHICLE_LAYOUT_FILE` for `VEHICLE_LAYOUTS_FILE`. Types the list does not know are left alone. |
| Data files | Metadata that is not well-formed XML, which the game ignores as a whole. |
| Vehicles | A model in `vehicles.meta` without a `.yft` of that name in `stream/`, or a `txdName` without its `.ytd`. |
| Vehicles | A `handlingId` that no `handling.meta` of the resource defines. |
| Vehicles | A model without an entry in `carvariations.meta`, and an entry there for a model `vehicles.meta` does not list. |
| Vehicles | A mod kit used in `carvariations.meta` that no `carcols.meta` of the resource defines. |
| Vehicles, across resources | A mod kit ID or siren ID that two resources use. Vehicles that share one get each other's parts or lights. |
| Vehicles, across resources | A vehicle model that two resources define. |
| Weapons | A model in `weaponarchetypes.meta` without its `.ydr` or `.ytd` in `stream/`, and a weapon or component whose model is neither streamed nor listed as an archetype. |
| Streaming | A file name that two resources stream, or that one resource streams twice. Only one of the files is used. |
| Streaming | A streamed resource container (`.ytd`, `.ydr`, `.yft`, `.ydd`, `.ybn` and the like) that needs 16 MiB or more of physical memory, the size from which the game itself warns. From 64 MiB it is listed as an error. |
| Asset Escrow | An `escrow_ignore` pattern that matches no file, and `escrow_ignore` without `lua54 'yes'`. |
| Asset Escrow | A resource with a `.fxap` file is reported as escrowed, with the number of encrypted Lua files. |

Below the problems, **Largest streamed assets** lists the 25 files that need the
most memory, and **Streaming by resource** the total per resource.

### What the checks cannot know

- The game's own models, textures and handling are not in your workspace. A
  vehicle that reuses a base-game texture dictionary or handling name is
  reported as not provided by its resource; that warning can be ignored. A
  resource that streams no `.yft` at all is treated as metadata for existing
  models, and its models are not checked against streamed files.
- A model, texture or mod kit that another resource provides counts as missing
  in the resource that uses it.
- Physical memory is read from the header of each file, the figure the game
  reserves when loading it. Files that are not resource containers have none.
- Manifests are read as text. A `data_file` whose arguments are computed by Lua
  code is not seen.
- At most 20,000 files of a resource are read, metadata files up to 8 MiB.

Escrowed resources show a lock and the word *escrowed* in the Resources view of
the FiveM sidebar. Their encrypted Lua files cannot be analysed by the language
server either.

## Show Locale Matrix

Run **FiveM: Show Locale Matrix** for one resource or the whole workspace. It
reads the `.json` and `.lua` files directly inside a resource's `locales` (or
`locale`) folder:

- JSON files may be flat or nested; nested keys are joined with dots.
- Lua files count as far as they assign or return tables of string literals,
  which covers `Locales['en'] = { … }`, `local Translations = { … }` and
  `return { … }`. Strings built at run time are not seen.

Each language is compared with the base language of its resource: `en` where it
exists, otherwise the language with the most keys.

| Table | Content |
| --- | --- |
| Coverage | Per language: keys, keys missing compared with the base language, keys the base language lacks, and the share that is translated. |
| Missing translations | Every key of the base language that another language lacks, with the base text and a link to it. |
| Placeholder differences | Translations whose `%s`, `%d` or `%{name}` placeholders are not those of the base text. |
| Files that could not be read | Locale files with a syntax error. |

The language server reports locale keys that code uses but no locale defines,
and keys that nothing uses; the matrix adds the comparison between languages.
