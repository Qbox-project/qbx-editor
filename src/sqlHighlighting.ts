import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';

/** The grammar that highlights SQL in database calls and below `---@language sql`. VS Code reads it when a window starts. */
export const SQL_GRAMMAR = 'syntaxes/sql.injection.json';
/** The grammar that highlights SQL in calls of the workspace's own query functions. VS Code reads it when a window starts. */
export const SQL_FUNCTIONS_GRAMMAR = 'syntaxes/sql-functions.injection.json';
const INJECTION_SELECTOR = 'L:source.lua -comment -string -meta.embedded.block.sql -meta.function.lua';

const QUERY_METHODS = ['query', 'single', 'scalar', 'insert', 'update', 'prepare', 'rawExecute', 'execute'];
const LEGACY_METHODS = ['fetchAll', 'fetchScalar', 'fetchSingle', 'execute', 'insert', 'store'];
const OXMYSQL_EXPORTS = ['query', 'single', 'scalar', 'insert', 'update', 'prepare', 'rawExecute', 'execute', 'fetch'];

/** The ways a call writes `exports.resource:`, for a fixed-length lookbehind. */
function exportPrefixes(resource: string): string[] {
    return [String.raw`\bexports\.${resource}:`, String.raw`\bexports\['${resource}'\]:`, String.raw`\bexports\["${resource}"\]:`];
}

/**
 * `names` written after one of `prefixes`, which end in the `.` or `:` that a call pattern starts
 * at. Each name checks its prefix in a lookbehind after it, since a pattern that starts with a
 * lookbehind is tried at every character of a line.
 */
function after(prefixes: readonly string[], names: readonly string[]): string {
    return names.map((name) => `${name}(?<=${prefixes.map((prefix) => prefix + name).join('|')})`).join('|');
}

/** The begin of a call of one of the `after` names, with the name as capture 1. */
function callBegin(names: readonly string[]): string {
    return String.raw`[.:](${names.join('|')})\s*(\()`;
}

function sqlString(quote: string, kind: string, start = ''): Record<string, unknown> {
    return {
        begin: quote + start,
        beginCaptures: { 0: { name: `string.quoted.${kind}.lua punctuation.definition.string.begin.lua` } },
        end: String.raw`${quote}|(?=\n)`,
        endCaptures: { 0: { name: `string.quoted.${kind}.lua punctuation.definition.string.end.lua` } },
        contentName: 'meta.embedded.block.sql',
        patterns: [{ include: `#sql-in-${kind}` }],
    };
}

const LONG_SQL_STRING = {
    begin: String.raw`(?<!--)\[(=*)\[`,
    beginCaptures: { 0: { name: 'string.quoted.other.multiline.lua punctuation.definition.string.begin.lua' } },
    end: String.raw`\]\1\]`,
    endCaptures: { 0: { name: 'string.quoted.other.multiline.lua punctuation.definition.string.end.lua' } },
    contentName: 'meta.embedded.block.sql',
    patterns: [{ include: '#sql-in-multiline' }],
};

const SQL_QUOTES = [["'", 'single'], ['"', 'double'], ['`', 'other.backtick']];

/**
 * VS Code's SQL grammar for the text of a Lua string that ends before `stop`, with the comments,
 * strings and quoted names that it would run on past the end of the Lua string ended there. A long
 * string's level is not known here, so any closing long brackets end them.
 */
function sqlContent(stop: string, luaQuote?: string): Record<string, unknown> {
    const escapes = luaQuote ? [{ include: 'source.lua#escaped_char' }] : [];
    const until = (close: string) => String.raw`${close}|(?=${stop})`;
    return {
        patterns: [
            ...escapes,
            { match: String.raw`^[ \t]+(?=--)`, name: 'punctuation.whitespace.comment.leading.sql' },
            {
                begin: '--',
                beginCaptures: { 0: { name: 'punctuation.definition.comment.sql' } },
                end: String.raw`(?=${stop}|$)`,
                name: 'comment.line.double-dash.sql',
                patterns: escapes,
            },
            {
                begin: String.raw`/\*`,
                beginCaptures: { 0: { name: 'punctuation.definition.comment.sql' } },
                end: until(String.raw`\*/`),
                endCaptures: { 0: { name: 'punctuation.definition.comment.sql' } },
                name: 'comment.block',
                patterns: escapes,
            },
            ...SQL_QUOTES.filter(([quote]) => quote !== luaQuote).map(([quote, kind]) => ({
                begin: quote === "'" ? String.raw`(?:(?<![a-zA-Z0-9_])N)?'` : quote,
                beginCaptures: { 0: { name: 'punctuation.definition.string.begin.sql' } },
                end: until(quote),
                endCaptures: { 0: { name: 'punctuation.definition.string.end.sql' } },
                name: `string.quoted.${kind}.sql`,
                patterns: luaQuote ? escapes : [{ include: 'source.sql#string_escape' }],
            })),
            { begin: String.raw`\[`, end: until(String.raw`\]`), name: 'text.bracketed', patterns: escapes },
            { include: 'source.sql' },
        ],
    };
}

