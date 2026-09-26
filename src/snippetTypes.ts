export type SnippetKind = 'builtin' | 'personal' | 'workspace';

export interface RecipeSnippet {
    id: string;
    label: string;
    description: string;
    body: string;
    /** Rendered example when provided by the existing language server. */
    preview?: string;
    prefix: string[];
    source: SnippetKind;
    sourceLabel: string;
}

export interface SnippetCatalog {
    items: RecipeSnippet[];
    issues: string[];
}

export type SnippetHostMessage =
    | { type: 'catalog'; requestId: number; catalog: SnippetCatalog }
    | { type: 'error'; requestId: number; message: string }
    | { type: 'actionComplete'; requestId: number; message: string }
    | { type: 'target'; name: string | undefined }
    | { type: 'invalidate' };

export type SnippetWebviewMessage =
    | { type: 'load'; requestId: number }
    | { type: 'action'; requestId: number; id: string; action: 'insert' | 'copy' | 'edit' | 'duplicate' }
    | { type: 'manage'; requestId: number; action: 'new' | 'personal' | 'workspace' | 'saveSelection' };
