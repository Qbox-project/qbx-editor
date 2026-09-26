import { constants } from 'node:fs';
import { open, stat as fileStat, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cleanLogText } from './runtimeLogParser';

export interface LogLine { id: string; text: string }
export interface LogTailUpdate { lines: LogLine[]; status: string; paused: boolean }
export interface RuntimeLogTailOptions { pollIntervalMs?: number }

export const MAX_LOG_LINES = 1000;
export const MAX_LOG_BYTES = 512 * 1024;
export const MAX_LOG_LINE_CHARS = 8192;
const READ_BYTES = 256 * 1024;
const ANCHOR_BYTES = 64;
const RAW_LINE_CHARS = MAX_LOG_LINE_CHARS * 2;
const TRUNCATED = ' … [line truncated]';

function clipped(text: string, limit: number): string {
    let end = Math.min(text.length, limit);
    if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) { end--; }
    return text.slice(0, end);
}

/** Reads only an explicitly selected regular file. No directory scanning or log writes. */
export class RuntimeLogTail {
    private readonly interval: number;
    private lines: LogLine[] = [];
    private bytes = 0;
    private nextId = 0;
    private status = 'Opening local log…';
    private paused = false;
    private disposed = false;
    private started = false;
    private epoch = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private reading: Promise<void> | undefined;
    private activeHandle: FileHandle | undefined;
    private identity: string | undefined;
    private offset = 0;
    private anchor: Buffer = Buffer.alloc(0);
    private decoder = new StringDecoder('utf8');
    private raw = '';
    private rawTruncated = false;
    private partialId: string | undefined;
    private dropFirst = false;
    private clearPending = false;
    private changed = false;

    constructor(private readonly filename: string, private readonly onUpdate: (update: LogTailUpdate) => void, options: RuntimeLogTailOptions = {}) {
        this.interval = Math.min(5000, Math.max(10, options.pollIntervalMs ?? 350));
    }

    async start(): Promise<void> {
        if (this.disposed) { return; }
        if (this.started) { await this.reading; return; }
        if (!path.isAbsolute(this.filename)) { throw new Error('Choose an absolute local log file path.'); }
        this.started = true;
        try { await this.run(true); }
        catch (error) { this.started = false; this.cancelTimer(); throw error; }
    }

    setPaused(paused: boolean): void {
        if (this.disposed || this.paused === paused) { return; }
        this.paused = paused;
        ++this.epoch;
        this.setStatus(paused ? 'Paused. New output will be read when resumed.' : 'Resuming local log…');
        this.emit();
        this.cancelTimer();
        if (!paused) { this.schedule(0); }
    }

    /** Clear the view and skip bytes already present at the next synchronization; never truncate disk. */
    clear(): void {
        if (this.disposed) { return; }
        ++this.epoch;
        this.lines = [];
        this.bytes = 0;
        this.resetPartial();
        this.clearPending = true;
        this.changed = true;
        this.emit();
        this.cancelTimer();
        this.schedule(0);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        ++this.epoch;
        this.cancelTimer();
        void this.activeHandle?.close().catch(() => undefined);
        this.lines = [];
        this.raw = '';
        this.anchor = Buffer.alloc(0);
    }

