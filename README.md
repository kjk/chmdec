# chmdec — a plain-C CHM reader

This is a [CHM](https://fileformats.dev/chm) / ITSS archive reader, ported and cleaned from [CHMLib](https://github.com/jedwing/CHMLib).

* plain C, no dependencies
* wasm build to be used in web apps
* simpler / cleaned API
* easy to integrate: copy `dist/chm.h` and `dist/chm.c` to your project (amalgamated build like sqlite)
* in-memory only (no incremental I/O)
* fuzzed for robustness
* battle tested in [SumatraPDF](https://www.sumatrapdfreader.org/)

## API

See `src/chm.h`. Basic usage:

```c
chm_ctx *ctx = chm_ctx_new(NULL, NULL, NULL, NULL);  /* default malloc/free, no error cb */
if (!chm_open(ctx, data, len)) {             /* data must stay valid until chm_close */
    chm_ctx_free(ctx);
    return;
}
struct chm_entry **entries = NULL;           /* owned by ctx */
int n = chm_get_entries(ctx, &entries);
for (int i = 0; i < n; i++) {
    if (strcmp(entries[i]->path, "/foo/bar.html") == 0) {
        uint8_t *buf = malloc(entries[i]->length);
        if (buf) {
            int64_t n_read = chm_read_entry(ctx, entries[i], buf);
            if (n_read == (int64_t)entries[i]->length) {
                /* use buf; a short count means corrupt data */
            }
            free(buf);
        }
        break;
    }
}
chm_close(ctx);
chm_ctx_free(ctx);
```

## Dev build & test

For dev, we require bun and use clang as the C compiler (on Windows, the clang
bundled with Visual Studio).

```
bun cmd/build.ts          # builds out/clang/chm_test + out/clang/chm_bench
bun cmd/get-deps.ts       # download public .chm samples → testfiles/chm
bun cmd/tests.ts          # smoke tests over testfiles/chm (auto get-deps)
bun cmd/test.ts testfiles/chm  # byte-compare extraction vs vendored CHMLib (-rand N)
bun cmd/build-dist.ts     # updates dist/chm.{h,c}, then rebuilds dist/wasm (needs emsdk)
bun cmd/build-wasm.ts     # dist/wasm/chm.js + chm.wasm + demo.html (bootstraps emsdk if needed)
bun cmd/verify-wasm.ts f.chm  # open/list through the wasm glue (CI)
bun cmd/run-wasm-demo.ts  # serve the browser demo
bun cmd/fuzz.ts           # libFuzzer (seeded from testfiles/chm)
bun cmd/fuzz.ts -check-crashes  # replay fuzz/crashes/* under ASan (CI)
```

CI (GitHub Actions): `.github/workflows/ci.yml` — Windows/Linux/macOS smoke +
CHMLib oracle tests + amalgamation, fuzz crash regression, WASM open/list.

CLI:
```
chm_test [-list] file.chm   # open (and with -list, list entries)
chm_test -lzx-wrap          # LZX wrap-around self-test
```

## How it was made

Port of CHMLib (from SumatraPDF's ext/CHMLib) cleaned up coding conventions, with ctx/alloc, amalgamated build, fuzzing, wasm build.

## License

LGPL-2.1-or-later, inherited from CHMLib. See [LICENSE.md](LICENSE.md).
