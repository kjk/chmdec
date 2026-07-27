/***************************************************************************
 *             chm_lib.c - CHM archive manipulation routines               *
 *                           -------------------                           *
 *                                                                         *
 *  author:     Jed Wing <jedwin@ugcs.caltech.edu>                         *
 *  version:    0.3                                                        *
 *  notes:      These routines are meant for the manipulation of microsoft *
 *              .chm (compiled html help) files, but may likely be used    *
 *              for the manipulation of any ITSS archive, if ever ITSS     *
 *              archives are used for any other purpose.                   *
 *                                                                         *
 *              Note also that the section names are statically handled.   *
 *              To be entirely correct, the section names should be read   *
 *              from the section names meta-file, and then the various     *
 *              content sections and the "transforms" to apply to the data *
 *              they contain should be inferred from the section name and  *
 *              the meta-files referenced using that name; however, all of *
 *              the files I've been able to get my hands on appear to have *
 *              only two sections: Uncompressed and MSCompressed.          *
 *              Additionally, the ITSS.DLL file included with Windows does *
 *              not appear to handle any different transforms than the     *
 *              simple LZX-transform.  Furthermore, the list of transforms *
 *              to apply is broken, in that only half the required space   *
 *              is allocated for the list.  (It appears as though the      *
 *              space is allocated for ASCII strings, but the strings are  *
 *              written as unicode.  As a result, only the first half of   *
 *              the string appears.)  So this is probably not too big of   *
 *              a deal, at least until CHM v4 (MS .lit files), which also  *
 *              incorporate encryption, of some description.               *
 *                                                                         *
 ***************************************************************************/

/***************************************************************************
 *                                                                         *
 *   This program is free software; you can redistribute it and/or modify  *
 *   it under the terms of the GNU Lesser General Public License as        *
 *   published by the Free Software Foundation; either version 2.1 of the  *
 *   License, or (at your option) any later version.                       *
 *                                                                         *
 ***************************************************************************/

#include "chm_internal.h"

/* Windows compat already handled in internal.h for strcasecmp etc. */

/* names of sections essential to decompression */
static const char _CHMU_RESET_TABLE[] =
    "::DataSpace/Storage/MSCompressed/Transform/"
    "{7FC28940-9D31-11D0-9B27-00A0C91E9C7C}/"
    "InstanceData/ResetTable";
static const char _CHMU_LZXC_CONTROLDATA[] = "::DataSpace/Storage/MSCompressed/ControlData";
static const char _CHMU_CONTENT[] = "::DataSpace/Storage/MSCompressed/Content";
#if 0
static const char _CHMU_SPANINFO[] = "::DataSpace/Storage/MSCompressed/SpanInfo";
#endif

/* read helpers (internal, not inlined) */

static int read_char_array(uint8_t **pData, unsigned int *pLenRemain, char *dest, int count)
{
    if (count <= 0 || (unsigned int)count > *pLenRemain) return 0;
    memcpy(dest, *pData, (size_t)count);
    *pData += count;
    *pLenRemain -= (unsigned int)count;
    return 1;
}

static int read_uchar_array(uint8_t **pData, unsigned int *pLenRemain, uint8_t *dest, int count)
{
    if (count <= 0 || (unsigned int)count > *pLenRemain) return 0;
    memcpy(dest, *pData, (size_t)count);
    *pData += count;
    *pLenRemain -= (unsigned int)count;
    return 1;
}

static int read_i32(uint8_t **pData, unsigned int *pLenRemain, int32_t *dest)
{
    if (4 > *pLenRemain) return 0;
    *dest = (*pData)[0] | ((*pData)[1] << 8) | ((*pData)[2] << 16) | ((*pData)[3] << 24);
    *pData += 4;
    *pLenRemain -= 4;
    return 1;
}

static int read_u32(uint8_t **pData, unsigned int *pLenRemain, uint32_t *dest)
{
    if (4 > *pLenRemain) return 0;
    *dest = (*pData)[0] | ((*pData)[1] << 8) | ((*pData)[2] << 16) | ((*pData)[3] << 24);
    *pData += 4;
    *pLenRemain -= 4;
    return 1;
}

static int read_i64(uint8_t **pData, unsigned int *pLenRemain, int64_t *dest)
{
    int64_t temp = 0;
    if (8 > *pLenRemain) return 0;
    for (int i = 8; i > 0; i--) {
        temp <<= 8;
        temp |= (*pData)[i - 1];
    }
    *dest = temp;
    *pData += 8;
    *pLenRemain -= 8;
    return 1;
}

static int read_u64(uint8_t **pData, unsigned int *pLenRemain, uint64_t *dest)
{
    uint64_t temp = 0;
    if (8 > *pLenRemain) return 0;
    for (int i = 8; i > 0; i--) {
        temp <<= 8;
        temp |= (*pData)[i - 1];
    }
    *dest = temp;
    *pData += 8;
    *pLenRemain -= 8;
    return 1;
}

static int read_uuid(uint8_t **pData, unsigned int *pDataLen, uint8_t *dest)
{
    return read_uchar_array(pData, pDataLen, dest, 16);
}

/* ITSF/ITSP readers (local, depend on markers in scope via internal) */

static int read_itsf_header(uint8_t **pData, unsigned int *pDataLen, struct chmItsfHeader *dest)
{
    if (*pDataLen != _CHM_ITSF_V2_LEN && *pDataLen != _CHM_ITSF_V3_LEN) return 0;

    read_char_array(pData, pDataLen, dest->signature, 4);
    read_i32(pData, pDataLen, &dest->version);
    read_i32(pData, pDataLen, &dest->header_len);
    read_i32(pData, pDataLen, &dest->unknown_000c);
    read_u32(pData, pDataLen, &dest->last_modified);
    read_u32(pData, pDataLen, &dest->lang_id);
    read_uuid(pData, pDataLen, dest->dir_uuid);
    read_uuid(pData, pDataLen, dest->stream_uuid);
    read_u64(pData, pDataLen, &dest->unknown_offset);
    read_u64(pData, pDataLen, &dest->unknown_len);
    read_u64(pData, pDataLen, &dest->dir_offset);
    read_u64(pData, pDataLen, &dest->dir_len);

    if (memcmp(dest->signature, "ITSF", 4) != 0) return 0;
    if (dest->version == 2) {
        if (dest->header_len < _CHM_ITSF_V2_LEN) return 0;
    } else if (dest->version == 3) {
        if (dest->header_len < _CHM_ITSF_V3_LEN) return 0;
    } else {
        return 0;
    }

    if (dest->version == 3) {
        if (*pDataLen != 0)
            read_u64(pData, pDataLen, &dest->data_offset);
        else
            return 0;
    } else {
        dest->data_offset = dest->dir_offset + dest->dir_len;
    }
    if (dest->dir_offset > UINT_MAX || dest->dir_len > UINT_MAX) return 0;
    return 1;
}

