import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HoverLevels, verboseHoverClass, type HoverLevelSettings } from '../../src/hoverLevels';

type Test = [name: string, body: () => void | Promise<void>];

type ShownHover = vscode.Hover & { canIncreaseVerbosity?: boolean; canDecreaseVerbosity?: boolean };

class MemoryMemento implements vscode.Memento {
    readonly values = new Map<string, unknown>();

    keys(): readonly string[] { return [...this.values.keys()]; }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, value);
        }
    }
}

/** A provider whose server writes hovers up to `server.maxLevel`, which it leaves out when it is undefined. */
function fixture(settings: HoverLevelSettings, maxLevel: number | undefined) {
    const VerboseHover = verboseHoverClass();
    assert.ok(VerboseHover, 'the test host should have hover buttons');
    const server = { maxLevel, asked: [] as number[] };
    const provider = new HoverLevels(VerboseHover, new MemoryMemento(), () => settings, async (_document, _position, level) => {
        server.asked.push(level);
        return { hover: new vscode.Hover(`level ${level}`), maxLevel: server.maxLevel };
    });
    const token = new vscode.CancellationTokenSource().token;
    const hover = async (previousHover?: vscode.Hover, verbosityDelta?: number): Promise<ShownHover> => {
        const context = previousHover && { previousHover, verbosityDelta };
        const shown = await provider.provideHover({} as vscode.TextDocument, new vscode.Position(0, 0), token, context);
        assert.ok(shown, 'the provider should answer');
        return shown;
    };
    return { provider, server, hover };
}

function buttons(hover: ShownHover): [boolean | undefined, boolean | undefined] {
    return [hover.canIncreaseVerbosity, hover.canDecreaseVerbosity];
}

const tests: Test[] = [
    ['new hovers open at qbxLua.hover.verbosity and the buttons step from the level shown', async () => {
        const { server, hover } = fixture({ verbosity: 1, remember: false }, 3);
        const first = await hover();
        assert.deepEqual(buttons(first), [true, true]);
        const most = await hover(await hover(first, 1), 1);
        assert.deepEqual(buttons(most), [false, true]);
        assert.deepEqual(buttons(await hover(first, -1)), [true, false]);
        await hover();
        assert.deepEqual(server.asked, [1, 2, 3, 0, 1]);
    }],
    ['a hover with less to show stops at its deepest level', async () => {
        const { server, hover } = fixture({ verbosity: 4, remember: false }, 2);
        const first = await hover();
        assert.deepEqual(buttons(first), [false, true]);
        await hover(first, -1);
        assert.deepEqual(server.asked, [4, 1]);
    }],
    ['remembered levels open new hovers until they are forgotten', async () => {
        const { provider, server, hover } = fixture({ verbosity: 1, remember: true }, 5);
        await hover(await hover(), 1);
        await hover();
        server.maxLevel = 0;
        assert.deepEqual(buttons(await hover()), [false, false]);
        server.maxLevel = 5;
        await hover();
        await provider.forget();
        await hover();
        assert.deepEqual(server.asked, [1, 2, 2, 2, 2, 1], 'a hover with less to show leaves the remembered level');
    }],
    ['servers without hover levels get plain hovers', async () => {
        const { hover } = fixture({ verbosity: 1, remember: false }, undefined);
        assert.deepEqual(buttons(await hover()), [undefined, undefined]);
    }],
];

export async function runHoverLevelTests(): Promise<void> {
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
        throw new Error(`${failures.length} hover level test(s) failed: ${failures.join(', ')}`);
    }
}
