/** Decode prose character references while passing only individual entities to the decoder. */
export function decodeMarkdownEntities(text: string, decodeEntity: (entity: string) => string): string {
    return text.replace(/&(?:#[0-9]{1,10}|#[xX][0-9A-Fa-f]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/g, (entity) => decodeEntity(entity));
}
