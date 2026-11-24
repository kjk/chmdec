// fuzz.ts -- coverage-guided fuzzing of the CHM reader (libFuzzer).
//
//   bun cmd/fuzz.ts                     whole files: build, seed, fuzz until killed
//   bun cmd/fuzz.ts -target lzx         the LZX decoder on its own (much faster)
//   bun cmd/fuzz.ts -jobs 8             parallel workers sharing the corpus
//   bun cmd/fuzz.ts -time 60            stop after 60 seconds
//   bun cmd/fuzz.ts -repro FILE         replay one artifact and exit
//   bun cmd/fuzz.ts -check-crashes      replay fuzz/crashes (CI)
//   bun cmd/fuzz.ts -coverage           which src/ code the corpus never reaches
//   bun cmd/fuzz.ts -msan               MemorySanitizer instead of ASan (Linux)
//
// Targets:
//   doc   whole file through the public API, with an ITSF-aware mutator
//         (test/fuzz_mutator.c) and fuzz/chm.dict. Corpus: fuzz/corpus.
//         Crashes: fuzz/crashes (tracked).
//   lzx   raw LZX frames (test/fuzz_lzx.c) cut from real CHMs. Corpus:
//         fuzz/corpus-lzx. Crashes: fuzz/crashes/lzx.
//
// Sanitizers: ASan everywhere. UBSan as well on Linux and macOS, and a
// finding aborts so libFuzzer saves it (-no-ubsan leaves it out; Windows
// stays ASan-only). -msan builds MemorySanitizer instead (Linux).
//
// The corpus directory is the checkpoint: Ctrl-C to stop, run again to
// resume. AFL++ (bun cmd/fuzz-afl.ts) shares these corpora.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import {
  buildFuzz,
  findLlvmTool,
  fuzzExe,
  isFuzzTarget,
  isWindows,
  FUZZ_TARGETS,
  type FuzzBuildOpts,
  type FuzzTarget,
} from "./build-fuzz";
import { seedDocCorpus, seedLzxCorpus } from "./fuzz-seeds";

const ROOT = resolve(import.meta.dir, "..");
const FUZZ = join(ROOT, "fuzz");
const SEED_DIR = join(ROOT, "testfiles", "chm");

const DEFAULT_MAX: Record<FuzzTarget, number> = { doc: 4_000_000, lzx: 262_144 };
const TIMEOUT: Record<FuzzTarget, number> = { doc: 25, lzx: 10 };

function corpusDir(t: FuzzTarget): string {
  return join(FUZZ, t === "doc" ? "corpus" : "corpus-lzx");
}
function crashDir(t: FuzzTarget): string {
  return join(FUZZ, t === "doc" ? "crashes" : join("crashes", "lzx"));
}
function dictPath(t: FuzzTarget): string {
  return join(FUZZ, t === "doc" ? "chm.dict" : "lzx.dict");
}

