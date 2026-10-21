import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { SQL_FUNCTIONS_GRAMMAR, SQL_GRAMMAR, SqlHighlighting, disabledSqlGrammar, grammarText, sqlFunctionsGrammar, sqlGrammar } from '../../src/sqlHighlighting';

type Test = [name: string, body: () => void | Promise<void>];

let wasm: Promise<void> | undefined;

/** The paths of the grammars a Lua file uses: VS Code's own Lua and SQL grammars, and the injections of this extension. */
function grammarFiles(): Record<string, string> {
    const builtIn = (id: string, file: string) => {
        const extension = vscode.extensions.getExtension(id);
        assert.ok(extension, `the built-in ${id} extension should be present`);
        return path.join(extension.extensionPath, 'syntaxes', file);
    };
    const own = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(own, 'extension should be installed in the test host');
    const files: Record<string, string> = {
        'source.lua': builtIn('vscode.lua', 'lua.tmLanguage.json'),
        'source.sql': builtIn('vscode.sql', 'sql.tmLanguage.json'),
    };
    for (const grammar of own.packageJSON.contributes.grammars as { scopeName: string; path: string }[]) {
        files[grammar.scopeName] = path.join(own.extensionPath, grammar.path);
    }
    return files;
}

/** For each line of `text`, the parts that the grammars read as SQL, with the given grammar of query functions and, by path, grammar files in place of the shipped ones. */
async function sqlParts(text: string, functions: readonly string[] = [], replaced: Record<string, string> = {}): Promise<string[]> {
    wasm ??= oniguruma.loadWASM(fs.readFileSync(path.join(path.dirname(require.resolve('vscode-oniguruma')), 'onig.wasm')).buffer);
    await wasm;
    const files = grammarFiles();
    const generated = JSON.stringify(sqlFunctionsGrammar(functions));
    const registry = new textmate.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
            createOnigString: (value) => new oniguruma.OnigString(value),
        }),
        loadGrammar: async (scope) => {
            if (scope === 'lua.sql-functions.injection') {
                return textmate.parseRawGrammar(generated, 'functions.json');
            }
            if (scope === 'lua.sql.injection' && replaced[SQL_GRAMMAR]) {
                return textmate.parseRawGrammar(replaced[SQL_GRAMMAR], 'sql.json');
            }
            return files[scope] ? textmate.parseRawGrammar(fs.readFileSync(files[scope], 'utf8'), files[scope]) : null;
        },
        getInjections: (scope) => (scope === 'source.lua' ? Object.keys(files).filter((name) => name !== 'source.lua' && name !== 'source.sql') : undefined),
    });
    const grammar = await registry.loadGrammar('source.lua');
    assert.ok(grammar, 'the Lua grammar should load');
    let state = textmate.INITIAL;
    return text.split('\n').map((line) => {
        const result = grammar.tokenizeLine(line, state);
        state = result.ruleStack;
        return result.tokens
            .filter((token) => token.scopes.includes('meta.embedded.block.sql'))
            .map((token) => line.slice(token.startIndex, token.endIndex))
            .join('')
            .trim();
    });
}

async function highlightsDatabaseCalls(): Promise<void> {
    const parts = await sqlParts([
        "local rows = MySQL.query.await('SELECT id FROM players WHERE citizenid = ?', { citizenid })",
        'MySQL.update("UPDATE players SET name = \\"x\\"", {})',
        'local employees = MySQL.query.await(([[',
        '    SELECT firstname FROM players',
        ']]):format(name), { job })',
        'local id = MySQL.insert.await(',
        "    'INSERT INTO logs (message) VALUES (?)', { message })",
        "exports.oxmysql:execute('DELETE FROM logs')",
        'exports[\'oxmysql\']:query_async("SELECT 1")',
        "MySQL.Async.fetchAll('SELECT * FROM users', {}, function(result) print('done') end)",
        "MySQL.transaction.await({ 'INSERT INTO a VALUES (1)', { query = 'UPDATE b SET c = 1', values = { 'abc' } } })",
        "print('SELECT is only text here')",
        "MySQL.ready(function() print('ready') end)",
    ].join('\n'));
    assert.deepEqual(parts, [
        'SELECT id FROM players WHERE citizenid = ?',
        'UPDATE players SET name = \\"x\\"',
        '',
        'SELECT firstname FROM players',
        '',
        '',
        'INSERT INTO logs (message) VALUES (?)',
        'DELETE FROM logs',
        'SELECT 1',
        'SELECT * FROM users',
        'INSERT INTO a VALUES (1)UPDATE b SET c = 1',
        '',
        '',
    ]);
}

