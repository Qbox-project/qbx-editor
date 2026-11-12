import type { Vec3 } from './mapMath';

export type CoordStyle = 'vec' | 'vector' | 'table' | 'plain';
export const COORD_STYLES: readonly CoordStyle[] = ['vec', 'vector', 'table', 'plain'];

/** A Lua float literal rounded to `precision` decimals, always with a decimal point. */
export function luaNumber(value: number, precision: number): string {
    if (!Number.isFinite(value)) { return '0.0'; }
    const text = value.toFixed(Math.max(0, Math.min(6, precision))).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const normal = /^-0*(\.0*)?$/.test(text) ? '0' : text;
    return normal.includes('.') ? normal : `${normal}.0`;
}
export function luaCoords(position: Vec3, style: CoordStyle, precision: number, heading?: number): string {
    const parts = [...position, ...(heading === undefined ? [] : [heading])].map((value) => luaNumber(value, precision));
    if (style === 'plain') { return parts.join(', '); }
    if (style === 'table') { return `{ ${['x', 'y', 'z', 'w'].slice(0, parts.length).map((axis, index) => `${axis} = ${parts[index]}`).join(', ')} }`; }
    return `${style === 'vec' ? 'vec' : 'vector'}${parts.length}(${parts.join(', ')})`;
}
/** A backtick hash for a resolved model name, or the numeric hash when only that is known. */
export function luaModel(name: string, hash: number): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `\`${name}\`` : `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}
export function luaString(value: string): string { return `'${value.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`; }
export function luaPlayAnim(dictionary: string, clip: string, style: 'ox' | 'natives'): string {
    const dict = luaString(dictionary), name = luaString(clip);
    if (style === 'ox') { return `lib.playAnim(cache.ped, ${dict}, ${name})`; }
    return `RequestAnimDict(${dict})\nwhile not HasAnimDictLoaded(${dict}) do Wait(0) end\nTaskPlayAnim(PlayerPedId(), ${dict}, ${name}, 8.0, -8.0, -1, 0, 0.0, false, false, false)\nRemoveAnimDict(${dict})`;
}
export function luaEntity(name: string, hash: number, position: Vec3, heading: number, style: CoordStyle, precision: number): string {
    return `{ model = ${luaModel(name, hash)}, coords = ${luaCoords(position, style === 'plain' ? 'vec' : style, precision, heading)} }`;
}
export function luaBoxZone(center: Vec3, size: Vec3, heading: number, style: CoordStyle, precision: number): string {
    const vector = style === 'plain' || style === 'table' ? 'vec' : style;
    return `lib.zones.box({\n    coords = ${luaCoords(center, vector, precision)},\n    size = ${luaCoords(size, vector, precision)},\n    rotation = ${luaNumber(heading, precision)},\n})`;
}
export function luaPoints(points: readonly Vec3[], style: CoordStyle, precision: number): string {
    return `{\n${points.map((point) => `    ${luaCoords(point, style === 'plain' ? 'vec' : style, precision)},`).join('\n')}\n}`;
}
export function luaInteriorLookup(position: Vec3, precision: number): string {
    return `local interior = GetInteriorAtCoords(${luaCoords(position, 'plain', precision)})`;
}
export function luaEntitySet(position: Vec3, name: string, precision: number): string {
    return `${luaInteriorLookup(position, precision)}\nActivateInteriorEntitySet(interior, ${luaString(name)})\nRefreshInterior(interior)`;
}
