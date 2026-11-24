// build-fuzz.ts -- libFuzzer and AFL++ builds of the CHM fuzz targets.
//
// Variants live in their own directory (out/fuzz/<variant>, out/fuzz-afl/<mode>)
// because the sanitizer flags are part of the object code. A stamp records the
// flags; a change wipes the objects so a binary never mixes two instrumentations.
import { $ } from "bun";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..").replaceAll("\\", "/");
export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

export type FuzzTarget = "doc" | "lzx";
export const FUZZ_TARGETS: readonly FuzzTarget[] = ["doc", "lzx"];

export function isFuzzTarget(name: string): name is FuzzTarget {
  return name === "doc" || name === "lzx";
}

const LIB_SRCS = ["src/lzx.c", "src/chm.c"];
const HEADERS = ["src/chm.h", "src/chm_internal.h"];

/** Extra units beyond the library, per target. The doc mutator is libFuzzer-only. */
function targetSrcs(target: FuzzTarget, mutator: boolean): string[] {
  if (target === "lzx") return ["test/fuzz_lzx.c"];
  return mutator ? ["test/fuzz_target.c", "test/fuzz_mutator.c"] : ["test/fuzz_target.c"];
}

export type FuzzBuildOpts = {
  target?: FuzzTarget;
  /** asan (default) or msan (Linux only) */
  sanitizer?: "asan" | "msan";
  /** undefined sanitizer; findings abort. Not supported on Windows. */
  ubsan?: boolean;
  /** source coverage instead of a sanitizer (still links libFuzzer) */
  coverage?: boolean;
  clean?: boolean;
};

function variantOf(opts: FuzzBuildOpts): string {
  if (opts.coverage) return "cov";
  const base = opts.sanitizer === "msan" ? "msan" : "asan";
  return opts.ubsan ? `${base}-ubsan` : base;
}

function exeName(target: FuzzTarget): string {
  return `chm_fuzz_${target}${isWindows ? ".exe" : ""}`;
}

/** Where buildFuzz writes the executable. */
export function fuzzExe(opts: FuzzBuildOpts = {}): string {
  const target = opts.target ?? "doc";
  return `${ROOT}/out/fuzz/${variantOf(opts)}/${exeName(target)}`;
}

// libFuzzer is not in Apple clang. On macOS use Homebrew LLVM
// (`brew install llvm`). Override with CHMDEC_FUZZ_CLANG.
export function resolveFuzzClang(): string {
  const override = process.env.CHMDEC_FUZZ_CLANG;
  if (override) {
    if (!existsSync(override)) throw new Error(`fuzz clang not found: ${override}`);
    return override;
  }
  if (isMac) {
    const candidates = [
      process.env.LLVM_PREFIX
        ? `${process.env.LLVM_PREFIX.replaceAll("\\", "/")}/bin/clang`
        : "",
      "/opt/homebrew/opt/llvm/bin/clang",
      "/usr/local/opt/llvm/bin/clang",
    ].filter(Boolean);
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    throw new Error(
      "libFuzzer needs Homebrew LLVM on macOS (Apple clang has no fuzzer runtime).\n" +
        "  brew install llvm\n" +
        "Then re-run, or set CHMDEC_FUZZ_CLANG=/opt/homebrew/opt/llvm/bin/clang",
    );
  }
  return "clang";
}

/** llvm-profdata / llvm-cov / llvm-symbolizer matching the fuzz clang. */
export function findLlvmTool(name: string): string | null {
  const cc = (() => {
    try {
      return resolveFuzzClang();
    } catch {
      return "clang";
    }
  })();
  const dir = cc.includes("/") ? cc.slice(0, cc.lastIndexOf("/")) : "";
  const version = /-(\d+)$/.exec(cc)?.[1];
  const names = version ? [`${name}-${version}`, name] : [name];
  for (const n of names) {
    if (dir && existsSync(`${dir}/${n}`)) return `${dir}/${n}`;
    const found = Bun.which(n);
    if (found) return found;
  }
  for (let v = 30; v >= 12; v--) {
    const found = Bun.which(`${name}-${v}`);
    if (found) return found;
  }
  return null;
}