/**
 * The grammar that highlights SQL with VS Code's own SQL grammar: in the query argument of oxmysql,
 * mysql-async and ghmattimysql calls, in the queries a transaction is given, and in the strings
 * that start on the line below `---@language sql`. A call is matched from the `.` or `:` before its
 * name, with the rest of its path checked in a fixed-length lookbehind, so the Lua grammar still
 * colors that path.
 */
export function sqlGrammar(): Record<string, unknown> {
    const calls = [
        after([String.raw`\bMySQL\.`], QUERY_METHODS),
        after(QUERY_METHODS.map((method) => String.raw`\bMySQL\.${method}\.`), ['await']),
        after([String.raw`\bMySQL\.Async\.`, String.raw`\bMySQL\.Sync\.`], LEGACY_METHODS),
        after(exportPrefixes('oxmysql'), OXMYSQL_EXPORTS.flatMap((method) => [method, `${method}_async`, `${method}Sync`])),
        after(exportPrefixes('ghmattimysql'), ['execute', 'executeSync', 'scalar', 'scalarSync']),
    ];
    const transactions = [
        after([String.raw`\bMySQL\.`], ['transaction']),
        after([String.raw`\bMySQL\.transaction\.`], ['await']),
        after(exportPrefixes('oxmysql'), ['transaction', 'transaction_async']),
        after(exportPrefixes('ghmattimysql'), ['transaction', 'transactionSync']),
    ];
    const statement = String.raw`(?=\s*(?i:select|insert|update|delete|replace|with|create|alter|drop|truncate|call|set)\b)`;
    return {
        scopeName: 'lua.sql.injection',
        injectionSelector: INJECTION_SELECTOR,
        patterns: [{ include: '#language-marker' }, { include: '#transaction' }, { include: '#call' }],
        repository: {
            'language-marker': {
                comment: '---@language sql above a line highlights the strings that start on that line as SQL. The begin takes the newline, so the end of the marked line itself, which follows it, is no end.',
                begin: String.raw`^([ \t]*)((---)(@language)[ \t]+(sql)\b[^\n]*)\n`,
                beginCaptures: {
                    2: { name: 'comment.line.double-dash.documentation.lua' },
                    3: { name: 'punctuation.definition.comment.lua' },
                    4: { name: 'storage.type.annotation.lua' },
                    5: { name: 'support.type.lua' },
                },
                end: '(?<=.)$',
                applyEndPatternLast: 1,
                patterns: [
                    { include: '#sql-strings' },
                    {
                        comment: "A line comment that leaves the newline, which the Lua grammar's takes, so the end still follows it.",
                        begin: String.raw`--(?!\[=*\[)`,
                        beginCaptures: { 0: { name: 'punctuation.definition.comment.lua' } },
                        end: String.raw`(?=\n)`,
                        name: 'comment.line.double-dash.lua',
                    },
                    { include: 'source.lua' },
                ],
            },
            call: {
                comment: 'The first argument of an oxmysql, mysql-async or ghmattimysql call that takes a query.',
                begin: callBegin(calls),
                beginCaptures: { 1: { name: 'support.function.any-method.lua' } },
                end: '(?=[,)])',
                patterns: [{ include: '#sql-strings' }, { include: 'source.lua' }],
            },
            transaction: {
                comment: 'The queries a transaction is given: long strings, and short ones that start with a statement.',
                begin: callBegin(transactions),
                beginCaptures: { 1: { name: 'support.function.any-method.lua' } },
                end: String.raw`\)`,
                patterns: [sqlString("'", 'single', statement), sqlString('"', 'double', statement), LONG_SQL_STRING, { include: 'source.lua' }],
            },
            'sql-strings': { patterns: [sqlString("'", 'single'), sqlString('"', 'double'), LONG_SQL_STRING] },
            'sql-in-single': sqlContent("'|$", "'"),
            'sql-in-double': sqlContent('"|$', '"'),
            'sql-in-multiline': sqlContent(String.raw`\]=*\]`),
        },
    };
}

/**
 * The `sqlGrammar` that highlights nothing, which `qbxLua.sqlHighlighting.enable` turns off to.
 * Without an injection selector it is not injected, so it takes no time on each line.
 */
export function disabledSqlGrammar(): Record<string, unknown> {
    return { scopeName: 'lua.sql.injection', patterns: [], repository: { 'sql-strings': { patterns: [] } } };
}

/**
 * The pattern that matches a call of one of `functions`, as `qbx/sqlFunctions` writes them
 * (`Fetch`, `DB.fetch`, `DB:query`, `exports.mydb:scalar`), with the name as capture 1 or 2. A name
 * after a `.` or `:` is matched from there, with the rest of its path checked in a fixed-length
 * lookbehind, so the Lua grammar still colors that path.
 */
