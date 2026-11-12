// A small streaming XML tokenizer for the parts of an Excel workbook (spec import-format.md §5.6).
// It works on UTF-8 bytes as they are inflated, so a large worksheet never sits in memory as text.
// Safety: a DOCTYPE is refused, only the five XML entities and character references are expanded
// (nothing is ever fetched or defined), and input that is not well-formed is refused: unbalanced or
// mismatched tags, a second root, text outside the root, bad attributes, unknown entities, unbound
// namespace prefixes, a truncated document. Line endings in text and attribute values are normalised
// as the XML specification says (CR LF and CR become LF; in attributes, tab/CR/LF become a space).

export class XmlError extends Error {
  constructor(
    message: string,
    public doctype = false,
  ) {
    super(message);
  }
}

export interface XmlHandler {
  /** Element start. `attrs` is a flat list [qname, value, qname, value, …]. */
  open(local: string, prefix: string, attrs: string[]): void;
  close(local: string): void;
  /** Character data (text and CDATA), only called while `wantText` is true. */
  text(s: string): void;
  /** Read before every run of character data: false skips decoding it. */
  readonly wantText: boolean;
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder("utf-8");

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function bytesToString(b: Uint8Array, s: number, e: number): string {
  if (e - s <= 24) {
    let out = "";
    for (let i = s; i < e; i++) {
      const c = b[i];
      if (c >= 0x80) return decoder.decode(b.subarray(s, e));
      out += String.fromCharCode(c);
    }
    return out;
  }
  return decoder.decode(b.subarray(s, e));
}

function validChar(c: number): boolean {
  return c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
}

const ENTITY = /&([^;&]*)(;?)/g;
function expandEntities(s: string): string {
  return s.replace(ENTITY, (_m, name: string, semi: string) => {
    if (!semi) throw new XmlError("an & that does not start an entity reference");
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    let code = NaN;
    if (/^#x[0-9a-fA-F]+$/.test(name)) code = parseInt(name.slice(2), 16);
    else if (/^#[0-9]+$/.test(name)) code = parseInt(name.slice(1), 10);
    else throw new XmlError(`the entity &${name}; is not defined`);
    if (!validChar(code)) throw new XmlError(`the character reference &${name}; is not allowed`);
    return String.fromCodePoint(code);
  });
}

function textValue(s: string): string {
  if (s.includes("\r")) s = s.replace(/\r\n?/g, "\n");
  return s.includes("&") ? expandEntities(s) : s;
}

function attrValue(s: string): string {
  if (s.includes("<")) throw new XmlError("a < in an attribute value");
  if (s.includes("\r")) s = s.replace(/\r\n?/g, "\n");
  if (s.includes("\n") || s.includes("\t")) s = s.replace(/[\t\n]/g, " ");
  return s.includes("&") ? expandEntities(s) : s;
}

const STARTS_NAME = (c: number) => !(c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) && c > 0x20;

/** Push parser: feed() chunks, then end(). Handler exceptions propagate unchanged. */
export class XmlParser {
  private rest: Uint8Array = EMPTY;
  private pieces: Uint8Array[] = [];
  private names: string[] = [];
  /** Namespace frames parallel to `names` (null when the element declares none). */
  private frames: (Map<string, string> | null)[] = [];
  private nsDepth = 0;
  private rootSeen = false;
  private rootClosed = false;
  private started = false;

  constructor(private h: XmlHandler) {}

  /** Namespace URI bound to a prefix ("" = default namespace) at the current element. */
  uriOf(prefix: string): string | null {
    if (prefix === "xml") return XML_NS;
    if (prefix === "xmlns") return XMLNS_NS;
    if (this.nsDepth)
      for (let i = this.frames.length - 1; i >= 0; i--) {
        const f = this.frames[i];
        if (f && f.has(prefix)) return f.get(prefix)!;
      }
    return prefix === "" ? "" : null;
  }

  feed(chunk: Uint8Array): void {
    let b = chunk;
    if (this.rest.length) {
      b = new Uint8Array(this.rest.length + chunk.length);
      b.set(this.rest, 0);
      b.set(chunk, this.rest.length);
    }
    let i = 0;
    const n = b.length;
    if (!this.started) {
      if (n < 3 && b[0] === 0xef) {
        this.rest = b.slice();
        return;
      }
      this.started = true;
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    }
    while (i < n) {
      if (b[i] !== 0x3c) {
        const lt = b.indexOf(0x3c, i);
        const end = lt < 0 ? n : lt;
        this.pieces.push(b.subarray(i, end));
        i = end;
        if (lt < 0) break;
      }
      const next = this.markup(b, i, n);
      if (next < 0) break;
      i = next;
    }
    this.rest = i < n ? b.slice(i) : EMPTY;
  }

  end(): void {
    if (!this.started && this.rest.length) {
      this.started = true;
      const r = this.rest;
      this.rest = EMPTY;
      this.feed(r);
    }
    if (this.rest.length) throw new XmlError("the document ends inside markup");
    this.flushText();
    if (this.names.length) throw new XmlError(`the element <${this.names[this.names.length - 1]}> is not closed`);
    if (!this.rootSeen) throw new XmlError("the document has no root element");
  }

  private flushText(): void {
    const p = this.pieces;
    if (!p.length) return;
    this.pieces = [];
    const depth = this.names.length;
    if (depth > 0 && this.h.wantText) {
      const s = p.length === 1 ? bytesToString(p[0], 0, p[0].length) : decoder.decode(concat(p));
      const v = textValue(s);
      if (v !== "") this.h.text(v);
      return;
    }
    // Text that is not needed is still checked: outside the root only whitespace, inside valid references.
    for (const piece of p) {
      if (depth === 0) {
        for (let k = 0; k < piece.length; k++) if (!isWs(piece[k])) throw new XmlError("text outside the root element");
      } else if (piece.indexOf(0x26) >= 0) {
        textValue(decoder.decode(concat(p)));
        return;
      }
    }
  }

  /** Handles the markup starting at b[i] === "<". Returns the index after it, or -1 when incomplete. */
  private markup(b: Uint8Array, i: number, n: number): number {
    if (i + 1 >= n) return -1;
    const c = b[i + 1];
    if (c === 0x2f) {
      const gt = b.indexOf(0x3e, i + 2);
      if (gt < 0) return -1;
      this.flushText();
      let e = gt;
      while (e > i + 2 && isWs(b[e - 1])) e--;
      const name = bytesToString(b, i + 2, e);
      const open = this.names.pop();
      if (open === undefined) throw new XmlError(`the end tag </${name}> has no start tag`);
      if (open !== name) throw new XmlError(`the end tag </${name}> does not match <${open}>`);
      const frame = this.frames.pop();
      const colon = name.indexOf(":");
      this.h.close(colon < 0 ? name : name.slice(colon + 1));
      if (frame) this.nsDepth--;
      if (!this.names.length) this.rootClosed = true;
      return gt + 1;
    }
    if (c === 0x3f) {
      let q = b.indexOf(0x3f, i + 2);
      while (q >= 0 && q + 1 < n && b[q + 1] !== 0x3e) q = b.indexOf(0x3f, q + 1);
      if (q < 0 || q + 1 >= n) return -1;
      this.flushText();
      return q + 2;
    }
    if (c === 0x21) {
      const head = bytesToString(b, i, Math.min(n, i + 9));
      // Not yet enough bytes to tell a comment, CDATA or DOCTYPE apart?
      if (head.length < 9 && !head.startsWith("<!--") && ("<!--".startsWith(head) || "<![CDATA[".startsWith(head) || "<!DOCTYPE".startsWith(head.toUpperCase()))) return -1;
      if (head.startsWith("<!--")) {
        let q = b.indexOf(0x2d, i + 4);
        while (q >= 0 && !(b[q + 1] === 0x2d && b[q + 2] === 0x3e)) {
          if (q + 2 >= n) return -1;
          q = b.indexOf(0x2d, q + 1);
        }
        if (q < 0) return -1;
        this.flushText();
        return q + 3;
      }
      if (head === "<![CDATA[") {
        let q = b.indexOf(0x5d, i + 9);
        while (q >= 0 && !(b[q + 1] === 0x5d && b[q + 2] === 0x3e)) {
          if (q + 2 >= n) return -1;
          q = b.indexOf(0x5d, q + 1);
        }
        if (q < 0) return -1;
        this.flushText();
        if (!this.names.length) throw new XmlError("CDATA outside the root element");
        if (this.h.wantText) {
          let s = decoder.decode(b.subarray(i + 9, q));
          if (s.includes("\r")) s = s.replace(/\r\n?/g, "\n");
          if (s !== "") this.h.text(s);
        }
        return q + 3;
      }
      if (head.toUpperCase() === "<!DOCTYPE") throw new XmlError("the part has a DOCTYPE", true);
      throw new XmlError("unexpected markup <!");
    }
    // start tag
    let j = i + 1;
    while (j < n && !isWs(b[j]) && b[j] !== 0x3e && b[j] !== 0x2f) j++;
    if (j >= n) return -1;
    if (j === i + 1 || !STARTS_NAME(b[i + 1])) throw new XmlError("a < that does not start a tag");
    const name = bytesToString(b, i + 1, j);
    const attrs: string[] = [];
    let self = false;
    for (;;) {
      const before = j;
      while (j < n && isWs(b[j])) j++;
      if (j >= n) return -1;
      const ch = b[j];
      if (ch === 0x3e) {
        j++;
        break;
      }
      if (ch === 0x2f) {
        if (j + 1 >= n) return -1;
        if (b[j + 1] !== 0x3e) throw new XmlError(`a / inside the tag <${name}>`);
        self = true;
        j += 2;
        break;
      }
      if (j === before) throw new XmlError(`no space between the attributes of <${name}>`);
      let k = j;
      while (k < n && b[k] !== 0x3d && !isWs(b[k]) && b[k] !== 0x3e && b[k] !== 0x2f) k++;
      if (k >= n) return -1;
      if (k === j) throw new XmlError(`a bad attribute in <${name}>`);
      const an = bytesToString(b, j, k);
      while (k < n && isWs(b[k])) k++;
      if (k >= n) return -1;
      if (b[k] !== 0x3d) throw new XmlError(`the attribute ${an} of <${name}> has no value`);
      k++;
      while (k < n && isWs(b[k])) k++;
      if (k >= n) return -1;
      const q = b[k];
      if (q !== 0x22 && q !== 0x27) throw new XmlError(`the attribute ${an} of <${name}> is not quoted`);
      const close = b.indexOf(q, k + 1);
      if (close < 0) return -1;
      for (let a = 0; a < attrs.length; a += 2) if (attrs[a] === an) throw new XmlError(`the attribute ${an} appears twice in <${name}>`);
      attrs.push(an, attrValue(bytesToString(b, k + 1, close)));
      j = close + 1;
    }
    this.flushText();
    if (!this.names.length) {
      if (this.rootSeen || this.rootClosed) throw new XmlError("a second root element");
      this.rootSeen = true;
    }
    let frame: Map<string, string> | null = null;
    for (let a = 0; a < attrs.length; a += 2) {
      const an = attrs[a];
      if (an === "xmlns") (frame ??= new Map()).set("", attrs[a + 1]);
      else if (an.startsWith("xmlns:")) (frame ??= new Map()).set(an.slice(6), attrs[a + 1]);
    }
    this.names.push(name);
    this.frames.push(frame);
    if (frame) this.nsDepth++;
    const colon = name.indexOf(":");
    const prefix = colon < 0 ? "" : name.slice(0, colon);
    if (prefix && this.uriOf(prefix) === null) throw new XmlError(`the prefix ${prefix} is not bound to a namespace`);
    for (let a = 0; a < attrs.length; a += 2) {
      const an = attrs[a];
      const ac = an.indexOf(":");
      if (ac > 0 && this.uriOf(an.slice(0, ac)) === null) throw new XmlError(`the prefix ${an.slice(0, ac)} is not bound to a namespace`);
    }
    this.h.open(colon < 0 ? name : name.slice(colon + 1), prefix, attrs);
    if (self) {
      this.names.pop();
      this.frames.pop();
      this.h.close(colon < 0 ? name : name.slice(colon + 1));
      if (frame) this.nsDepth--;
      if (!this.names.length) this.rootClosed = true;
    }
    return j;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Value of an unprefixed attribute. */
export function attrOf(attrs: string[], local: string): string | undefined {
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === local) return attrs[i + 1];
  return undefined;
}
