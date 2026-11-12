export interface XmlElement { name: string; attributes: Record<string, string>; children: XmlElement[]; text: string }
export const MAX_XML_ELEMENTS = 500_000;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const TAG = /<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

function decode(value: string): string {
    return value.includes('&') ? value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (match, name: string) => {
        if (name[0] !== '#') { return ENTITIES[name.toLowerCase()] ?? match; }
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }) : value;
}

/** Parses the element tree of a data XML file: no DTD, namespaces or processing beyond the predefined entities. */
export function parseXml(source: string): XmlElement {
    const root: XmlElement = { name: '', attributes: {}, children: [], text: '' };
    const stack = [root];
    let at = source.charCodeAt(0) === 0xfeff ? 1 : 0, elements = 0;
    while (at < source.length) {
        const open = source.indexOf('<', at), current = stack[stack.length - 1];
        if (open < 0) { current.text += decode(source.slice(at)); break; }
        if (open > at) { current.text += decode(source.slice(at, open)); }
        if (source.startsWith('<!--', open)) {
            const end = source.indexOf('-->', open + 4);
            if (end < 0) { throw new Error('XML comment is not closed.'); }
            at = end + 3;
        } else if (source.startsWith('<![CDATA[', open)) {
            const end = source.indexOf(']]>', open + 9);
            if (end < 0) { throw new Error('XML CDATA section is not closed.'); }
            current.text += source.slice(open + 9, end); at = end + 3;
        } else if (source[open + 1] === '?' || source[open + 1] === '!') {
            const end = source.indexOf('>', open);
            if (end < 0) { throw new Error('XML declaration is not closed.'); }
            at = end + 1;
        } else if (source[open + 1] === '/') {
            const end = source.indexOf('>', open);
            if (end < 0 || stack.length < 2 || source.slice(open + 2, end).trim() !== current.name) { throw new Error(`XML closing tag does not match <${current.name}>.`); }
            stack.pop(); at = end + 1;
        } else {
            TAG.lastIndex = open;
            const tag = TAG.exec(source);
            if (!tag) { throw new Error('XML contains a malformed tag.'); }
            if (++elements > MAX_XML_ELEMENTS) { throw new Error('This XML file exceeds the 500,000-element inspection limit.'); }
            if (stack.length > 64) { throw new Error('XML nesting exceeds 64 levels.'); }
            const element: XmlElement = { name: tag[1], attributes: {}, children: [], text: '' };
            for (const attribute of tag[2].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) { element.attributes[attribute[1]] = decode(attribute[2] ?? attribute[3]); }
            current.children.push(element);
            if (!tag[3]) { stack.push(element); }
            at = open + tag[0].length;
        }
    }
    if (stack.length !== 1) { throw new Error(`XML element <${stack[stack.length - 1].name}> is not closed.`); }
    if (root.children.length !== 1) { throw new Error('XML must contain exactly one root element.'); }
    return root.children[0];
}
