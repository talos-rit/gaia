/**
 * Minimal streaming tar (ustar/pax) support, so Gaia doesn't depend on a shell `tar`, which
 * differs across macOS/Linux/Windows and can't create symlinks on Windows.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const BLOCK = 512;
const dec = new TextDecoder();
const enc = new TextEncoder();

function str(b: Uint8Array, off: number, len: number) {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return dec.decode(z >= 0 ? s.subarray(0, z) : s);
}
const octal = (b: Uint8Array, off: number, len: number) => parseInt(str(b, off, len).trim() || "0", 8);
const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

interface Entry {
  name: string;
  type: string; // "0" file, "5" dir, "2" symlink, "x"/"g" pax, "L" GNU long name
  size: number;
  mode: number;
  /** Raw header (+ preceding pax/longname blocks) for pass-through filtering. */
  raw: Uint8Array[];
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const text = dec.decode(data);
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Walk a tar stream entry by entry. `onEntry` gets each real entry (pax/longname headers already
 * applied) and returns whether to keep it; kept entries' bytes are passed to `emit` unchanged.
 */
async function walk(
  input: ReadableStream<Uint8Array>,
  onEntry: (e: Entry) => boolean | Promise<boolean>,
  onData: (e: Entry, chunk: Uint8Array) => void | Promise<void>,
  emit?: (chunk: Uint8Array) => void,
) {
  let buf = new Uint8Array(0);
  let pending: Uint8Array[] = []; // pax/longname header blocks belonging to the next entry
  let override: { name?: string } = {};
  let cur: { e: Entry; keep: boolean; left: number; pad: number; meta?: Uint8Array[] } | null = null;
  let ended = false;

  const take = (n: number) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };

  for await (const chunk of input) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    while (true) {
      if (ended) {
        if (emit && buf.length) emit(take(buf.length).slice());
        break;
      }
      if (cur) {
        if (cur.left > 0) {
          if (!buf.length) break;
          const piece = take(Math.min(cur.left, buf.length)).slice();
          cur.left -= piece.length;
          if (cur.meta) cur.meta.push(piece);
          else {
            if (cur.keep) emit?.(piece);
            await onData(cur.e, piece);
          }
          continue;
        }
        if (cur.pad > 0) {
          if (buf.length < cur.pad) break;
          const p = take(cur.pad).slice();
          if (cur.meta) cur.meta.push(p);
          else if (cur.keep) emit?.(p);
          cur.pad = 0;
        }
        if (cur.meta) {
          // pax/longname data finished: apply to the following entry
          const data = concat(cur.meta).subarray(0, cur.e.size);
          if (cur.e.type === "x") override = { ...override, name: parsePax(data).path ?? override.name };
          else if (cur.e.type === "L") override = { ...override, name: dec.decode(data).replace(/\0+$/, "") };
          pending.push(...cur.meta);
        }
        cur = null;
        continue;
      }
      if (buf.length < BLOCK) break;
      const h = take(BLOCK).slice();
      if (h.every((b) => b === 0)) {
        ended = true;
        emit?.(h);
        continue;
      }
      const type = String.fromCharCode(h[156] || 48);
      const size = octal(h, 124, 12);
      const prefix = str(h, 345, 155);
      const base = str(h, 0, 100);
      const e: Entry = { name: prefix ? `${prefix}/${base}` : base, type, size, mode: octal(h, 100, 8), raw: [] };
      if (type === "x" || type === "L") {
        pending.push(h);
        cur = { e, keep: false, left: size, pad: padded(size) - size, meta: [] };
        continue;
      }
      if (type === "g") {
        // global pax header: pass through untouched, ignore contents
        emit?.(h);
        cur = { e, keep: true, left: size, pad: padded(size) - size };
        continue;
      }
      if (override.name) e.name = override.name;
      override = {};
      e.raw = [...pending, h];
      pending = [];
      const keep = await onEntry(e);
      if (keep) for (const r of e.raw) emit?.(r);
      cur = { e, keep, left: size, pad: padded(size) - size };
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Re-stream a tar, dropping entries whose name is in `omit` (and their pax headers). */
export function tarFilter(input: ReadableStream<Uint8Array>, omit: Set<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      try {
        await walk(
          input,
          (e) => !omit.has(e.name),
          () => {},
          (c) => controller.enqueue(c),
        );
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Read one small file (e.g. manifest.json) out of a tar stream. */
export async function tarReadFile(input: ReadableStream<Uint8Array>, name: string): Promise<string | undefined> {
  const parts: Uint8Array[] = [];
  let found = false;
  await walk(
    input,
    (e) => {
      found ||= e.name === name;
      return e.name === name;
    },
    (e, c) => {
      if (e.name === name) parts.push(c);
    },
  );
  return found ? dec.decode(concat(parts)) : undefined;
}

/**
 * Extract a tar stream into `dir`. Symlinks are skipped (reported via `onSkip`): they can't be
 * created reliably on Windows, and Docker build contexts rarely need them.
 */
export async function tarExtract(input: ReadableStream<Uint8Array>, dir: string, onSkip?: (msg: string) => void) {
  const root = normalize(dir) + sep;
  const files = new Map<Entry, Uint8Array[]>();
  await walk(
    input,
    (e) => {
      const target = normalize(join(dir, e.name));
      if (!target.startsWith(root) && target + sep !== root) throw new Error(`unsafe path in archive: ${e.name}`);
      if (e.type === "5") mkdirSync(target, { recursive: true });
      else if (e.type === "0" || e.type === "\0" || e.type === "7") files.set(e, []);
      else if (e.type === "2") onSkip?.(`skipped symlink ${e.name}`);
      return true;
    },
    (e, c) => {
      files.get(e)?.push(c);
    },
  );
  for (const [e, parts] of files) {
    const target = join(dir, e.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, concat(parts));
    if (process.platform !== "win32") chmodSync(target, e.mode & 0o777 || 0o644);
  }
}

/** Build a small ustar archive in memory (stack files uploaded to the Pi). */
export function tarCreate(files: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === "string" ? enc.encode(body) : body;
    const h = new Uint8Array(BLOCK);
    const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
    const oct = (n: number, off: number, len: number) => put(n.toString(8).padStart(len - 1, "0") + "\0", off, len);
    if (enc.encode(name).length > 100) throw new Error(`tar name too long: ${name}`);
    put(name, 0, 100);
    oct(0o644, 100, 8);
    oct(0, 108, 8);
    oct(0, 116, 8);
    oct(data.length, 124, 12);
    oct(mtime, 136, 12);
    h.fill(32, 148, 156); // checksum placeholder = spaces
    h[156] = 48; // "0"
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    const sum = h.reduce((a, b) => a + b, 0);
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    parts.push(h, data, new Uint8Array(padded(data.length) - data.length));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}