static int read_itsp_header(uint8_t **pData, unsigned int *pDataLen, struct chmItspHeader *dest)
{
    if (*pDataLen != _CHM_ITSP_V1_LEN) return 0;

    read_char_array(pData, pDataLen, dest->signature, 4);
    read_i32(pData, pDataLen, &dest->version);
    read_i32(pData, pDataLen, &dest->header_len);
    read_i32(pData, pDataLen, &dest->unknown_000c);
    read_u32(pData, pDataLen, &dest->block_len);
    read_i32(pData, pDataLen, &dest->blockidx_intvl);
    read_i32(pData, pDataLen, &dest->index_depth);
    read_i32(pData, pDataLen, &dest->index_root);
    read_i32(pData, pDataLen, &dest->index_head);
    read_i32(pData, pDataLen, &dest->unknown_0024);
    read_u32(pData, pDataLen, &dest->num_blocks);
    read_i32(pData, pDataLen, &dest->unknown_002c);
    read_u32(pData, pDataLen, &dest->lang_id);
    read_uuid(pData, pDataLen, dest->system_uuid);
    read_uchar_array(pData, pDataLen, dest->unknown_0044, 16);

    if (memcmp(dest->signature, "ITSP", 4) != 0) return 0;
    if (dest->version != 1) return 0;
    if (dest->header_len != _CHM_ITSP_V1_LEN) return 0;
    /* a directory block must hold at least a full PMGL page header; this also
       guarantees the page buffer is >= 4 bytes for the marker memcmp before
       read_pmgl_header/read_pmgi_header run */
    if (dest->block_len < _CHM_PMGL_LEN) return 0;
    /* block_len is the directory block size (normally 0x1000). Cap it so a
       bogus header can't make dir_session_begin request a multi-gigabyte page
       buffer (out-of-memory); 2 MB is far above any real directory block. */
    if (dest->block_len > 2097152) return 0;
    return 1;
}

static int read_pmgi_header(uint8_t **pData, unsigned int *pDataLen, unsigned int blockLen,
                                  struct chmPmgiHeader *dest)
{
    if (*pDataLen != _CHM_PMGI_LEN) return 0;
    if (blockLen < _CHM_PMGI_LEN) return 0;

    read_char_array(pData, pDataLen, dest->signature, 4);
    read_u32(pData, pDataLen, &dest->free_space);

    if (memcmp(dest->signature, _chm_pmgi_marker, 4) != 0) return 0;
    if (dest->free_space > blockLen - _CHM_PMGI_LEN) return 0;
    return 1;
}

static int read_lzxc_reset_table(uint8_t **pData, unsigned int *pDataLen, struct chmLzxcResetTable *dest)
{
    if (*pDataLen != _CHM_LZXC_RESETTABLE_V1_LEN) return 0;

    read_u32(pData, pDataLen, &dest->version);
    read_u32(pData, pDataLen, &dest->block_count);
    read_u32(pData, pDataLen, &dest->unknown);
    read_u32(pData, pDataLen, &dest->table_offset);
    read_u64(pData, pDataLen, &dest->uncompressed_len);
    read_u64(pData, pDataLen, &dest->compressed_len);
    read_u64(pData, pDataLen, &dest->block_len);

    if (dest->version != 2) return 0;
    if (dest->block_count == 0) return 0;
    if (dest->uncompressed_len > INT_MAX || dest->compressed_len > INT_MAX) return 0;
    /* block_len is the per-block uncompressed size (normally 0x8000); a single
       LZX block cannot decode more than the largest legal window (2 MB), so cap
       it there instead of INT_MAX to bound the decompress buffers */
    if (dest->block_len == 0 || dest->block_len > 2097152) return 0;
    return 1;
}

/* ----- allocator + error (djvudec style) ----- */

static void *default_alloc(void *user, void *ctx, size_t size)
{
    (void)user;
    (void)ctx;
    return malloc(size);
}

static void default_free(void *user, void *ctx, void *ptr)
{
    (void)user;
    (void)ctx;
    free(ptr);
}

void *chm_alloc(chm_ctx *ctx, size_t size)
{
    chm_alloc_cb a = (ctx && ctx->alloc) ? ctx->alloc : default_alloc;
    void *u = ctx ? ctx->user : NULL;
    return a(u, ctx, size);
}

void chm_free(chm_ctx *ctx, void *ptr)
{
    if (!ptr) return;
    chm_free_cb f = (ctx && ctx->free) ? ctx->free : default_free;
    void *u = ctx ? ctx->user : NULL;
    f(u, ctx, ptr);
}

void chm_errorf(chm_ctx *ctx, int sev, const char *fmt, ...)
{
    char buf[512];
    va_list ap;
    if (!ctx || !ctx->error) return;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    ctx->error(ctx->user, sev, buf);
}

chm_ctx *chm_ctx_new(chm_alloc_cb alloc, chm_free_cb free_cb,
                     chm_error_cb error, void *user)
{
    chm_ctx *ctx;
    chm_alloc_cb a = alloc ? alloc : default_alloc;
    ctx = (chm_ctx *)a(user, NULL, sizeof(chm_ctx));
    if (!ctx) return NULL;
    memset(ctx, 0, sizeof(*ctx));
    ctx->alloc = a;
    ctx->free = free_cb ? free_cb : default_free;
    ctx->error = error;
    ctx->user = user;
    return ctx;
}

void chm_ctx_free(chm_ctx *ctx)
{
    if (ctx) {
        chm_close(ctx);
        ctx->free(ctx->user, NULL, ctx);
    }
}

/* PMGL reader (marker is in internal.h) */

static int read_pmgl_header(uint8_t **pData, unsigned int *pDataLen, unsigned int blockLen,
                                  struct chmPmglHeader *dest)
{
    if (*pDataLen != _CHM_PMGL_LEN) return 0;
    if (blockLen < _CHM_PMGL_LEN) return 0;

    read_char_array(pData, pDataLen, dest->signature, 4);
    read_u32(pData, pDataLen, &dest->free_space);
    read_u32(pData, pDataLen, &dest->unknown_0008);
    read_i32(pData, pDataLen, &dest->block_prev);
    read_i32(pData, pDataLen, &dest->block_next);

    if (memcmp(dest->signature, _chm_pmgl_marker, 4) != 0) return 0;
    if (dest->free_space > blockLen - _CHM_PMGL_LEN) return 0;
    return 1;
}

