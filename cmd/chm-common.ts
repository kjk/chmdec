// chm-common.ts -- shared helpers for CHM command scripts.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { CHMLIB_DIR, getDeps } from "./get-deps";

export const ROOT = resolve(import.meta.dir, "..");
export const CORPUS_DIR = join(ROOT, "testfiles", "chm");

const OUT = join(ROOT, "out", "chm-tools");
const OUR_DUMP_C = join(ROOT, "cmd", "our-dump.c");
const CHMLIB_DUMP_C = join(ROOT, "cmd", "chmlib-dump.c");

const isWindows = process.platform === "win32";

function binName(base: string): string {
  return isWindows ? `${base}.exe` : base;
}

export type DumperKind = "ours" | "chmlib";

export interface Dumpers {
  ours: string;
  chmlib: string;
}

export interface ChmDumpEntry {
  path: string;
  start: bigint;
  length: bigint;
  flags: number;
  // whether the entry's content could be read/decompressed. When false, `data`
  // is empty (the dumper records the failure instead of aborting the whole file).
  readOk: boolean;
  data: Uint8Array;
}

export interface ChmDump {
  entries: ChmDumpEntry[];
  stderr: string;
}

// Run a compiler invocation, printing the full command first so the build is
// reproducible/inspectable. Uses spawn (no shell) so args with spaces are exact.
async function runCompile(label: string, args: string[]): Promise<void> {
  const printable = args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
  console.log(`[build ${label}] ${printable}`);
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`compile failed (${label}): clang exited ${code}`);
}

export async function buildDumpers(): Promise<Dumpers> {
  await getDeps();
  mkdirSync(OUT, { recursive: true });

  const ours = join(OUT, binName("our-dump"));
  const chmlib = join(OUT, binName("chmlib-dump"));

  // Clean build: delete any prior binaries so a failed or stale compile can
  // never be silently reused (that once showed up as phantom decompression
  // failures). The dumpers are always compiled fresh from their full sources.
  rmSync(ours, { force: true });
  rmSync(chmlib, { force: true });

  await runCompile("our-dump", [
    "clang", "-O3", "-Wall", "-Werror", "-D_CRT_SECURE_NO_WARNINGS",
    `-I${join(ROOT, "src")}`,
    join(ROOT, "src", "lzx.c"), join(ROOT, "src", "chm.c"), OUR_DUMP_C,
    "-o", ours,
  ]);

  // The sumatra CHMLib fork is written for a Windows/prefix-header build: it
  // relies on <limits.h> being pulled in implicitly and gates its Windows
  // shims (a local ffs, strcasecmp/strncasecmp -> stricmp/strnicmp) behind
  // `#ifdef WIN32`. Plain clang targeting MSVC defines _WIN32 but not WIN32,
  // so on Windows we define WIN32 ourselves to activate those shims (and
  // silence the UCRT deprecation warnings). On macOS/Linux, WIN32 is absent
  // and the vendored code calls the MSVC-only _stricmp in one spot, so map it
  // to the POSIX name there. Either way the vendored copy stays an exact
  // mirror of upstream.
  const chmlibShims = isWindows
    ? ["-DWIN32", "-D_CRT_SECURE_NO_WARNINGS", "-D_CRT_NONSTDC_NO_WARNINGS"]
    : ["-D_stricmp=strcasecmp"];
  await runCompile("chmlib-dump", [
    "clang", "-O3", "-Wno-macro-redefined", "-include", "limits.h",
    ...chmlibShims, `-I${CHMLIB_DIR}`,
    join(CHMLIB_DIR, "lzx.c"), join(CHMLIB_DIR, "chm_lib.c"), CHMLIB_DUMP_C,
    "-o", chmlib,
  ]);

  return { ours, chmlib };
}

export function findChmFiles(input: string): string[] {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`not found: ${input}`);
  const st = statSync(p);
  if (st.isFile()) {
    if (!p.toLowerCase().endsWith(".chm")) throw new Error(`not a .chm file: ${input}`);
    return [p];
  }
  if (!st.isDirectory()) throw new Error(`not a file or directory: ${input}`);

  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      const childStat = statSync(child);
      if (childStat.isDirectory()) {
        walk(child);
      } else if (childStat.isFile() && child.toLowerCase().endsWith(".chm")) {
        files.push(child);
      }
    }
  }
  walk(p);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function readU32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

function readU64(view: DataView, off: number): bigint {
  return view.getBigUint64(off, true);
}

// Some malformed/malicious .chm files send a dumper into an infinite loop
// (upstream CHMLib has such DoS cases). Cap each run so the harness can treat
// a hang as a read failure instead of blocking forever.
const DUMP_TIMEOUT_MS = 30_000;

