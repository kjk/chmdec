/* fuzz_target.c -- libFuzzer target for chm decoder. */
#include "chm.h"
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    if (size < 8) return 0;
    chm_ctx *ctx = chm_ctx_new(NULL, NULL, NULL, NULL);
    if (!ctx) return 0;
    if (!chm_open(ctx, data, size)) {
        chm_ctx_free(ctx);
        return 0;
    }

    /* drive common surface */
    struct chm_entry **entries = NULL;
    int n = chm_get_entries(ctx, &entries);
    /* read every entry, as an app showing the archive does: that is what runs
       the LZX decoder over the compressed content */
    for (int i = 0; i < n; i++) {
        if (entries[i]->length > 0 && entries[i]->length <= (1 << 20)) {
            uint8_t *tmp = malloc(entries[i]->length);
            if (tmp) {
                chm_read_entry(ctx, entries[i], tmp);
                free(tmp);
            }
        }
    }
    (void)n;  /* n already obtained above */

    chm_close(ctx);
    chm_ctx_free(ctx);
    return 0;
}
