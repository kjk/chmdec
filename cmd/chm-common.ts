// chm-common.ts -- shared helpers for CHM command scripts.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { CHMLIB_DIR, getDeps } from "./get-deps";

export const ROOT = resolve(import.meta.dir, "..");
export const CORPUS_DIR = join(ROOT, "testfiles", "chm");

const OUT = join(ROOT, "out", "chm-tools");
// our-dump is a checked-in source file; chmlib-dump is generated (see below).
const OUR_DUMP_C = join(ROOT, "cmd", "our-dump.c");
const CHMLIB_DUMP_C = join(OUT, "chmlib-dump.c");

const isWindows = process.platform === "win32";

function binName(base: string): string {
  return isWindows ? `${base}.exe` : base;
}

function writeFileIfChanged(path: string, data: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === data) return;
  writeFileSync(path, data);
}

const CHMLIB_DUMP_SOURCE = String.raw`
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#else
#include <time.h>
#endif
#include "chm_lib.h"

struct emit_ctx {
    int failed;
};

/* stdout carries a binary dump; keep Windows from translating \n to \r\n. */
static void set_stdout_binary(void)
{
#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY);
#endif
}

static double now_ms(void)
{
#ifdef _WIN32
    static LARGE_INTEGER freq;
    LARGE_INTEGER c;
    if (!freq.QuadPart)
        QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

static int write_all(const void *p, size_t n)
{
    return fwrite(p, 1, n, stdout) == n;
}

static int write_u32(uint32_t v)
{
    unsigned char b[4];
    b[0] = (unsigned char)(v);
    b[1] = (unsigned char)(v >> 8);
    b[2] = (unsigned char)(v >> 16);
    b[3] = (unsigned char)(v >> 24);
    return write_all(b, sizeof(b));
}

static int write_u64(uint64_t v)
{
    unsigned char b[8];
    for (int i = 0; i < 8; i++) b[i] = (unsigned char)(v >> (i * 8));
    return write_all(b, sizeof(b));
}

static int write_u8(uint8_t v)
{
    return write_all(&v, 1);
}

static uint32_t unit_flags(const struct chmUnitInfo *ui)
{
    uint32_t flags = 0;
    if (ui->space == CHM_COMPRESSED) flags |= 1u;
    if (ui->flags & CHM_ENUMERATE_DIRS) flags |= 2u;
    if (ui->flags & CHM_ENUMERATE_FILES) flags |= 4u;
    if (ui->flags & CHM_ENUMERATE_NORMAL) flags |= 8u;
    if (ui->flags & CHM_ENUMERATE_META) flags |= 16u;
    if (ui->flags & CHM_ENUMERATE_SPECIAL) flags |= 32u;
    return flags;
}

static int g_emit_data = 1;
static int g_bench_mode = 0;

struct bench_ctx {
    int failed;
    unsigned char *buf;
    size_t buf_cap;
};

static int emit_unit(struct chmFile *h, struct chmUnitInfo *ui)
{
    size_t path_len = strlen(ui->path);
    unsigned char *data = NULL;
    uint64_t want = g_emit_data ? (uint64_t)ui->length : 0;
    uint8_t read_ok = 1;
    uint64_t data_len = 0;

    if (path_len > UINT32_MAX) return 0;
    if (want > SIZE_MAX) return 0;
    if (want > 0) {
        data = (unsigned char *)malloc((size_t)want);
        if (!data) return 0;
        int64_t n = chm_retrieve_object(h, ui, data, 0, (int64_t)want);
        if (n != (int64_t)want) {
            /* record the read failure for this entry and keep going (see the
               matching note in our-dump); don't abort the whole dump. */
            read_ok = 0;
            free(data);
            data = NULL;
        } else {
            data_len = want;
        }
    }

    int ok = write_u32((uint32_t)path_len) &&
             write_u64((uint64_t)ui->start) &&
             write_u64((uint64_t)ui->length) &&
             write_u32(unit_flags(ui)) &&
             write_u8(read_ok) &&
             write_u64(data_len) &&
             write_all(ui->path, path_len) &&
             (data_len == 0 || write_all(data, (size_t)data_len));
    free(data);
    return ok;
}

static int enum_cb(struct chmFile *h, struct chmUnitInfo *ui, void *context)
{
    struct emit_ctx *ctx = (struct emit_ctx *)context;
    if (!emit_unit(h, ui)) {
        ctx->failed = 1;
        fprintf(stderr, "failed to emit %s\n", ui->path);
        return CHM_ENUMERATOR_FAILURE;
    }
    return CHM_ENUMERATOR_CONTINUE;
}

/* Retrieve every file entry into a scratch buffer (no I/O). */
static int bench_enum_cb(struct chmFile *h, struct chmUnitInfo *ui, void *context)
{
    struct bench_ctx *b = (struct bench_ctx *)context;
    uint64_t want;
    int64_t n;

    if (ui->flags & CHM_ENUMERATE_DIRS)
        return CHM_ENUMERATOR_CONTINUE;
    want = (uint64_t)ui->length;
    if (want == 0)
        return CHM_ENUMERATOR_CONTINUE;
    if (want > SIZE_MAX) {
        b->failed = 1;
        return CHM_ENUMERATOR_FAILURE;
    }
    if ((size_t)want > b->buf_cap) {
        unsigned char *nbuf = (unsigned char *)realloc(b->buf, (size_t)want);
        if (!nbuf) {
            b->failed = 1;
            return CHM_ENUMERATOR_FAILURE;
        }
        b->buf = nbuf;
        b->buf_cap = (size_t)want;
    }
    n = chm_retrieve_object(h, ui, b->buf, 0, (int64_t)want);
    if (n != (int64_t)want) {
        b->failed = 1;
        return CHM_ENUMERATOR_FAILURE;
    }
    return CHM_ENUMERATOR_CONTINUE;
}

static double session_ms(const char *file_data, size_t sz)
{
    struct chmFile *h;
    struct bench_ctx b;
    double t0, dt;
    int ok;

    memset(&b, 0, sizeof(b));
    t0 = now_ms();
    h = chm_open(file_data, sz);
    if (!h)
        return -1.0;
    ok = chm_enumerate(h, CHM_ENUMERATE_ALL, bench_enum_cb, &b);
    chm_close(h);
    dt = now_ms() - t0;
    free(b.buf);
    if (!ok || b.failed)
        return -1.0;
    return dt;
}

static int do_bench(const char *file_data, size_t sz)
{
    double ms = session_ms(file_data, sz);
    if (ms < 0.0) {
        fprintf(stderr, "bench session failed\n");
        return 1;
    }
    printf("total_ms=%.2f\n", ms);
    return 0;
}

int main(int argc, char **argv)
{
    const char *file_path = NULL;
    if (argc == 2) {
        file_path = argv[1];
    } else if (argc == 3 && strcmp(argv[1], "-list") == 0) {
        g_emit_data = 0;
        file_path = argv[2];
    } else if (argc == 3 && strcmp(argv[1], "-bench") == 0) {
        g_bench_mode = 1;
        file_path = argv[2];
    } else {
        fprintf(stderr, "usage: chmlib-dump [-list|-bench] file.chm\n");
        return 2;
    }
    if (!g_bench_mode)
        set_stdout_binary();

    /* The sumatra CHMLib fork takes the whole archive as an in-memory buffer
       (chm_open(data, len)), matching our own API, so read the file first. */
    FILE *f = fopen(file_path, "rb");
    if (!f) {
        perror("fopen");
        return 1;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return 1;
    }
    long sz = ftell(f);
    if (sz <= 0) {
        fclose(f);
        fprintf(stderr, "empty file\n");
        return 1;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return 1;
    }

    char *file_data = (char *)malloc((size_t)sz);
    if (!file_data) {
        fclose(f);
        return 1;
    }
    if (fread(file_data, 1, (size_t)sz, f) != (size_t)sz) {
        perror("fread");
        free(file_data);
        fclose(f);
        return 1;
    }
    fclose(f);

    if (g_bench_mode) {
        int rc = do_bench(file_data, (size_t)sz);
        free(file_data);
        return rc;
    }

    struct chmFile *h = chm_open(file_data, (size_t)sz);
    if (!h) {
        fprintf(stderr, "chm_open failed\n");
        free(file_data);
        return 1;
    }

    if (!write_all("CHMDUMP2\n", 9)) {
        chm_close(h);
        free(file_data);
        return 1;
    }

    struct emit_ctx ctx;
    ctx.failed = 0;
    int ok = chm_enumerate(h, CHM_ENUMERATE_ALL, enum_cb, &ctx);
    chm_close(h);
    free(file_data);
    return (ok && !ctx.failed) ? 0 : 1;
}
`;

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
  // OUR_DUMP_C is a checked-in source file (cmd/our-dump.c); only the CHMLib
  // oracle dumper is generated from an embedded string.
  writeFileIfChanged(CHMLIB_DUMP_C, CHMLIB_DUMP_SOURCE);

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
    : "no .chm files under testfiles/chm (gitignored — copy samples in, or set CHM_SPECS, or pass paths)";
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

/** "path/to/file.chm (1.2 MB, 1,234,567 bytes)" relative to repo root when possible. */
export function fileLabel(f: string, root: string = ROOT): string {
  let rel = relative(root, f);
  if (rel.startsWith("..") || isAbsolute(rel)) rel = f;
  rel = rel.replaceAll("\\", "/");
  const size = statSync(f).size;
  return `${rel} (${fmtBytesHuman(size)}, ${fmtBytesExact(size)} bytes)`;
}

export function corpusSummary(): string {
  const n = corpusFiles().length;
  const src = process.env.CHM_SPECS
    ? `CHM_SPECS=${process.env.CHM_SPECS}`
    : "testfiles/chm (populate manually; gitignored)";
  return `${n} .chm file(s) available from ${src}`;
}
