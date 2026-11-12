/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { COORD_STYLES, luaBoxZone, luaCoords, luaEntity, luaEntitySet, luaInteriorLookup, luaModel, luaPoints, type CoordStyle } from './mapLua.js';
import type { Vec3 } from './mapMath.js';
import type { MapAction, MapArchetypeRow, MapEntityRow, MapInterior, MapMessage, MapRoom, MapView } from './mapTypes.js';
import { button, element, facts, fromHost, matches, node, pager, record, themeColor, tokens } from './viewerDom.mjs';

declare function acquireVsCodeApi(): { postMessage(message: MapAction): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const saved = vscode.getState(), prior = record(saved) ? saved : {};
const TABS = [['overview', 'Overview'], ['entities', 'Entities'], ['plot', 'Top-down map'], ['interiors', 'Interiors'], ['archetypes', 'Archetypes'], ['cars', 'Car generators']] as const;
type Tab = typeof TABS[number][0];
const state = {
    tab: (TABS.some(([id]) => id === prior.tab) ? prior.tab : 'overview') as Tab,
    style: (COORD_STYLES.includes(prior.style as CoordStyle) ? prior.style : 'vec') as CoordStyle,
    precision: typeof prior.precision === 'number' && prior.precision >= 1 && prior.precision <= 4 ? Math.floor(prior.precision) : 2,
    entityQuery: typeof prior.entityQuery === 'string' ? prior.entityQuery.slice(0, 256) : '',
    archetypeQuery: typeof prior.archetypeQuery === 'string' ? prior.archetypeQuery.slice(0, 256) : '',
    path: typeof prior.path === 'string' ? prior.path.slice(0, 4096) : '',
};
interface Picked { position: Vec3; heading?: number; note: string; levels?: number[] }
let view: MapView | undefined, selected: MapEntityRow | undefined, selectedArchetype: MapArchetypeRow | undefined, picked: Picked | undefined;
let entityGroup = -1, surfaceRequest = 0;
const hidden = new Set<string>();
function save(): void { vscode.setState({ ...state }); }
function status(message: string): void { element('status').textContent = message; }
function copy(text: string, label: string): void { vscode.postMessage({ type: 'copy', text, label }); }
function fixed(value: number, digits = state.precision): string { return Number.isFinite(value) ? value.toFixed(digits) : '0'; }
function coords(position: Vec3, heading?: number): string { return luaCoords(position, state.style, state.precision, heading); }
function hex(hash: number): string { return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`; }
function where(row: MapEntityRow): string {
    const group = view?.groups[row.group];
    if (!group) { return ''; }
    const interior = group.interior === undefined ? undefined : view?.interiors[group.interior];
    const room = row.room === undefined ? undefined : interior?.rooms[row.room]?.name, portal = row.portal === undefined ? undefined : interior?.portals[row.portal];
    const roomName = (index: number): string => interior?.rooms[index]?.name ?? `room ${index}`;
    const place = room ?? (portal ? `portal ${portal.index} (${roomName(portal.roomFrom)} ↔ ${roomName(portal.roomTo)})` : undefined);
    return place ? `${place}${group.kind === 'entitySet' ? ` · ${group.label.replace(/^Entity set · /, 'set ')}` : ''}` : group.label;
}
function cell(text: string, className?: string): HTMLTableCellElement { return node('td', text, className); }
function copyRow(...buttons: HTMLButtonElement[]): HTMLDivElement { const row = node('div', undefined, 'copy-row'); row.append(...buttons); return row; }

function entityDetail(row: MapEntityRow, withMapButton: boolean): HTMLElement[] {
    const rows = [{ name: 'Position', value: row.position.map((value) => fixed(value, 3)).join(', ') }, { name: 'Heading', value: `${fixed(row.heading)}°` },
        { name: 'Rotation', value: row.rotation.map((value) => fixed(value, 4)).join(', ') }, { name: 'Where', value: where(row) }];
    if (row.size) { rows.push({ name: 'Size', value: `${row.size.map((value) => fixed(value)).join(' × ')} m` }); }
    if (row.scale[0] !== 1 || row.scale[1] !== 1) { rows.push({ name: 'Scale', value: `${fixed(row.scale[0])} (XY), ${fixed(row.scale[1])} (Z)` }); }
    rows.push({ name: 'LOD', value: `${fixed(row.lodDist, 1)} m · ${row.lodLevel || 'unknown level'}` }, { name: 'Flags', value: String(row.flags) });
    const name = row.name.startsWith('0x') ? 'model hash' : row.name;
    const actions = [button('Copy position', () => copy(coords(row.position), `position of ${name}`)), button('Copy with heading', () => copy(coords(row.position, row.heading), `position and heading of ${name}`)),
        button('Copy model', () => copy(luaModel(row.name, row.hash), 'model')), button('Copy hash', () => copy(hex(row.hash), 'hash')),
        button('Copy as Lua table', () => copy(luaEntity(row.name, row.hash, row.position, row.heading, state.style, state.precision), `Lua table for ${name}`))];
    if (withMapButton) { actions.push(button('Show on map', () => { focusPoint(row.position); showTab('plot'); })); }
    return [node('h2', row.name, 'detail-name'), node('p', `${hex(row.hash)} · ${row.kind === 'interior' ? 'interior placement' : 'entity'} #${row.id}`, 'detail-sub'), facts(rows, 'facts compact'), copyRow(...actions)];
}
function select(row: MapEntityRow | undefined): void {
    selected = row;
    element('entity-detail').replaceChildren(...(row ? entityDetail(row, true) : [node('p', 'Select an entity to see its world position, heading and copy actions.', 'muted')]));
    entities.render(filteredEntities());
    renderPlotDetail(); draw();
}
function filteredEntities(): MapEntityRow[] {
    const query = tokens(state.entityQuery);
    return view?.entities.filter((row) => (entityGroup < 0 || row.group === entityGroup) && matches(`${row.name} ${hex(row.hash)} ${row.hash} ${where(row)}`, query)) ?? [];
}
const entities = pager<MapEntityRow>({ body: 'entity-rows', previous: 'entity-previous', next: 'entity-next', range: 'entity-range' }, 100, 'entities', (row) => {
    const line = node('tr');
    line.append(cell(row.name), cell(where(row), 'muted'), cell(fixed(row.position[0]), 'num'), cell(fixed(row.position[1]), 'num'), cell(fixed(row.position[2]), 'num'), cell(fixed(row.heading, 1), 'num'));
    return line;
}, (row) => row === selected, (row) => select(row));

function filteredArchetypes(): MapArchetypeRow[] {
    const query = tokens(state.archetypeQuery);
    return view?.archetypes.filter((row) => matches(`${row.name} ${hex(row.hash)} ${row.kind} ${row.textureDictionary} ${row.drawableDictionary} ${row.physicsDictionary}`, query)) ?? [];
}
function selectArchetype(row: MapArchetypeRow | undefined): void {
    selectedArchetype = row;
    const detail = element('archetype-detail');
    if (!row) { detail.replaceChildren(node('p', 'Select an archetype to see its dictionaries and copy actions.', 'muted')); }
    else {
        const rows = [{ name: 'Kind', value: row.kind === 'mlo' ? 'interior (MLO)' : row.kind === 'time' ? 'time-dependent' : 'base' }, { name: 'Size', value: `${row.size.map((value) => fixed(value)).join(' × ')} m` },
            { name: 'LOD distance', value: `${fixed(row.lodDist, 1)} m` }, { name: 'Asset type', value: row.assetType || 'unknown' }, { name: 'Textures', value: row.textureDictionary || '(none)' },
            { name: 'Drawable dict.', value: row.drawableDictionary || '(none)' }, { name: 'Physics dict.', value: row.physicsDictionary || '(none)' }, { name: 'Clip dict.', value: row.clipDictionary || '(none)' },
            { name: 'Flags', value: String(row.flags) }, { name: 'Placed', value: row.placements ? `${row.placements} time${row.placements === 1 ? '' : 's'} by maps in this resource` : 'not by a map in this resource' }];
        detail.replaceChildren(node('h2', row.name, 'detail-name'), node('p', hex(row.hash), 'detail-sub'), facts(rows, 'facts compact'),
            copyRow(button('Copy model', () => copy(luaModel(row.name, row.hash), 'model')), button('Copy name', () => copy(row.name, 'name')), button('Copy hash', () => copy(hex(row.hash), 'hash'))));
    }
    archetypes.render(filteredArchetypes());
}
const archetypes = pager<MapArchetypeRow>({ body: 'archetype-rows', previous: 'archetype-previous', next: 'archetype-next', range: 'archetype-range' }, 100, 'archetypes', (row) => {
    const line = node('tr');
    line.append(cell(row.name), cell(row.kind === 'mlo' ? 'interior' : row.kind, 'muted'), cell(row.size.map((value) => fixed(value, 1)).join(' × '), 'num'), cell(fixed(row.lodDist, 0), 'num'),
        cell(row.textureDictionary, 'muted'), cell(String(row.placements), 'num'));
    return line;
}, (row) => row === selectedArchetype, (row) => selectArchetype(row));

function roomCorners(room: MapRoom): Vec3[] { return room.corners.map(([x, y]) => [x, y, room.floor] as Vec3); }
function renderInteriors(): void {
    if (!view) { return; }
    element('interiors').replaceChildren(...view.interiors.map((interior) => {
        const card = node('section', undefined, 'card');
        const lead = interior.placed ? `Placed at ${interior.position.map((value) => fixed(value)).join(', ')} · heading ${fixed(interior.heading, 1)}°${interior.placedIn ? ` · by ${interior.placedIn}` : ''}`
            : 'Not placed by a map file in this resource: coordinates below are relative to the interior origin.';
        card.append(node('h2', interior.name), node('p', `${hex(interior.hash)} · defined in ${interior.definedIn} · ${interior.entityCount} entities`, 'detail-sub'), node('p', lead, 'hint'));
        if (interior.collision) {
            card.append(node('p', `Floor heights and picked points use the collision in ${interior.collision.files.join(', ')} (${interior.collision.triangles.toLocaleString()} triangles).`, 'hint'));
        } else if (interior.rooms.length) { card.append(node('p', 'No collision file for this interior was found in the resource, so floor heights are the bottoms of the room boxes.', 'hint')); }
        if (interior.placed) {
            card.append(copyRow(button('Copy position', () => copy(coords(interior.position), `position of ${interior.name}`)), button('Copy with heading', () => copy(coords(interior.position, interior.heading), `placement of ${interior.name}`)),
                button('Copy interior lookup', () => copy(luaInteriorLookup(interior.position, state.precision), 'GetInteriorAtCoords call')), button('Show on map', () => { focusPoint(interior.position); showTab('plot'); })));
        }
        if (interior.rooms.length) { card.append(node('h3', `Rooms (${interior.rooms.length})`), roomTable(interior)); }
        if (interior.portals.length) { card.append(node('h3', `Portals (${interior.portals.length})`), portalTable(interior)); }
        if (interior.entitySets.length) { card.append(node('h3', `Entity sets (${interior.entitySets.length})`), entitySetTable(interior)); }
        return card;
    }));
}
function table(headings: (string | [string, 'num'])[], rows: HTMLTableRowElement[]): HTMLElement {
    const wrapper = node('div', undefined, 'table-scroll'), result = node('table', undefined, 'data'), head = node('thead'), line = node('tr'), body = node('tbody');
    line.append(...headings.map((heading) => { const th = node('th', typeof heading === 'string' ? heading : heading[0]); if (typeof heading !== 'string') { th.className = 'num'; } return th; }));
    head.append(line); body.append(...rows); result.append(head, body); wrapper.append(result);
    return wrapper;
}
function actionsCell(...buttons: HTMLButtonElement[]): HTMLTableCellElement { const td = node('td'), row = node('div', undefined, 'row-actions'); row.append(...buttons); td.append(row); return td; }
function roomTable(interior: MapInterior): HTMLElement {
    return table(['Room', ['Center', 'num'], ['Size (m)', 'num'], ['Floor Z', 'num'], ['Entities', 'num'], ''], interior.rooms.map((room) => {
        const line = node('tr');
        line.append(cell(room.name), cell(room.center.map((value) => fixed(value)).join(', '), 'num'), cell(room.size.map((value) => fixed(value, 1)).join(' × '), 'num'), cell(fixed(room.surface ?? room.floor), 'num'),
            cell(String(room.entityCount), 'num'), actionsCell(button('Center', () => copy(coords(room.center), `center of ${room.name}`), 'Copy the room center'),
                button('Box zone', () => copy(luaBoxZone(room.center, room.size, interior.heading, state.style, state.precision), `ox_lib box zone for ${room.name}`), 'Copy an ox_lib box zone covering the room'),
                button('Corners', () => copy(luaPoints(roomCorners(room), state.style, state.precision), `corners of ${room.name}`), 'Copy the four floor corners'),
                button('Map', () => { focusPoint(room.center); showTab('plot'); }, 'Show on the top-down map')));
        return line;
    }));
}
function portalTable(interior: MapInterior): HTMLElement {
    const name = (index: number): string => interior.rooms[index]?.name ?? `room ${index}`;
    return table([['#', 'num'], 'From', 'To', ['Center', 'num'], ['Flags', 'num'], ''], interior.portals.map((portal) => {
        const line = node('tr');
        line.append(cell(String(portal.index), 'num'), cell(name(portal.roomFrom)), cell(name(portal.roomTo)), cell(portal.center.map((value) => fixed(value)).join(', '), 'num'), cell(String(portal.flags), 'num'),
            actionsCell(button('Center', () => copy(coords(portal.center), `center of portal ${portal.index}`), 'Copy the portal center'), button('Map', () => { focusPoint(portal.center); showTab('plot'); }, 'Show on the top-down map')));
        return line;
    }));
}
function entitySetTable(interior: MapInterior): HTMLElement {
    return table(['Entity set', ['Entities', 'num'], 'Default', ''], interior.entitySets.map((set) => {
        const line = node('tr');
        line.append(cell(set.name), cell(String(set.entityCount), 'num'), cell(set.enabledByDefault ? 'on' : 'off', 'muted'),
            actionsCell(button('Name', () => copy(set.name, 'entity set name'), 'Copy the entity set name'),
                button('Activate', () => copy(luaEntitySet(interior.position, set.name, state.precision), `activation code for ${set.name}`), 'Copy Lua that activates this entity set')));
        return line;
    }));
}
function renderCars(): void {
    if (!view) { return; }
    element('car-rows').replaceChildren(...view.carGenerators.map((car) => {
        const line = node('tr');
        line.append(cell(car.model), cell(fixed(car.position[0]), 'num'), cell(fixed(car.position[1]), 'num'), cell(fixed(car.position[2]), 'num'), cell(fixed(car.heading, 1), 'num'),
            actionsCell(button('Position', () => copy(coords(car.position), 'car generator position')), button('With heading', () => copy(coords(car.position, car.heading), 'car generator position and heading')),
                button('Map', () => { focusPoint(car.position); showTab('plot'); }, 'Show on the top-down map')));
        return line;
    }));
}

const canvas = element<HTMLCanvasElement>('plot'), context = canvas.getContext('2d');
const plot = { scale: 1, x: 0, y: 0, fitted: false };
const PALETTE: [string, string][] = [['--vscode-charts-blue', '#3794ff'], ['--vscode-charts-green', '#89d185'], ['--vscode-charts-orange', '#d18616'], ['--vscode-charts-purple', '#b180d7'],
    ['--vscode-charts-yellow', '#cca700'], ['--vscode-charts-red', '#f14c4c']];
function groupColor(group: number): string { const [name, fallback] = PALETTE[group % PALETTE.length]; return themeColor(name, fallback); }
function toScreen(x: number, y: number): [number, number] { return [(x - plot.x) * plot.scale + canvas.clientWidth / 2, canvas.clientHeight / 2 - (y - plot.y) * plot.scale]; }
function toWorld(sx: number, sy: number): [number, number] { return [(sx - canvas.clientWidth / 2) / plot.scale + plot.x, (canvas.clientHeight / 2 - sy) / plot.scale + plot.y]; }
function visible(row: MapEntityRow): boolean { return !hidden.has(`group:${row.group}`); }
function fit(): void {
    if (!view || !canvas.clientWidth || !canvas.clientHeight) { return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (x: number, y: number): void => { if (Number.isFinite(x) && Number.isFinite(y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); } };
    for (const row of view.entities) { if (visible(row)) { include(row.position[0], row.position[1]); } }
    for (const interior of view.interiors) { for (const room of interior.rooms) { for (const [x, y] of room.corners) { include(x, y); } } }
    for (const car of view.carGenerators) { include(car.position[0], car.position[1]); }
    if (minX === Infinity) { plot.x = 0; plot.y = 0; plot.scale = 10; }
    else {
        plot.x = (minX + maxX) / 2; plot.y = (minY + maxY) / 2;
        plot.scale = Math.min(200, Math.max(1e-4, Math.min(canvas.clientWidth / Math.max(maxX - minX, 2), canvas.clientHeight / Math.max(maxY - minY, 2)) * 0.88));
    }
    plot.fitted = true; draw();
}
function focusPoint(position: Vec3): void { plot.x = position[0]; plot.y = position[1]; plot.scale = Math.max(plot.scale, 12); plot.fitted = true; }
function zoom(factor: number, sx = canvas.clientWidth / 2, sy = canvas.clientHeight / 2): void {
    const [wx, wy] = toWorld(sx, sy);
    plot.scale = Math.min(2000, Math.max(1e-4, plot.scale * factor));
    const [nx, ny] = toWorld(sx, sy);
    plot.x += wx - nx; plot.y += wy - ny; draw();
}
function inside(point: [number, number], polygon: readonly [number, number][]): boolean {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
        if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) { result = !result; }
    }
    return result;
}
/** The smallest named room whose floor outline contains the point; the catch-all exterior room is ignored. */
function roomAt(point: [number, number]): { room: MapRoom; interior: MapInterior } | undefined {
    let best: { room: MapRoom; interior: MapInterior } | undefined;
    for (const interior of view?.interiors ?? []) {
        for (const room of interior.rooms) {
            if (room.name.toLowerCase() !== 'limbo' && inside(point, room.corners) && (!best || room.size[0] * room.size[1] < best.room.size[0] * best.room.size[1])) { best = { room, interior }; }
        }
    }
    return best;
}
function nearest(sx: number, sy: number, limit: number): MapEntityRow | undefined {
    let best: MapEntityRow | undefined, distance = limit * limit;
    for (const row of view?.entities ?? []) {
        if (!visible(row)) { continue; }
        const [x, y] = toScreen(row.position[0], row.position[1]), d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d <= distance) { best = row; distance = d; }
    }
    return best;
}
function draw(): void {
    if (!context || !view || element('panel-plot').hidden) { return; }
    const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    if (!plot.fitted) { fit(); return; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const foreground = themeColor('--vscode-foreground', '#ccc'), faint = themeColor('--vscode-panel-border', '#444'), accent = themeColor('--vscode-focusBorder', '#007fd4');
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((size) => size * plot.scale >= 70) ?? 10000;
    const [left, top] = toWorld(0, 0), [right, bottom] = toWorld(width, height);
    context.lineWidth = 1; context.strokeStyle = faint; context.fillStyle = themeColor('--vscode-descriptionForeground', '#999'); context.font = '10px sans-serif';
    context.beginPath();
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) { const [sx] = toScreen(x, 0); context.moveTo(Math.round(sx) + 0.5, 0); context.lineTo(Math.round(sx) + 0.5, height); context.fillText(String(x), sx + 3, 11); }
    for (let y = Math.ceil(bottom / step) * step; y <= top; y += step) { const [, sy] = toScreen(0, y); context.moveTo(0, Math.round(sy) + 0.5); context.lineTo(width, Math.round(sy) + 0.5); context.fillText(String(y), 3, sy - 3); }
    context.globalAlpha = 0.5; context.stroke(); context.globalAlpha = 1;
    if (!hidden.has('rooms')) {
        for (const interior of view.interiors) {
            for (const room of interior.rooms) {
                const limbo = room.name.toLowerCase() === 'limbo';
                context.beginPath();
                room.corners.forEach(([x, y], index) => { const [sx, sy] = toScreen(x, y); if (index) { context.lineTo(sx, sy); } else { context.moveTo(sx, sy); } });
                context.closePath();
                context.strokeStyle = groupColor(interior.group); context.setLineDash(limbo ? [4, 4] : []); context.lineWidth = limbo ? 1 : 1.5;
                if (!limbo) { context.globalAlpha = 0.1; context.fillStyle = groupColor(interior.group); context.fill(); context.globalAlpha = 1; }
                context.stroke(); context.setLineDash([]);
                const [cx, cy] = toScreen(room.center[0], room.center[1]);
                if (!limbo && Math.max(room.size[0], room.size[1]) * plot.scale > 60) { context.fillStyle = foreground; context.font = '11px sans-serif'; context.textAlign = 'center'; context.fillText(room.name, cx, cy); context.textAlign = 'start'; }
            }
        }
    }
    if (!hidden.has('portals')) {
        context.strokeStyle = themeColor('--vscode-charts-yellow', '#cca700'); context.lineWidth = 2.5;
        for (const interior of view.interiors) {
            for (const portal of interior.portals) {
                if (portal.corners.length < 2) { continue; }
                const points = portal.corners.map((corner) => toScreen(corner[0], corner[1]));
                let a = points[0], b = points[1], span = 0;
                for (const p of points) { for (const q of points) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d > span) { span = d; a = p; b = q; } } }
                context.beginPath(); context.moveTo(a[0], a[1]); context.lineTo(b[0], b[1]); context.stroke();
            }
        }
    }
    const radius = plot.scale > 4 ? 3 : 2;
    for (const row of view.entities) {
        if (!visible(row)) { continue; }
        const [sx, sy] = toScreen(row.position[0], row.position[1]);
        if (sx < -4 || sy < -4 || sx > width + 4 || sy > height + 4) { continue; }
        context.fillStyle = groupColor(row.group);
        if (row.kind === 'interior') { context.fillRect(sx - 4, sy - 4, 8, 8); } else { context.beginPath(); context.arc(sx, sy, radius, 0, Math.PI * 2); context.fill(); }
    }
    if (!hidden.has('cars')) {
        context.strokeStyle = themeColor('--vscode-charts-red', '#f14c4c'); context.lineWidth = 1.5;
        for (const car of view.carGenerators) {
            const [sx, sy] = toScreen(car.position[0], car.position[1]), angle = car.heading * Math.PI / 180, length = Math.max(8, car.length * plot.scale / 2);
            context.beginPath(); context.moveTo(sx + Math.sin(angle) * length, sy + Math.cos(angle) * length); context.lineTo(sx - Math.sin(angle) * length, sy - Math.cos(angle) * length); context.stroke();
            context.beginPath(); context.arc(sx - Math.sin(angle) * length, sy - Math.cos(angle) * length, 2.5, 0, Math.PI * 2); context.stroke();
        }
    }
    if (selected && visible(selected)) {
        const [sx, sy] = toScreen(selected.position[0], selected.position[1]), angle = selected.heading * Math.PI / 180;
        context.strokeStyle = accent; context.lineWidth = 2;
        context.beginPath(); context.arc(sx, sy, 8, 0, Math.PI * 2); context.moveTo(sx, sy); context.lineTo(sx - Math.sin(angle) * 20, sy - Math.cos(angle) * 20); context.stroke();
    }
    if (picked) {
        const [sx, sy] = toScreen(picked.position[0], picked.position[1]);
        context.strokeStyle = foreground; context.lineWidth = 1.5;
        context.beginPath(); context.moveTo(sx - 9, sy); context.lineTo(sx + 9, sy); context.moveTo(sx, sy - 9); context.lineTo(sx, sy + 9);
        if (picked.heading !== undefined) { const angle = picked.heading * Math.PI / 180; context.moveTo(sx, sy); context.lineTo(sx - Math.sin(angle) * 26, sy - Math.cos(angle) * 26); }
        context.stroke();
    }
}
function pick(sx: number, sy: number, heading?: number): void {
    const [x, y] = toWorld(sx, sy), found = roomAt([x, y]), close = nearest(sx, sy, 1e6);
    const z = found ? found.room.floor : close ? close.position[2] : 0;
    picked = { position: [x, y, z], heading, note: found ? `Inside ${found.room.name}. Z is the room floor from its bounding box; a standing ped is about 1.0 higher.`
        : close ? `Z is copied from the nearest entity (${close.name}).` : 'Z is unknown here and set to 0.' };
    surfaceRequest++;
    if (found?.interior.collision && view) {
        vscode.postMessage({ type: 'surfaces', requestId: surfaceRequest, interior: view.interiors.indexOf(found.interior), x, y, low: found.room.floor - 0.5, high: found.room.ceiling - 0.5 });
    }
    renderPlotDetail(); draw();
}
function renderPlotDetail(): void {
    const parts: HTMLElement[] = [];
    if (picked) {
        const point = picked;
        parts.push(node('h2', 'Picked point', 'section-label'), node('p', `${point.position.map((value) => fixed(value)).join(', ')}${point.heading === undefined ? '' : ` · heading ${fixed(point.heading, 1)}°`}`, 'detail-name'), node('p', point.note, 'hint'),
            copyRow(button('Copy position', () => copy(coords(point.position), 'picked position')),
                ...(point.heading === undefined ? [] : [button('Copy with heading', () => copy(coords(point.position, point.heading), 'picked position and heading'))]),
                button('Clear', () => { picked = undefined; renderPlotDetail(); draw(); })));
        if (point.levels && point.levels.length > 1) {
            parts.push(node('p', 'Surfaces under this point, lowest first:', 'hint'), copyRow(...[...point.levels].reverse().map((level) => {
                const choose = button(fixed(level), () => { point.position = [point.position[0], point.position[1], level]; renderPlotDetail(); draw(); }, 'Use this height');
                if (level === point.position[2]) { choose.className = 'primary'; }
                return choose;
            })));
        }
    }
    if (selected) { parts.push(node('h2', 'Selected entity', 'section-label'), ...entityDetail(selected, false)); }
    element('plot-detail').replaceChildren(...parts);
}
function renderLayers(): void {
    if (!view) { return; }
    const items: [string, string, string][] = view.groups.map((group, index) => [`group:${index}`, group.label, groupColor(index)]);
    if (view.interiors.some((interior) => interior.rooms.length)) { items.push(['rooms', 'Room outlines', themeColor('--vscode-foreground', '#ccc')]); }
    if (view.interiors.some((interior) => interior.portals.length)) { items.push(['portals', 'Portals', themeColor('--vscode-charts-yellow', '#cca700')]); }
    if (view.carGenerators.length) { items.push(['cars', 'Car generators', themeColor('--vscode-charts-red', '#f14c4c')]); }
    element('layers').replaceChildren(...items.map(([key, label, color]) => {
        const item = node('li'), wrap = node('label'), box = node('input'), swatch = node('span', undefined, 'swatch');
        box.type = 'checkbox'; box.checked = !hidden.has(key); swatch.style.background = color;
        box.addEventListener('change', () => { if (box.checked) { hidden.delete(key); } else { hidden.add(key); } draw(); });
        wrap.append(box, swatch, label); item.append(wrap); return item;
    }));
}
let drag: { x: number; y: number; moved: boolean; aim: boolean } | undefined;
canvas.addEventListener('pointerdown', (event) => { drag = { x: event.offsetX, y: event.offsetY, moved: false, aim: event.shiftKey }; canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener('pointermove', (event) => {
    const [x, y] = toWorld(event.offsetX, event.offsetY), found = roomAt([x, y]);
    element('plot-readout').textContent = `x ${fixed(x)}  y ${fixed(y)}${found ? `  ·  ${found.room.name}` : ''}`;
    if (!drag) { return; }
    if (!drag.moved && Math.hypot(event.offsetX - drag.x, event.offsetY - drag.y) < 4) { return; }
    drag.moved = true;
    if (drag.aim) { pick(drag.x, drag.y, ((Math.atan2(-(event.offsetX - drag.x), -(event.offsetY - drag.y)) * 180 / Math.PI) % 360 + 360) % 360); }
    else { plot.x -= event.movementX / plot.scale; plot.y += event.movementY / plot.scale; draw(); }
});
canvas.addEventListener('pointerup', (event) => {
    const start = drag; drag = undefined;
    if (!start || start.moved) { return; }
    const hit = nearest(event.offsetX, event.offsetY, 7);
    if (hit) { select(hit); } else { pick(event.offsetX, event.offsetY); }
});
canvas.addEventListener('pointercancel', () => { drag = undefined; });
canvas.addEventListener('wheel', (event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.offsetX, event.offsetY); }, { passive: false });
canvas.addEventListener('keydown', (event) => {
    const pan = 40 / plot.scale;
    if (event.key === 'ArrowLeft') { plot.x -= pan; } else if (event.key === 'ArrowRight') { plot.x += pan; } else if (event.key === 'ArrowUp') { plot.y += pan; } else if (event.key === 'ArrowDown') { plot.y -= pan; }
    else if (event.key === '+' || event.key === '=') { zoom(1.2); return; } else if (event.key === '-') { zoom(1 / 1.2); return; } else if (event.key === '0') { fit(); return; } else { return; }
    event.preventDefault(); draw();
});
new ResizeObserver(() => draw()).observe(canvas);
new MutationObserver(() => { renderLayers(); draw(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function available(tab: Tab): boolean {
    if (!view) { return false; }
    return tab === 'overview' || (tab === 'entities' && view.entities.length > 0) || (tab === 'plot' && (view.entities.length > 0 || view.carGenerators.length > 0 || view.interiors.length > 0))
        || (tab === 'interiors' && view.interiors.length > 0) || (tab === 'archetypes' && view.archetypes.length > 0) || (tab === 'cars' && view.carGenerators.length > 0);
}
function tabCount(tab: Tab): string {
    const count = tab === 'entities' ? view?.entities.length : tab === 'interiors' ? view?.interiors.length : tab === 'archetypes' ? view?.archetypes.length : tab === 'cars' ? view?.carGenerators.length : undefined;
    return count === undefined ? '' : ` (${count.toLocaleString()})`;
}
function showTab(tab: Tab): void {
    state.tab = available(tab) ? tab : 'overview';
    for (const [id] of TABS) { element(`panel-${id}`).hidden = !view || id !== state.tab; }
    element('tabs').replaceChildren(...TABS.filter(([id]) => available(id)).map(([id, label]) => {
        const tab = button(`${label}${tabCount(id)}`, () => showTab(id));
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(id === state.tab)); tab.setAttribute('aria-controls', `panel-${id}`);
        return tab;
    }));
    if (state.tab === 'plot') { draw(); }
    save();
}
function renderAll(): void {
    if (!view) { return; }
    element('title').textContent = view.title; element('path').textContent = view.path;
    element('export').textContent = view.source === 'xml' ? 'Edit as text' : 'Open as XML';
    element('facts').replaceChildren(...view.facts.flatMap((row) => [node('dt', row.name), node('dd', row.value)]));
    element('notes').replaceChildren(...view.notes.map((note) => node('li', note)));
    element('related').hidden = !view.related.length;
    element('related-list').replaceChildren(...view.related.map((file) => {
        const item = node('li'), link = button(file.label, () => vscode.postMessage({ type: 'openRelated', id: file.id }));
        link.className = 'link'; item.append(link, node('span', ` · ${file.role}`, 'muted')); return item;
    }));
    const groups = element<HTMLSelectElement>('entity-group');
    groups.replaceChildren(...[['-1', 'All groups'] as [string, string], ...view.groups.map((group, index) => [String(index), group.label] as [string, string])].map(([value, label]) => { const option = node('option', label); option.value = value; return option; }));
    groups.value = String(entityGroup);
    renderLayers(); renderInteriors(); renderCars(); select(selected); selectArchetype(selectedArchetype); renderPlotDetail();
}
window.addEventListener('message', (event: MessageEvent<MapMessage>) => {
    if (!fromHost(event)) { return; }
    const message = event.data;
    if (message?.type === 'loading') { element('loading').hidden = false; element('error').hidden = true; status('Reading map file…'); }
    else if (message?.type === 'state') {
        const same = state.path === message.data.path;
        view = message.data; state.path = view.path;
        selected = undefined; selectedArchetype = undefined; picked = undefined; entityGroup = -1; hidden.clear();
        view.groups.forEach((group, index) => { if (!group.enabled) { hidden.add(`group:${index}`); } });
        if (!same) { state.entityQuery = ''; state.archetypeQuery = ''; plot.fitted = false; }
        element<HTMLInputElement>('entity-search').value = state.entityQuery; element<HTMLInputElement>('archetype-search').value = state.archetypeQuery;
        element('loading').hidden = true; element('error').hidden = true;
        entities.reset(); archetypes.reset(); renderAll(); showTab(state.tab);
        status(`${view.kind === 'ymap' ? 'Map data' : 'Archetype definitions'} loaded. The view refreshes when the file changes on disk.`);
        vscode.postMessage({ type: 'loaded', snapshotId: view.snapshotId });
    } else if (message?.type === 'error') {
        view = undefined; element('loading').hidden = true; element('error').hidden = false; element('error').textContent = message.message;
        showTab('overview'); status('This file could not be read as map data.');
    } else if (message?.type === 'status') { status(message.message); }
    else if (message?.type === 'surfaces' && message.requestId === surfaceRequest && picked) {
        const heights = message.heights.filter((height) => Number.isFinite(height));
        if (heights.length) {
            picked.levels = heights; picked.position = [picked.position[0], picked.position[1], heights[heights.length - 1]];
            picked.note = picked.note.replace('Z is the room floor from its bounding box', 'Z is the collision surface under this point');
        } else { picked.note = picked.note.replace('Z is the room floor from its bounding box', 'No collision surface lies under this point, so Z is the room floor from its bounding box'); }
        renderPlotDetail(); draw();
    }
});
const styleSelect = element<HTMLSelectElement>('style'), precisionSelect = element<HTMLSelectElement>('precision');
styleSelect.value = state.style; precisionSelect.value = String(state.precision);
styleSelect.addEventListener('change', () => { state.style = COORD_STYLES.includes(styleSelect.value as CoordStyle) ? styleSelect.value as CoordStyle : 'vec'; save(); });
precisionSelect.addEventListener('change', () => { state.precision = Math.min(4, Math.max(1, Number(precisionSelect.value) || 2)); save(); renderAll(); draw(); });
element('entity-search').addEventListener('input', () => { state.entityQuery = element<HTMLInputElement>('entity-search').value.slice(0, 256); entities.reset(); entities.render(filteredEntities()); save(); });
element('entity-group').addEventListener('change', () => { entityGroup = Number(element<HTMLSelectElement>('entity-group').value); entities.reset(); entities.render(filteredEntities()); });
element('archetype-search').addEventListener('input', () => { state.archetypeQuery = element<HTMLInputElement>('archetype-search').value.slice(0, 256); archetypes.reset(); archetypes.render(filteredArchetypes()); save(); });
element('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
element('export').addEventListener('click', () => vscode.postMessage({ type: 'exportXml' }));
element('plot-fit').addEventListener('click', fit); element('plot-in').addEventListener('click', () => zoom(1.4)); element('plot-out').addEventListener('click', () => zoom(1 / 1.4));
vscode.postMessage({ type: 'ready' });
