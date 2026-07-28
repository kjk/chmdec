// build-lib.ts -- helpers to build the plain library and fuzz target.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(import.meta.dir, "..").replaceAll("\\", "/");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

export const FUZZ_DIR = join(ROOT, "out", "fuzz");
export const FUZZ_EXE = join(
  FUZZ_DIR,
  isWindows ? "chm_fuzz.exe" : "chm_fuzz",
);

// libFuzzer is not in Apple clang (Xcode). On macOS use Homebrew LLVM
// (`brew install llvm`); Windows keeps the VS-bundled clang. Override with
// CHMDEC_FUZZ_CLANG=/path/to/clang if needed.
function resolveFuzzClang(): string {
  const override =
    process.env.CHMDEC_FUZZ_CLANG ||
    process.env.CLANG ||
    process.env.CC ||
    process.env.FUZZ_CC;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`fuzz clang not found: ${override}`);
    }
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

// The exe links the DYNAMIC asan runtime on Windows (clang_rt.asan_dynamic-*.dll),
// which lives in clang's resource dir, not on PATH.
async function copyAsanRuntimeDll(dir: string): Promise<void> {
  if (!isWindows) return;
  const dllName = "clang_rt.asan_dynamic-x86_64.dll";
  const dst = resolve(dir, dllName);
  if (existsSync(dst)) return;
  const proc = Bun.spawnSync(["clang", "-print-resource-dir"]);
  const resDir = proc.stdout.toString().trim();
  const src = resolve(resDir, "lib/windows", dllName);
  if (!existsSync(src)) {
    console.warn(`warning: ${src} not found; ${dllName} must be on PATH`);
    return;
  }
  copyFileSync(src, dst);
}

export async function buildFuzz(clean = false): Promise<string> {
  mkdirSync(FUZZ_DIR, { recursive: true });
  if (clean) {
    rmSync(FUZZ_EXE, { force: true });
  }

  const srcs = [
    join(ROOT, "src", "lzx.c"),
    join(ROOT, "src", "chm.c"),
    join(ROOT, "test", "fuzz_target.c"),
  ];
  const clang = resolveFuzzClang();
  // CHM_FUZZ_UBSAN=1 adds undefined sanitizer (Linux/macOS CI; Windows
  // ASan+UBSan together is flaky with the VS clang runtime).
  const wantUbsan =
    process.env.CHM_FUZZ_UBSAN === "1" ||
    process.env.CHM_FUZZ_UBSAN === "true";
  const sanitize =
    wantUbsan && !isWindows ? "address,undefined,fuzzer" : "address,fuzzer";
  const inc = `-I${join(ROOT, "src")}`;
  const cflags = `-O1 -g -fsanitize=${sanitize} -Wall -Werror -D_CRT_SECURE_NO_WARNINGS`;

  console.log(`building chm_fuzz (clang+${sanitize}; ${clang})...`);
  try {
    await $`${clang} ${{ raw: cflags }} ${{ raw: inc }} ${srcs} -o ${FUZZ_EXE}`.cwd(
      ROOT,
    );
  } catch (e) {
    if (isMac && clang === "clang") {
      console.error(
        "\nfuzz build failed: Apple's clang does not include libFuzzer.",
      );
      console.error(
        "Install LLVM from Homebrew which provides a clang with fuzzer support:",
      );
      console.error("  brew install llvm");
      console.error(
        "Then re-run. The script will auto-detect /opt/homebrew/opt/llvm/bin/clang.\n",
      );
    }
    throw e;
  }
  if (isWindows) await copyAsanRuntimeDll(FUZZ_DIR);
  console.log("built chm_fuzz");
  return FUZZ_EXE;
}
