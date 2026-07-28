// bench.ts -- benchmark chmdec against vendored CHMLib (whole-file extract).
//
//   bun cmd/bench.ts <file.chm ... | -rand N | -all>
//   bun cmd/bench.ts -list-files
//
// Builds our-dump + chmlib-dump, then for each file runs both with -bench:
// load .chm into memory, open, extract every entry, close (best of 3 sessions
// per side). Compact default line (djvudec-style):
//
//   chmlib   chmdec     diff    %diff file
//    62.50    34.20   -28.30   -45.3% path/to/file.chm : 2,639,774 bytes
//
// (+ = chmdec slower). With no selection prints usage + corpus file count.
import { isAbsolute, relative } from "path";
import { statSync } from "fs";
import {
  CORPUS_DIR,
  ROOT,
  buildDumpers,
  corpusFiles,
  corpusSummary,
  fmtBytesExact,
  selectFiles,
} from "./chm-common";
import { getDeps } from "./get-deps";

/** Path relative to corpus dir + exact size: `main.chm : 49,749 bytes`. */
function benchLabel(f: string): string {
  let rel = relative(CORPUS_DIR, f);
  if (rel.startsWith("..") || isAbsolute(rel)) rel = f;
  rel = rel.replaceAll("\\", "/");
  return `${rel} : ${fmtBytesExact(statSync(f).size)} bytes`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60_000);
  const s = Math.floor((total % 60_000) / 1_000);
  const rem = total % 1_000;
  const parts: string[] = [];
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  if (rem || parts.length === 0) parts.push(`${rem}ms`);
  return parts.join(" ");
}

function fmtMs(n: number | null): string {
  return n === null ? "ERROR" : n.toFixed(2);
}

function fmtDiff(ours: number | null, lib: number | null): string {
  if (ours === null || lib === null) return "ERROR";
  return `${ours - lib >= 0 ? "+" : ""}${(ours - lib).toFixed(2)}`;
}

function fmtPct(ours: number | null, lib: number | null): string {
  if (ours === null || lib === null) return "ERROR";
  if (lib > 0) {
    const p = ((ours - lib) / lib) * 100;
    return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
  }
  return "0.0%";
}

// Compact default line: 4× 8-char right-aligned number columns, then file.
const col = (s: string) => s.padStart(8);
function printCompactLine(
  lib: string,
  ours: string,
  diff: string,
  pct: string,
  label: string,
): void {
  console.log(`${col(lib)} ${col(ours)} ${col(diff)} ${col(pct)} ${label}`);
}

function parseTotalMs(stdout: string): number | null {
  const m = stdout.match(/total_ms=([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function runBench(exe: string, file: string): number | null {
  const r = Bun.spawnSync({
    cmd: [exe, "-bench", file],
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
  if (r.exitCode !== 0) return null;
  return parseTotalMs(out);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Ensure testfiles/chm exists before -list-files / -all / -rand read the corpus.
  await getDeps();

  if (argv.includes("-list-files")) {
    const all = corpusFiles();
    for (const f of all) console.log(benchLabel(f));
    console.log(`\n${all.length} file(s)`);
    process.exit(0);
  }

  const files = selectFiles(
    `usage: bun cmd/bench.ts <selection> [options]
selection (required; default prints this help):
  file.chm ...   bench the given files (or a directory of .chm files)
  -rand N         bench N randomly selected corpus files
  -all            bench every corpus file
  -list-files     list corpus files (path, size) and exit

Corpus: recursive .chm under testfiles/chm (gitignored), or CHM_SPECS=dir.
Session: open from memory, extract every entry, close. Best-of-3 each side.
Default line: chmlib chmdec diff %diff file  (+ = chmdec slower).

${corpusSummary()}`,
  );

  const dumpers = await buildDumpers();
  const t0 = performance.now();
  let rc = 0;
  let nOk = 0;
  let nFail = 0;

  printCompactLine("chmlib", "chmdec", "diff", "%diff", "file");

  const ROUNDS = 3;
  const bestOf = (times: (number | null)[]): number | null => {
    let best: number | null = null;
    for (const t of times) {
      if (t === null) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  };

  for (const file of files) {
    const label = benchLabel(file);
    // Interleave so a machine-load swing can't hit only one side.
    const oursRuns: (number | null)[] = [];
    const libRuns: (number | null)[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      oursRuns.push(runBench(dumpers.ours, file));
      libRuns.push(runBench(dumpers.chmlib, file));
    }
    const ours = bestOf(oursRuns);
    const lib = bestOf(libRuns);

    if (ours === null || lib === null) {
      printCompactLine(
        fmtMs(lib),
        fmtMs(ours),
        "ERROR",
        "ERROR",
        label,
      );
      nFail++;
      rc = 1;
      continue;
    }

    printCompactLine(
      fmtMs(lib),
      fmtMs(ours),
      fmtDiff(ours, lib),
      fmtPct(ours, lib),
      label,
    );
    nOk++;
  }

  console.log(`elapsed ${formatElapsed(performance.now() - t0)}`);
  if (files.length > 1) {
    console.log(`bench summary: ok=${nOk} fail=${nFail}`);
  }
  process.exit(rc);
}

if (import.meta.main) await main();
