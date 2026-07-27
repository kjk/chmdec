/* chm_bench.c -- open a .chm from memory and decompress every entry.
 *
 * Used as a winperf workload: disk I/O (file load) is outside the marked
 * region; open / retrieve-all / close sit between winperf_profile_start/stop
 * so ETW samples outside library work are dropped (-print-agent).
 *
 *   chm_bench [-loops N] file.chm
 */
#include "chm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
/* Vendored control client; calls are no-ops when winperf is not recording. */
#include "winperf_control.h"
#else
#include <time.h>
static void winperf_profile_start(void) {}
static void winperf_profile_stop(void) {}
#endif

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

static uint8_t *load_file(const char *path, size_t *out_len)
{
    FILE *f;
    long sz;
    uint8_t *data;

    f = fopen(path, "rb");
    if (!f) {
        perror("fopen");
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        perror("fseek");
        fclose(f);
        return NULL;
    }
    sz = ftell(f);
    if (sz <= 0) {
        fprintf(stderr, "empty or unreadable file: %s\n", path);
        fclose(f);
        return NULL;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        perror("fseek");
        fclose(f);
        return NULL;
    }
    data = (uint8_t *)malloc((size_t)sz);
    if (!data) {
        fprintf(stderr, "oom reading %s (%ld bytes)\n", path, sz);
        fclose(f);
        return NULL;
    }
    if (fread(data, 1, (size_t)sz, f) != (size_t)sz) {
        perror("fread");
        free(data);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *out_len = (size_t)sz;
    return data;
}

/* Open archive, read every entry with length > 0 into a scratch buffer, close.
 * Returns 0 on success. */
static int session_open_decompress_close(chm_ctx *ctx, const uint8_t *data,
                                         size_t len, int *out_entries,
                                         int *out_files, uint64_t *out_bytes)
{
    struct chm_entry **entries = NULL;
    int n, i, n_files = 0;
    uint64_t total_bytes = 0;
    uint8_t *buf = NULL;
    size_t buf_cap = 0;

    if (!chm_open(ctx, data, len))
        return 1;

    n = chm_get_entries(ctx, &entries);
    if (n < 0) {
        chm_close(ctx);
        return 1;
    }

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
                return 1;
            }
            buf = nbuf;
            buf_cap = need;
        }
        got = chm_read_entry(ctx, e, buf);
        if (got != (int64_t)e->length) {
            fprintf(stderr, "chm_read_entry failed: %s (got %lld want %llu)\n",
                    e->path ? e->path : "?", (long long)got,
                    (unsigned long long)e->length);
            free(buf);
            chm_close(ctx);
            return 1;
        }
        n_files++;
        total_bytes += e->length;
    }

    free(buf);
    chm_close(ctx);
    if (out_entries)
        *out_entries = n;
    if (out_files)
        *out_files = n_files;
    if (out_bytes)
        *out_bytes = total_bytes;
    return 0;
}

int main(int argc, char **argv)
{
    const char *path = NULL;
    int loops = 1;
    int i;
    uint8_t *data = NULL;
    size_t len = 0;
    chm_ctx *ctx;
    int n_entries = 0, n_files = 0;
    uint64_t total_bytes = 0;
    double t0, total_ms = 0.0;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-loops") == 0 && i + 1 < argc) {
            loops = atoi(argv[++i]);
            if (loops < 1)
                loops = 1;
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "unknown flag: %s\n", argv[i]);
            fprintf(stderr, "usage: chm_bench [-loops N] file.chm\n");
            return 1;
        } else if (!path) {
            path = argv[i];
        } else {
            fprintf(stderr, "usage: chm_bench [-loops N] file.chm\n");
            return 1;
        }
    }
    if (!path) {
        fprintf(stderr, "usage: chm_bench [-loops N] file.chm\n");
        return 1;
    }

    /* Disk I/O stays outside the winperf section. */
    data = load_file(path, &len);
    if (!data)
        return 1;

    ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx) {
        fprintf(stderr, "chm_ctx_new failed\n");
        free(data);
        return 1;
    }

    for (i = 0; i < loops; i++) {
        double dt;

        winperf_profile_start();
        t0 = now_ms();
        if (session_open_decompress_close(ctx, data, len, &n_entries, &n_files,
                                          &total_bytes) != 0) {
            winperf_profile_stop();
            fprintf(stderr, "session failed on loop %d for %s\n", i + 1, path);
            chm_ctx_free(ctx);
            free(data);
            return 1;
        }
        dt = now_ms() - t0;
        winperf_profile_stop();
        total_ms += dt;
    }

    chm_ctx_free(ctx);
    free(data);

    printf("chm_bench file=%s size=%zu loops=%d entries=%d files=%d "
           "bytes=%llu total_ms=%.2f avg_ms=%.2f\n",
           path, len, loops, n_entries, n_files,
           (unsigned long long)total_bytes, total_ms, total_ms / (double)loops);
    return 0;
}