async function endsSqlWithTheLuaString(): Promise<void> {
    const parts = await sqlParts([
        'local rows = MySQL.query.await([[SELECT * FROM t -- every row]])',
        "print('one')",
        "MySQL.query('SELECT 1 -- note /* open', {}, function() end)",
        "print('two')",
        'MySQL.update("UPDATE vehicles SET `" .. column .. "` = ? WHERE plate = ?", { plate })',
        "MySQL.query(\"SELECT * FROM users WHERE identifier = '\" .. id .. \"'\", {})",
        "MySQL.query('SELECT \"it\\'s\" FROM t [x', {})",
        'MySQL.query.await([==[',
        "    SELECT 'O\\'Brien' FROM t /* a",
        '    comment */ WHERE a = 1',
        ']==], {})',
        "print('three')",
    ].join('\n'));
    assert.deepEqual(parts, [
        'SELECT * FROM t -- every row',
        '',
        'SELECT 1 -- note /* open',
        '',
        'UPDATE vehicles SET `` = ? WHERE plate = ?',
        "SELECT * FROM users WHERE identifier = ''",
        'SELECT "it\\\'s" FROM t [x',
        '',
        "SELECT 'O\\'Brien' FROM t /* a",
        'comment */ WHERE a = 1',
        '',
        '',
    ]);
}

async function highlightsMarkedStrings(): Promise<void> {
    const parts = await sqlParts([
        '---@language sql',
        'local query = [[',
        '    SELECT * FROM vehicles',
        ']]',
        "local text = 'not a query'",
        '---@language sql',
        "Queries.byId = 'SELECT * FROM vehicles WHERE id = ?'",
        "local after = 'not a query'",
    ].join('\n'));
    assert.deepEqual(parts, ['', '', 'SELECT * FROM vehicles', '', '', '', 'SELECT * FROM vehicles WHERE id = ?', '']);
}

async function endsMarkedStringsAfterACommentedLine(): Promise<void> {
    const parts = await sqlParts([
        '---@language sql',
        "local query = 'SELECT 1' -- the first query",
        "local name = 'Bob' -- a default",
        "local job = 'police'",
    ].join('\n'));
    assert.deepEqual(parts, ['', 'SELECT 1', '', '']);
}

