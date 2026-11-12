export type Test = [name: string, body: () => Promise<void>];

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs `tests` in order in the extension host and fails with the names of those that failed.
 * `QBX_TEST_FILTER` keeps only the tests whose name contains it. A test that does not finish
 * within `QBX_TEST_TIMEOUT_MS` (ten minutes by default) fails by name instead of stalling the run.
 */
export async function runTests(tests: readonly Test[]): Promise<void> {
    const filter = process.env.QBX_TEST_FILTER?.toLowerCase();
    const timeoutMs = Number(process.env.QBX_TEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const selected = filter ? tests.filter(([name]) => name.toLowerCase().includes(filter)) : tests;
    if (selected.length === 0) {
        throw new Error(`No test name contains "${filter}".`);
    }
    const failures: string[] = [];
    for (const [name, body] of selected) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([body(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`did not finish within ${timeoutMs} ms`)), timeoutMs);
            })]);
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures.push(name);
            console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} test(s) failed: ${failures.join(', ')}`);
    }
}
