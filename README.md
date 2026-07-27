# chmdec — a plain-C CHM reader

This is a CHM / ITSS archive reader, ported and cleaned from [CHMLib](https://github.com/jedwing/CHMLib).

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
chm_ctx *ctx = chm_open(NULL, data, len);   /* data must outlive ctx */
struct chm_entry **entries = NULL;
int n = chm_get_entries(ctx, &entries);
for (int i = 0; i < n; i++) {
    if (strcmp(entries[i]->path, "/foo/bar.html") == 0) {
        uint8_t *buf = malloc(entries[i]->length);
        if (buf) {
            chm_read_entry(ctx, entries[i], buf);
            free(buf);
        }
        break;
    }
}
chm_close(ctx);
```

## Dev build & test

For dev, we require bun and use msvc and clang as C compilers.

```
bun cmd/build.ts          # builds out/clang/chm_test
bun cmd/tests.ts          # smoke tests over testfiles/chm
bun cmd/build-dist.ts     # updates dist/chm.{h,c}
bun cmd/build-wasm.ts     # dist/wasm/chm.js + chm.wasm + demo.html (bootstraps emsdk if needed)
bun cmd/run-wasm-demo.ts  # serve the browser demo
bun cmd/fuzz.ts           # libFuzzer (seeded from testfiles/chm)
```

CLI:
```
chm_test -list file.chm
```

## How it was made

Port of CHMLib (from SumatraPDF's ext/CHMLib) cleaned up coding conventions, with ctx/alloc, amalgamated build, fuzzing, wasm build.

## License

See LICENSE.md (LGPL-ish origin from CHMLib, adapted).