async function copyAsanRuntimeDll(clang: string, dir: string): Promise<void> {
  if (!isWindows) return;
  const dllName = "clang_rt.asan_dynamic-x86_64.dll";
  const dst = resolve(dir, dllName);
  if (existsSync(dst)) return;
  const proc = Bun.spawnSync([clang, "-print-resource-dir"]);
  const resDir = proc.stdout.toString().trim();
  const src = resolve(resDir, "lib/windows", dllName);
  if (!existsSync(src)) {
    console.warn(`warning: ${src} not found; ${dllName} must be on PATH`);
    return;
  }
  copyFileSync(src, dst);
}

function newer(path: string, than: string): boolean {
  if (!existsSync(path) || !existsSync(than)) return true;
  return statSync(path).mtimeMs > statSync(than).mtimeMs;
}

function objStale(obj: string, src: string, stampChanged: boolean): boolean {
  if (stampChanged || !existsSync(obj)) return true;
  if (newer(src, obj)) return true;
  for (const h of HEADERS) {
    if (newer(`${ROOT}/${h}`, obj)) return true;
  }
  return false;
}

export async function buildFuzz(opts: FuzzBuildOpts = {}): Promise<string> {
  const target = opts.target ?? "doc";
  const msan = !opts.coverage && opts.sanitizer === "msan";
  if (msan && process.platform !== "linux") {
    throw new Error("MemorySanitizer fuzzing needs Linux (clang -fsanitize=memory)");
  }
  if (opts.ubsan && isWindows) {
    throw new Error("UBSan fuzzing is not supported on Windows");
  }

  const variant = variantOf(opts);
  const dir = `${ROOT}/out/fuzz/${variant}`;
  const exe = fuzzExe(opts);
  mkdirSync(dir, { recursive: true });

  const cc = resolveFuzzClang();
  const sanitize = opts.coverage
    ? "fuzzer"
    : [msan ? "memory" : "address", ...(opts.ubsan ? ["undefined"] : []), "fuzzer"].join(",");
  const extra = opts.coverage
    ? " -fprofile-instr-generate -fcoverage-mapping"
    : (msan ? " -fsanitize-memory-track-origins=2 -fno-omit-frame-pointer" : "") +
      (opts.ubsan ? " -fno-sanitize-recover=undefined" : "");
  const cflags =
    `-O1 -g -fsanitize=${sanitize}${extra} -Wall -Werror -D_CRT_SECURE_NO_WARNINGS -Isrc`;

  const stampPath = `${dir}/.flags`;
  const stampWant = `${cc}\n${cflags}\n`;
  const stampChanged = !existsSync(stampPath) || readFileSync(stampPath, "utf8") !== stampWant;
  if (opts.clean || stampChanged) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const srcs = [...LIB_SRCS, ...targetSrcs(target, true)];
  const units = srcs.map((src) => ({
    src: `${ROOT}/${src}`,
    obj: `${dir}/${src.replaceAll("/", "_").replace(/\.c$/, ".o")}`,
  }));

  console.log(
    `building chm_fuzz_${target} (clang+${sanitize}${opts.coverage ? "+coverage" : ""}; ${cc})...`,
  );
  try {
    for (const u of units) {
      if (!objStale(u.obj, u.src, false)) continue;
      await $`${cc} ${{ raw: cflags }} -c -o ${u.obj} ${u.src}`.cwd(ROOT);
    }
    const objs = units.map((u) => u.obj);
    if (!existsSync(exe) || objs.some((o) => newer(o, exe))) {
      const linkSan = `-fsanitize=${sanitize}${opts.coverage ? " -fprofile-instr-generate" : ""}`;
      await $`${cc} ${{ raw: linkSan }} ${objs} -o ${exe}`.cwd(ROOT);
    }
  } catch (e) {
    if (isMac && cc === "clang") {
      console.error("\nfuzz build failed: Apple's clang does not include libFuzzer.");
      console.error("Install LLVM from Homebrew:");
      console.error("  brew install llvm");
    }
    throw e;
  }
  writeFileSync(stampPath, stampWant);
  if (isWindows) await copyAsanRuntimeDll(cc, dir);
  console.log(`built chm_fuzz_${target} (${variant})`);
  return exe;
}

/* ----- AFL++ (macOS / Linux; cmd/fuzz-afl.ts) ----- */

