/* fuzz_mutator.c -- libFuzzer mutator that keeps an ITSF container intact.
 *
 * A byte-level mutation usually lands in the header and the parser rejects
 * the file before the directory or the LZX content runs. This mutator leaves
 * the "ITSF" signature in place and changes one region: a header field, one
 * directory or control-data page, or the content past the directory.
 *
 * One call in four is the plain mutator, so broken containers are still
 * explored. AFL++ has its own mutators and does not link this file.
 *
 * CHM_FUZZ_NO_MUTATOR=1 forces the plain mutator (bun cmd/fuzz.ts -no-mutator).
 */
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

size_t LLVMFuzzerMutate(uint8_t *data, size_t size, size_t max_size);

static int plain_only(void)
{
    const char *e = getenv("CHM_FUZZ_NO_MUTATOR");
    return e && e[0] && e[0] != '0';
}

static uint32_t rd_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static uint64_t rd_u64(const uint8_t *p)
{
    uint64_t v = 0;
    int i;
    for (i = 7; i >= 0; i--)
        v = (v << 8) | p[i];
    return v;
}

static void wr_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

/* Directory end from a v2/v3 ITSF header, or 0 when the offsets are nonsense. */
static size_t dir_end_of(const uint8_t *data, size_t size)
{
    uint64_t dir_off, dir_len, end;
    int32_t version, header_len;
    if (size < 0x58 || memcmp(data, "ITSF", 4) != 0)
        return 0;
    version = (int32_t)rd_u32(data + 4);
    header_len = (int32_t)rd_u32(data + 8);
    if (version == 2 && header_len < 0x58)
        return 0;
    if (version == 3 && (header_len < 0x60 || size < 0x60))
        return 0;
    if (version != 2 && version != 3)
        return 0;
    dir_off = rd_u64(data + 0x48);
    dir_len = rd_u64(data + 0x50);
    if (dir_off > size || dir_len > size - dir_off)
        return 0;
    end = dir_off + dir_len;
    if (end < 0x58 || end > size)
        return 0;
    return (size_t)end;
}

/* Mutate [off, off+len) without changing the file size. */
static void mutate_inplace(uint8_t *data, size_t off, size_t len)
{
    uint8_t *tmp;
    size_t n;
    if (len == 0 || len > (1u << 20))
        return;
    tmp = (uint8_t *)malloc(len);
    if (!tmp)
        return;
    memcpy(tmp, data + off, len);
    n = LLVMFuzzerMutate(tmp, len, len);
    if (n > 0 && n <= len)
        memcpy(data + off, tmp, n);
    free(tmp);
}

static size_t find_marker(const uint8_t *data, size_t size, size_t from, const char *sig)
{
    size_t i;
    if (size < 4 || from > size - 4)
        return size;
    for (i = from; i + 4 <= size; i++) {
        if (memcmp(data + i, sig, 4) == 0)
            return i;
    }
    return size;
}

/* Replace one u32 just after an "LZXC" with a value the control-data checks
   care about (0, 1, a unit of 32 KB, a power-of-two window, too big). */
static int tweak_lzxc(uint8_t *data, size_t size, unsigned seed)
{
    static const uint32_t k_vals[] = {
        0, 1, 2, 15, 16, 21, 0x8000u, 0x10000u, 0x200000u, 0xffffffffu,
    };
    size_t at = 0;
    unsigned which = seed % 4;
    size_t hits = 0;
    size_t pick = size;
    while (at + 8 <= size) {
        at = find_marker(data, size, at, "LZXC");
        if (at == size)
            break;
        hits++;
        if ((hits % 4) == (which % 4))
            pick = at;
        at += 4;
    }
    /* signature, then version / resetInterval / windowSize / windowsPerReset */
    {
        size_t field = 4u + 4u * ((seed >> 8) % 4u);
        if (pick == size || pick + field + 4 > size)
            return 0;
        wr_u32(data + pick + field,
               k_vals[(seed >> 4) % (sizeof(k_vals) / sizeof(k_vals[0]))]);
    }
    return 1;
}

