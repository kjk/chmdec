// fuzz.ts -- coverage-guided fuzzing of the chm reader (libFuzzer + ASan).
//
//   bun cmd/fuzz.ts                  build, seed corpus if empty, fuzz until killed
//   bun cmd/fuzz.ts -jobs 4          run N parallel workers
//   bun cmd/fuzz.ts -repro FILE      replay one crash artifact
//   bun cmd/fuzz.ts -check-crashes   replay every fuzz/crashes/* under ASan (CI)
//   bun cmd/fuzz.ts -minimize        shrink corpus via libFuzzer -merge=1
//
// The corpus directory (fuzz/corpus) IS the checkpoint: stop by killing the
// process, resume by running again. Crashes land in fuzz/crashes (tracked in
// git as regression seeds).
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { buildFuzz, FUZZ_EXE } from "./build-lib";

const ROOT = resolve(import.meta.dir, "..");
const FUZZ = join(ROOT, "fuzz");
const CORPUS = join(FUZZ, "corpus");
const CRASHES = join(FUZZ, "crashes");
const SEED_DIR = join(ROOT, "testfiles", "chm");

function usage(): never {
  console.error(
    `usage: bun cmd/fuzz.ts [options]
  (no args)      build, seed corpus if empty, fuzz until killed (resumes)
  -jobs N        run N parallel workers sharing the corpus
  -max-len N     max input size in bytes (default 4000000)
  -repro FILE    replay a single crash artifact and exit
  -check-crashes replay every fuzz/crashes artifact under ASan (CI regression)
  -minimize      shrink the corpus to a minimal covering set
  -clean         wipe corpus before seeding
  -h, --help`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let jobs = 1;
let maxLen = 4000000;
let repro = "";
let checkCrashes = false;
let minimize = false;
let clean = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-jobs") jobs = intArg(args[++i], "-jobs");
  else if (a === "-max-len") maxLen = intArg(args[++i], "-max-len");
  else if (a === "-repro") repro = args[++i] ?? usage();
  else if (a === "-check-crashes") checkCrashes = true;
  else if (a === "-minimize") minimize = true;
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

// Everything tracked under fuzz/crashes (libFuzzer crash/oom/timeout + named
// regression .chm seeds). Skip dotfiles only.
function listArtifacts(): string[] {
  if (!existsSync(CRASHES)) return [];
  return readdirSync(CRASHES).filter((name) => !name.startsWith("."));
}

async function run(argv: string[]): Promise<number> {
  const proc = Bun.spawn([FUZZ_EXE, ...argv], {
    cwd: FUZZ,
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

const exe = await buildFuzz(true); // always clean-build
void exe;

mkdirSync(CORPUS, { recursive: true });
mkdirSync(CRASHES, { recursive: true });

if (clean && existsSync(CORPUS)) {
  rmSync(CORPUS, { recursive: true, force: true });
  mkdirSync(CORPUS, { recursive: true });
}

// -repro: replay one artifact with a full stack trace, then exit.
if (repro) {
  const path = resolve(repro);
  if (!existsSync(path)) {
    console.error(`no such file: ${path}`);
    process.exit(1);
  }
  console.log(`replaying ${path}`);
  process.exit(await run([path]));
}

// -check-crashes: every tracked artifact must complete without ASan/libFuzzer
// crash (exit 0). Used by CI as a fixed regression suite.
if (checkCrashes) {
  const arts = listArtifacts();
  if (arts.length === 0) {
    console.log("no artifacts in fuzz/crashes — nothing to check");
    process.exit(0);
  }
  let fail = 0;
  console.log(`checking ${arts.length} fuzz/crashes artifact(s) under ASan...`);
  for (const name of arts) {
    const path = join(CRASHES, name);
    const rc = await run([path]);
    if (rc !== 0) {
      fail++;
      console.error(`[fail] ${name} exit=${rc}`);
    } else {
      console.log(`[ok] ${name}`);
    }
  }
  if (fail) {
    console.error(`${fail}/${arts.length} artifact(s) still crash`);
    process.exit(1);
  }
  console.log(`check-crashes: ${arts.length} ok`);
  process.exit(0);
}

// -minimize: merge the corpus into a fresh minimal covering set, then swap.
if (minimize) {
  const tmp = join(FUZZ, "corpus.min");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  console.log("minimizing corpus (libFuzzer -merge=1)...");
  const rc = await run(["-merge=1", "corpus.min", "corpus"]);
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

// First run: seed the (empty) corpus with real .chm files from testfiles/chm.
if (readdirSync(CORPUS).length === 0 && existsSync(SEED_DIR)) {
  let n = 0;
  for (const f of readdirSync(SEED_DIR)) {
    if (!f.toLowerCase().endsWith(".chm")) continue;
    copyFileSync(join(SEED_DIR, f), join(CORPUS, f));
    n++;
  }
  if (n) console.log(`seeded corpus with ${n} file(s) from testfiles/chm`);
}

const fuzzArgs = [
  "corpus",
  "-artifact_prefix=crashes/",
  `-max_len=${maxLen}`,
  "-rss_limit_mb=4096",
  "-timeout=25",
  "-print_final_stats=1",
  ...(jobs > 1 ? [`-jobs=${jobs}`, `-workers=${jobs}`] : []),
];

console.log(`starting fuzzer (${FUZZ_EXE}); Ctrl-C to stop, rerun to resume`);
const p = await $`${FUZZ_EXE} ${fuzzArgs}`.cwd(FUZZ).nothrow();
if (p.exitCode !== 0) {
  console.log(`fuzzer exited with code ${p.exitCode}`);
  console.log(`check ${CRASHES} for new crash files`);
  process.exit(p.exitCode ?? 1);
}
