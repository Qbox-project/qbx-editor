# Lua utilities

Run **Qbox Lua: Open Lua Utilities** to open one reusable offline tab. The panel is
loaded on demand, makes no network requests and never executes its Lua preview.

## joaat hashes

Enter a model, weapon or other asset name to copy or insert its eight-digit hex,
signed decimal or unsigned decimal hash. All three represent the same 32 bits.
ASCII A–Z is folded to a–z; spaces are retained. For example, `adder` produces
`0xB779A091`, `-1216765807` and `3078201489`.

The algorithm follows the [Cfx Lua `luaO_HashString` implementation](https://github.com/citizenfx/lua/blob/luaglm-dev/cfx/lglm.cpp)
and [Lua `joaat` binding](https://github.com/citizenfx/lua/blob/luaglm-dev/cfx/lbaselib.c).
The calculator supports printable ASCII input, at most 4,096 characters. It
rejects non-ASCII characters, NUL and other control characters: the upstream
`char`/`tolower` implementation is not a portable Unicode case-folding contract.
The native [Cfx `HashString` helper](https://github.com/citizenfx/fivem/blob/master/code/client/shared/Utils.h)
also folds ASCII only. No Unicode lowercasing or input trimming is silently applied.

## Colors

Use the native color picker, enter hexadecimal color text, or edit R/G/B/A
channels. Supported hex forms are `#RGB`, `#RGBA`, `#RRGGBB`, and `#RRGGBBAA`;
alpha is last and defaults to 255. Channels must be integers from 0 to 255.

Copy hex, RGB/RGBA argument lists, a Lua `{ r, g, b, a }` table, or `vec3(...)`.
Lua values remain in the 0–255 range; the tool does not silently normalize them.

## JSON to Lua

Paste strict JSON or select JSON in an editor and choose **Use editor selection**.
Press **Convert to Lua**, review the editable preview, then copy or insert it.
The panel keeps the preview separate from its JSON input: changing the input or
the null option requires another conversion. Copy and Insert always use exactly
the visible preview, including your edits. Drafts remain in the local webview state.

- Object key order is preserved. Lua keywords and non-identifier keys are quoted;
  strings are escaped as Lua strings, including literal backslashes and controls.
  Duplicate JSON keys and unpaired Unicode surrogates are rejected.
- Arrays become tables with explicit indices starting at 1. Empty arrays and
  empty objects both become `{}`; plain Lua tables do not preserve that JSON distinction.
- JSON null defaults to FiveM's `json.null` sentinel, defined by the bundled
  [JSON library](https://github.com/citizenfx/fivem/blob/master/data/shared/citizen/scripting/lua/json.lua).
  Choosing `nil` removes object keys and creates holes in arrays; the panel warns
  that Lua length and `ipairs` behavior changes.
- Numeric source tokens are retained without passing through JavaScript numeric
  serialization. Plain integers use Lua's signed 64-bit range, including integers
  above JavaScript's safe integer range. Out-of-range integers are rejected.
  The minimum integer is emitted as `(-9223372036854775807 - 1)` to avoid an
  overflowing positive literal; negative zero is emitted as `-0.0`.
- Decimal/exponent values remain verbatim and receive an explicit warning about
  Lua binary floating-point precision. Overflow, underflow, and decimal/exponent
  integers beyond safe floating-point integer precision are rejected. Store exact
  large decimal quantities as JSON strings when that precision matters.

Input is limited to 128 KiB, 64 nesting levels and 10,000 values. The generated or
edited Lua preview is limited to 512 KiB. No clipboard read, file write, formatter
execution or network access happens during conversion.

## Inserting safely

Opening the panel captures your last Lua document, selection and document version.
**Use current Lua selection** captures them again. **Use editor selection** reads
the last text editor's selection and refreshes the Lua insertion target; JSON can
be copied from another language's editor without making that file an insertion target.

The target is shown beneath the tools. Insertion replaces the captured selection
as literal text, so `$0`, `${...}` and backslashes never expand as snippets.
If the document changed or closed, insertion is refused. A successful insertion
clears the target; capture a fresh selection before inserting again. Closing the
panel cancels pending panel work; extension disposal releases the editor listeners.