static int tweak_header_field(uint8_t *data, size_t size, unsigned seed)
{
    /* version, header_len, and the low halves of dir_offset / dir_len / data_offset */
    static const size_t k_off[] = {4, 8, 0x0c, 0x48, 0x50, 0x58};
    static const uint32_t k_delta[] = {0, 1, 0xffffffffu, 0x58, 0x60, 0x54, 0x1000, 0x8000};
    size_t off = k_off[seed % (sizeof(k_off) / sizeof(k_off[0]))];
    uint32_t delta = k_delta[(seed >> 4) % (sizeof(k_delta) / sizeof(k_delta[0]))];
    if (off + 4 > size)
        return 0;
    wr_u32(data + off, rd_u32(data + off) + delta);
    return 1;
}

static const char *k_sigs[] = {"PMGL", "PMGI", "LZXC", "ITSP"};

static int mutate_marked_page(uint8_t *data, size_t size, unsigned seed)
{
    const char *sig = k_sigs[seed % 4];
    size_t at = 0;
    size_t n = 0;
    size_t pick = size;
    unsigned want = (seed >> 3) & 0xffu;
    while (at + 4 <= size) {
        at = find_marker(data, size, at, sig);
        if (at == size)
            break;
        pick = at;
        if (n == want)
            break;
        n++;
        at += 4;
    }
    if (pick + 4 >= size)
        return 0;
    /* Keep the 4-byte marker. Mutate the payload after it, in place. */
    {
        size_t len = size - (pick + 4);
        if (len > 256)
            len = 256;
        mutate_inplace(data, pick + 4, len);
    }
    return 1;
}

/* Grow or shrink the bytes after the directory. The ITSF header and the
   directory it points at stay put, so the parser still reaches the content. */
static size_t mutate_content(uint8_t *data, size_t size, size_t max_size, int change_size)
{
    size_t prefix = dir_end_of(data, size);
    size_t tail, cap, n;
    uint8_t *tmp;
    if (prefix == 0)
        prefix = size / 2;
    if (prefix >= size || prefix >= max_size)
        return 0;
    tail = size - prefix;
    cap = change_size ? max_size - prefix : tail;
    if (cap == 0)
        return 0;
    if (tail > cap)
        tail = cap;
    tmp = (uint8_t *)malloc(cap);
    if (!tmp)
        return 0;
    memcpy(tmp, data + prefix, tail);
    n = LLVMFuzzerMutate(tmp, tail, cap);
    if (n == 0 || n > cap) {
        free(tmp);
        return 0;
    }
    memcpy(data + prefix, tmp, n);
    free(tmp);
    return prefix + n;
}

size_t LLVMFuzzerCustomMutator(uint8_t *data, size_t size, size_t max_size, unsigned int seed)
{
    unsigned op;
    size_t n;
    if (max_size == 0)
        return 0;
    if (plain_only() || size < 8 || (seed & 3u) == 0)
        return LLVMFuzzerMutate(data, size, max_size);
    if (size < 4 || memcmp(data, "ITSF", 4) != 0)
        return LLVMFuzzerMutate(data, size, max_size);

    op = (seed >> 2) % 5u;
    switch (op) {
    case 0:
        if (tweak_header_field(data, size, seed))
            return size;
        break;
    case 1:
        if (tweak_lzxc(data, size, seed))
            return size;
        break;
    case 2:
        if (mutate_marked_page(data, size, seed))
            return size;
        break;
    case 3:
        n = mutate_content(data, size, max_size, 0);
        if (n)
            return n;
        break;
    default:
        n = mutate_content(data, size, max_size, 1);
        if (n)
            return n;
        break;
    }
    return LLVMFuzzerMutate(data, size, max_size);
}
