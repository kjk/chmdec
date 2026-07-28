// get-deps.ts -- fetch a public .chm test/bench corpus into testfiles/chm/.
//
//   bun cmd/get-deps.ts            # small open samples (~0.5 MB)
//   bun cmd/get-deps.ts -large     # also one large SDK help file (~43 MB)
//   bun cmd/get-deps.ts -force     # re-download even if present
//
// Sources (all public GitHub raw URLs):
//   mlocati/chm-lib          test/samples/{main,second,putty}.chm
//   madler/zlib              contrib/dotzlib/DotZLib.chm
//   sumatrapdfreader/...     tests/issue-chm-lzx.chm  (LZX edge case)
//   mattslay/Visual-FoxPro-Toolkit-for-.NET  VFPToolkitNET.chm
//   ADN-DevTech/revit-api-chms  2025.3.chm  (-large only; real-world size)
//
// The reference CHMLib (sumatrapdf's ext/CHMLib fork) is vendored under
// test/CHMLib and committed, so no network fetch is needed for the oracle.
// testfiles/ is gitignored.
import { existsSync, mkdirSync, writeFileSync, statSync } from "fs";
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

// Curated public samples. Sizes are fixed so we can skip re-download and reject
// truncated / LFS-pointer responses without hashing.
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
  // zlib DotZLib .NET binding help (widely mirrored)
  {
    name: "DotZLib.chm",
    url: "https://raw.githubusercontent.com/madler/zlib/develop/contrib/dotzlib/DotZLib.chm",
    size: 72726,
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
  // Large real-world SDK help for benchmarking (opt-in; ~43 MB)
  {
    name: "revit-api-2025.3.chm",
    url: "https://raw.githubusercontent.com/ADN-DevTech/revit-api-chms/main/2025.3.chm",
    size: 42884131,
    large: true,
  },
];

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
  /** Also fetch large SDK help files for benchmarking. */
  large?: boolean;
};

/**
 * Ensure testfiles/chm has the public sample corpus.
 * Returns the corpus directory path.
 */
export async function getDeps(opts: GetDepsOpts = {}): Promise<string> {
  mkdirSync(DEST, { recursive: true });

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
  -large   also fetch a large Revit API help CHM (~43 MB) for bench

Small set sources:
  https://github.com/mlocati/chm-lib          (main/second/putty)
  https://github.com/madler/zlib             (DotZLib.chm)
  https://github.com/sumatrapdfreader/sumatrapdf  (issue-chm-lzx.chm)
  https://github.com/mattslay/Visual-FoxPro-Toolkit-for-.NET

Large:
  https://github.com/ADN-DevTech/revit-api-chms  (2025.3.chm)
`);
    process.exit(0);
  }
  await getDeps({ force, large });
  console.log("deps ready (vendored test/CHMLib + public testfiles/chm corpus)");
}
