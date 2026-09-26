import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanLogText, parseLogSources } from '../../src/runtimeLogParser';
import { MAX_LOG_BYTES, MAX_LOG_LINE_CHARS, MAX_LOG_LINES, RuntimeLogTail, type LogTailUpdate } from '../../src/runtimeLogTail';

type Test = [name: string, body: () => void | Promise<void>];

async function waitFor(label: string, condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!condition()) {
        if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${label}`); }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function quietInterval(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 75));
}

async function withLog(body: (fixture: {
    filename: string;
    root: string;
    tail: RuntimeLogTail;
    updates: LogTailUpdate[];
    latest: () => LogTailUpdate;
    text: () => string[];
}) => Promise<void>, initial = ''): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbx-log-tests-'));
    const filename = path.join(root, 'console.log');
    await fs.writeFile(filename, initial);
    const updates: LogTailUpdate[] = [];
    const tail = new RuntimeLogTail(filename, (update) => updates.push(update), { pollIntervalMs: 10 });
    const latest = (): LogTailUpdate => updates.at(-1) ?? { lines: [], status: '', paused: false };
    try { await body({ filename, root, tail, updates, latest, text: () => latest().lines.map((line) => line.text) }); }
    finally {
        tail.dispose();
        assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
        assert.ok(path.basename(root).startsWith('qbx-log-tests-'));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
}

function assertBounds(update: LogTailUpdate): void {
    assert.ok(update.lines.length <= MAX_LOG_LINES);
    assert.ok(update.lines.reduce((total, line) => total + Buffer.byteLength(line.text), 0) <= MAX_LOG_BYTES);
    assert.ok(update.lines.every((line) => line.text.length <= MAX_LOG_LINE_CHARS));
    assert.equal(new Set(update.lines.map((line) => line.id)).size, update.lines.length);
}

const tests: Test[] = [
    ['runtime log cleaning strips Cfx colors and terminal controls while retaining plain text', () => {
        const raw = '\x1b[31m^1SCRIPT ERROR:^7 text\x1b[0m\x00\x07\x08\r\tline\n😀^0end';
        assert.equal(cleanLogText(raw), 'SCRIPT ERROR: text\tline\n😀end');
        assert.equal(cleanLogText('\x1b]8;;https://example.test\x07safe\x1b]8;;\x1b\\'), 'safe');
        assert.equal(cleanLogText('\x9b31mred\x9b0m\x9dsecret\x9cplain'), 'redplain');
        assert.equal(cleanLogText('before\x1b[' + '1;'.repeat(50000)), 'before', 'unterminated CSI has bounded linear work');
        assert.equal(cleanLogText('a\u202eb\u2066c\u2069d'), 'abcd');
        assert.equal(cleanLogText('^x literal ^ and <script>text</script>'), '^x literal ^ and <script>text</script>', 'markup remains plain text for the renderer');
    }],
    ['runtime source parsing preserves exact resource/path spelling and points to the matched text', () => {
        const text = cleanLogText('[ script:Garage] ^1SCRIPT ERROR: @Garage/client/Main.lua:42: bad value^7\n^3> handler^7 (^5@Other_Res/server/callbacks.lua^7:123)');
        const sources = parseLogSources(text);
        assert.equal(sources.length, 2);
        assert.deepEqual(sources.map(({ resource, path: file, line }) => ({ resource, file, line })), [
            { resource: 'Garage', file: 'client/Main.lua', line: 42 },
            { resource: 'Other_Res', file: 'server/callbacks.lua', line: 123 },
        ]);
        assert.deepEqual(sources.map((source) => text.slice(source.start, source.end)), ['@Garage/client/Main.lua:42', '@Other_Res/server/callbacks.lua:123']);
        assert.equal(parseLogSources('> fn (@resource/client.lua:1)')[0].line, 1);
        assert.equal(parseLogSources('@resource/folder/file.lua:00012: error')[0].line, 12);
        assert.equal(parseLogSources('@resource/../outside.lua:12')[0].path, '../outside.lua', 'workspace resolution remains responsible for traversal rejection');
    }],
    ['runtime source parsing bounds matches and rejects malformed source lines', () => {
        for (const value of ['@resource/client.lua:0', '@resource/client.lua:-1', '@resource/client.lua:2147483648',
            '@resource/client.lua:99999999999999999999', '@resource/client.lua:1.5', '@resource/client.lua:1junk',
            '@resource/client.luax:12', '@citizen:/scripting/lua/scheduler.lua:12', 'https://example.test/client.lua:1']) {
            assert.deepEqual(parseLogSources(value), [], value);
        }
        assert.equal(parseLogSources(Array.from({ length: 100 }, (_, i) => `@res/file.lua:${i + 1}`).join(' ')).length, 32);
        assert.deepEqual(parseLogSources(' '.repeat(32768) + '@res/late.lua:1'), []);
        assert.deepEqual(parseLogSources(`@${'a'.repeat(129)}/file.lua:1`), []);
    }],
    ['runtime tail accepts only explicit absolute regular files', async () => withLog(async ({ root }) => {
        for (const filename of [root, path.join(root, 'missing.log'), 'relative.log']) {
            const updates: LogTailUpdate[] = [];
            const tail = new RuntimeLogTail(filename, (update) => updates.push(update), { pollIntervalMs: 10 });
            try { await assert.rejects(tail.start()); assert.deepEqual(updates, []); }
            finally { tail.dispose(); }
        }
    })],
    ['runtime tail follows partial UTF-8 and CRLF without duplicate lines or reused changed IDs', async () => withLog(async ({ filename, tail, latest, text }) => {
        await tail.start();
        assert.deepEqual(text(), ['first', 'par']);
        const firstPartial = latest().lines[1].id;
        await fs.appendFile(filename, 'tial\r');
        await waitFor('extended partial line', () => text()[1] === 'partial');
        assert.notEqual(latest().lines[1].id, firstPartial, 'a changed line must invalidate its old source-navigation ID');
        await fs.appendFile(filename, '\nface ');
        await waitFor('next partial line', () => text().at(-1) === 'face ');
        const face = Buffer.from('😀');
        await fs.appendFile(filename, face.subarray(0, 2));
        await quietInterval();
        assert.equal(text().at(-1), 'face ');
        await fs.appendFile(filename, face.subarray(2));
        await waitFor('completed UTF-8 character', () => text().at(-1) === 'face 😀');
        await fs.appendFile(filename, '\r\nlast\n');
        await waitFor('complete CRLF append', () => text().at(-1) === 'last');
        assert.deepEqual(text(), ['first', 'partial', 'face 😀', 'last']);
        assert.ok(!text().join('').includes('\uFFFD'));
    }, 'first\r\npar')],
    ['runtime initial tail drops an incomplete first line and shows the recent suffix', async () => withLog(async ({ tail, text, latest }) => {
        await tail.start();
        assert.ok(text().some((line) => line.includes('older bytes skipped')));
        assert.deepEqual(text().slice(-2), ['visible one', 'last partial']);
        assert.ok(!text().some((line) => line.includes('HIDDEN')));
        assertBounds(latest());
    }, 'HIDDEN'.repeat(50000) + '\nvisible one\nlast partial')],
    ['runtime tail bounds retained line count, UTF-8 bytes and overlong partial lines', async () => withLog(async ({ filename, tail, latest, text, updates }) => {
        await tail.start();
        await fs.appendFile(filename, Array.from({ length: 1200 }, (_, i) => `line ${i}\n`).join(''));
        await waitFor('line-count cap', () => text().at(-1) === 'line 1199');
        assert.equal(latest().lines.length, MAX_LOG_LINES);
        assert.equal(text()[0], 'line 200');
        for (let batch = 0; batch < 4; batch++) {
            const lines = Array.from({ length: 6 }, (_, index) => {
                const prefix = `${batch}:${index} `;
                return prefix + '界'.repeat(MAX_LOG_LINE_CHARS - prefix.length);
            });
            await fs.appendFile(filename, lines.join('\n') + '\n');
            await waitFor(`bounded batch ${batch}`, () => text().at(-1) === lines.at(-1));
            assertBounds(latest());
        }
        assert.ok(latest().lines.length < 30, 'UTF-8 byte budget should evict long multibyte lines');
        await fs.appendFile(filename, 'x'.repeat(20000));
        await waitFor('long line marker', () => text().at(-1)?.includes('[line truncated]') === true);
        await fs.appendFile(filename, 'continued\nnext\n');
        await waitFor('line after truncation', () => text().at(-1) === 'next');
        for (const update of updates) { assertBounds(update); }
    })],
    ['runtime tail detects truncate-and-regrow and pathname replacement', async () => withLog(async ({ filename, root, tail, latest, text, updates }) => {
        await tail.start();
        const original = latest().lines[0].id;
        await fs.writeFile(filename, 'rewritten to a longer same-file line\n');
        await waitFor('truncate and regrow', () => text().at(-1) === 'rewritten to a longer same-file line');
        assert.ok(text().some((line) => line.includes('truncated or rewritten')));
        await fs.rename(filename, path.join(root, 'previous.log'));
        await fs.writeFile(filename, 'replacement file\n');
        await waitFor('replacement log', () => text().at(-1) === 'replacement file');
        assert.ok(text().some((line) => line.includes('file replaced')));
        assert.notEqual(latest().lines.at(-1)?.id, original);
        const identities = new Map<string, string>();
        for (const update of updates) {
            for (const line of update.lines) {
                assert.ok(!identities.has(line.id) || identities.get(line.id) === line.text, 'an ID must never describe two different texts');
                identities.set(line.id, line.text);
            }
        }
    }, 'original\n')],
    ['runtime tail reports temporary missing files and follows their replacement', async () => withLog(async ({ filename, tail, latest, text }) => {
        await tail.start();
        await fs.unlink(filename);
        await waitFor('missing log status', () => latest().status.includes('reappear'));
        await fs.writeFile(filename, 'available again\n');
        await waitFor('recreated log', () => text().at(-1) === 'available again');
        assert.equal(latest().status, 'Following local log.');
    }, 'before removal\n')],
    ['runtime clear preserves rewrite detection while paused', async () => withLog(async ({ filename, tail, latest, text }) => {
        await tail.start();
        tail.setPaused(true);
        tail.clear();
        await waitFor('paused clear synchronization', () => latest().status.includes('Display cleared'));
        assert.deepEqual(text(), []);
        await fs.writeFile(filename, 'longer output after truncate and regrow\n');
        tail.setPaused(false);
        await waitFor('rewritten log after clear', () => text().at(-1) === 'longer output after truncate and regrow');
        assert.ok(text().some((line) => line.includes('truncated or rewritten')));
    }, 'original\n')],
    ['runtime pause resumes with bounded catch-up and clear changes only the view', async () => withLog(async ({ filename, tail, latest, text }) => {
        await tail.start();
        const oldIds = new Set(latest().lines.map((line) => line.id));
        tail.setPaused(true);
        await fs.appendFile(filename, 'skipped old output\n'.repeat(20000) + 'newest while paused\n');
        await quietInterval();
        assert.deepEqual(text(), ['initial']);
        assert.equal(latest().paused, true);
        tail.setPaused(false);
        await waitFor('bounded paused catch-up', () => text().at(-1) === 'newest while paused');
        assert.ok(text().some((line) => line.includes('skipped while catching up')) || latest().status.includes('skipped while catching up'));
        assertBounds(latest());
        const disk = await fs.readFile(filename);
        tail.clear();
        assert.deepEqual(text(), []);
        await waitFor('clear synchronization', () => latest().status.includes('Display cleared'));
        assert.deepEqual(await fs.readFile(filename), disk, 'clear never truncates the logfile');
        await fs.appendFile(filename, 'after clear\n');
        await waitFor('new output after clear', () => text().at(-1) === 'after clear');
        assert.deepEqual(text(), ['after clear']);
        assert.ok(!oldIds.has(latest().lines[0].id));
    }, 'initial\n')],
    ['runtime idle polls emit no redundant snapshots and disposal suppresses pending work', async () => withLog(async ({ filename, tail, updates }) => {
        await tail.start();
        const count = updates.length;
        await quietInterval();
        assert.equal(updates.length, count);
        tail.dispose();
        await fs.appendFile(filename, 'after disposal\n');
        tail.setPaused(true);
        tail.clear();
        await tail.start();
        await quietInterval();
        assert.equal(updates.length, count);
        const pendingUpdates: LogTailUpdate[] = [];
        const pending = new RuntimeLogTail(filename, (update) => pendingUpdates.push(update), { pollIntervalMs: 10 });
        const started = pending.start();
        pending.dispose();
        await started;
        await quietInterval();
        assert.deepEqual(pendingUpdates, []);
    }, 'unchanged\n')],
];

/** Pure parser and read-only tail integration against temporary files; no server connection. */
export async function runRuntimeLogCoreTests(): Promise<void> {
    const failures: string[] = [];
    for (const [name, body] of tests) {
        try { await body(); console.log(`  ok   ${name}`); }
        catch (error) { failures.push(name); console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`); }
    }
    if (failures.length) { throw new Error(`${failures.length} runtime log core test(s) failed: ${failures.join(', ')}`); }
}
