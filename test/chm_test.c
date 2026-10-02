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

static void print_entry(struct chm_entry *entry)
{
    const char *type = entry->is_dir ? "dir" : "file";
    printf("  %s %s (len=%llu compressed=%d)\n", type, entry->path ? entry->path : "", (unsigned long long)entry->length, entry->is_compressed);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: chm_test [-list] file.chm\n       chm_test -lzx-wrap\n");
        return 1;
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
