/* chm_wasm_api.c -- thin JS-friendly helpers for the emscripten/wasm build.
 *
 * Avoids exposing struct layout to JS; returns paths as C strings and
 * lengths as double (safe integer range up to 2^53).
 */
#include "chm.h"
#include <stddef.h>
#include <stdint.h>

chm_ctx *chm_wasm_open(const uint8_t *data, size_t len)
{
    chm_ctx *ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx)
        return NULL;
    if (!chm_open(ctx, data, len)) {
        chm_ctx_free(ctx);
        return NULL;
    }
    return ctx;
}

void chm_wasm_close(chm_ctx *ctx)
{
    if (ctx)
        chm_ctx_free(ctx);
}

int chm_wasm_entry_count(chm_ctx *ctx)
{
    struct chm_entry **entries = NULL;
    return chm_get_entries(ctx, &entries);
}

static struct chm_entry *entry_at(chm_ctx *ctx, int i)
{
    struct chm_entry **entries = NULL;
    int n = chm_get_entries(ctx, &entries);
    if (!entries || i < 0 || i >= n)
        return NULL;
    return entries[i];
}

const char *chm_wasm_entry_path(chm_ctx *ctx, int i)
{
    struct chm_entry *e = entry_at(ctx, i);
    return e ? e->path : NULL;
}

/* double so JS gets a Number without BigInt glue; CHM sizes fit. */
double chm_wasm_entry_length(chm_ctx *ctx, int i)
{
    struct chm_entry *e = entry_at(ctx, i);
    return e ? (double)e->length : 0.0;
}

int chm_wasm_entry_is_dir(chm_ctx *ctx, int i)
{
    struct chm_entry *e = entry_at(ctx, i);
    return e && e->is_dir ? 1 : 0;
}

int chm_wasm_entry_is_file(chm_ctx *ctx, int i)
{
    struct chm_entry *e = entry_at(ctx, i);
    return e && e->is_file ? 1 : 0;
}
