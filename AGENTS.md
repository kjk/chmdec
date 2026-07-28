# AGENTS.md — working on chmdec

Plain-C, read-only CHM/ITSS archive library. Ported/cleaned from CHMLib (Jed Wing), modeled directly on the djvudec project structure and style.

## Goal / scope
Read-only. Caller hands the entire .chm as an in-memory buffer.
We provide:
- open / close
- chm_entry (start, length, is_compressed, is_dir/is_file, is_normal/is_meta/is_special, path)
- retrieve bytes for an entry
- get all entries (files/dirs/meta)

No writers. No FS I/O.

## Layout (mimics djvudec)
- src/chm.h            — public API (ctx + chmFile opaque, chm_entry, resolve/retrieve/enumerate)
- src/chm_internal.h   — one internal header with structs, helpers, LZX
- src/chm.c            — main logic
- src/lzx.c            — LZX decompressor
- cmd/*.ts             — bun build/dist/fuzz/tests/...
- dist/                — amalgamation (chm.h/c) + optional dist/wasm/
- cmd/wasm-demo.html   — browser demo source (copied to dist/wasm/demo.html)
- cmd/chm_wasm_api.c   — thin JS-friendly wasm exports
- fuzz/                — crashes/ tracked; corpus/ ignored
- test/                — chm_test.c , chm_bench.c , fuzz_target.c , winperf_control.h
- test/CHMLib/         — vendored sumatrapdf ext/CHMLib fork (oracle for cmd/test.ts)
- testfiles/chm/       — .chm corpus (gitignored; `bun cmd/get-deps.ts` fills from public GitHub samples)

## Reference
- Oracle: test/CHMLib (vendored sumatrapdf ext/CHMLib fork, in-mem chm_open).
  cmd/test.ts builds chmlib-dump from it and byte-compares against our output.
  Refresh from https://github.com/sumatrapdfreader/sumatrapdf/tree/master/ext/CHMLib
- Usage examples: SumatraPDF ChmFile.cpp, ChmDump.cpp, SumatraTest chm bits

## Build & test

The Windows harness vendors `test/winperf_control.h`, so a **winperf** checkout
is not required to compile. To record profiles, first look for the private
winperf repository at `..\winperf`. If it is absent, try to clone it there:

```
git clone https://github.com/kjk/winperf ..\winperf
```

The clone requires access to the private repository. Keep the vendored header
in sync with `..\winperf\client\winperf_control.h`.

- `bun cmd/build.ts` — builds chm_test + chm_bench (clang; CodeView PDB on Windows)
- `bun cmd/get-deps.ts` — download public .chm samples into testfiles/chm
  (mlocati, Tika, Sumatra LZX fixture, …; `-large` adds ~10 MB + ~43 MB bench
  CHMs; `-force` re-downloads; drops obsolete truncated DotZLib.chm)
- `bun cmd/tests.ts` — runs smoke on testfiles/chm/*.chm (calls get-deps first)
- `bun cmd/bench.ts <file.chm … | -rand N | -all>` — open/extract-all/close vs CHMLib
  (compact `chmlib chmdec diff %diff file` lines; best-of-3 each side)
- `bun cmd/build-dist.ts` — produces dist/chm.h + dist/chm.c ; verifies clang -c
  (also rebuilds the wasm drop when run as main)
- `bun cmd/fuzz.ts` — libFuzzer+ASan; seeds from testfiles/chm ; corpus/ is checkpoint.
  Flags: `-jobs N`, `-repro FILE`, `-check-crashes` (CI: replay all
  `fuzz/crashes/*`, expect exit 0), `-minimize`, `-max-len N`. Linux/macOS CI may
  set `CHM_FUZZ_UBSAN=1` for ASan+UBSan+fuzzer. macOS needs Homebrew LLVM
  (`brew install llvm`); override with `CHMDEC_FUZZ_CLANG`.
- `bun cmd/build-wasm.ts` — emscripten build → dist/wasm/chm.js + chm.wasm + demo.html
  (bootstraps `deps/emsdk` if `emcc` is missing; `-clean` wipes/reinstalls emsdk)
- `bun cmd/verify-wasm.ts <file.chm>` — open/list smoke via the wasm glue (CI)
- `bun cmd/run-wasm-demo.ts` — serve dist/wasm (optional `-build`, `-port N`)
- GitHub Actions: `.github/workflows/ci.yml` (Windows clang smoke + amalgamation,
  Windows ASan crash regression, Linux clang smoke + amalgamation + UBSan
  crashes, WASM open/list smoke). Full `tests.ts` / CHMLib oracle stays local
  (needs `testfiles/chm`, gitignored).

No heavy C++ oracle like djvudec; correctness is by enumeration + roundtrip retrieve on known good .chm files + fuzz.

### Windows sampling profiles (winperf)

`test/chm_bench.c` loads a `.chm` into memory, then loops open / decompress every
entry / close under `winperf_profile_start`/`stop` section marks so disk I/O is
excluded from the sample set. Build winperf once, then record with
`-print-agent` (top self-time functions, hot source lines, heaviest call path).
Needs the **Windows Performance Toolkit** (`xperf.exe` from the ADK) and
**Administrator rights** (UAC prompt). Give winperf an **absolute path** to the
exe.

```
bun cmd/build.ts
# once: cd ..\winperf && bun cmd/build.ts -release

# from chmdec root; absolute path to the workload exe (relative can attach wrong)
..\winperf\out\rel64\winperf.exe record -i 4000 -o out\prof\winperf.etl -print-agent -- %CD%\out\clang\chm_bench.exe -loops 10 path\to\file.chm
```

`-loops N` (default 1) repeats the open/decompress/close session so sampling has
enough hits. Marks are no-ops when not running under `winperf record`.

## Coding style (strict)
- Follow djvudec exactly: header comment `/* name -- desc */`
- chm_ prefix
- ctx for alloc/error (djvudec/jbig2dec)
- internal.h declares shared structs + non-file-local funcs
- no two .c files define same-name statics (amalgam req)
- use chm_alloc / chm_free (never raw malloc in lib code except test)
- keep LZX logic faithful (only style/minor cleanup)
- no new features without tests

## Amalgamation rules
- dist/ is generated. Do not edit dist/ directly.
- After src/ changes, run build-dist.ts before publishing a drop-in.
- dist/chm.c is single TU: pub header + internal + lzx.c + chm.c with local #includes stripped.

## Fuzzing
Crashes go to `fuzz/crashes/` (commit them as seeds). Use `-repro FILE` to
debug; `bun cmd/fuzz.ts -check-crashes` for the CI regression suite.

## Wasm
`dist/wasm/` holds the emscripten build (`chm.js` + `chm.wasm`, LF-only JS glue) and `demo.html`.
Source demo: `cmd/wasm-demo.html`; JS glue API: `cmd/chm_wasm_api.c`.
If `emcc` is not on PATH, `build-wasm.ts` clones/installs emsdk into `deps/emsdk` (gitignored).
Serve with `bun cmd/run-wasm-demo.ts` (use `-build` to compile first).

## Windows / mac notes
- Test harness / bench use fopen (ASCII paths only). Library itself is pure bytes.
- Use clang everywhere for this tree.
- Profiling: see **Windows sampling profiles (winperf)** above (`chm_bench` + `winperf_control.h`).

When editing, run `bun cmd/build.ts && bun cmd/tests.ts` and `bun cmd/build-dist.ts` before considering done.
