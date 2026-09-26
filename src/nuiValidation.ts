import { validResourceFileUri, validResourceLocation } from './resourceDetailsSession';
import type { NuiResource } from './nuiTypes';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length <= 32768; }
export function validNuiResource(value: unknown): value is NuiResource {
    return record(value) && record(value.resource) && text(value.resource.name)
        && validResourceFileUri(value.resource.uri) && validResourceFileUri(value.resource.manifestUri)
        && (value.uiPage === null || (text(value.uiPage) && value.uiPage.length <= 16384))
        && Number.isSafeInteger(value.truncated) && (value.truncated as number) >= 0
        && Array.isArray(value.callbacks) && value.callbacks.length <= 500
        && value.callbacks.every((callback: unknown) => record(callback) && text(callback.name) && !!callback.name && validResourceLocation(callback.location))
        && Array.isArray(value.notes) && value.notes.length <= 50 && value.notes.every(text);
}
