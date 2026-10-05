import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';

/** The grammar that highlights SQL in database calls and below `---@language sql`. VS Code reads it when a window starts. */
export const SQL_GRAMMAR = 'syntaxes/sql.injection.json';
/** The grammar that highlights SQL in calls of the workspace's own query functions. VS Code reads it when a window starts. */
export const SQL_FUNCTIONS_GRAMMAR = 'syntaxes/sql-functions.injection.json';
const STATE_KEY = 'qbxLua.sqlFunctions';
const INJECTION_SELECTOR = 'L:source.lua -comment -string -meta.embedded.block.sql';

const QUERY_METHODS = ['query', 'single', 'scalar', 'insert', 'update', 'prepare', 'rawExecute', 'execute'];
const LEGACY_METHODS = ['fetchAll', 'fetchScalar', 'fetchSingle', 'execute', 'insert', 'store'];
const OXMYSQL_EXPORTS = ['query', 'single', 'scalar', 'insert', 'update', 'prepare', 'rawExecute', 'execute', 'fetch'];

/** The ways a call writes `exports.resource:`, for a fixed-length lookbehind. */
function exportPrefixes(resource: string): string[] {
    return [String.raw`\bexports\.${resource}:`, String.raw`\bexports\['${resource}'\]:`, String.raw`\bexports\["${resource}"\]:`];
}

function sqlString(quote: string, kind: string, start = ''): Record<string, unknown> {
    return {
        begin: quote + start,
        beginCaptures: { 0: { name: `string.quoted.${kind}.lua punctuation.definition.string.begin.lua` } },
        end: String.raw`${quote}|(?=\n)`,
        endCaptures: { 0: { name: `string.quoted.${kind}.lua punctuation.definition.string.end.lua` } },
        contentName: 'meta.embedded.block.sql',
        patterns: [{ include: 'source.lua#escaped_char' }, { include: 'source.sql' }],
    };
}

const LONG_SQL_STRING = {
    begin: String.raw`(?<!--)\[(=*)\[`,
    beginCaptures: { 0: { name: 'string.quoted.other.multiline.lua punctuation.definition.string.begin.lua' } },
    end: String.raw`\]\1\]`,
    endCaptures: { 0: { name: 'string.quoted.other.multiline.lua punctuation.definition.string.end.lua' } },
    contentName: 'meta.embedded.block.sql',
    patterns: [{ include: 'source.sql' }],
};

/**
 * The grammar that highlights SQL with VS Code's own SQL grammar: in the query argument of oxmysql,
 * mysql-async and ghmattimysql calls, in the queries a transaction is given, and in the strings
 * that start on the line below `---@language sql`. Call names are matched with what precedes them in
 * a fixed-length lookbehind, so the Lua grammar still colors the rest of the path.
 */
export function sqlGrammar(): Record<string, unknown> {
    const calls = [
        String.raw`(?<=\bMySQL\.)(?:${QUERY_METHODS.join('|')})`,
        String.raw`(?<=${QUERY_METHODS.map((method) => String.raw`\bMySQL\.${method}\.`).join('|')})await`,
        String.raw`(?<=\bMySQL\.Async\.|\bMySQL\.Sync\.)(?:${LEGACY_METHODS.join('|')})`,
        String.raw`(?<=${exportPrefixes('oxmysql').join('|')})(?:${OXMYSQL_EXPORTS.join('|')})(?:_async|Sync)?`,
        String.raw`(?<=${exportPrefixes('ghmattimysql').join('|')})(?:execute|scalar)(?:Sync)?`,
    ];
    const transactions = [
        String.raw`(?<=\bMySQL\.)transaction`,
        String.raw`(?<=\bMySQL\.transaction\.)await`,
        String.raw`(?<=${exportPrefixes('oxmysql').join('|')})transaction(?:_async)?`,
        String.raw`(?<=${exportPrefixes('ghmattimysql').join('|')})transaction(?:Sync)?`,
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
                patterns: [{ include: '#sql-strings' }, { include: 'source.lua' }],
            },
            call: {
                comment: 'The first argument of an oxmysql, mysql-async or ghmattimysql call that takes a query.',
                begin: String.raw`(${calls.join('|')})\s*(\()`,
                beginCaptures: { 1: { name: 'support.function.any-method.lua' } },
                end: '(?=[,)])',
                patterns: [{ include: '#sql-strings' }, { include: 'source.lua' }],
            },
            transaction: {
                comment: 'The queries a transaction is given: long strings, and short ones that start with a statement.',
                begin: String.raw`(${transactions.join('|')})\s*(\()`,
                beginCaptures: { 1: { name: 'support.function.any-method.lua' } },
                end: String.raw`\)`,
                patterns: [sqlString("'", 'single', statement), sqlString('"', 'double', statement), LONG_SQL_STRING, { include: 'source.lua' }],
            },
            'sql-strings': { patterns: [sqlString("'", 'single'), sqlString('"', 'double'), LONG_SQL_STRING] },
        },
    };
}