export function sqlCallPattern(functions: readonly string[]): string | undefined {
    const escape = (text: string) => text.replace(/[.[\]()|?*+^$\\]/g, (char) => `\\${char}`);
    const separated: string[] = [];
    const bare: string[] = [];
    for (const name of functions) {
        const exported = /^exports\.([\w-]+):(\w+)$/.exec(name);
        const split = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
        if (exported) {
            separated.push(after(exportPrefixes(exported[1]), [exported[2]]));
        } else if (split >= 0) {
            separated.push(after([String.raw`\b${escape(name.slice(0, split + 1))}`], [escape(name.slice(split + 1))]));
        } else {
            bare.push(String.raw`${escape(name)}(?<![.:\w]${escape(name)})`);
        }
    }
    const branches = [...(separated.length > 0 ? [String.raw`[.:](${separated.join('|')})`] : []), ...(bare.length > 0 ? [`(${bare.join('|')})`] : [])];
    return branches.length > 0 ? String.raw`(?:${branches.join('|')})\s*\(` : undefined;
}

/**
 * The grammar that highlights the first argument of calls of `functions` as SQL, like the built-in
 * database calls, unless it is off. With nothing to highlight it has no injection selector, so it
 * is not injected and takes no time on each line.
 */
export function sqlFunctionsGrammar(functions: readonly string[], enabled = true): Record<string, unknown> {
    const begin = enabled ? sqlCallPattern(functions) : undefined;
    return {
        scopeName: 'lua.sql-functions.injection',
        ...(begin ? { injectionSelector: INJECTION_SELECTOR } : {}),
        functions,
        patterns: begin
            ? [{
                begin,
                beginCaptures: { 1: { name: 'support.function.any-method.lua' }, 2: { name: 'support.function.any-method.lua' } },
                end: '(?=[,)])',
                patterns: [{ include: 'lua.sql.injection#sql-strings' }, { include: 'source.lua' }],
            }]
            : [],
    };
}

/** How a grammar is written to its file. */
export function grammarText(grammar: Record<string, unknown>): string {
    return `${JSON.stringify(grammar, null, 2)}\n`;
}

/**
 * Keeps the SQL grammars in line with `qbxLua.sqlHighlighting.enable` and with the query functions
 * the language server finds. Every window and profile reads the same file, so the functions of each
 * workspace are added to it and stay until the extension updates. VS Code only reads a grammar when
 * a window starts, so a change takes a reload. The grammars of an extension under development are
 * the checked-in files, which are left as they are.
 */
export class SqlHighlighting {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        readonly enabled: () => boolean = () => vscode.workspace.getConfiguration('qbxLua').get<boolean>('sqlHighlighting.enable', true),
    ) {}

    /** Writes the grammars the setting asks for, adding `functions` to the query functions the grammar holds. */
    async sync(functions: readonly string[] = []): Promise<void> {
        if (this.context.extensionMode !== vscode.ExtensionMode.Production) {
            return;
        }
        const enabled = this.enabled();
        const switched = await this.write(SQL_GRAMMAR, grammarText(enabled ? sqlGrammar() : disabledSqlGrammar()));
        const current = await grammarFunctions(this.context.asAbsolutePath(SQL_FUNCTIONS_GRAMMAR));
        const added = [...new Set(functions)].filter((name) => !current.includes(name));
        const relisted = await this.write(SQL_FUNCTIONS_GRAMMAR, grammarText(sqlFunctionsGrammar([...current, ...added].sort(), enabled)));
        if (switched) {
            this.offerReload(enabled ? 'Qbox Lua highlights SQL once the window reloads.' : 'Qbox Lua stops highlighting SQL once the window reloads.');
        } else if (relisted && enabled && added.length > 0) {
            const names = added.length > 3 ? `${added.slice(0, 3).join(', ')} and ${added.length - 3} more` : added.join(', ');
            this.offerReload(`Qbox Lua highlights SQL in calls of ${names} once the window reloads.`);
        }
    }

    /** Writes `text` to the grammar at `relative` unless it holds it already, telling whether it changed. */
    private async write(relative: string, text: string): Promise<boolean> {
        const file = this.context.asAbsolutePath(relative);
        if ((await fs.readFile(file, 'utf8').catch(() => undefined)) === text) {
            return false;
        }
        try {
            await fs.writeFile(file, text);
            return true;
        } catch (error) {
            this.output.appendLine(`could not update the SQL highlighting in ${relative}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    private offerReload(message: string): void {
        // Not awaited: the message stays until it is answered, and the grammars are already written.
        void vscode.window.showInformationMessage(message, 'Reload Window').then(async (choice) => {
            if (choice === 'Reload Window') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
}

/** The functions the grammar file on disk highlights, which a window that started with it uses. */
async function grammarFunctions(file: string): Promise<string[]> {
    try {
        const grammar = JSON.parse(await fs.readFile(file, 'utf8')) as { functions?: unknown };
        return Array.isArray(grammar.functions) ? grammar.functions.filter((name): name is string => typeof name === 'string') : [];
    } catch {
        return [];
    }
}