static int read_lzxc_control_data(uint8_t **pData, unsigned int *pDataLen, struct chmLzxcControlData *dest)
{
    if (*pDataLen < _CHM_LZXC_MIN_LEN) return 0;

    read_u32(pData, pDataLen, &dest->size);
    read_char_array(pData, pDataLen, dest->signature, 4);
    read_u32(pData, pDataLen, &dest->version);
    read_u32(pData, pDataLen, &dest->resetInterval);
    read_u32(pData, pDataLen, &dest->windowSize);
    read_u32(pData, pDataLen, &dest->windowsPerReset);

    if (*pDataLen >= _CHM_LZXC_V2_LEN)
        read_u32(pData, pDataLen, &dest->unknown_18);
    else
        dest->unknown_18 = 0;

    if (dest->version == 2) {
        dest->resetInterval *= 0x8000;
        dest->windowSize *= 0x8000;
    }
    if (dest->windowSize == 0 || dest->resetInterval == 0) return 0;

    if (dest->windowSize < 32768 || dest->windowSize > 2097152) return 0;
    if ((dest->windowSize & (dest->windowSize - 1)) != 0) return 0;
    if ((dest->resetInterval % (dest->windowSize / 2)) != 0) return 0;

    if (memcmp(dest->signature, "LZXC", 4) != 0) return 0;
    return 1;
}

/* archive state is now embedded in chm_ctx (no separate chmFile) */

static int64_t fetch_bytes(chm_ctx *ctx, uint8_t* buf, uint64_t offset, int64_t len) {
    if (len <= 0) {
        return 0;
    }
    if (offset > ctx->data_len) {
        return 0;
    }
    if ((uint64_t)len > ctx->data_len - offset) {
        return 0;
    }
    memcpy(buf, ctx->data + offset, (size_t)len);
    return len;
}

static int add_u64(uint64_t a, uint64_t b, uint64_t* result) {
    if (a > UINT64_MAX - b) return 0;
    *result = a + b;
    return 1;
}

static int get_entry_offset(chm_ctx *ctx, const struct chm_entry* entry, uint64_t addr, int64_t len,
                                  uint64_t* offset) {
    uint64_t temp;

    if (len <= 0) return 0;
    if (addr > entry->length) return 0;
    if ((uint64_t)len > entry->length - addr) return 0;
    if (!add_u64((uint64_t)entry->start, addr, &temp)) return 0;
    if (!add_u64(ctx->data_offset, temp, offset)) return 0;
    return 1;
}

static uint64_t dir_page_count(chm_ctx *ctx) {
    if (ctx->block_len == 0) return 0;
    return ctx->dir_len / ctx->block_len;
}

static int is_valid_dir_page(chm_ctx *ctx, int32_t page) {
    uint64_t page_count = dir_page_count(ctx);
    if (page < 0) return 0;
    if (page_count == 0) return 0;
    return (uint64_t)page < page_count;
}

static int dir_page_offset(chm_ctx *ctx, int32_t page, uint64_t* offset) {
    uint64_t page_off;

    if (!is_valid_dir_page(ctx, page)) return 0;
    if ((uint64_t)page > UINT64_MAX / ctx->block_len) return 0;
    page_off = (uint64_t)page * ctx->block_len;
    if (!add_u64(ctx->dir_offset, page_off, offset)) return 0;
    if (*offset > ctx->data_len || (uint64_t)ctx->block_len > ctx->data_len - *offset) return 0;
    return 1;
}

static int dir_fetch_page(chm_ctx *ctx, int32_t page, uint8_t* page_buf) {
    uint64_t offset;

    if (!dir_page_offset(ctx, page, &offset)) return 0;
    return fetch_bytes(ctx, page_buf, offset, ctx->block_len) == ctx->block_len;
}

static void dir_visit_reset(chm_ctx *ctx) {
    ctx->dir_pages_seen = 0;
    memset(ctx->dir_seen_bitmap, 0, sizeof(ctx->dir_seen_bitmap));
}

static int dir_visit_begin(chm_ctx *ctx) {
    if (ctx->dir_page_count == 0) return 0;
    dir_visit_reset(ctx);
    return 1;
}

static int dir_visit_page(chm_ctx *ctx, int32_t page) {
    uint32_t word_idx;
    uint32_t bit_mask;

    if (page < 0) return 0;
    if ((uint64_t)page >= ctx->dir_page_count) return 0;
    if (ctx->dir_pages_seen >= ctx->dir_page_count) return 0;
    if ((uint32_t)page >= CHM_DIR_SEEN_BITMAP_BITS) return 0;

    word_idx = (uint32_t)page >> 5;
    bit_mask = 1u << (page & 31);
    if (ctx->dir_seen_bitmap[word_idx] & bit_mask) return 0;
    ctx->dir_seen_bitmap[word_idx] |= bit_mask;
    ctx->dir_pages_seen++;
    return 1;
}

/* chmDirSession defined in chm_internal.h */

static int dir_session_begin(chm_ctx *ctx, struct chmDirSession *s)
{
    s->ctx = ctx;
    s->page_buf = NULL;
    s->page_buf_end = NULL;
    if (!dir_visit_begin(ctx)) return 0;
    s->page_buf = (uint8_t *)chm_alloc(ctx, (size_t)ctx->block_len);
    if (!s->page_buf) return 0;
    s->page_buf_end = s->page_buf + ctx->block_len;
    return 1;
}

static void dir_session_end(struct chmDirSession *s)
{
    chm_free(s->ctx, s->page_buf);
    s->page_buf = NULL;
    s->page_buf_end = NULL;
}

static int dir_session_fetch(struct chmDirSession* s, int32_t page) {
    if (!dir_visit_page(s->ctx, page)) return 0;
    return dir_fetch_page(s->ctx, page, s->page_buf);
}

/* skip a compressed dword */
static void skip_cword(uint8_t** pEntry, uint8_t* end) {
    while ((*pEntry < end) && *(*pEntry)++ >= 0x80);
}

/* skip the data from a PMGL entry */
static void skip_PMGL_entry_data(uint8_t** pEntry, uint8_t* end) {
    skip_cword(pEntry, end);
    skip_cword(pEntry, end);
    skip_cword(pEntry, end);
}

