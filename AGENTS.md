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
- test/                — chm_test.c , fuzz_target.c
- test/CHMLib/         — vendored sumatrapdf ext/CHMLib fork (oracle for cmd/test.ts)
- testfiles/chm/       — .chm corpus (gitignored, populate manually or via scripts)

## Reference
- Oracle: test/CHMLib (vendored sumatrapdf ext/CHMLib fork, in-mem chm_open).
  cmd/test.ts builds chmlib-dump from it and byte-compares against our output.
  Refresh from https://github.com/sumatrapdfreader/sumatrapdf/tree/master/ext/CHMLib
- Usage examples: SumatraPDF ChmFile.cpp, ChmDump.cpp, SumatraTest chm bits

## Build & test
- `bun cmd/build.ts` — builds chm_test (clang)
- `bun cmd/tests.ts` — runs smoke on testfiles/chm/*.chm
- `bun cmd/build-dist.ts` — produces dist/chm.h + dist/chm.c ; verifies clang -c
- `bun cmd/fuzz.ts` — libFuzzer+ASan; seeds from testfiles/chm ; corpus/ is checkpoint
- `bun cmd/build-wasm.ts` — emscripten build → dist/wasm/chm.js + chm.wasm + demo.html
  (bootstraps `deps/emsdk` if `emcc` is missing; `-clean` wipes/reinstalls emsdk)
- `bun cmd/run-wasm-demo.ts` — serve dist/wasm (optional `-build`, `-port N`)

No heavy C++ oracle like djvudec; correctness is by enumeration + roundtrip retrieve on known good .chm files + fuzz.

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
Crashes go to fuzz/crashes/ (commit them as seeds). Use -repro to debug.

## Wasm
`dist/wasm/` holds the emscripten build (`chm.js` + `chm.wasm`, LF-only JS glue) and `demo.html`.
Source demo: `cmd/wasm-demo.html`; JS glue API: `cmd/chm_wasm_api.c`.
If `emcc` is not on PATH, `build-wasm.ts` clones/installs emsdk into `deps/emsdk` (gitignored).
Serve with `bun cmd/run-wasm-demo.ts` (use `-build` to compile first).

## Windows / mac notes
- Test harness uses fopen (ASCII paths only). Library itself is pure bytes.
- Use clang everywhere for this tree.

When editing, run `bun cmd/build.ts && bun cmd/tests.ts` and `bun cmd/build-dist.ts` before considering done.
