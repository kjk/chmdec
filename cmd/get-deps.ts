// get-deps.ts -- fetch a public .chm test/bench corpus into testfiles/chm/.
//
//   bun cmd/get-deps.ts            # open samples (~3–4 MB)
//   bun cmd/get-deps.ts -large     # also large help files for bench
//   bun cmd/get-deps.ts -force     # re-download even if present
//
// Sources (public raw URLs; sizes pinned to reject LFS pointers / truncations):
//   mlocati/chm-lib              test/samples/{main,second,putty}.chm
//   sumatrapdfreader/sumatrapdf  tests/issue-chm-lzx.chm  (LZX edge case)
//   mattslay/Visual-FoxPro-Toolkit-for-.NET  VFPToolkitNET.chm
//   normanbrobinson/chmProcessor WarningBrokenLink.chm
//   apache/tika                  test-documents/*.chm (Windows help + fixtures)
//   ADN-DevTech/revit-api-chms   2025.3.chm  (-large)
//   apache/tika                  testChm2.chm (~10 MB, -large)
//
// Note: madler/zlib DotZLib.chm is intentionally omitted — the public copy is
// truncated (file 72726 B, stream needs 72728) and fails half-way through LZX.
//
// The reference CHMLib (sumatrapdf's ext/CHMLib fork) is vendored under
// test/CHMLib and committed, so no network fetch is needed for the oracle.
// testfiles/ is gitignored.
import { existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const ROOT = `${import.meta.dir}/..`;
const DEST = join(ROOT, "testfiles", "chm");
export const CHMLIB_DIR = join(ROOT, "test", "CHMLib");
export const CORPUS_DIR = DEST;

/** ITSF magic every valid CHM starts with. */
const ITSF = new TextEncoder().encode("ITSF");

type Sample = {
  /** Filename under testfiles/chm/ */
  name: string;
  url: string;
  /** Expected size in bytes (skip re-download when match; detect LFS pointers). */
  size: number;
  /** Only fetched with -large. */
  large?: boolean;
};

const TIKA_DOC =
  "https://raw.githubusercontent.com/apache/tika/main/" +
  "tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/" +
  "tika-parser-microsoft-module/src/test/resources/test-documents";

// Curated public samples. Sizes are fixed so we can skip re-download and reject
// truncated / LFS-pointer responses without hashing. Prefer archives that
// 7-Zip `t` reports as intact (ITSF + complete compressed stream).
const SAMPLES: Sample[] = [
  // mlocati/chm-lib — deliberately published PHP CHMLib test fixtures
  {
    name: "main.chm",
    url: "https://raw.githubusercontent.com/mlocati/chm-lib/main/test/samples/main.chm",
    size: 10616,
  },
  {
    name: "second.chm",
    url: "https://raw.githubusercontent.com/mlocati/chm-lib/main/test/samples/second.chm",
    size: 10578,
  },
  {
    name: "putty.chm",
    url: "https://raw.githubusercontent.com/mlocati/chm-lib/main/test/samples/putty.chm",
    size: 271652,
  },
  {
    name: "putty.chm.LICENCE",
    url: "https://raw.githubusercontent.com/mlocati/chm-lib/main/test/samples/putty.chm.LICENCE",
    size: 1338,
  },
  // SumatraPDF regression fixture (tiny LZX corner case)
  {
    name: "issue-chm-lzx.chm",
    url: "https://raw.githubusercontent.com/sumatrapdfreader/sumatrapdf/master/tests/issue-chm-lzx.chm",
    size: 2379,
  },
  // Real help file, medium size
  {
    name: "VFPToolkitNET.chm",
    url: "https://raw.githubusercontent.com/mattslay/Visual-FoxPro-Toolkit-for-.NET/master/VFPToolkitNET.chm",
    size: 193956,
  },
  // chmProcessor test output (small, intact)
  {
    name: "WarningBrokenLink.chm",
    url:
      "https://raw.githubusercontent.com/normanbrobinson/chmProcessor/master/" +
      "chmProcessor/tests/ExitCodeTest/WarningBrokenLink.chm",
    size: 10983,
  },
  // Apache Tika microsoft-parser test CHMs (real Windows help + fixtures)
  { name: "admin.chm", url: `${TIKA_DOC}/chm/admin.chm`, size: 49749 },
  { name: "cmak_ops.chm", url: `${TIKA_DOC}/chm/cmak_ops.CHM`, size: 82895 },
  { name: "comexp.chm", url: `${TIKA_DOC}/chm/comexp.CHM`, size: 109882 },
  { name: "gpedit.chm", url: `${TIKA_DOC}/chm/gpedit.CHM`, size: 49537 },
  { name: "tcpip.chm", url: `${TIKA_DOC}/chm/tcpip.CHM`, size: 33186 },
  { name: "wmicontrol.chm", url: `${TIKA_DOC}/chm/wmicontrol.CHM`, size: 32096 },
  { name: "testChm.chm", url: `${TIKA_DOC}/testChm.chm`, size: 186259 },
  { name: "testChm3.chm", url: `${TIKA_DOC}/testChm3.chm`, size: 900481 },
  { name: "IMJPCL.chm", url: `${TIKA_DOC}/chm/IMJPCL.CHM`, size: 757069 },
  { name: "IMJPCLE.chm", url: `${TIKA_DOC}/chm/IMJPCLE.CHM`, size: 256718 },
  { name: "IMTCEN.chm", url: `${TIKA_DOC}/chm/IMTCEN.CHM`, size: 452547 },
  // Larger bench files (opt-in)
  {
    name: "testChm2.chm",
    url: `${TIKA_DOC}/testChm2.chm`,
    size: 10807437,
    large: true,
  },
  {
    name: "revit-api-2025.3.chm",
    url: "https://raw.githubusercontent.com/ADN-DevTech/revit-api-chms/main/2025.3.chm",
    size: 42884131,
    large: true,
  },
];

/** Stale files from older get-deps runs that should not stay in the corpus. */
const REMOVE = ["DotZLib.chm"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isItsf(buf: Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === ITSF[0] &&
    buf[1] === ITSF[1] &&
    buf[2] === ITSF[2] &&
    buf[3] === ITSF[3]
  );
}

function looksPresent(path: string, size: number): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size === size;
  } catch {
    return false;
  }
}