/* parse a compressed dword */
static int parse_cword(uint8_t** pEntry, uint8_t* end, uint64_t* result) {
    uint64_t accum = 0;
    uint8_t temp = 0;

    while (*pEntry < end) {
        temp = *(*pEntry)++;
        if (temp < 0x80) {
            if (accum > (UINT64_MAX - temp) >> 7) return 0;
            *result = (accum << 7) + temp;
            return 1;
        }
        if (accum > (UINT64_MAX - (temp & 0x7f)) >> 7) return 0;
        accum <<= 7;
        accum += temp & 0x7f;
    }

    return 0;
}

/* parse a utf-8 string into an ASCII char buffer */
static int parse_UTF8(uint8_t** pEntry, uint8_t* end, uint64_t count, char* path) {
    /* XXX: implement UTF-8 support, including a real mapping onto
     *      ISO-8859-1?  probably there is a library to do this?  As is
     *      immediately apparent from the below code, I'm presently not doing
     *      any special handling for files in which none of the strings contain
     *      UTF-8 multi-byte characters.
     */
    if (*pEntry > end) return 0;
    if ((uint64_t)(end - *pEntry) < count) return 0;
    memcpy(path, *pEntry, (size_t)count);
    path += count;
    *pEntry += count;

    *path = '\0';
    return 1;
}

/* parse a PMGL entry into a chm_entry struct; allocates path via ctx.
   return 1 on success. */
static int parse_PMGL_entry(chm_ctx *ctx, uint8_t** pEntry, uint8_t* end, struct chm_entry* entry) {
    uint64_t strLen;

    /* parse str len */
    if (!parse_cword(pEntry, end, &strLen)) return 0;
    if (strLen == 0) return 0;
    /* the path can't be longer than the bytes remaining in the entry region;
       reject before allocating so a bogus length can't request a huge buffer */
    if ((uint64_t)(end - *pEntry) < strLen) return 0;

    /* allocate and parse path */
    entry->path = (char *)chm_alloc(ctx, (size_t)strLen + 1);
    if (!entry->path) return 0;
    if (!parse_UTF8(pEntry, end, strLen, entry->path)) {
        chm_free(ctx, entry->path);
        entry->path = NULL;
        return 0;
    }

    /* parse info: the "space" field is the content-section index (0 =
       uncompressed, 1 = MSCompressed). Keep the raw value: an entry is only
       reported as compressed when space == CHM_COMPRESSED exactly, but the
       retrieve path treats any non-zero section as compressed (matching
       CHMLib, which diverge for corrupt files whose space is neither 0 nor 1). */
    if (!parse_cword(pEntry, end, &strLen)) return 0;
    entry->space = (uint32_t)strLen;
    entry->is_compressed = (strLen == CHM_COMPRESSED);
    if (!parse_cword(pEntry, end, &entry->start)) return 0;
    if (!parse_cword(pEntry, end, &entry->length)) return 0;
    return 1;
}

/* collect every entry in the archive into ctx->entries / ctx->entry_ptrs */
static int collect_entries(chm_ctx *ctx) {
    struct chmDirSession session;
    struct chmPmglHeader header;
    int count = 0;
    uint8_t *cur, *end;
    unsigned int remain;

    if (!ctx || ctx->entry_count > 0) return ctx->entry_count;

    if (!dir_session_begin(ctx, &session)) return 0;

    /* first pass: count entries by walking PMGL chain (ignore PMGI for full list) */
    int32_t page = ctx->index_head;
    while (page != -1) {
        if (!dir_session_fetch(&session, page)) break;
        if (memcmp(session.page_buf, _chm_pmgl_marker, 4) == 0) {
            cur = session.page_buf;
            remain = _CHM_PMGL_LEN;
            if (read_pmgl_header(&cur, &remain, ctx->block_len, &header)) {
                end = session.page_buf + ctx->block_len - (header.free_space);
                while (cur < end) {
                    uint64_t nlen;
                    if (!parse_cword(&cur, end, &nlen)) break;
                    /* the name can't be longer than the bytes left in the page;
                       without this an over-long cword would advance cur past end
                       (wrapping the pointer) and the following skips would read
                       out of bounds. Mirrors the check in parse_PMGL_entry. */
                    if ((uint64_t)(end - cur) < nlen) break;
                    cur += nlen;
                    skip_PMGL_entry_data(&cur, end);
                    count++;
                }
                page = header.block_next;
                continue;
            }
        }
        /* if not a parsable PMGL, try to follow next if possible (rare) */
        page = -1;
    }

    if (count == 0) {
        dir_session_end(&session);
        return 0;
    }

    ctx->entries = (struct chm_entry *)chm_alloc(ctx, sizeof(struct chm_entry) * count);
    ctx->entry_ptrs = (struct chm_entry **)chm_alloc(ctx, sizeof(struct chm_entry *) * count);
    if (!ctx->entries || !ctx->entry_ptrs) {
        chm_free(ctx, ctx->entries);
        chm_free(ctx, ctx->entry_ptrs);
        ctx->entries = NULL;
        ctx->entry_ptrs = NULL;
        dir_session_end(&session);
        return 0;
    }

    /* reset visit state so second pass can fetch the pages again */
    dir_visit_reset(ctx);

    /* second pass: parse and store */
    int idx = 0;
    page = ctx->index_head;
    while (page != -1 && idx < count) {
        if (!dir_session_fetch(&session, page)) break;
        if (memcmp(session.page_buf, _chm_pmgl_marker, 4) != 0) {
            page = -1; continue;
        }
        cur = session.page_buf;
        remain = _CHM_PMGL_LEN;
        if (!read_pmgl_header(&cur, &remain, ctx->block_len, &header)) break;
        end = session.page_buf + ctx->block_len - (header.free_space);

        while (cur < end && idx < count) {
            struct chm_entry *entry = &ctx->entries[idx];
            memset(entry, 0, sizeof(*entry));

            if (!parse_PMGL_entry(ctx, &cur, end, entry)) {
                /* on parse error, stop */
                break;
            }

            /* set type flags */
            size_t plen = strlen(entry->path);
            if (plen > 0) {
                if (entry->path[plen-1] == '/') {
                    entry->is_dir = true;
                } else {
                    entry->is_file = true;
                }
                if (entry->path[0] == '/') {
                    if (entry->path[1] == '#' || entry->path[1] == '$') {
                        entry->is_special = true;
                    } else {
                        entry->is_normal = true;
                    }
                } else {
                    entry->is_meta = true;
                }
            }

            ctx->entry_ptrs[idx] = entry;
            idx++;
        }
        page = header.block_next;
    }

    ctx->entry_count = idx;
    dir_session_end(&session);
    return ctx->entry_count;
}

int chm_get_entries(chm_ctx *ctx, struct chm_entry ***outEntries) {
    if (!ctx || !ctx->data || ctx->entry_count <= 0) {
        if (outEntries) *outEntries = NULL;
        return 0;
    }
    if (outEntries) *outEntries = ctx->entry_ptrs;
    return ctx->entry_count;
}