async function highlightsCallsOfQueryFunctions(): Promise<void> {
    const parts = await sqlParts([
        "DB.fetch('SELECT 1')",
        "DB:query('SELECT 2')",
        "Fetch('SELECT 3')",
        "exports['my-db']:scalar('SELECT 4')",
        "Other.Fetch('not a query')",
        "DB.fetchAll('not a query')",
        "XDB.fetch('not a query')",
    ].join('\n'), ['DB.fetch', 'DB:query', 'Fetch', 'exports.my-db:scalar']);
    assert.deepEqual(parts, ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4', '', '', '']);
}

/** A folder holding the two SQL grammars as the extension ships them, and a context whose extension lives there. */
async function shippedGrammars(run: (folder: string, context: (mode: vscode.ExtensionMode) => vscode.ExtensionContext) => Promise<void>): Promise<void> {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qbx-sql-'));
    try {
        fs.mkdirSync(path.join(folder, 'syntaxes'));
        fs.writeFileSync(path.join(folder, SQL_GRAMMAR), grammarText(sqlGrammar()));
        fs.writeFileSync(path.join(folder, SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar([])));
        await run(folder, (extensionMode) => ({ extensionMode, asAbsolutePath: (relative: string) => path.join(folder, relative) }) as unknown as vscode.ExtensionContext);
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}

/** A `SqlHighlighting` whose reload prompts are collected instead of shown. */
function highlighting(context: vscode.ExtensionContext, enabled: () => boolean): { highlighting: SqlHighlighting; prompts: string[] } {
    const result = new SqlHighlighting(context, vscode.window.createOutputChannel('qbx-sql-test'), enabled);
    const prompts: string[] = [];
    (result as unknown as { offerReload(message: string): void }).offerReload = (message) => prompts.push(message);
    return { highlighting: result, prompts };
}

async function writesTheGrammarOfQueryFunctions(): Promise<void> {
    await shippedGrammars(async (folder, context) => {
        const grammar = path.join(folder, SQL_FUNCTIONS_GRAMMAR);
        const listed = () => (JSON.parse(fs.readFileSync(grammar, 'utf8')) as { functions: string[] }).functions;
        const first = highlighting(context(vscode.ExtensionMode.Production), () => true);
        const second = highlighting(context(vscode.ExtensionMode.Production), () => true);
        await first.highlighting.sync(['DB.fetch']);
        assert.deepEqual(listed(), ['DB.fetch']);
        assert.equal(first.prompts.length, 1, 'a new function offers a reload');
        for (let round = 0; round < 3; round++) {
            await second.highlighting.sync(['Other.query']);
            await second.highlighting.sync([]);
            await first.highlighting.sync(['DB.fetch']);
        }
        assert.deepEqual(listed(), ['DB.fetch', 'Other.query'], 'the grammar holds the functions of every window');
        assert.equal(first.prompts.length, 1, 'functions the grammar holds offer no reload');
        assert.equal(second.prompts.length, 1, 'each window is offered a reload once for its new function');
        const before = fs.statSync(grammar).mtimeMs;
        await first.highlighting.sync(['DB.fetch']);
        assert.equal(fs.statSync(grammar).mtimeMs, before, 'an unchanged list leaves the grammar alone');
    });
}

async function leavesTheGrammarOfADevelopmentHostAlone(): Promise<void> {
    await shippedGrammars(async (folder, context) => {
        const read = (relative: string) => fs.readFileSync(path.join(folder, relative), 'utf8');
        for (const mode of [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test]) {
            const { highlighting: development, prompts } = highlighting(context(mode), () => false);
            await development.sync(['DB.fetch']);
            assert.equal(read(SQL_GRAMMAR), grammarText(sqlGrammar()));
            assert.equal(read(SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar([])));
            assert.deepEqual(prompts, []);
        }
    });
}

async function turnsTheHighlightingOffAndOn(): Promise<void> {
    await shippedGrammars(async (folder, context) => {
        let enabled = true;
        const { highlighting: sql, prompts } = highlighting(context(vscode.ExtensionMode.Production), () => enabled);
        const read = (relative: string) => fs.readFileSync(path.join(folder, relative), 'utf8');
        await sql.sync(['DB.fetch']);
        enabled = false;
        await sql.sync();
        assert.equal(read(SQL_GRAMMAR), grammarText(disabledSqlGrammar()), 'off empties the grammar of database calls');
        assert.equal(read(SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar(['DB.fetch'], false)), 'off keeps the functions without highlighting them');
        assert.deepEqual(await sqlParts("MySQL.query.await('SELECT 1')\nDB.fetch('SELECT 2')", [], { [SQL_GRAMMAR]: read(SQL_GRAMMAR) }), ['', ''], 'off highlights nothing');
        enabled = true;
        await sql.sync();
        assert.equal(read(SQL_GRAMMAR), grammarText(sqlGrammar()), 'on writes the grammar of database calls back');
        assert.equal(read(SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar(['DB.fetch'])), 'on highlights the functions found before');
        assert.equal(prompts.length, 3, 'one reload for the new function, one for off and one for on');
    });
}

async function shipsTheGrammarTheCodeWrites(): Promise<void> {
    const own = vscode.extensions.getExtension('qbox.qbx-lua');
    assert.ok(own, 'extension should be installed in the test host');
    const shipped = (relative: string) => fs.readFileSync(path.join(own.extensionPath, relative), 'utf8');
    assert.equal(shipped(SQL_GRAMMAR), grammarText(sqlGrammar()), `${SQL_GRAMMAR} should be what sqlGrammar() writes`);
    assert.equal(shipped(SQL_FUNCTIONS_GRAMMAR), grammarText(sqlFunctionsGrammar([])), `${SQL_FUNCTIONS_GRAMMAR} should ship without functions`);
}

const tests: Test[] = [
    ['database calls highlight their query', highlightsDatabaseCalls],
    ['SQL comments, strings and quoted names end with the Lua string', endsSqlWithTheLuaString],
    ['---@language sql highlights the strings on the next line', highlightsMarkedStrings],
    ['---@language sql ends after a next line that ends in a comment', endsMarkedStringsAfterACommentedLine],
    ['calls of functions that take sql highlight their query', highlightsCallsOfQueryFunctions],
    ['the grammar of query functions holds every workspace without flipping between windows', writesTheGrammarOfQueryFunctions],
    ['an extension under development leaves its grammars alone', leavesTheGrammarOfADevelopmentHostAlone],
    ['qbxLua.sqlHighlighting.enable turns the grammars off and back on', turnsTheHighlightingOffAndOn],
    ['the extension ships the grammar the code writes', shipsTheGrammarTheCodeWrites],
];

export async function runSqlHighlightingTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try {
            await body();
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} SQL highlighting test(s) failed: ${failures.join(', ')}`);
    }
}