async function download(
  url: string,
  dest: string,
  expectSize: number,
  isChm: boolean,
  opts: { attempts?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length !== expectSize) {
        throw new Error(
          `size mismatch for ${dest}: got ${buf.length}, want ${expectSize}`,
        );
      }
      if (isChm && !isItsf(buf)) {
        throw new Error(`not a CHM (missing ITSF magic): ${dest}`);
      }
      writeFileSync(dest, buf);
      const kb = (buf.length / 1024).toFixed(buf.length >= 1024 * 1024 ? 0 : 1);
      console.log(`corpus: ${dest} (${kb} KB)`);
      return;
    } catch (err) {
      lastErr = err;
      if (i + 1 >= attempts) break;
      const delayMs = Math.min(20_000, 800 * 2 ** i);
      console.log(
        `corpus: retry ${i + 1}/${attempts - 1} in ${delayMs}ms (${url})`,
      );
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`GET ${url} failed: ${String(lastErr)}`);
}

export type GetDepsOpts = {
  /** Re-download even when size matches. */
  force?: boolean;
  /** Also fetch large help files for benchmarking. */
  large?: boolean;
};

/**
 * Ensure testfiles/chm has the public sample corpus.
 * Returns the corpus directory path.
 */
export async function getDeps(opts: GetDepsOpts = {}): Promise<string> {
  mkdirSync(DEST, { recursive: true });

  for (const name of REMOVE) {
    const p = join(DEST, name);
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`corpus: removed obsolete ${name}`);
    }
  }

  const want = SAMPLES.filter((s) => opts.large || !s.large);
  let fetched = 0;
  let skipped = 0;

  for (const s of want) {
    const dest = join(DEST, s.name);
    if (!opts.force && looksPresent(dest, s.size)) {
      skipped++;
      continue;
    }
    const isChm = s.name.toLowerCase().endsWith(".chm");
    await download(s.url, dest, s.size, isChm);
    fetched++;
  }

  if (fetched === 0 && skipped > 0) {
    console.log(`corpus: ${skipped} sample(s) already present in testfiles/chm`);
  } else if (fetched > 0) {
    console.log(
      `corpus: fetched ${fetched}, kept ${skipped}; total ${want.length} under testfiles/chm`,
    );
  }

  return DEST;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("-force") || args.includes("--force");
  const large = args.includes("-large") || args.includes("--large");
  if (args.some((a) => a === "-h" || a === "--help")) {
    console.log(`usage: bun cmd/get-deps.ts [-force] [-large]

Downloads public .chm samples into testfiles/chm/ (gitignored).

  -force   re-download even if present
  -large   also fetch large help CHMs for bench (~10 MB Tika + ~43 MB Revit)

Default sources:
  https://github.com/mlocati/chm-lib
  https://github.com/sumatrapdfreader/sumatrapdf  (issue-chm-lzx.chm)
  https://github.com/mattslay/Visual-FoxPro-Toolkit-for-.NET
  https://github.com/normanbrobinson/chmProcessor
  https://github.com/apache/tika  (microsoft-module test-documents)

Large:
  apache/tika testChm2.chm
  https://github.com/ADN-DevTech/revit-api-chms  (2025.3.chm)
`);
    process.exit(0);
  }
  await getDeps({ force, large });
  console.log("deps ready (vendored test/CHMLib + public testfiles/chm corpus)");
}