/* find an exact entry in PMGL; return NULL if we fail.
   Compares directly without using fixed-size buffer. */
static uint8_t* find_in_PMGL(uint8_t* page_buf, uint32_t block_len, const char* objPath) {
    /* XXX: modify this to do a binary search using the nice index structure
     *      that is provided for us.
     */
    struct chmPmglHeader header;
    unsigned int hremain;
    uint8_t* end;
    uint8_t* cur;
    uint8_t* temp;
    uint64_t strLen;

    /* figure out where to start and end */
    cur = page_buf;
    hremain = _CHM_PMGL_LEN;
    if (!read_pmgl_header(&cur, &hremain, block_len, &header)) return NULL;
    end = page_buf + block_len - (header.free_space);

    /* now, scan progressively */
    while (cur < end) {
        /* grab the name */
        temp = cur;
        if (!parse_cword(&cur, end, &strLen)) return NULL;
        if (strLen == 0) return NULL;
        /* the name must fit in the bytes remaining, else the compare below
           would read past the page buffer */
        if ((uint64_t)(end - cur) < strLen) return NULL;

        /* compare directly */
        if (strLen == strlen(objPath) &&
            strncasecmp((const char*)cur, objPath, (size_t)strLen) == 0) {
            return temp;
        }

        cur += strLen;
        skip_PMGL_entry_data(&cur, end);
    }

    return NULL;
}

/* case-insensitive compare of a counted (non-NUL-terminated) name against a
   C string, with the same ordering strcasecmp would give if name[len] were a
   terminating NUL. Returns <0, 0 or >0. */
