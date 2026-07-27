// our-dump -- dump a CHM's entries (metadata + content) in the binary format
// read by cmd/chm-common.ts (readDump). Used by the test/info tooling to
// compare chmdec against the upstream CHMLib oracle. Not part of the library.
//
//   our-dump [-list] file.chm     binary dump (default: with content)
//   our-dump -bench file.chm      time open / extract-all / close (one session)
#include "chm.h"
#include <stdint.h>
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

static uint32_t entry_flags(const struct chm_entry *e)
{
    uint32_t flags = 0;
    if (e->is_compressed) flags |= 1u;
    if (e->is_dir) flags |= 2u;
    if (e->is_file) flags |= 4u;
    if (e->is_normal) flags |= 8u;
    if (e->is_meta) flags |= 16u;
    if (e->is_special) flags |= 32u;
    return flags;
}

static int g_emit_data = 1;

static int emit_entry(chm_ctx *ctx, struct chm_entry *e)
{
    const char *path = e->path ? e->path : "";
    size_t path_len = strlen(path);
    uint8_t *data = NULL;
    uint64_t want = g_emit_data ? e->length : 0;
    uint8_t read_ok = 1;
    uint64_t data_len = 0;

    if (path_len > UINT32_MAX) return 0;
    if (want > SIZE_MAX) return 0;
    if (want > 0) {
        data = (uint8_t *)malloc((size_t)want);
        if (!data) return 0;
        int64_t n = chm_read_entry(ctx, e, data);
        if (n != (int64_t)want) {
            /* record the read failure for this entry and keep going, instead of
               aborting the whole dump - otherwise a single unreadable entry
               hides regressions/corruption on the file's other entries. */
            read_ok = 0;
            free(data);
            data = NULL;
        } else {
            data_len = want;
        }
    }

    int ok = write_u32((uint32_t)path_len) &&
             write_u64(e->start) &&
             write_u64(e->length) &&
             write_u32(entry_flags(e)) &&
             write_u8(read_ok) &&
             write_u64(data_len) &&
             write_all(path, path_len) &&
             (data_len == 0 || write_all(data, (size_t)data_len));
    free(data);
    return ok;
}

/* Open, extract every non-dir entry into a scratch buffer, close. Returns ms
   or <0 on failure. File bytes stay outside the timed region. */
static double session_ms(const uint8_t *file_data, size_t sz)
{
    chm_ctx *ctx;
    struct chm_entry **entries = NULL;
    int n, i;
    uint8_t *buf = NULL;
    size_t buf_cap = 0;
    double t0, dt;

    ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx)
        return -1.0;

    t0 = now_ms();
    if (!chm_open(ctx, file_data, sz)) {
        chm_ctx_free(ctx);
        return -1.0;
    }
    n = chm_get_entries(ctx, &entries);
    for (i = 0; i < n; i++) {
        struct chm_entry *e = entries[i];
        size_t need;
        int64_t got;
        if (!e || e->is_dir || e->length == 0)
            continue;
        need = (size_t)e->length;
        if (need > buf_cap) {
            uint8_t *nbuf = (uint8_t *)realloc(buf, need);
            if (!nbuf) {
                free(buf);
                chm_close(ctx);
                chm_ctx_free(ctx);
                return -1.0;
            }
            buf = nbuf;
            buf_cap = need;
        }
        got = chm_read_entry(ctx, e, buf);
        if (got != (int64_t)e->length) {
            free(buf);
            chm_close(ctx);
            chm_ctx_free(ctx);
            return -1.0;
        }
    }
    free(buf);
    chm_close(ctx);
    dt = now_ms() - t0;
    chm_ctx_free(ctx);
    return dt;
}

static int do_bench(const uint8_t *file_data, size_t sz)
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
    int do_bench_mode = 0;

    if (argc == 2) {
        file_path = argv[1];
    } else if (argc == 3 && strcmp(argv[1], "-list") == 0) {
        g_emit_data = 0;
        file_path = argv[2];
    } else if (argc == 3 && strcmp(argv[1], "-bench") == 0) {
        do_bench_mode = 1;
        file_path = argv[2];
    } else {
        fprintf(stderr, "usage: our-dump [-list|-bench] file.chm\n");
        return 2;
    }
    if (!do_bench_mode)
        set_stdout_binary();

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

    uint8_t *file_data = (uint8_t *)malloc((size_t)sz);
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

    if (do_bench_mode) {
        int rc = do_bench(file_data, (size_t)sz);
        free(file_data);
        return rc;
    }

    chm_ctx *ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx) {
        free(file_data);
        return 1;
    }
    if (!chm_open(ctx, file_data, (size_t)sz)) {
        fprintf(stderr, "chm_open failed\n");
        chm_ctx_free(ctx);
        free(file_data);
        return 1;
    }

    if (!write_all("CHMDUMP2\n", 9)) {
        chm_close(ctx);
        chm_ctx_free(ctx);
        free(file_data);
        return 1;
    }

    struct chm_entry **entries = NULL;
    int n = chm_get_entries(ctx, &entries);
    for (int i = 0; i < n; i++) {
        if (!emit_entry(ctx, entries[i])) {
            fprintf(stderr, "failed to emit %s\n", entries[i]->path ? entries[i]->path : "");
            chm_close(ctx);
            chm_ctx_free(ctx);
            free(file_data);
            return 1;
        }
    }

    chm_close(ctx);
    chm_ctx_free(ctx);
    free(file_data);
    return 0;
}
