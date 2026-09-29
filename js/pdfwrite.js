// A small PDF writer with no libraries: enough for vector ink, JPEG photos, transparency
// (highlighter) and a footer in Helvetica. Streams are compressed with the browser's
// built-in deflate (CompressionStream), which is exactly PDF's FlateDecode.

const enc = new TextEncoder();

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Number for a content stream: at most 2 decimals, never "-0" or exponent notation.
export const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? '0' : String(r);
};
export const rgb = (hex) => {
  const h = hex.replace('#', '');
  const n = (i) => num(parseInt(h.slice(i, i + 2), 16) / 255);
  return `${n(0)} ${n(2)} ${n(4)}`;
};

// Text string for the document info (any language): UTF-16BE with byte order mark.
export function textString(s) {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

// Literal string for Helvetica (WinAnsi): accented Latin letters work, the rest is simplified.
const SWAP = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '€': 'EUR', '•': '-' };
export function winAnsi(s) {
  let out = '(';
  for (const ch of String(s)) {
    const c = SWAP[ch] ?? ch;
    for (const d of c) {
      const code = d.codePointAt(0);
      if (d === '(' || d === ')' || d === '\\') out += '\\' + d;
      else if (code >= 32 && code < 127) out += d;
      else if (code >= 160 && code <= 255) out += '\\' + code.toString(8).padStart(3, '0');
      else out += '?';
    }
  }
  return out + ')';
}
// Width of a Helvetica string in points (approximate: good enough to right-align a footer).
export function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) w += /[0-9]/.test(ch) ? 556 : ch === ' ' || ch === '/' ? 278 : /[il.,:;|!']/.test(ch) ? 250 : /[MW]/.test(ch) ? 833 : /[A-Z]/.test(ch) ? 667 : 520;
  return (w / 1000) * size;
}

export class PdfDoc {
  constructor() { this.objs = [null]; } // object numbers start at 1
  reserve() { this.objs.push(null); return this.objs.length - 1; }
  set(n, dict, stream = null) { this.objs[n] = { dict, stream }; return n; }
  add(dict, stream = null) { return this.set(this.reserve(), dict, stream); }
  async stream(dict, data, { compress = true } = {}) {
    let bytes = typeof data === 'string' ? enc.encode(data) : data;
    let filter = '';
    if (compress) {
      const z = await deflate(bytes);
      if (z && z.length < bytes.length) { bytes = z; filter = '/Filter /FlateDecode '; }
    }
    return this.add(`<< ${dict} ${filter}/Length ${bytes.length} >>`, bytes);
  }
  // Assemble the file. root: catalog object number, info: document info object number.
  build(root, info) {
    const parts = []; let pos = 0; const offsets = [];
    const push = (b) => { parts.push(b); pos += b.length; };
    push(enc.encode('%PDF-1.7\n'));
    push(new Uint8Array([37, 226, 227, 207, 211, 10])); // binary marker comment
    for (let i = 1; i < this.objs.length; i++) {
      const o = this.objs[i];
      if (!o) throw new Error(`PDF object ${i} was reserved but never written`);
      offsets[i] = pos;
      push(enc.encode(`${i} 0 obj\n${o.dict}\n`));
      if (o.stream) { push(enc.encode('stream\n')); push(o.stream); push(enc.encode('\nendstream\n')); }
      push(enc.encode('endobj\n'));
    }
    const xref = pos;
    let x = `xref\n0 ${this.objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < this.objs.length; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    x += `trailer\n<< /Size ${this.objs.length} /Root ${root} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`;
    push(enc.encode(x));
    return new Blob(parts, { type: 'application/pdf' });
  }
}

export function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}