    private cancelTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
    private schedule(delay = this.interval): void {
        if (!this.started || this.disposed || this.timer || (this.paused && !this.clearPending)) { return; }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.run(false);
        }, delay);
    }

    private async run(initial: boolean): Promise<void> {
        if (this.disposed || this.reading) { return; }
        const task = this.poll(initial);
        this.reading = task;
        try { await task; }
        finally {
            this.reading = undefined;
            // Failed clear synchronization (for example a missing paused log) must also back off.
            this.schedule();
        }
    }

    private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch; }
    private setStatus(status: string): void { if (this.status !== status) { this.status = status; this.changed = true; } }
    private emit(): void {
        if (this.disposed || !this.changed) { return; }
        this.changed = false;
        this.onUpdate({ lines: this.lines.map((line) => ({ ...line })), status: this.status, paused: this.paused });
    }

    private resetPartial(): void {
        this.decoder = new StringDecoder('utf8');
        this.raw = '';
        this.rawTruncated = false;
        this.partialId = undefined;
        this.dropFirst = false;
    }

    private append(text: string, replace?: string): string {
        const previous = replace && this.lines.at(-1)?.id === replace ? this.lines.at(-1) : undefined;
        if (previous?.text === text) { return previous.id; }
        if (previous) { this.lines.pop(); this.bytes -= Buffer.byteLength(previous.text); }
        const line = { id: String(++this.nextId), text };
        this.lines.push(line);
        this.bytes += Buffer.byteLength(text);
        while (this.lines.length > MAX_LOG_LINES || this.bytes > MAX_LOG_BYTES) {
            this.bytes -= Buffer.byteLength(this.lines.shift()!.text);
        }
        this.changed = true;
        return line.id;
    }

    private piece(text: string, complete: boolean): void {
        const room = Math.max(0, RAW_LINE_CHARS - this.raw.length);
        this.raw += clipped(text, room);
        this.rawTruncated ||= text.length > room;
        const plain = cleanLogText(this.raw);
        const tooLong = this.rawTruncated || plain.length > MAX_LOG_LINE_CHARS;
        const displayed = tooLong ? clipped(plain, MAX_LOG_LINE_CHARS - TRUNCATED.length) + TRUNCATED : plain;
        this.partialId = this.append(displayed, this.partialId);
        if (complete) { this.raw = ''; this.rawTruncated = false; this.partialId = undefined; }
    }

    private consume(buffer: Buffer): void {
        let bytes = buffer;
        if (this.dropFirst) {
            const newline = bytes.indexOf(10);
            if (newline < 0) { return; }
            bytes = bytes.subarray(newline + 1);
            this.dropFirst = false;
        }
        const text = this.decoder.write(bytes);
        let start = 0;
        for (;;) {
            const newline = text.indexOf('\n', start);
            if (newline < 0) { break; }
            this.piece(text.slice(start, newline), true);
            start = newline + 1;
        }
        if (start < text.length) { this.piece(text.slice(start), false); }
    }

    private async poll(initial: boolean): Promise<void> {
        const epoch = this.epoch;
        let handle: FileHandle | undefined;
        try {
            if (this.paused && !this.clearPending) { return; }
            const entry = await fileStat(this.filename);
            if (!this.current(epoch)) { return; }
            if (!entry.isFile()) { throw new Error('Choose a regular local log file.'); }
            // Nonblocking open also avoids hanging if a POSIX FIFO replaces the checked file.
            handle = await open(this.filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
            if (!this.current(epoch)) { return; }
            this.activeHandle = handle;
            const stat = await handle.stat();
            if (!this.current(epoch)) { return; }
            if (!stat.isFile()) { throw new Error('Choose a regular local log file.'); }
            const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            const replaced = this.identity !== undefined && identity !== this.identity;
            let truncated = this.identity === identity && stat.size < this.offset;
            let spent = 0;
            if (!replaced && !truncated && this.anchor.length && stat.size >= this.offset) {
                const anchor = Buffer.alloc(this.anchor.length);
                const check = await handle.read(anchor, 0, anchor.length, this.offset - anchor.length);
                if (!this.current(epoch)) { return; }
                spent += check.bytesRead;
                truncated = check.bytesRead !== this.anchor.length || !anchor.equals(this.anchor);
            }
            const first = this.identity === undefined;
            this.identity = identity;
            if (this.clearPending) {
                const anchor = Buffer.alloc(Math.min(ANCHOR_BYTES, stat.size));
                const captured = await handle.read(anchor, 0, anchor.length, stat.size - anchor.length);
                if (!this.current(epoch)) { return; }
                this.offset = stat.size;
                this.anchor = Buffer.from(anchor.subarray(0, captured.bytesRead));
                this.clearPending = false;
                this.resetPartial();
                this.setStatus(this.paused ? 'Paused. Display cleared.' : 'Following local log. Display cleared.');
                this.emit();
                return;
            }
            if (first || replaced || truncated) {
                this.offset = 0;
                this.anchor = Buffer.alloc(0);
                this.resetPartial();
                if (!first) { this.append(replaced ? '[Log file replaced; following recent output.]' : '[Log file truncated or rewritten; following recent output.]'); }
            }
            const remaining = stat.size - this.offset;
            const capacity = READ_BYTES - spent - 1;
            let skipped = false;
            if (remaining > capacity) {
                const skipOffset = stat.size - capacity;
                const previous = Buffer.alloc(1);
                const check = await handle.read(previous, 0, 1, skipOffset - 1);
                if (!this.current(epoch)) { return; }
                this.offset = skipOffset;
                this.anchor = Buffer.alloc(0);
                this.resetPartial();
                this.dropFirst = check.bytesRead !== 1 || previous[0] !== 10;
                this.append(first ? '[Showing the most recent log output; older bytes skipped.]' : '[Log output skipped while catching up; showing recent output.]');
                skipped = true;
            }
            const length = Math.min(capacity, stat.size - this.offset);
            if (length > 0) {
                const buffer = Buffer.alloc(length);
                const read = await handle.read(buffer, 0, length, this.offset);
                if (!this.current(epoch)) { return; }
                const bytes = buffer.subarray(0, read.bytesRead);
                this.offset += read.bytesRead;
                this.anchor = Buffer.from(Buffer.concat([this.anchor, bytes]).subarray(-ANCHOR_BYTES));
                this.consume(bytes);
            }
            // The marker may itself leave the bounded line buffer during a large burst.
            // Keep the gap visible in status until more content arrives.
            this.setStatus(skipped ? 'Following local log. Older output was skipped while catching up.'
                : length === 0 && this.status.startsWith('Following local log.') ? this.status : 'Following local log.');
            this.emit();
        } catch (error) {
            if (!this.current(epoch)) { return; }
            if (initial) { throw error; }
            const code = (error as NodeJS.ErrnoException).code;
            this.setStatus(code === 'ENOENT' ? 'Waiting for the log file to reappear.' : `Cannot read log; retrying: ${error instanceof Error ? error.message : String(error)}`);
            this.emit();
        } finally {
            if (this.activeHandle === handle) { this.activeHandle = undefined; }
            await handle?.close().catch(() => undefined);
        }
    }
}
