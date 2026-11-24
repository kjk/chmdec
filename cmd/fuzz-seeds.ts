// fuzz-seeds.ts -- cut real LZX frames out of .chm files for the lzx fuzz target.
//
// The lzx harness (test/fuzz_lzx.c) does not parse ITSF. A useful seed is the
// window size and a few compressed frames from ::DataSpace/Storage/MSCompressed,
// which is what chm.c hands to LZXdecompress. Framing:
//   u8 window_bits, u8 reset_every, u32 out_len, then (u32 in_len, bytes)*.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT = "::DataSpace/Storage/MSCompressed/Content";
const CONTROL = "::DataSpace/Storage/MSCompressed/ControlData";
const RESET =
  "::DataSpace/Storage/MSCompressed/Transform/" +
  "{7FC28940-9D31-11D0-9B27-00A0C91E9C7C}/" +
  "InstanceData/ResetTable";

const MAX_FILE = 64 * 1024 * 1024;
const MAX_SEED = 256 * 1024;
const MAX_PAGES = 4096;

type Ent = { name: string; space: number; start: number; length: number };

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return -1;
  return Number(v);
}

function latin1(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

function encint(b: Uint8Array, o: number, end: number): { v: number; o: number } | null {
  let acc = 0;
  let n = 0;
  while (o < end && n < 10) {
    const t = b[o++]!;
    n++;
    if (t < 0x80) {
      const v = acc * 128 + t;
      if (!Number.isSafeInteger(v)) return null;
      return { v, o };
    }
    acc = acc * 128 + (t & 0x7f);
    if (!Number.isSafeInteger(acc)) return null;
  }
  return null;
}

function parsePmgl(b: Uint8Array, off: number, blockLen: number): { ents: Ent[]; next: number } | null {
  if (off < 0 || blockLen < 0x14 || off + blockLen > b.length) return null;
  if (latin1(b, off, 4) !== "PMGL") return null;
  const free = u32(b, off + 4);
  if (free > blockLen - 0x14) return null;
  const next = u32(b, off + 12) | 0;
  const end = off + blockLen - free;
  let p = off + 0x14;
  const ents: Ent[] = [];
  while (p < end) {
    const nameLen = encint(b, p, end);
    if (!nameLen || nameLen.v <= 0 || nameLen.o + nameLen.v > end) break;
    const name = latin1(b, nameLen.o, nameLen.v);
    p = nameLen.o + nameLen.v;
    const space = encint(b, p, end);
    if (!space) break;
    const start = encint(b, space.o, end);
    if (!start) break;
    const length = encint(b, start.o, end);
    if (!length) break;
    p = length.o;
    ents.push({ name, space: space.v, start: start.v, length: length.v });
  }
  return { ents, next };
}

function findEntry(b: Uint8Array, dirOff: number, blockLen: number, head: number, name: string): Ent | null {
  const seen = new Set<number>();
  let page = head;
  for (let n = 0; n < MAX_PAGES && page >= 0; n++) {
    if (seen.has(page)) return null;
    seen.add(page);
    const parsed = parsePmgl(b, dirOff + page * blockLen, blockLen);
    if (!parsed) return null;
    const hit = parsed.ents.find((e) => e.name === name);
    if (hit) return hit;
    page = parsed.next;
  }
  return null;
}

function sliceEntry(b: Uint8Array, dataOff: number, e: Ent): Uint8Array | null {
  if (e.space !== 0 || e.length <= 0 || e.length > b.length) return null;
  const at = dataOff + e.start;
  if (at < 0 || at + e.length > b.length) return null;
  return b.subarray(at, at + e.length);
}

function windowBits(window: number): number | null {
  if (window < 32768 || window > 2 * 1024 * 1024) return null;
  if ((window & (window - 1)) !== 0) return null;
  let bits = 0;
  let w = window;
  while (w > 1) {
    w >>= 1;
    bits++;
  }
  return bits >= 15 && bits <= 21 ? bits : null;
}

function putU32(out: number[], v: number): void {
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
}

/** Seeds from one CHM, or [] when it has no usable LZX section. */
export function lzxSeedsFromChm(file: Uint8Array): Uint8Array[] {
  if (file.length < 0x60 || latin1(file, 0, 4) !== "ITSF") return [];
  const version = u32(file, 4);
  const headerLen = u32(file, 8);
  if (version !== 2 && version !== 3) return [];
  if (version === 2 && headerLen < 0x58) return [];
  if (version === 3 && headerLen < 0x60) return [];
  const dirOff0 = u64(file, 0x48);
  const dirLen = u64(file, 0x50);
  if (dirOff0 < 0 || dirLen < 0x54) return [];
  let dataOff = version === 3 ? u64(file, 0x58) : dirOff0 + dirLen;
  if (dataOff < 0 || dirOff0 + 0x54 > file.length) return [];

  if (latin1(file, dirOff0, 4) !== "ITSP") return [];
  if (u32(file, dirOff0 + 4) !== 1) return [];
  const itspLen = u32(file, dirOff0 + 8);
  if (itspLen !== 0x54 || dirLen < itspLen) return [];
  const blockLen = u32(file, dirOff0 + 0x10);
  if (blockLen < 0x14 || blockLen > 2 * 1024 * 1024) return [];
  let head = u32(file, dirOff0 + 0x20) | 0;
  if (head < 0) return [];
  const dirOff = dirOff0 + itspLen;

  const content = findEntry(file, dirOff, blockLen, head, CONTENT);
  const control = findEntry(file, dirOff, blockLen, head, CONTROL);
  const reset = findEntry(file, dirOff, blockLen, head, RESET);
  if (!content || !control || !reset) return [];
  const cd = sliceEntry(file, dataOff, control);
  const rt = sliceEntry(file, dataOff, reset);
  if (!cd || cd.length < 0x18 || !rt || rt.length < 0x28) return [];
  if (latin1(cd, 4, 4) !== "LZXC") return [];
  const ctlVer = u32(cd, 8);
  let resetInterval = u32(cd, 12);
  let window = u32(cd, 16);
  const windowsPerReset = u32(cd, 20);
  if (ctlVer === 2) {
    resetInterval *= 0x8000;
    window *= 0x8000;
  }
  const bits = windowBits(window);
  if (bits === null || resetInterval === 0 || window === 0) return [];
  if (resetInterval % (window / 2) !== 0) return [];

  if (u32(rt, 0) !== 2) return [];
  const blockCount = u32(rt, 4);
  const tableOff = u32(rt, 12);
  const compressedLen = u64(rt, 24);
  const outLen = u64(rt, 32);
  if (blockCount <= 0 || blockCount > 1_000_000) return [];
  if (outLen <= 0 || outLen > 65536) return [];
  if (compressedLen < 0) return [];
  const tableBytes = blockCount * 8;
  if (tableOff > rt.length || tableBytes > rt.length - tableOff) return [];

  const contentAt = dataOff + content.start;
  if (content.space !== 0 || contentAt < 0 || contentAt > file.length) return [];

  let resetEvery = Math.floor(resetInterval / (window / 2)) * windowsPerReset;
  if (!Number.isFinite(resetEvery) || resetEvery < 1) resetEvery = 1;
  if (resetEvery > 255) resetEvery = 255;
  const group = Math.min(4, resetEvery, blockCount);

  const bounds = (i: number): { start: number; len: number } | null => {
    const start = u64(rt, tableOff + i * 8);
    const end = i + 1 < blockCount ? u64(rt, tableOff + (i + 1) * 8) : compressedLen;
    if (start < 0 || end < start) return null;
    const len = end - start;
    if (len <= 0 || len > outLen + 6144) return null;
    return { start, len };
  };

  const pack = (first: number): Uint8Array | null => {
    const bytes: number[] = [bits, resetEvery];
    putU32(bytes, outLen);
    for (let i = 0; i < group; i++) {
      const b = bounds(first + i);
      if (!b) return null;
      const at = contentAt + b.start;
      if (at + b.len > file.length) return null;
      putU32(bytes, b.len);
      for (let k = 0; k < b.len; k++) bytes.push(file[at + k]!);
      if (bytes.length > MAX_SEED) return null;
    }
    return Uint8Array.from(bytes);
  };

  const seeds: Uint8Array[] = [];
  const first = pack(0);
  if (first) seeds.push(first);
  if (blockCount > resetEvery) {
    const mid = resetEvery * Math.floor(blockCount / 2 / resetEvery);
    if (mid > 0 && mid + group <= blockCount) {
      const extra = pack(mid);
      if (extra) seeds.push(extra);
    }
  }
  return seeds;
}

function walkChm(dir: string, out: string[], depth: number): void {
  if (depth > 3 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkChm(p, out, depth + 1);
    else if (st.isFile() && name.toLowerCase().endsWith(".chm") && st.size <= MAX_FILE) out.push(p);
  }
}

/** Copy .chm files into a doc corpus, truncated to maxLen. Returns how many were written. */
export function seedDocCorpus(dir: string, chmRoot: string, maxLen: number, reseed: boolean): number {
  const files: string[] = [];
  walkChm(chmRoot, files, 0);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const src of files) {
    const dest = join(dir, src.slice(chmRoot.length + 1).replaceAll(/[\\/]/g, "_"));
    if (!reseed && existsSync(dest)) continue;
    let data: Buffer;
    try {
      data = readFileSync(src);
    } catch {
      continue;
    }
    writeFileSync(dest, data.length > maxLen ? data.subarray(0, maxLen) : data);
    n++;
  }
  return n;
}

/** Write LZX frame seeds into dir. Returns how many new files were added. */
export function seedLzxCorpus(dir: string, chmRoot: string): number {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  walkChm(chmRoot, files, 0);
  let n = 0;
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(f);
    } catch {
      continue;
    }
    for (const seed of lzxSeedsFromChm(buf)) {
      const name = createHash("sha1").update(seed).digest("hex").slice(0, 16);
      const dest = join(dir, name);
      if (existsSync(dest)) continue;
      writeFileSync(dest, seed);
      n++;
    }
  }
  return n;
}