static int cmp_counted_ci(const char* name, size_t len, const char* objPath) {
    for (size_t i = 0; i < len; i++) {
        unsigned char a = (unsigned char)name[i];
        unsigned char b = (unsigned char)objPath[i];
        if (b == '\0') return 1; /* name is longer -> greater */
        if (a >= 'A' && a <= 'Z') a = (unsigned char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (unsigned char)(b - 'A' + 'a');
        if (a != b) return a < b ? -1 : 1;
    }
    /* all of name matched; objPath is equal iff it also ends here */
    return objPath[len] == '\0' ? 0 : -1;
}

/* find which block should be searched next for the entry; -1 if no block */
static int32_t find_in_PMGI(uint8_t* page_buf, uint32_t block_len, const char* objPath) {
    /* XXX: modify this to do a binary search using the nice index structure
     *      that is provided for us
     */
    struct chmPmgiHeader header;
    unsigned int hremain;
    int page = -1;
    uint8_t* end;
    uint8_t* cur;
    uint64_t strLen;

    /* figure out where to start and end */
    cur = page_buf;
    hremain = _CHM_PMGI_LEN;
    if (!read_pmgi_header(&cur, &hremain, block_len, &header)) return -1;
    end = page_buf + block_len - (header.free_space);

    /* now, scan progressively */
    while (cur < end) {
        /* grab the name */
        if (!parse_cword(&cur, end, &strLen)) return -1;
        if (strLen == 0) return -1;
        /* the name must fit in the bytes remaining, else the compare below
           would read past the page buffer */
        if ((uint64_t)(end - cur) < strLen) return -1;

        /* compare against the counted name (page names are not NUL-terminated) */
        if (cmp_counted_ci((const char*)cur, (size_t)strLen, objPath) > 0) return page;

        cur += strLen;

        /* load next value for path (the page number) */
        if (!parse_cword(&cur, end, &strLen) || strLen > INT_MAX) return -1;
        page = (int)strLen;
    }

    return page;
}

/* enumeration walk removed */

/* resolve a particular entry from the archive */
static bool chm_resolve_entry(chm_ctx *ctx, const char* objPath, struct chm_entry* entry) {
    /*
     * XXX: implement caching scheme for dir pages
     */

    struct chmDirSession session;
    int32_t curPage;

    if (!dir_session_begin(ctx, &session)) return false;

    curPage = ctx->index_root;
    while (curPage != -1) {
        int32_t new_page;
        uint8_t* pEntry;

        if (!dir_session_fetch(&session, curPage)) goto cleanup;

        if (ctx->block_len < 4) goto cleanup;

        if (memcmp(session.page_buf, _chm_pmgl_marker, 4) == 0) {
            pEntry = find_in_PMGL(session.page_buf, ctx->block_len, objPath);
            if (pEntry == NULL) goto cleanup;
            if (!parse_PMGL_entry(ctx, &pEntry, session.page_buf_end, entry)) goto cleanup;
            dir_session_end(&session);
            return true;
        } else if (memcmp(session.page_buf, _chm_pmgi_marker, 4) == 0) {
            new_page = find_in_PMGI(session.page_buf, ctx->block_len, objPath);
            curPage = new_page;
        } else {
            goto cleanup;
        }
    }

cleanup:
    dir_session_end(&session);
    return false;
}

/* get the bounds of a compressed block.  return 0 on failure */
static int get_cmpblock_bounds(chm_ctx *ctx, uint64_t block, uint64_t* start, int64_t* len) {
    uint8_t buffer[8], *dummy;
    unsigned int remain;
    uint64_t table_offset;
    uint64_t table_addr;
    uint64_t block_entry_offset;
    uint64_t abs_start;

    if (block > UINT64_MAX / 8) return 0;
    block_entry_offset = block * 8;

    /* for all but the last block, use the reset table */
    if (block < ctx->reset_table.block_count - 1) {
        /* unpack the start address */
        dummy = buffer;
        remain = 8;
        if (!add_u64((uint64_t)ctx->reset_table.table_offset, block_entry_offset, &table_addr)) return 0;
        if (!get_entry_offset(ctx, &ctx->rt_entry, table_addr, remain, &table_offset) ||
            fetch_bytes(ctx, buffer, table_offset, remain) != remain || !read_u64(&dummy, &remain, start))
            return 0;

        /* unpack the end address */
        dummy = buffer;
        remain = 8;
        if (!add_u64(table_addr, 8, &table_addr)) return 0;
        if (!get_entry_offset(ctx, &ctx->rt_entry, table_addr, remain, &table_offset) ||
            fetch_bytes(ctx, buffer, table_offset, remain) != remain || !read_i64(&dummy, &remain, len))
            return 0;
    }

    /* for the last block, use the span in addition to the reset table */
    else {
        /* unpack the start address */
        dummy = buffer;
        remain = 8;
        if (!add_u64((uint64_t)ctx->reset_table.table_offset, block_entry_offset, &table_addr)) return 0;
        if (!get_entry_offset(ctx, &ctx->rt_entry, table_addr, remain, &table_offset) ||
            fetch_bytes(ctx, buffer, table_offset, remain) != remain || !read_u64(&dummy, &remain, start))
            return 0;

        *len = ctx->reset_table.compressed_len;
    }

    /* compute the length and absolute start address */
    if (*start > (uint64_t)*len) {
        return 0; // Invalid block bounds
    }
    *len -= *start;
    if (!get_entry_offset(ctx, &ctx->cn_entry, *start, *len, &abs_start)) return 0;
    *start = abs_start;

    return 1;
}

/* Ensure ctx->lzx_cbuffer holds at least need bytes. Returns NULL on OOM. */
static uint8_t *lzx_cbuffer_ensure(chm_ctx *ctx, uint64_t need)
{
    uint8_t *p;
    if (ctx->lzx_cbuffer && ctx->lzx_cbuffer_len >= need)
        return ctx->lzx_cbuffer;
    p = (uint8_t *)chm_alloc(ctx, (size_t)need);
    if (!p)
        return NULL;
    chm_free(ctx, ctx->lzx_cbuffer);
    ctx->lzx_cbuffer = p;
    ctx->lzx_cbuffer_len = need;
    return p;
}

/* decompress the block.  must have lzx_mutex. */
static int64_t decompress_block(chm_ctx *ctx, uint64_t block, uint8_t** ubuffer) {
    uint8_t* cbuffer;
    uint64_t cbufferLen;
    uint64_t cmpStart;                                           /* compressed start  */
    int64_t cmpLen;                                              /* compressed len    */
    int indexSlot;                                               /* cache index slot  */
    uint8_t* lbuffer;                                            /* local buffer ptr  */
    uint32_t blockAlign = (uint32_t)(block % ctx->reset_blkcount); /* reset intvl. aln. */
    uint32_t i;                                                  /* local loop index  */
    int ok;

    /* +16: zero padding so LZX ENSURE_BITS can refill without per-byte bounds
       checks (see lzx.c). block_len + 6144 already oversized vs real frames. */
    cbufferLen = ctx->reset_table.block_len + 6144;
    cbuffer = lzx_cbuffer_ensure(ctx, cbufferLen);
    if (!cbuffer) return -1;

    /* let the caching system pull its weight! */
    if (block - blockAlign <= ctx->lzx_last_block && block >= ctx->lzx_last_block) blockAlign = (block - ctx->lzx_last_block);

    /* check if we need previous blocks */
    if (blockAlign != 0) {
        /* fetch all required previous blocks since last reset */
        for (i = blockAlign; i > 0; i--) {
            uint32_t curBlockIdx = block - i;

            /* check if we most recently decompressed the previous block */
            if (ctx->lzx_last_block != (int)curBlockIdx) {
                if ((curBlockIdx % ctx->reset_blkcount) == 0) {
                    LZXreset(ctx->lzx_state);
                }

                /* decompress the previous block into its cache slot (we mainly
                   need the side-effect on the LZX state, but caching it lets a
                   later read of this block skip re-decompression). */
                indexSlot = (int)(curBlockIdx % ctx->cache_num_blocks);
                if (!ctx->cache_blocks[indexSlot]) {
                    ctx->cache_blocks[indexSlot] = (uint8_t *)chm_alloc(ctx, (size_t)ctx->reset_table.block_len);
                    if (!ctx->cache_blocks[indexSlot]) {
                        return -1;
                    }
                }
                ctx->cache_block_indices[indexSlot] = curBlockIdx;
                lbuffer = ctx->cache_blocks[indexSlot];

                /* decompress the previous block */
                if (!get_cmpblock_bounds(ctx, curBlockIdx, &cmpStart, &cmpLen) || cmpLen < 0 ||
                    (uint64_t)cmpLen + 16 > cbufferLen ||
                    fetch_bytes(ctx, cbuffer, cmpStart, cmpLen) != cmpLen) {
                    memset(lbuffer, 0, (size_t)ctx->reset_table.block_len);
                    return (int64_t)0;
                }
                memset(cbuffer + cmpLen, 0, 16);
                if (LZXdecompress(ctx->lzx_state, cbuffer, lbuffer, (int)cmpLen,
                                  (int)ctx->reset_table.block_len) != DECR_OK) {
                    /* Leave a deterministic buffer on failure (CHMLib still
                       exposes the cache slot for later reads of this block). */
                    memset(lbuffer, 0, (size_t)ctx->reset_table.block_len);
                    return (int64_t)0;
                }

                ctx->lzx_last_block = (int)curBlockIdx;
            }
        }
    } else {
        if ((block % ctx->reset_blkcount) == 0) {
            LZXreset(ctx->lzx_state);
        }
    }

    /* SumatraPDF: prevent division by zero */
    /* https://github.com/sumatrapdfreader/sumatrapdf/issues/5246 */
    if (ctx->cache_num_blocks == 0) {
        return -1;
    }

    /* decompress the wanted block into its cache slot; the slot is owned by ctx
       (freed in chm_close), not by the caller. The slot index is recorded
       before the decode so that, matching CHMLib, a later read of this block is
       served the (partially) decoded buffer even if the decode below fails. */
    indexSlot = (int)(block % ctx->cache_num_blocks);
    if (!ctx->cache_blocks[indexSlot]) {
        ctx->cache_blocks[indexSlot] = (uint8_t *)chm_alloc(ctx, (size_t)ctx->reset_table.block_len);
        if (!ctx->cache_blocks[indexSlot]) {
            return -1;
        }
    }
    ctx->cache_block_indices[indexSlot] = block;
    lbuffer = ctx->cache_blocks[indexSlot];
    *ubuffer = lbuffer;

    ok = get_cmpblock_bounds(ctx, block, &cmpStart, &cmpLen);
    if (!ok || cmpLen < 0 || (uint64_t)cmpLen + 16 > cbufferLen ||
        fetch_bytes(ctx, cbuffer, cmpStart, cmpLen) != cmpLen) {
        memset(lbuffer, 0, (size_t)ctx->reset_table.block_len);
        return (int64_t)0;
    }
    memset(cbuffer + cmpLen, 0, 16);
    if (LZXdecompress(ctx->lzx_state, cbuffer, lbuffer, (int)cmpLen,
                      (int)ctx->reset_table.block_len) != DECR_OK) {
        /* Slot is already indexed (matches CHMLib); zero so later reads of this
           block do not see uninitialized heap if the decode failed early. */
        memset(lbuffer, 0, (size_t)ctx->reset_table.block_len);
        return (int64_t)0;
    }
    ctx->lzx_last_block = (int)block;

    return ctx->reset_table.block_len;
}

/* grab a region from a compressed block */
static int64_t decompress_region(chm_ctx *ctx, uint8_t* buf, uint64_t start, int64_t len) {
    uint64_t nBlock, nOffset;
    uint64_t nLen;
    uint64_t gotLen;
    uint8_t* ubuffer = NULL;

    if (len <= 0) return (int64_t)0;

    /* SumatraPDF: prevent division by zero */
    /* https://github.com/sumatrapdfreader/sumatrapdf/issues/5246 */
    if (ctx->reset_table.block_len == 0) {
        return (int64_t)0;
    }

    /* figure out what we need to read */
    nBlock = start / ctx->reset_table.block_len;
    nOffset = start % ctx->reset_table.block_len;
    nLen = len;
    if (nLen > (ctx->reset_table.block_len - nOffset)) nLen = ctx->reset_table.block_len - nOffset;

    /* if this block is already decompressed, serve it from the cache. this is
       required for correctness, not just speed: the LZX decoder cannot re-emit
       a block it has already advanced past (e.g. a later entry sharing the same
       compressed block). */
    /* SumatraPDF: seen in a crash report */
    if (ctx->cache_num_blocks > 0) {
        if (ctx->cache_block_indices[nBlock % ctx->cache_num_blocks] == (int64_t)nBlock &&
            ctx->cache_blocks[nBlock % ctx->cache_num_blocks] != NULL) {
            memcpy(buf, ctx->cache_blocks[nBlock % ctx->cache_num_blocks] + nOffset, (unsigned int)nLen);
            return nLen;
        }
    }

    /* data request not satisfied, so... start up the decompressor machine */
    if (!ctx->lzx_state) {
        /* window_size is a power of two; ffs(x)-1 is its base-2 log. Compute
           it portably (ffs is POSIX-only, absent on MSVC/Windows). */
        int window_size = 0;
        {
            uint32_t w = ctx->window_size;
            while (w > 1) {
                w >>= 1;
                window_size++;
            }
        }
        ctx->lzx_last_block = -1;
        ctx->lzx_state = LZXinit(window_size);
    }

    /* SumatraPDF: prevent division by zero in decompress_block */
    /* https://github.com/sumatrapdfreader/sumatrapdf/issues/5246 */
    if (ctx->reset_blkcount == 0) {
        return (int64_t)0;
    }

    /* decompress some data (ubuffer points into a ctx-owned cache slot) */
    gotLen = decompress_block(ctx, nBlock, &ubuffer);
    /* SumatraPDF: check return value */
    if (gotLen == (uint64_t)-1 || ubuffer == NULL) {
        return 0;
    }
    if (gotLen < nLen) nLen = gotLen;
    memcpy(buf, ubuffer + nOffset, (unsigned int)nLen);
    return nLen;
}

/* internal: read a (possibly partial) range of an entry */
static int64_t read_entry_range(chm_ctx *ctx, struct chm_entry* entry, uint8_t* buf, uint64_t addr, int64_t len) {
    uint64_t offset;

    /* must be valid file handle */
    if (ctx == NULL || entry == NULL || buf == NULL) return (int64_t)0;
    if (len <= 0) return (int64_t)0;

    /* starting address must be in correct range */
    if (addr >= entry->length) return (int64_t)0;

    /* clip length */
    if ((uint64_t)len > entry->length - addr) len = (int64_t)(entry->length - addr);

    /* if the file is uncompressed, it's simple. Note: this tests the section
       index, not is_compressed -- a corrupt space that is neither 0 nor 1 is
       reported as uncompressed but still retrieved via the compressed path,
       matching CHMLib. */
    if (entry->space == CHM_UNCOMPRESSED) {
        /* read data */
        if (!get_entry_offset(ctx, entry, addr, len, &offset)) return (int64_t)0;
        return fetch_bytes(ctx, buf, offset, len);
    }

    /* else if the file is compressed, it's a little trickier */
    else
    {
        int64_t swath = 0, total = 0;

        /* if compression is not enabled for this file... */
        if (!ctx->compression_enabled) return total;

        do {
            if (!add_u64(entry->start, addr, &offset)) return total;

            /* swill another mouthful */
            swath = decompress_region(ctx, buf, offset, len);

            /* if we didn't get any... */
            if (swath == 0) return total;

            /* update stats */
            total += swath;
            len -= swath;
            addr += swath;
            buf += swath;

        } while (len != 0);

        return total;
    }
}

bool chm_open(chm_ctx *ctx, const uint8_t *data, size_t len)
{
    uint8_t sbuffer[256];
    unsigned int sremain;
    uint8_t *sbufpos;
    struct chmItsfHeader itsfHeader = {0};
    struct chmItspHeader itspHeader = {0};
#if 0
    struct chm_entry uiSpan;
#endif
    struct chm_entry uiLzxc = {0};
    struct chmLzxcControlData ctlData;
    int ok;

    if (!ctx) return false;

    /* reset document state (keep alloc/error callbacks) */
    chm_close(ctx);

    ctx->data = data;
    ctx->data_len = len;

    /* read and verify header */
    sremain = _CHM_ITSF_V3_LEN;
    sbufpos = sbuffer;
    ok = fetch_bytes(ctx, sbuffer, (uint64_t)0, sremain) == sremain;
    if (ok) {
        ok = read_itsf_header(&sbufpos, &sremain, &itsfHeader);
    }
    if (!ok) {
        chm_close(ctx);
        return false;
    }

    /* stash important values from header */
    ctx->dir_offset = itsfHeader.dir_offset;
    ctx->dir_len = itsfHeader.dir_len;
    ctx->data_offset = itsfHeader.data_offset;

    /* now, read and verify the directory header chunk */
    sremain = _CHM_ITSP_V1_LEN;
    sbufpos = sbuffer;
    ok = fetch_bytes(ctx, sbuffer, (uint64_t)itsfHeader.dir_offset, sremain) == sremain;
    if (ok) {
        ok = read_itsp_header(&sbufpos, &sremain, &itspHeader);
    }
    if (!ok) {
        chm_close(ctx);
        return false;
    }
    if (itsfHeader.dir_len < (uint64_t)itspHeader.header_len) {
        chm_close(ctx);
        return false;
    }

    /* grab essential information from ITSP header */
    ctx->dir_offset += itspHeader.header_len;
    ctx->dir_len -= itspHeader.header_len;
    ctx->index_root = itspHeader.index_root;
    ctx->index_head = itspHeader.index_head;
    ctx->block_len = itspHeader.block_len;
    if (dir_page_count(ctx) > CHM_MAX_DIR_PAGES) {
        chm_close(ctx);
        return false;
    }
    ctx->dir_page_count = dir_page_count(ctx);

    /* if the index root is -1, this means we don't have any PMGI blocks.
     * as a result, we must use the sole PMGL block as the index root
     */
    if (ctx->index_root <= -1) ctx->index_root = ctx->index_head;

    /* collect all entries (always everything, no filtering) */
    collect_entries(ctx);

    /* By default, compression is enabled. */
    ctx->compression_enabled = 1;

/* Jed, Sun Jun 27: 'span' doesn't seem to be used anywhere?! */
#if 0
    /* fetch span */
    if (!chm_resolve_entry(ctx,
                           _CHMU_SPANINFO,
                           &uiSpan) ||
        uiSpan.is_compressed)
    {
        chm_close(ctx);
        return false;
    }

    /* N.B.: we've already checked that uiSpan is in the uncompressed section,
     *       so this should not require attempting to decompress, which may
     *       rely on having a valid "span"
     */
    sremain = 8;
    sbufpos = sbuffer;
    if (read_entry_range(ctx, &uiSpan, sbuffer,
                            0, sremain) != sremain                        ||
        !read_u64(&sbufpos, &sremain, &ctx->span))
    {
        chm_close(ctx);
        return false;
    }
#endif

    /* prefetch most commonly needed entry infos */
    if (!chm_resolve_entry(ctx, _CHMU_RESET_TABLE, &ctx->rt_entry) ||
        ctx->rt_entry.is_compressed ||
        !chm_resolve_entry(ctx, _CHMU_CONTENT, &ctx->cn_entry) ||
        ctx->cn_entry.is_compressed ||
        !chm_resolve_entry(ctx, _CHMU_LZXC_CONTROLDATA, &uiLzxc) ||
        uiLzxc.is_compressed) {
        ctx->compression_enabled = 0;
    }

    /* read reset table info */
    if (ctx->compression_enabled) {
        sremain = _CHM_LZXC_RESETTABLE_V1_LEN;
        sbufpos = sbuffer;
        ok = read_entry_range(ctx, &ctx->rt_entry, sbuffer, 0, sremain) == sremain;
        if (ok) {
            ok = read_lzxc_reset_table(&sbufpos, &sremain, &ctx->reset_table);
        }
        if (!ok) {
            ctx->compression_enabled = 0;
        } else {
            /* Prefer one cache slot per LZX block so extract-all never re-decodes
               a block already visited (modulo only kicks in above the cap). */
            if (ctx->reset_table.block_count > 0 &&
                ctx->reset_table.block_count < (uint32_t)CHM_MAX_BLOCKS_CACHED)
                ctx->cache_num_blocks = (int)ctx->reset_table.block_count;
            else
                ctx->cache_num_blocks = CHM_MAX_BLOCKS_CACHED;
        }
    }

    /* read control data */
    if (ctx->compression_enabled) {
        sremain = (unsigned int)uiLzxc.length;
        if (uiLzxc.length > sizeof(sbuffer)) {
            chm_close(ctx);
            return false;
        }

        sbufpos = sbuffer;
        if (read_entry_range(ctx, &uiLzxc, sbuffer, 0, sremain) != sremain ||
            !read_lzxc_control_data(&sbufpos, &sremain, &ctlData)) {
            ctx->compression_enabled = 0;
        } else /* SumatraPDF: prevent division by zero */
        {
            ctx->window_size = ctlData.windowSize;
            ctx->reset_interval = ctlData.resetInterval;

/* Jed, Mon Jun 28: Experimentally, it appears that the reset block count */
/*       must be multiplied by this formerly unknown ctrl data field in   */
/*       order to decompress some files.                                  */
#if 0
        ctx->reset_blkcount = ctx->reset_interval /
                    (ctx->window_size / 2);
#else
            ctx->reset_blkcount =
                ctx->reset_interval / (ctx->window_size / 2) * ctlData.windowsPerReset;
#endif
        }
    }

    return true;
}

/* close an ITS archive (clears document state inside ctx, but keeps the ctx itself) */
void chm_close(chm_ctx *ctx)
{
    if (!ctx) return;
    if (ctx->lzx_state) LZXteardown(ctx->lzx_state);
    ctx->lzx_state = NULL;

    for (int i = 0; i < CHM_MAX_BLOCKS_CACHED; i++) {
        chm_free(ctx, ctx->cache_blocks[i]);
        ctx->cache_blocks[i] = NULL;
        ctx->cache_block_indices[i] = -1;
    }
    ctx->cache_num_blocks = CHM_MAX_BLOCKS_CACHED;

    chm_free(ctx, ctx->lzx_cbuffer);
    ctx->lzx_cbuffer = NULL;
    ctx->lzx_cbuffer_len = 0;

    /* clear archive fields (keep alloc/free/error/user) */
    if (ctx->entries) {
        for (int i = 0; i < ctx->entry_count; i++) {
            chm_free(ctx, ctx->entries[i].path);
        }
        chm_free(ctx, ctx->entries);
        chm_free(ctx, ctx->entry_ptrs);
        ctx->entries = NULL;
        ctx->entry_ptrs = NULL;
        ctx->entry_count = 0;
    }

    ctx->data = NULL;
    ctx->data_len = 0;
    /* zero the rest for safety */
    ctx->dir_offset = 0;
    ctx->dir_len = 0;
    ctx->data_offset = 0;
    ctx->index_root = 0;
    ctx->index_head = 0;
    ctx->block_len = 0;
    ctx->span = 0;
    memset(&ctx->rt_entry, 0, sizeof(ctx->rt_entry));
    memset(&ctx->cn_entry, 0, sizeof(ctx->cn_entry));
    memset(&ctx->reset_table, 0, sizeof(ctx->reset_table));
    ctx->compression_enabled = 0;
    ctx->window_size = 0;
    ctx->reset_interval = 0;
    ctx->reset_blkcount = 0;
    ctx->lzx_last_block = 0;
    ctx->dir_page_count = 0;
    ctx->dir_pages_seen = 0;
    memset(ctx->dir_seen_bitmap, 0, sizeof(ctx->dir_seen_bitmap));
}



/* read an entire entry from the archive */
int64_t chm_read_entry(chm_ctx *ctx, struct chm_entry *entry, uint8_t *buf) {
    if (!entry) return 0;
    return read_entry_range(ctx, entry, buf, 0, entry->length);
}

/* enumeration API removed; entries are collected into ctx->entries at open time */