/** The `sqlGrammar` that highlights nothing, which `qbxLua.sqlHighlighting.enable` turns off to. */
export function disabledSqlGrammar(): Record<string, unknown> {
    return { scopeName: 'lua.sql.injection', injectionSelector: INJECTION_SELECTOR, patterns: [], repository: { 'sql-strings': { patterns: [] } } };
}

/**
 * The pattern that matches the name of a call of one of `functions`, as `qbx/sqlFunctions` writes
 * them (`Fetch`, `DB.fetch`, `DB:query`, `exports.mydb:scalar`), with what precedes it in a
 * fixed-length lookbehind, so the Lua grammar still colors the rest of the path.
 */
export function sqlCallPattern(functions: readonly string[]): string | undefined {
    const escape = (text: string) => text.replace(/[.[\]()|?*+^$\\]/g, (char) => `\\${char}`);
    const alternatives = functions.map((name) => {
        const exported = /^exports\.([\w-]+):(\w+)$/.exec(name);
        if (exported) {
            const [, resource, method] = exported;
            return `(?<=${exportPrefixes(resource).join('|')})${method}`;
        }
        const split = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
        if (split < 0) {
            return String.raw`(?<![.:\w])` + escape(name);
        }
        return String.raw`(?<=\b${escape(name.slice(0, split + 1))})${escape(name.slice(split + 1))}`;
    });
    return alternatives.length > 0 ? String.raw`(${alternatives.join('|')})\s*(\()` : undefined;
}

/** The grammar that highlights the first argument of calls of `functions` as SQL, like the built-in database calls. */
export function sqlFunctionsGrammar(functions: readonly string[]): Record<string, unknown> {
    const begin = sqlCallPattern(functions);
    return {
        scopeName: 'lua.sql-functions.injection',
        injectionSelector: INJECTION_SELECTOR,
        functions,
        patterns: begin
            ? [{
                begin,
                beginCaptures: { 1: { name: 'support.function.any-method.lua' } },
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
 * the language server finds. Each workspace keeps its own list of functions, and the grammar holds
 * them all, since every window reads the same file. VS Code only reads a grammar when a window
 * starts, so a change takes a reload.
 */
export class SqlHighlighting {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
        readonly enabled: () => boolean = () => vscode.workspace.getConfiguration('qbxLua').get<boolean>('sqlHighlighting.enable', true),
    ) {}

    /** Writes the grammars the setting asks for, with `functions` as the query functions of this workspace once the server lists them. */
    async sync(functions?: readonly string[]): Promise<void> {
        const stored = { ...this.context.globalState.get<Record<string, string[]>>(STATE_KEY, {}) };
        const workspace = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
        if (functions && workspace) {
            stored[workspace] = [...functions];
            await this.context.globalState.update(STATE_KEY, stored);
        }
        const enabled = this.enabled();
        const switched = await this.write(SQL_GRAMMAR, grammarText(enabled ? sqlGrammar() : disabledSqlGrammar()));
        const file = this.context.asAbsolutePath(SQL_FUNCTIONS_GRAMMAR);
        const current = await grammarFunctions(file);
        const all = enabled ? [...new Set(Object.values(stored).flat())].sort() : [];
        const listed = current.length === all.length && current.every((name, index) => name === all[index]);
        const relisted = !listed && (await this.write(SQL_FUNCTIONS_GRAMMAR, grammarText(sqlFunctionsGrammar(all))));
        // A function that is gone stays highlighted until the next start, which does no harm.
        const added = all.filter((name) => !current.includes(name));
        if (switched) {
            this.offerReload(enabled ? 'Qbox Lua highlights SQL once the window reloads.' : 'Qbox Lua stops highlighting SQL once the window reloads.');
        } else if (relisted && added.length > 0) {
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