export function aflExe(opts: { target?: FuzzTarget; cmplog?: boolean } = {}): string {
  const target = opts.target ?? "doc";
  const mode = opts.cmplog ? "cmplog" : "asan";
  return `${ROOT}/out/fuzz-afl/${mode}/chm_afl_${target}`;
}

export function findAflCc(): string {
  const env = process.env.AFL_CC || process.env.AFL_CLANG_FAST;
  if (env && existsSync(env)) return env;
  for (const c of [
    "/opt/homebrew/bin/afl-clang-fast",
    "/usr/local/bin/afl-clang-fast",
    "/opt/homebrew/bin/afl-cc",
    "/usr/local/bin/afl-cc",
  ]) {
    if (existsSync(c)) return c;
  }
  return "afl-clang-fast";
}

export function aflTool(name: string): string | null {
  const envKey = name.toUpperCase().replaceAll("-", "_");
  const env = process.env[envKey];
  if (env && existsSync(env)) return env;
  for (const base of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const p = `${base}/${name}`;
    if (existsSync(p)) return p;
  }
  return Bun.which(name);
}

export async function buildAflFuzz(opts: {
  target?: FuzzTarget;
  clean?: boolean;
  cmplog?: boolean;
} = {}): Promise<string> {
  if (isWindows) {
    throw new Error("AFL++ fuzzing is not supported on Windows; use bun cmd/fuzz.ts");
  }
  const target = opts.target ?? "doc";
  const cmplog = !!opts.cmplog;
  const exe = aflExe({ target, cmplog });
  const dir = exe.slice(0, exe.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });

  const cc = findAflCc();
  if (!existsSync(cc) && !Bun.which(cc)) {
    throw new Error(
      "afl-clang-fast not found. macOS: brew install afl++; Debian/Ubuntu: sudo apt install afl++",
    );
  }

  const cflags = `-O1 -g -fsanitize=fuzzer -Wall -Werror -D_CRT_SECURE_NO_WARNINGS -Isrc`;
  const stampPath = `${dir}/.flags`;
  const stampWant = `${cc}\n${cflags}\ncmplog=${cmplog ? 1 : 0}\n`;
  const stampChanged = !existsSync(stampPath) || readFileSync(stampPath, "utf8") !== stampWant;
  if (opts.clean || stampChanged) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const srcs = [...LIB_SRCS, ...targetSrcs(target, false)];
  const units = srcs.map((src) => ({
    src: `${ROOT}/${src}`,
    obj: `${dir}/${src.replaceAll("/", "_").replace(/\.c$/, ".o")}`,
  }));
  const env: Record<string, string> = {
    ...process.env,
    AFL_LLVM_NO_ERROR: process.env.AFL_LLVM_NO_ERROR ?? "1",
    AFL_QUIET: process.env.AFL_QUIET ?? "1",
  };
  if (cmplog) {
    env.AFL_LLVM_CMPLOG = "1";
    delete env.AFL_USE_ASAN;
    delete env.AFL_USE_UBSAN;
  } else {
    env.AFL_USE_ASAN = "1";
    env.AFL_USE_UBSAN = "1";
    delete env.AFL_LLVM_CMPLOG;
  }

  console.log(
    `building chm_afl_${target} (afl-clang-fast+fuzzer${cmplog ? "+cmplog" : "+asan+ubsan"})...`,
  );
  try {
    for (const u of units) {
      if (!objStale(u.obj, u.src, false)) continue;
      await $`${cc} ${{ raw: cflags }} -c -o ${u.obj} ${u.src}`.cwd(ROOT).env(env);
    }
    const objs = units.map((u) => u.obj);
    if (!existsSync(exe) || objs.some((o) => newer(o, exe))) {
      await $`${cc} -fsanitize=fuzzer ${objs} -o ${exe}`.cwd(ROOT).env(env);
    }
  } catch (e) {
    console.error("\nAFL++ fuzz build failed.");
    console.error("  macOS:          brew install afl++");
    console.error("  Debian/Ubuntu:  sudo apt install afl++");
    throw e;
  }
  writeFileSync(stampPath, stampWant);
  console.log(`built chm_afl_${target}${cmplog ? " (cmplog)" : ""}`);
  return exe;
}
