/* chm_test.c -- simple CLI test harness for chmdec (djvudec style). */

#include "chm_internal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 16-bit little-endian words; the decompressor consumes bit 15 first. */
struct lzx_bits {
    uint8_t *d;
    int cap;
    int nbits;
};

static void lzx_bit(struct lzx_bits *w, int b)
{
    int bitIndex = 15 - (w->nbits % 16);
    int byteOff = (w->nbits / 16) * 2 + (bitIndex >= 8 ? 1 : 0);
    w->d[byteOff] |= (uint8_t)((b & 1) << (bitIndex & 7));
    w->nbits++;
}

static void lzx_bits(struct lzx_bits *w, uint32_t v, int n)
{
    int i;
    for (i = n - 1; i >= 0; i--)
        lzx_bit(w, (int)((v >> i) & 1));
}

static int lzx_align16(struct lzx_bits *w)
{
    int bytes = ((w->nbits + 15) / 16) * 2;
    w->nbits = bytes * 8;
    return bytes;
}

/* One uncompressed LZX block. intel_bit is the stream header (first block only). */
static int write_lzx_uncomp(uint8_t *d, int cap, int len, const uint8_t *payload, int intel_bit)
{
    struct lzx_bits w;
    int off;
    memset(d, 0, (size_t)cap);
    w.d = d;
    w.cap = cap;
    w.nbits = 0;
    if (intel_bit)
        lzx_bits(&w, 0, 1);
    lzx_bits(&w, 3, 3);
    lzx_bits(&w, ((uint32_t)len >> 8) & 0xffffu, 16);
    lzx_bits(&w, (uint32_t)len & 0xffu, 8);
    off = lzx_align16(&w);
    off += 12;
    if (off < 0 || len < 0 || off + len > cap)
        return -1;
    memcpy(d + off, payload, (size_t)len);
    return off + len;
}

/* A frame whose two blocks cross the end of the window must return the tail
 * then the head, not bytes from before the window allocation. */
static int lzx_window_wrap(void)
{
    const int wnd = 15;
    const int size = 1 << wnd;
    const int tailN = 4;
    struct LZXstate *st = LZXinit(wnd);
    int n1, nIn1, rc, nA, nB;
    uint8_t *pay1 = NULL, *in1 = NULL, *out1 = NULL;
    uint8_t blockTail[4] = {1, 2, 3, 4};
    uint8_t blockHead[4] = {5, 6, 7, 8};
    uint8_t in2[128];
    uint8_t out2[8];
    uint8_t expect[8] = {1, 2, 3, 4, 5, 6, 7, 8};
    int failed = 0;

    if (!st) {
        fprintf(stderr, "LZXinit failed\n");
        return 1;
    }
    n1 = size - tailN;
    pay1 = (uint8_t *)malloc((size_t)n1);
    in1 = (uint8_t *)malloc((size_t)n1 + 64);
    out1 = (uint8_t *)malloc((size_t)n1);
    if (!pay1 || !in1 || !out1) {
        fprintf(stderr, "oom\n");
        failed = 1;
        goto done;
    }
    memset(pay1, 0xA1, (size_t)n1);
    nIn1 = write_lzx_uncomp(in1, n1 + 32, n1, pay1, 1);
    rc = LZXdecompress(st, in1, out1, nIn1, n1);
    if (nIn1 < 0 || rc != 0 || memcmp(out1, pay1, (size_t)n1) != 0) {
        fprintf(stderr, "non-wrapping frame failed rc=%d\n", rc);
        failed = 1;
        goto done;
    }

    nA = write_lzx_uncomp(in2, 64, 4, blockTail, 0);
    nB = write_lzx_uncomp(in2 + nA, 64, 4, blockHead, 0);
    memset(out2, 0x5a, sizeof(out2));
    rc = LZXdecompress(st, in2, out2, nA + nB, 8);
    if (nA < 0 || nB < 0 || rc != 0 || memcmp(out2, expect, sizeof(expect)) != 0) {
        fprintf(stderr, "wrapped frame failed rc=%d got", rc);
        for (n1 = 0; n1 < 8; n1++)
            fprintf(stderr, " %02x", out2[n1]);
        fprintf(stderr, "\n");
        failed = 1;
    }

done:
    LZXteardown(st);
    free(pay1);
    free(in1);
    free(out1);
    return failed;
}

