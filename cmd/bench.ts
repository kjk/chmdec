// bench.ts -- benchmark chmdec against vendored CHMLib (whole-file extract).
//
//   bun cmd/bench.ts <file.chm ... | -rand N | -all>
//   bun cmd/bench.ts -list-files
//
// Builds our-dump + chmlib-dump, then for each file runs both with -bench:
// load .chm into memory, open, extract every entry, close (best of 3 sessions
// per side). Default output: directory header lines (e.g. testfiles/chm), then
//   chmlib   chmdec     diff    %diff basename.chm : 2,639,774 bytes
// (+ = chmdec slower). Last data line is sum of fastest times, label "total".
// With no selection prints usage + corpus file count.
import { basename, dirname, isAbsolute, relative } from "path";
import { statSync } from "fs";
import {
  ROOT,
  buildDumpers,
  corpusFiles,
  corpusSummary,
  fmtBytesExact,
  selectFiles,
} from "./chm-common";
import { getDeps } from "./get-deps";

/** Path relative to repo root when possible (forward slashes). */
function fileRel(f: string): string {
  let rel = relative(ROOT, f);
  if (rel.startsWith("..") || isAbsolute(rel)) rel = f;
  return rel.replaceAll("\\", "/");
}

/** Basename + size for compact lines under a directory header. */
function fileNameLabel(f: string): string {
  return `${basename(f)} : ${fmtBytesExact(statSync(f).size)} bytes`;
}

/** Print dir once when it changes; return basename(+size) for the line. */
function enterDirAndName(
  file: string,
  lastDir: { value: string },
): string {
  const rel = fileRel(file);
  const dir = dirname(rel).replaceAll("\\", "/");
  if (dir !== lastDir.value) {
    console.log(dir);
    lastDir.value = dir;
  }
  try {
    return fileNameLabel(file);
  } catch {
    return basename(file);
  }
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
    const lastDir = { value: "" };
    for (const f of all) console.log(enterDirAndName(f, lastDir));
    console.log(`\n${all.length} file(s)`);
    process.exit(0);
  }

  const files = selectFiles(
    `usage: bun cmd/bench.ts <selection> [options]
selection (required; default prints this help):
  file.chm ...   bench the given files (or a directory of .chm files)
  -rand N         bench N randomly selected corpus files
  -all            bench every corpus file
  -list-files     list corpus dirs + basenames (with size) and exit

Corpus: recursive .chm under testfiles/chm (gitignored), or CHM_SPECS=dir.
Session: open from memory, extract every entry, close. Best-of-3 each side.
Default: dir headers, then chmlib chmdec diff %diff basename  (+ = chmdec slower);
  ends with a "total" line (sum of fastest chmdec vs sum of fastest chmlib).

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

  let sumOurs = 0;
  let sumLib = 0;

  const lastDir = { value: "" };
  for (const file of files) {
    const nameLabel = enterDirAndName(file, lastDir);
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
        nameLabel,
      );
      nFail++;
      rc = 1;
      continue;
    }

    sumOurs += ours;
    sumLib += lib;

    printCompactLine(
      fmtMs(lib),
      fmtMs(ours),
      fmtDiff(ours, lib),
      fmtPct(ours, lib),
      nameLabel,
    );
    nOk++;
  }

  if (nOk > 0) {
    printCompactLine(
      fmtMs(sumLib),
      fmtMs(sumOurs),
      fmtDiff(sumOurs, sumLib),
      fmtPct(sumOurs, sumLib),
      "total",
    );
  }

  console.log(`elapsed ${formatElapsed(performance.now() - t0)}`);
  if (files.length > 1) {
    console.log(`bench summary: ok=${nOk} fail=${nFail}`);
  }
  process.exit(rc);
}

if (import.meta.main) await main();
