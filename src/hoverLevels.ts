import * as vscode from 'vscode';

/** The deepest level the language server writes hovers at. */
export const MAX_HOVER_LEVEL = 5;

const REMEMBERED_LEVEL = 'qbxLua.hover.rememberedVerbosity';

/** A hover from a server that writes hovers at levels, with the deepest level that writes more of it. */
export interface LevelHover {
    hover: vscode.Hover;
    /** Missing when the server writes its hovers at one level only. */
    maxLevel?: number;
}

export type LevelHoverRequest = (document: vscode.TextDocument, position: vscode.Position, level: number, token: vscode.CancellationToken) => Promise<LevelHover | undefined>;

/** `qbxLua.hover.verbosity` and `qbxLua.hover.rememberVerbosity` for a document. */
export interface HoverLevelSettings {
    verbosity: number;
    remember: boolean;
}

/**
 * `HoverContext` of VS Code's proposed `editorHoverVerbosityLevel` API, which the `+` and `-` buttons
 * of a hover send. VS Code hands it to every hover provider without the proposal being enabled, as
 * lua-language-server relies on, but `@types/vscode` does not declare it.
 */
interface HoverContext {
    readonly previousHover?: vscode.Hover;
    readonly verbosityDelta?: number;
}

/** `vscode.VerboseHover` of the same proposal: a hover with `+` and `-` buttons. */
export type VerboseHoverClass = new (contents: vscode.Hover['contents'], range: vscode.Range | undefined, canIncreaseVerbosity: boolean, canDecreaseVerbosity: boolean) => vscode.Hover;

/** `vscode.VerboseHover`, which VS Code versions without hover buttons lack. */
export function verboseHoverClass(): VerboseHoverClass | undefined {
    return (vscode as unknown as { VerboseHover?: VerboseHoverClass }).VerboseHover;
}

function clampLevel(level: number): number {
    return Number.isFinite(level) ? Math.min(Math.max(Math.trunc(level), 0), MAX_HOVER_LEVEL) : 1;
}

/**
 * Hovers with `+` and `-` buttons, as lua-language-server's client shows them. A new hover opens at
 * `qbxLua.hover.verbosity`, or with `qbxLua.hover.rememberVerbosity` at the level last chosen with the
 * buttons, and the buttons ask the server for the level above or below the one the hover shows.
 */
export class HoverLevels implements vscode.HoverProvider {
    /** The level each hover shows, which its buttons start from. */
    private readonly levels = new WeakMap<vscode.Hover, number>();

    constructor(private readonly VerboseHover: VerboseHoverClass, private readonly state: vscode.Memento, private readonly settings: (document: vscode.TextDocument) => HoverLevelSettings, private readonly request: LevelHoverRequest) {}

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context?: HoverContext): Promise<vscode.Hover | undefined> {
        const settings = this.settings(document);
        const previous = context?.previousHover ? this.levels.get(context.previousHover) : undefined;
        let level: number;
        if (previous !== undefined && context?.verbosityDelta !== undefined) {
            level = clampLevel(previous + context.verbosityDelta);
            if (settings.remember) {
                void this.state.update(REMEMBERED_LEVEL, level);
            }
        } else {
            const configured = clampLevel(settings.verbosity);
            level = settings.remember ? clampLevel(this.state.get<number>(REMEMBERED_LEVEL, configured)) : configured;
        }
        const result = await this.request(document, position, level, token);
        if (!result || token.isCancellationRequested) {
            return undefined;
        }
        if (result.maxLevel === undefined) {
            return result.hover;
        }
        // A hover with less to show stops at its deepest level, which leaves the remembered one as it is.
        const shown = Math.min(level, result.maxLevel);
        const hover = new this.VerboseHover(result.hover.contents, result.hover.range, shown < result.maxLevel, shown > 0);
        this.levels.set(hover, shown);
        return hover;
    }

    /** Opens new hovers at `qbxLua.hover.verbosity` again, as after either setting changes. */
    forget(): Thenable<void> {
        return this.state.update(REMEMBERED_LEVEL, undefined);
    }
}