export async function readDump(exe: string, file: string, includeContent = true): Promise<ChmDump> {
  const args = includeContent ? [exe, file] : [exe, "-list", file];
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, DUMP_TIMEOUT_MS);

  const [stdoutBuf, stderrText] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stderr = stderrText;
  if (timedOut) {
    throw new Error(`${basename(exe)} timed out for ${file} after ${DUMP_TIMEOUT_MS}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`${basename(exe)} failed for ${file}${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  const bytes = new Uint8Array(stdoutBuf);
  const magic = new TextDecoder().decode(bytes.subarray(0, 9));
  if (magic !== "CHMDUMP2\n") throw new Error(`${basename(exe)} produced invalid dump`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const entries: ChmDumpEntry[] = [];
  let off = 9;
  while (off < bytes.length) {
    if (off + 33 > bytes.length) throw new Error(`${basename(exe)} produced truncated entry header`);
    const pathLen = readU32(view, off); off += 4;
    const start = readU64(view, off); off += 8;
    const length = readU64(view, off); off += 8;
    const flags = readU32(view, off); off += 4;
    const readOk = view.getUint8(off) !== 0; off += 1;
    const dataLenBig = readU64(view, off); off += 8;
    if (dataLenBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("entry too large to parse");
    const dataLen = Number(dataLenBig);
    if (off + pathLen + dataLen > bytes.length) throw new Error(`${basename(exe)} produced truncated entry data`);
    const path = dec.decode(bytes.subarray(off, off + pathLen));
    off += pathLen;
    const data = bytes.slice(off, off + dataLen);
    off += dataLen;
    entries.push({ path, start, length, flags, readOk, data });
  }
  return { entries, stderr };
}

export function flagsText(flags: number): string {
  const space = (flags & 1) ? "compressed" : "plain";
  const kind = (flags & 2) ? "dir" : ((flags & 4) ? "file" : "object");
  const cls = (flags & 8) ? "normal" : ((flags & 16) ? "meta" : ((flags & 32) ? "special" : "unknown"));
  return `${space} ${cls} ${kind}`;
}

/* ----- corpus / bench helpers (djvudec-style selection) ----- */

/** Every .chm under testfiles/chm (recursive). CHM_SPECS overrides with any dir. */
export function corpusFiles(): string[] {
  const dir = process.env.CHM_SPECS ? resolve(process.env.CHM_SPECS) : CORPUS_DIR;
  if (!existsSync(dir)) return [];
  return findChmFiles(dir);
}

export function pickRandom<T>(items: T[], n: number): T[] {
  const arr = items.slice();
  const count = Math.min(n, arr.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

/** Fail when -all/-rand selected an empty corpus (common: testfiles/chm unset). */
function requireCorpus(files: string[], kind: string): string[] {
  if (files.length > 0) return files;
  const hint = process.env.CHM_SPECS
    ? `CHM_SPECS=${process.env.CHM_SPECS} has no .chm files`
    : "no .chm files under testfiles/chm (run: bun cmd/get-deps.ts, or set CHM_SPECS, or pass paths)";
  console.error(`${kind}: ${hint}`);
  process.exit(1);
}

/**
 * Explicit paths, -rand N, or -all. With none of those, prints usageText and
 * exits 2. valueFlags lists flags that take a following value.
 */
export function selectFiles(
  usageText: string,
  valueFlags: string[] = ["-rand"],
): string[] {
  const argv = process.argv.slice(2);
  const explicit = argv.filter(
    (a, i) => !a.startsWith("-") && !valueFlags.includes(argv[i - 1] ?? ""),
  );
  if (argv.includes("-all")) return requireCorpus(corpusFiles(), "-all");
  const ri = argv.indexOf("-rand");
  if (ri >= 0) {
    const n = parseInt(argv[ri + 1] ?? "", 10);
    if (!(n > 0)) {
      console.log(usageText);
      process.exit(2);
    }
    const all = requireCorpus(corpusFiles(), "-rand");
    const picked = pickRandom(all, n);
    console.log(`(${picked.length} random of ${all.length} corpus files)`);
    return picked;
  }
  if (explicit.length > 0) {
    const out: string[] = [];
    for (const f of explicit) {
      if (!existsSync(f)) {
        console.error(`no such file: ${f}`);
        process.exit(1);
      }
      out.push(...findChmFiles(f));
    }
    if (out.length === 0) {
      console.error("no .chm files found in the given path(s)");
      process.exit(1);
    }
    return out;
  }
  console.log(usageText);
  process.exit(2);
}

export function fmtBytesExact(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtBytesHuman(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function corpusSummary(): string {
  const n = corpusFiles().length;
  const src = process.env.CHM_SPECS
    ? `CHM_SPECS=${process.env.CHM_SPECS}`
    : "testfiles/chm (bun cmd/get-deps.ts; gitignored)";
  return `${n} .chm file(s) available from ${src}`;
}
