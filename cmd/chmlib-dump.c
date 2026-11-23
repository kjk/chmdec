// chmlib-dump -- dump a CHM's entries (metadata + content) using the vendored
// CHMLib oracle (test/CHMLib), in the same binary format as our-dump.c. Read
// by cmd/chm-common.ts (readDump) so cmd/test.ts can byte-compare the two.
//
//   chmlib-dump [-list] file.chm     binary dump (default: with content)
//   chmlib-dump -bench file.chm      time open / extract-all / close (one session)
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
