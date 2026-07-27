/* chm_test.c -- simple CLI test harness for chmdec (djvudec style). */

#include "chm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void print_entry(struct chm_entry *entry)
{
    const char *type = entry->is_dir ? "dir" : "file";
    printf("  %s %s (len=%llu compressed=%d)\n", type, entry->path ? entry->path : "", (unsigned long long)entry->length, entry->is_compressed);
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: chm_test [-list] file.chm\n");
        return 1;
    }
    int do_list = 0;
    const char *path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-list") == 0) do_list = 1;
        else if (!path) path = argv[i];
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