static uint8_t *load_file(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    long sz;
    uint8_t *d;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    d = sz > 0 ? (uint8_t *)malloc((size_t)sz) : NULL;
    if (d && fread(d, 1, (size_t)sz, f) != (size_t)sz) {
        free(d);
        d = NULL;
    }
    fclose(f);
    *len = (size_t)sz;
    return d;
}

/* Read entry `path` of the archive open on ctx into a malloc'd buffer.
   Returns the number of bytes read (-1 if the entry is missing). */
static int64_t read_by_path(chm_ctx *ctx, const char *path, uint8_t **out)
{
    struct chm_entry **entries = NULL;
    int n = chm_get_entries(ctx, &entries);
    *out = NULL;
    for (int i = 0; i < n; i++) {
        if (strcmp(entries[i]->path, path) != 0) continue;
        *out = (uint8_t *)malloc(entries[i]->length ? (size_t)entries[i]->length : 1);
        if (!*out) return -1;
        return chm_read_entry(ctx, entries[i], *out);
    }
    return -1;
}

/* chm_close keeps the LZX decoder for the next chm_open on the same ctx.
   Reading a compressed entry of b.chm after closing a.chm on that ctx must
   give the same bytes as reading it on a fresh ctx -- in particular for an
   entry whose first block is inside the first reset interval but not block 0,
   where the decoder has to catch up from block 0 of the *new* archive.
   Exit code: 0 pass, 1 fail, 2 can't test this pair (no such entries, or the
   two archives use different LZX windows, which rebuilds the decoder). */
static int reuse_test(const char *pa, const char *pb)
{
    size_t la, lb;
    uint8_t *da = load_file(pa, &la), *db = load_file(pb, &lb);
    chm_ctx *probe = chm_ctx_new(NULL, NULL, NULL, NULL);
    char *targets[64];
    char *dirty = NULL;
    int ntargets = 0, failed = 0, rc = 2;
    uint32_t wnd_a;

    if (!da || !db || !probe) {
        fprintf(stderr, "can't read %s or %s\n", pa, pb);
        free(da);
        free(db);
        chm_ctx_free(probe);
        return 1;
    }

    /* A: its LZX window, and one compressed entry to read so the decoder
       state left behind is A's */
    if (!chm_open(probe, da, la)) goto done;
    wnd_a = probe->window_size;
    {
        struct chm_entry **e = NULL;
        int n = chm_get_entries(probe, &e);
        for (int i = 0; i < n && !dirty; i++) {
            if (e[i]->is_compressed && e[i]->is_normal && e[i]->length > 0) {
                dirty = (char *)malloc(strlen(e[i]->path) + 1);
                if (dirty) strcpy(dirty, e[i]->path);
            }
        }
    }
    chm_close(probe);

    /* B: entries whose first block is in the first reset interval, not 0 */
    if (!dirty || !chm_open(probe, db, lb)) goto done;
    if (!probe->compression_enabled || probe->window_size != wnd_a ||
        probe->reset_table.block_len == 0 || probe->reset_blkcount < 2) {
        chm_close(probe);
        goto done;
    }
    {
        struct chm_entry **e = NULL;
        int n = chm_get_entries(probe, &e);
        uint64_t blen = probe->reset_table.block_len;
        for (int i = 0; i < n && ntargets < 64; i++) {
            uint64_t blk = e[i]->start / blen;
            if (!e[i]->is_compressed || !e[i]->is_normal || e[i]->length == 0) continue;
            if (blk == 0 || blk >= probe->reset_blkcount) continue;
            targets[ntargets] = (char *)malloc(strlen(e[i]->path) + 1);
            if (!targets[ntargets]) break;
            strcpy(targets[ntargets], e[i]->path);
            ntargets++;
        }
    }
    chm_close(probe);
    if (ntargets == 0) goto done;

    rc = 0;
    for (int t = 0; t < ntargets; t++) {
        uint8_t *want = NULL, *got = NULL, *tmp = NULL;
        int64_t nwant, ngot;
        chm_ctx *fresh = chm_ctx_new(NULL, NULL, NULL, NULL);
        chm_ctx *reused = chm_ctx_new(NULL, NULL, NULL, NULL);

        /* reference: B on a fresh ctx */
        nwant = (fresh && chm_open(fresh, db, lb)) ? read_by_path(fresh, targets[t], &want) : -1;

        /* A, read, close, then B on the same ctx */
        ngot = -1;
        if (reused && chm_open(reused, da, la)) {
            read_by_path(reused, dirty, &tmp);
            chm_close(reused);
            if (chm_open(reused, db, lb)) ngot = read_by_path(reused, targets[t], &got);
        }
        if (nwant <= 0 || ngot != nwant || memcmp(want, got, (size_t)nwant) != 0) {
            fprintf(stderr, "FAIL reuse: %s: fresh ctx read %lld bytes, reused ctx %lld%s\n",
                    targets[t], (long long)nwant, (long long)ngot,
                    ngot == nwant ? " (different bytes)" : "");
            failed++;
        }
        free(want);
        free(got);
        free(tmp);
        if (fresh) chm_close(fresh);
        if (reused) chm_close(reused);
        chm_ctx_free(fresh);
        chm_ctx_free(reused);
    }
    if (failed) rc = 1;
    printf("reuse %s -> %s: %d entries, %d failed\n", pa, pb, ntargets, failed);

done:
    if (rc == 2) printf("reuse %s -> %s: can't test (no entry in blocks 1..reset-1, or different LZX window)\n", pa, pb);
    for (int t = 0; t < ntargets; t++) free(targets[t]);
    free(dirty);
    chm_ctx_free(probe);
    free(da);
    free(db);
    return rc;
}

