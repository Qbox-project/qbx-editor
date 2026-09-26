import * as vscode from 'vscode';
import { ASSISTANT_TOOLS, AssistantTools, type AssistantToolDefinition } from './assistantTools';

export interface AssistantApi {
    readonly version: 1;
    readonly tools: readonly AssistantToolDefinition[];
    call(name: string, arguments_: unknown, token?: vscode.CancellationToken): Promise<unknown>;
}

export type AssistantVscodeRequest = (method: string, params: unknown, token?: vscode.CancellationToken) => Promise<unknown>;

/** The public API works without a chat extension; LM registration is optional on older VS Code. */
export function registerAssistantTools(context: vscode.ExtensionContext, request: AssistantVscodeRequest): AssistantApi {
    const dispatcher = new AssistantTools({
        roots: () => vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath) ?? [],
        trusted: () => vscode.workspace.isTrusted,
        snapshot: 'live editor index',
        request: async (method, params, signal) => {
            const cancellation = new vscode.CancellationTokenSource();
            const cancel = (): void => cancellation.cancel();
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) { cancel(); }
            try { return await request(method, params, cancellation.token); }
            finally { signal.removeEventListener('abort', cancel); cancellation.dispose(); }
        },
    });
    context.subscriptions.push(dispatcher);
    const api: AssistantApi = Object.freeze({
        version: 1 as const,
        tools: ASSISTANT_TOOLS,
        call: async (name: string, arguments_: unknown, token?: vscode.CancellationToken): Promise<unknown> => {
            const controller = new AbortController();
            const subscription = token?.onCancellationRequested(() => controller.abort());
            if (token?.isCancellationRequested) { controller.abort(); }
            try { return await dispatcher.call(name, arguments_, controller.signal); }
            finally { subscription?.dispose(); }
        },
    });
    if (typeof vscode.lm?.registerTool === 'function') {
        for (const definition of ASSISTANT_TOOLS) {
            context.subscriptions.push(vscode.lm.registerTool(definition.name, {
                invoke: async (options: vscode.LanguageModelToolInvocationOptions<unknown>, token: vscode.CancellationToken) => new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(await api.call(definition.name, options.input, token))),
                ]),
                prepareInvocation: () => ({ invocationMessage: definition.title }),
            }));
        }
    }
    return api;
}