function usage(): never {
  console.error(
    `usage: bun cmd/fuzz.ts [options]
  (no args)      doc target: build, seed corpus if empty, fuzz until killed
  -target T      doc (default, whole file) | lzx (LZX decoder only)
  -jobs N        run N parallel workers sharing the corpus
  -time SEC      stop after SEC seconds
  -runs N        stop after N inputs
  -max-len N     max input size (default ${DEFAULT_MAX.doc} for doc, ${DEFAULT_MAX.lzx} for lzx)
  -repro FILE    replay one artifact and exit (target from -target, or from
                 fuzz/crashes/lzx/ in the path)
  -check-crashes replay tracked artifacts under the sanitizer (CI). With no
                 -target, every target that has any.
  -minimize      shrink the corpus to a minimal covering set
  -coverage      replay the corpus on a coverage build; report src/ gaps
  -msan          MemorySanitizer instead of ASan (Linux)
  -ubsan         UBSan on (default on Linux/macOS)   -no-ubsan  leave it out
  -no-mutator    plain libFuzzer mutations only (doc target)
  -reseed        add seeds again (lzx: rewrite from testfiles/chm)
  -clean         wipe the corpus before seeding
  -h, --help`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let targetArg = "";
let jobs = 1;
let maxLenArg = 0;
let timeSec = 0;
let runs = 0;
let repro = "";
let checkCrashes = false;
let minimize = false;
let coverage = false;
let msan = false;
let ubsan = !isWindows;
let noMutator = false;
let reseed = false;
let clean = false;

if (process.env.CHM_FUZZ_UBSAN === "0" || process.env.CHM_FUZZ_UBSAN === "false") ubsan = false;
if (process.env.CHM_FUZZ_UBSAN === "1" || process.env.CHM_FUZZ_UBSAN === "true") ubsan = true;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-target") targetArg = args[++i] ?? usage();
  else if (a === "-jobs") jobs = intArg(args[++i], "-jobs");
  else if (a === "-max-len") maxLenArg = intArg(args[++i], "-max-len");
  else if (a === "-time") timeSec = intArg(args[++i], "-time");
  else if (a === "-runs") runs = intArg(args[++i], "-runs");
  else if (a === "-repro") repro = args[++i] ?? usage();
  else if (a === "-check-crashes") checkCrashes = true;
  else if (a === "-minimize") minimize = true;
  else if (a === "-coverage") coverage = true;
  else if (a === "-msan") msan = true;
  else if (a === "-ubsan") ubsan = true;
  else if (a === "-no-ubsan") ubsan = false;
  else if (a === "-no-mutator") noMutator = true;
  else if (a === "-reseed") reseed = true;
  else if (a === "-clean") clean = true;
  else if (a === "-h" || a === "--help") usage();
  else usage();
}

function intArg(v: string | undefined, name: string): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`${name} requires a positive integer`);
    process.exit(2);
  }
  return n;
}

if (targetArg && !isFuzzTarget(targetArg)) {
  console.error(`unknown target "${targetArg}" (have: ${FUZZ_TARGETS.join(" ")})`);
  process.exit(2);
}
if (msan && process.platform !== "linux") {
  console.error("-msan needs Linux (clang has no MemorySanitizer on Windows/macOS)");
  process.exit(2);
}
if (ubsan && isWindows) {
  console.error("-ubsan is not supported on Windows");
  process.exit(2);
}

function targetOfRepro(path: string): FuzzTarget {
  if (targetArg) return targetArg as FuzzTarget;
  const parts = path.split(/[/\\]/);
  const i = parts.lastIndexOf("crashes");
  if (i >= 0 && parts[i + 1] === "lzx") return "lzx";
  return "doc";
}

const target: FuzzTarget = targetArg ? (targetArg as FuzzTarget) : "doc";
const maxLen = maxLenArg || DEFAULT_MAX[target];

function buildOpts(t: FuzzTarget, extra: FuzzBuildOpts = {}): FuzzBuildOpts {
  return {
    target: t,
    sanitizer: msan ? "msan" : "asan",
    ubsan: extra.coverage ? false : ubsan,
    ...extra,
  };
}

function fuzzEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const symbolizer = findLlvmTool("llvm-symbolizer");
  if (symbolizer) {
    env.ASAN_SYMBOLIZER_PATH ??= symbolizer;
    env.MSAN_SYMBOLIZER_PATH ??= symbolizer;
    env.UBSAN_SYMBOLIZER_PATH ??= symbolizer;
  }
  env.UBSAN_OPTIONS ??= "print_stacktrace=1:halt_on_error=1";
  if (noMutator) env.CHM_FUZZ_NO_MUTATOR = "1";
  return env;
}

async function run(exe: string, argv: string[], cwd = FUZZ): Promise<number> {
  const proc = Bun.spawn([exe, ...argv], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: fuzzEnv(),
  });
  return await proc.exited;
}

async function runCapture(argv: string[], env?: Record<string, string | undefined>): Promise<{ rc: number; out: string }> {
  const proc = Bun.spawn(argv, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "inherit",
    env: env ?? fuzzEnv(),
  });
  const out = await new Response(proc.stdout).text();
  return { rc: await proc.exited, out };
}

function listCrashFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .map((name) => join(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function crashGroups(t: FuzzTarget | "all"): { target: FuzzTarget; files: string[] }[] {
  const targets: FuzzTarget[] = t === "all" ? ["doc", "lzx"] : [t];
  return targets
    .map((target) => ({ target, files: listCrashFiles(crashDir(target)) }))
    .filter((g) => g.files.length > 0);
}

// -repro
if (repro) {
  const path = resolve(repro);
  if (!existsSync(path)) {
    console.error(`no such file: ${path}`);
    process.exit(1);
  }
  const t = targetOfRepro(path);
  const exe = await buildFuzz(buildOpts(t));
  console.log(`replaying ${path} on ${t}`);
  process.exit(await run(exe, [path], dirname(path)));
}

// -check-crashes: every tracked artifact must exit 0.
if (checkCrashes) {
  const groups = crashGroups(targetArg ? target : "all");
  if (groups.length === 0) {
    console.log("no artifacts in fuzz/crashes — nothing to check");
    process.exit(0);
  }
  let fail = 0;
  let total = 0;
  for (const g of groups) {
    const exe = await buildFuzz(buildOpts(g.target));
    console.log(`checking ${g.files.length} ${g.target} artifact(s)...`);
    for (const path of g.files) {
      total++;
      const rc = await run(exe, [path]);
      if (rc !== 0) {
        fail++;
        console.error(`[fail] ${basename(path)} exit=${rc}`);
      } else {
        console.log(`[ok] ${g.target} ${basename(path)}`);
      }
    }
  }
  if (fail) {
    console.error(`${fail}/${total} artifact(s) still crash`);
    process.exit(1);
  }
  console.log(`check-crashes: ${total} ok`);
  process.exit(0);
}

const CORPUS = corpusDir(target);
const CRASHES = crashDir(target);
mkdirSync(CORPUS, { recursive: true });
mkdirSync(CRASHES, { recursive: true });

if (clean) {
  rmSync(CORPUS, { recursive: true, force: true });
  mkdirSync(CORPUS, { recursive: true });
}

function seedIfNeeded(): void {
  const empty = readdirSync(CORPUS).length === 0;
  if (!empty && !reseed) return;
  if (target === "lzx") {
    const n = seedLzxCorpus(CORPUS, SEED_DIR);
    console.log(`seeded corpus-lzx with ${n} new frame input(s) from testfiles/chm`);
    return;
  }
  const n = seedDocCorpus(CORPUS, SEED_DIR, maxLen, reseed);
  if (n) console.log(`seeded corpus with ${n} file(s) from testfiles/chm`);
}

async function runCoverage(): Promise<never> {
  const profdata = findLlvmTool("llvm-profdata");
  const cov = findLlvmTool("llvm-cov");
  if (!profdata || !cov) {
    console.error("llvm-profdata / llvm-cov not found (they ship next to the fuzz clang)");
    process.exit(2);
  }
  seedIfNeeded();
  const exe = await buildFuzz(buildOpts(target, { coverage: true }));
  const dir = join(ROOT, "out", "fuzz", "cov");
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, `${target}.profraw`);
  const merged = join(dir, `${target}.profdata`);
  rmSync(raw, { force: true });
  console.log(`running ${readdirSync(CORPUS).length} corpus input(s) for coverage...`);
  const proc = Bun.spawn(
    [exe, CORPUS, "-runs=0", "-rss_limit_mb=4096", `-timeout=${TIMEOUT[target]}`],
    {
      cwd: FUZZ,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...fuzzEnv(), LLVM_PROFILE_FILE: raw },
    },
  );
  const rc = await proc.exited;
  if (rc !== 0 || !existsSync(raw)) {
    console.error(`coverage run failed (exit ${rc})`);
    process.exit(1);
  }
  await runCapture([profdata, "merge", "-sparse", raw, "-o", merged]);
  const srcDir = join(ROOT, "src");
  const report = await runCapture([cov, "report", exe, `-instr-profile=${merged}`, srcDir]);
  console.log(report.out);
  const html = join(dir, `${target}-html`);
  await runCapture([
    cov, "show", exe, `-instr-profile=${merged}`, "-format=html",
    `-output-dir=${html}`, srcDir,
  ]);
  const exported = await runCapture([cov, "export", exe, `-instr-profile=${merged}`, srcDir]);
  try {
    type Fn = { name: string; count: number; filenames: string[] };
    const srcPrefix = srcDir.replaceAll("\\", "/") + "/";
    const fns = (JSON.parse(exported.out).data[0].functions as Fn[]).filter((f) => {
      const file = f.filenames[0]?.replaceAll("\\", "/") ?? "";
      return f.count === 0 && file.startsWith(srcPrefix) && file.endsWith(".c");
    });
    const byFile = new Map<string, Set<string>>();
    for (const f of fns) {
      const file = f.filenames[0]!.replaceAll("\\", "/").slice(srcPrefix.length);
      const name = f.name.includes(":") ? f.name.slice(f.name.indexOf(":") + 1) : f.name;
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file)!.add(name);
    }
    const total = [...byFile.values()].reduce((n, set) => n + set.size, 0);
    console.log(`${total} function(s) in src/*.c never entered by this corpus:`);
    for (const [file, names] of [...byFile].sort()) {
      console.log(`  ${file} (${names.size}): ${[...names].sort().join(", ")}`);
    }
  } catch {
    console.error("could not parse llvm-cov export output");
  }
  console.log(`line-by-line report: ${join(html, "index.html")}`);
  process.exit(0);
}

