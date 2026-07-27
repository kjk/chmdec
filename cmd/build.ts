// build.ts -- build driver for the chm C library (run with `bun cmd/build.ts`).
//
//   bun cmd/build.ts        build the lib + chm_test + chm_bench (clang)
//   bun cmd/build.ts -clean delete out/ and rebuild
//
// Produces out/clang/chm_test(.exe) and out/clang/chm_bench(.exe).
// On Windows, objects/exes get CodeView PDB (-g -gcodeview) for winperf.
import { $ } from "bun";
import { mkdirSync, rmSync } from "fs";

const ROOT = `${import.meta.dir}/..`.replaceAll("\\", "/");
const OUT_ROOT = `${ROOT}/out`;
const OUT = `${OUT_ROOT}/clang`;

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

function binName(base: string): string {
  return isWindows ? `${base}.exe` : base;
}

const SRCS = ["src/lzx.c", "src/chm.c"];
const TEST = "test/chm_test.c";
const BENCH = "test/chm_bench.c";

function objFor(src: string): string {
  const base = src.replace(/^src\//, "").replace(/\.c$/, "");
  return `${OUT}/${base}.o`;
}

/** -O3 for decode speed; CodeView on Windows so winperf can symbolicate. */
function cFlags(): string {
  const pdb = isWindows ? " -g -gcodeview" : " -g";
  return `-O3 -Wall -Werror -D_CRT_SECURE_NO_WARNINGS${pdb} -I${ROOT}/src -I${ROOT}/test`;
}

// Always compile from scratch. mtime-based incremental builds silently served
// stale binaries when a header/source change wasn't detected, so C code here is
// always rebuilt clean rather than cached.
export async function build(useClang = true): Promise<string> {
  if (!useClang && isWindows) {
    // On windows one could use cl, but for this port we use clang everywhere.
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const flags = cFlags();
  const objs: string[] = [];
  for (const src of SRCS) {
    const obj = objFor(src);
    objs.push(obj);
    console.log(`cc ${src}`);
    await $`clang ${{ raw: flags }} -c ${src} -o ${obj}`.cwd(ROOT);
  }

  const testExe = `${OUT}/${binName("chm_test")}`;
  const testSrc = `${ROOT}/${TEST}`;
  console.log("link chm_test");
  // chm_test.c uses fopen; silence the MSVC/UCRT deprecation so -Werror
  // doesn't fail the Windows build (the library sources use no unsafe CRT).
  await $`clang ${{ raw: flags }} ${objs} ${testSrc} -o ${testExe}`.cwd(ROOT);

  const benchExe = `${OUT}/${binName("chm_bench")}`;
  const benchSrc = `${ROOT}/${BENCH}`;
  console.log("link chm_bench");
  await $`clang ${{ raw: flags }} ${objs} ${benchSrc} -o ${benchExe}`.cwd(ROOT);
  console.log(`built ${benchExe}`);

  return testExe;
}

export async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes("-clean") || args.includes("--clean");
  if (clean) {
    rmSync(OUT_ROOT, { recursive: true, force: true });
    console.log("cleaned out/");
  }
  const exe = await build(true);
  console.log(`built ${exe}`);
}

if (import.meta.main) {
  await main();
}