static void print_entry(struct chm_entry *entry)
{
    const char *type = entry->is_dir ? "dir" : "file";
    printf("  %s %s (len=%llu compressed=%d)\n", type, entry->path ? entry->path : "", (unsigned long long)entry->length, entry->is_compressed);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: chm_test [-list] file.chm\n       chm_test -lzx-wrap\n"
                        "       chm_test -reuse a.chm b.chm\n");
        return 1;
    }
    if (strcmp(argv[1], "-reuse") == 0) {
        if (argc != 4) {
            fprintf(stderr, "usage: chm_test -reuse a.chm b.chm\n");
            return 1;
        }
        return reuse_test(argv[2], argv[3]);
    }
    int do_list = 0;
    int only_wrap = 0;
    const char *path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-list") == 0) do_list = 1;
        else if (strcmp(argv[i], "-lzx-wrap") == 0) only_wrap = 1;
        else if (!path) path = argv[i];
    }
    if (lzx_window_wrap() != 0)
        return 1;
    if (only_wrap) {
        printf("lzx-wrap OK\n");
        return 0;
    }
    if (!path) {
        fprintf(stderr, "no chm file\n");
        return 1;
    }

    FILE *f = fopen(path, "rb");
    if (!f) {
        perror("fopen");
        return 1;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) {
        fclose(f);
        fprintf(stderr, "empty file\n");
        return 1;
    }
    uint8_t *data = (uint8_t *)malloc((size_t)sz);
    if (!data) {
        fclose(f);
        return 1;
    }
    if (fread(data, 1, (size_t)sz, f) != (size_t)sz) {
        perror("fread");
        free(data);
        fclose(f);
        return 1;
    }
    fclose(f);

    chm_ctx *ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx) {
        fprintf(stderr, "chm_ctx_new failed\n");
        free(data);
        return 1;
    }
    if (!chm_open(ctx, data, (size_t)sz)) {
        fprintf(stderr, "chm_open failed for %s\n", path);
        chm_ctx_free(ctx);
        free(data);
        return 1;
    }
    printf("opened %s (%ld bytes)\n", path, sz);

    if (do_list) {
        struct chm_entry **entries = NULL;
        int n = chm_get_entries(ctx, &entries);
        printf("entries (%d):\n", n);
        for (int i = 0; i < n; i++) {
            print_entry(entries[i]);
        }
    }

    chm_close(ctx);
    chm_ctx_free(ctx);
    free(data);
    printf("OK\n");
    return 0;
}