if (coverage) await runCoverage();

const exe = await buildFuzz(buildOpts(target));

if (minimize) {
  seedIfNeeded();
  const tmp = join(FUZZ, `corpus.min-${target}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log("minimizing corpus (libFuzzer -merge=1)...");
  const rc = await run(exe, ["-merge=1", `-max_len=${maxLen}`, tmp, CORPUS]);
  if (rc !== 0) {
    console.error(`merge failed (${rc}); leaving corpus untouched`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(rc);
  }
  const before = readdirSync(CORPUS).length;
  rmSync(CORPUS, { recursive: true, force: true });
  renameSync(tmp, CORPUS);
  const after = readdirSync(CORPUS).length;
  console.log(`corpus minimized: ${before} -> ${after} inputs`);
  process.exit(0);
}

seedIfNeeded();

const before = new Set(listCrashFiles(CRASHES));
process.on("SIGINT", () => {});

const dict = dictPath(target);
const logDir = join(FUZZ, "logs", target);
mkdirSync(logDir, { recursive: true });
const fuzzArgs = [
  CORPUS,
  `-artifact_prefix=${CRASHES}/`,
  `-max_len=${maxLen}`,
  ...(existsSync(dict) ? [`-dict=${dict}`] : []),
  "-rss_limit_mb=4096",
  `-timeout=${TIMEOUT[target]}`,
  `-report_slow_units=${target === "lzx" ? 5 : 20}`,
  "-print_final_stats=1",
  ...(timeSec ? [`-max_total_time=${timeSec}`] : []),
  ...(runs ? [`-runs=${runs}`] : []),
  ...(jobs > 1 ? [`-jobs=${jobs}`, `-workers=${jobs}`] : []),
];

const san = `${msan ? "msan" : "asan"}${ubsan ? "+ubsan" : ""}`;
console.log(
  `fuzzing ${target} (${jobs} ${jobs === 1 ? "process" : "workers"}, ${san}); corpus=${CORPUS}\n` +
    `  Ctrl-C to stop; rerun to resume.`,
);
const rc = await run(exe, fuzzArgs, logDir);
const fresh = listCrashFiles(CRASHES).filter((f) => !before.has(f));
if (fresh.length > 0) {
  console.log(`\n${fresh.length} new crash artifact(s) in ${CRASHES}:`);
  for (const f of fresh) {
    console.log(`  ${basename(f)}`);
    console.log(`    reproduce: bun cmd/fuzz.ts -target ${target} -repro ${f}`);
  }
}
if (rc !== 0) {
  console.log(`fuzzer exited with code ${rc}`);
  process.exit(rc);
}
