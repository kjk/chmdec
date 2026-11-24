/* fuzz_lzx.c -- libFuzzer target for the LZX decoder, without the CHM container.
 *
 * Whole-file inputs spend most of their time in the directory parser. This
 * target feeds LZXdecompress the way chm.c does (one frame, then LZX_INPUT_PAD
 * zero bytes, LZXreset on the reset interval) so the codec runs on its own.
 *
 *   u8  window_bits   15..21; any other value is folded into that range
 *   u8  reset_every   LZXreset before frame i when (i % n) == 0; 0 means every frame
 *   u32 out_len       decompressed size of every frame, little endian
 *                     (0 means 32768). Clamped to min(window, 65536).
 *   repeated up to 32 times:
 *     u32 in_len
 *     in_len bytes
 *
 * A buffer too short for that header is one frame: window from byte 0, the
 * rest is the compressed bytes, out_len 32768.
 *
 * CHM_LZX_TRACE=1 prints "lzx-trace ok=N fail=N" at exit (seed checks).
 */
#include "chm_internal.h"

#include <stdio.h>
#include <stdlib.h>

#define LZX_FUZZ_MAX_FRAMES 32
#define LZX_FUZZ_MAX_OUT 65536u
#define LZX_FUZZ_MAX_IN (1u << 20)

static int g_trace;
static int g_trace_ok;
static int g_trace_fail;

static void trace_init(void)
{
    const char *e;
    static int once;
    if (once)
        return;
    once = 1;
    e = getenv("CHM_LZX_TRACE");
    g_trace = e && e[0] == '1';
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((destructor)) static void trace_dump(void)
{
    if (g_trace)
        fprintf(stderr, "lzx-trace ok=%d fail=%d\n", g_trace_ok, g_trace_fail);
}
#endif

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static int window_bits_of(uint8_t b)
{
    if (b >= 15 && b <= 21)
        return (int)b;
    return 15 + (int)(b % 7);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size)
{
    int window;
    unsigned reset_every;
    uint32_t out_len;
    size_t pos;
    int frames;
    int all_ok;
    struct LZXstate *st;
    uint8_t *outbuf;
    uint8_t *inbuf;

    trace_init();
    if (size < 2)
        return 0;

    window = window_bits_of(data[0]);
    if (size >= 6) {
        reset_every = data[1];
        out_len = rd_u32(data + 2);
        pos = 6;
    } else {
        reset_every = 1;
        out_len = 32768;
        pos = 1;
    }
    if (reset_every == 0)
        reset_every = 1;
    if (out_len == 0)
        out_len = 32768;
    if (out_len > LZX_FUZZ_MAX_OUT)
        out_len = LZX_FUZZ_MAX_OUT;
    if (out_len > (1u << window))
        out_len = 1u << window;

    st = LZXinit(NULL, window);
    if (!st)
        return 0;
    outbuf = (uint8_t *)malloc(out_len);
    if (!outbuf) {
        LZXteardown(NULL, st);
        return 0;
    }

    frames = 0;
    all_ok = 1;
    while (pos + 4 <= size && frames < LZX_FUZZ_MAX_FRAMES) {
        uint32_t in_len = rd_u32(data + pos);
        pos += 4;
        if (in_len > LZX_FUZZ_MAX_IN || pos + in_len > size) {
            all_ok = 0;
            break;
        }
        if ((frames % (int)reset_every) == 0)
            LZXreset(st);
        inbuf = (uint8_t *)malloc((size_t)in_len + LZX_INPUT_PAD);
        if (!inbuf) {
            all_ok = 0;
            break;
        }
        memcpy(inbuf, data + pos, in_len);
        memset(inbuf + in_len, 0, LZX_INPUT_PAD);
        if (LZXdecompress(st, inbuf, outbuf, (int)in_len, (int)out_len) != DECR_OK)
            all_ok = 0;
        free(inbuf);
        pos += in_len;
        frames++;
    }
    /* No framed payload. A short input is one raw frame after the window byte. */
    if (frames == 0 && size < 6 && pos < size) {
        size_t in_len = size - pos;
        if (in_len > LZX_FUZZ_MAX_IN)
            in_len = LZX_FUZZ_MAX_IN;
        inbuf = (uint8_t *)malloc(in_len + LZX_INPUT_PAD);
        if (inbuf) {
            memcpy(inbuf, data + pos, in_len);
            memset(inbuf + in_len, 0, LZX_INPUT_PAD);
            LZXreset(st);
            if (LZXdecompress(st, inbuf, outbuf, (int)in_len, (int)out_len) != DECR_OK)
                all_ok = 0;
            free(inbuf);
            frames = 1;
        }
    }

    if (g_trace) {
        if (frames > 0 && all_ok)
            g_trace_ok++;
        else
            g_trace_fail++;
    }

    free(outbuf);
    LZXteardown(NULL, st);
    return 0;
}
