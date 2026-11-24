// fuzz-afl.ts -- coverage-guided fuzzing with AFL++ (macOS / Linux).
//
//   bun cmd/fuzz-afl.ts                  build, seed if needed, afl-fuzz until killed
//   bun cmd/fuzz-afl.ts -target lzx      the LZX decoder on its own
//   bun cmd/fuzz-afl.ts -jobs 4          1 main + 3 secondary instances
//   bun cmd/fuzz-afl.ts -V 60            stop after 60 seconds
//   bun cmd/fuzz-afl.ts -import          copy AFL queue/crashes into the shared corpus
//   bun cmd/fuzz-afl.ts -repro FILE      replay one artifact with the AFL harness
//
// A second engine next to libFuzzer. CmpLog on the main instance solves the
// comparisons (ITSF, PMGL, LZXC) that bit flips miss. Both engines share
// fuzz/corpus and fuzz/corpus-lzx. AFL state is fuzz/afl-out[-lzx]/ (gitignored).
// On exit, new queue entries and crashes are copied back into those shared dirs.
//
// Install: macOS `brew install afl++`, Debian/Ubuntu `sudo apt install afl++`.
// macOS once per machine (raises SysV shm; needs root): sudo afl-system-config
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  aflTool,
  buildAflFuzz,
  isFuzzTarget,
  isMac,
  isWindows,
  type FuzzTarget,
} from "./build-fuzz";
import { seedDocCorpus, seedLzxCorpus } from "./fuzz-seeds";

const ROOT = resolve(import.meta.dir, "..");
const FUZZ = join(ROOT, "fuzz");
const SEED_DIR = join(ROOT, "testfiles", "chm");

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
    `usage: bun cmd/fuzz-afl.ts [options]
  (no args)      build, seed if the corpus is empty, afl-fuzz until killed
  -target T      doc (default) or lzx
  -jobs N        parallel instances sharing -o (1 main + N-1 secondaries)
  -max-len N     max input size (default 1000000 doc, 262144 lzx; AFL -G)
  -repro FILE    replay one artifact with the AFL harness and exit
  -import        merge AFL queue → shared corpus and AFL crashes → fuzz/crashes
  -no-cmplog     do not build / use the CmpLog binary
  -V SEC         stop after SEC seconds (afl-fuzz -V)
  -clean         force a rebuild of the AFL harness
  -h, --help

Corpus is shared with bun cmd/fuzz.ts. AFL state is fuzz/afl-out[-lzx]/.
On macOS, once: sudo afl-system-config
`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let jobs = 1;
let targetArg = "";
let maxLenArg = 0;
let noCmplog = false;
let repro = "";
let doImport = false;
let timeLimitSec = 0;
let clean = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-jobs") jobs = intArg(args[++i], "-jobs");
  else if (a === "-target") targetArg = args[++i] ?? usage();
  else if (a === "-no-cmplog") noCmplog = true;
  else if (a === "-max-len") maxLenArg = intArg(args[++i], "-max-len");
  else if (a === "-repro") repro = args[++i] ?? usage();
  else if (a === "-import") doImport = true;
  else if (a === "-V") timeLimitSec = intArg(args[++i], "-V");
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

if (isWindows) {
  console.error("AFL++ fuzzing is for macOS and Linux. On Windows use: bun cmd/fuzz.ts");
  process.exit(2);
}
if (targetArg && !isFuzzTarget(targetArg)) {
  console.error(`unknown target "${targetArg}"`);
  usage();
}
const target: FuzzTarget = targetArg ? (targetArg as FuzzTarget) : "doc";
const CORPUS = corpusDir(target);
const CRASHES = crashDir(target);
const AFL_OUT = join(FUZZ, target === "doc" ? "afl-out" : "afl-out-lzx");
const maxLen = maxLenArg || (target === "doc" ? 1_000_000 : 262_144);

function requireTool(name: string): string {
  const p = aflTool(name);
  if (!p) {
    console.error(`${name} not found. macOS: brew install afl++; Debian/Ubuntu: sudo apt install afl++`);
    process.exit(2);
  }
  return p;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    if (n.startsWith(".")) return false;
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

function aflInstanceDirs(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .map((n) => join(outDir, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "queue"));
      } catch {
        return false;
      }
    });
}

function importAflFindings(): { queue: number; crashes: number } {
  mkdirSync(CORPUS, { recursive: true });
  mkdirSync(CRASHES, { recursive: true });
  let queue = 0;
  let crashes = 0;
  for (const inst of aflInstanceDirs(AFL_OUT)) {
    for (const name of listFiles(join(inst, "queue"))) {
      if (name === "README.txt" || name.includes(",orig:")) continue;
      const data = readFileSync(join(inst, "queue", name));
      const hash = createHash("sha1").update(data).digest("hex").slice(0, 16);
      const dest = join(CORPUS, `afl-${hash}`);
      if (existsSync(dest)) continue;
      copyFileSync(join(inst, "queue", name), dest);
      queue++;
    }
    for (const name of listFiles(join(inst, "crashes"))) {
      if (name === "README.txt") continue;
      const data = readFileSync(join(inst, "crashes", name));
      const hash = createHash("sha1").update(data).digest("hex");
      const dest = join(CRASHES, `afl-${hash}`);
      if (existsSync(dest)) continue;
      copyFileSync(join(inst, "crashes", name), dest);
      crashes++;
    }
  }
  return { queue, crashes };
}

async function dumpMapSize(exe: string): Promise<number | null> {
  const proc = Bun.spawn([exe], {
    cwd: FUZZ,
    env: { ...process.env, AFL_DUMP_MAP_SIZE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const text = `${stdout}\n${stderr}`;
  const m = text.match(/^\s*(\d+)\s*$/m);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function macShmMax(): number | null {
  if (!isMac) return null;
  try {
    const r = Bun.spawnSync(["sysctl", "-n", "kern.sysv.shmmax"]);
    const n = Number.parseInt(r.stdout.toString().trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function baseAflEnv(mapSize: number | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.AFL_SKIP_CPUFREQ ??= "1";
  env.AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES ??= "1";
  env.AFL_AUTORESUME ??= "1";
  env.AFL_FAST_CAL ??= "1";
  env.ASAN_OPTIONS ??= "abort_on_error=1:detect_leaks=0:symbolize=0:allocator_may_return_null=1";
  env.UBSAN_OPTIONS ??= "halt_on_error=1:print_stacktrace=1";
  if (mapSize && !process.env.AFL_MAP_SIZE) env.AFL_MAP_SIZE = String(Math.max(mapSize + 1, 65536));
  return env;
}

async function runCapture(argv: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(argv, { cwd: FUZZ, env, stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

function seedIfEmpty(): void {
  mkdirSync(CORPUS, { recursive: true });
  if (readdirSync(CORPUS).length > 0) return;
  if (target === "lzx") {
    const n = seedLzxCorpus(CORPUS, SEED_DIR);
    console.log(`seeded corpus-lzx with ${n} frame input(s)`);
    return;
  }
  const n = seedDocCorpus(CORPUS, SEED_DIR, maxLen, false);
  if (n) console.log(`seeded corpus with ${n} file(s) from testfiles/chm`);
}

mkdirSync(CORPUS, { recursive: true });
mkdirSync(CRASHES, { recursive: true });
mkdirSync(AFL_OUT, { recursive: true });

// -import on its own merges AFL findings back into the shared corpus and exits.
// A fuzz run always merges on the way out, so -import -V 60 still fuzzes first.
if (doImport && timeLimitSec === 0 && !args.includes("-jobs")) {
  const r = importAflFindings();
  console.log(`imported ${r.queue} queue input(s) → ${CORPUS}, ${r.crashes} crash(es) → ${CRASHES}`);
  process.exit(0);
}

const exe = await buildAflFuzz({ target, clean });
const cmplogExe = noCmplog ? null : await buildAflFuzz({ target, clean, cmplog: true });

if (repro) {
  const path = resolve(repro);
  if (!existsSync(path)) {
    console.error(`no such file: ${path}`);
    process.exit(1);
  }
  console.log(`replaying ${path}`);
  process.exit(await runCapture([exe, path], baseAflEnv(null)));
}

seedIfEmpty();
if (readdirSync(CORPUS).length === 0) {
  console.error("corpus is empty; run bun cmd/get-deps.ts and retry");
  process.exit(1);
}

const mapSize = await dumpMapSize(exe);
if (mapSize) console.log(`AFL coverage map size: ${mapSize} bytes`);
const shmMax = macShmMax();
const needShm = (mapSize ?? 65536) + 1_000_000 + 4096;
if (shmMax !== null && needShm > shmMax) {
  console.error(
    `\nmacOS SysV shared-memory limit is too small for this target:\n` +
      `  kern.sysv.shmmax=${shmMax}  need≈${needShm}\n` +
      `Raise limits once (requires root):\n  sudo afl-system-config\n`,
  );
  process.exit(2);
}

const aflFuzz = requireTool("afl-fuzz");
const env = baseAflEnv(mapSize);
const beforeCrashes = new Set(listFiles(CRASHES));
process.on("SIGINT", () => {});

console.log(
  `AFL++ fuzzing ${target} (${jobs} ${jobs === 1 ? "instance" : "instances"}` +
    `${cmplogExe ? ", cmplog" : ""}); seeds=${CORPUS}\n  state=${AFL_OUT}\n` +
    `  Ctrl-C to stop; rerun to resume. Queue entries are merged back on exit.`,
);

function spawnAfl(role: "-M" | "-S", name: string, quiet: boolean): ReturnType<typeof Bun.spawn> {
  const resume = existsSync(join(AFL_OUT, name, "queue"));
  const dict = dictPath(target);
  const argv = [
    aflFuzz,
    "-i",
    resume ? "-" : CORPUS,
    "-o",
    AFL_OUT,
    role,
    name,
    "-G",
    String(maxLen),
    ...(existsSync(dict) ? ["-x", dict] : []),
    ...(role === "-M" && cmplogExe ? ["-c", cmplogExe] : []),
    "-t",
    target === "lzx" ? "1000" : "5000",
    "-m",
    "none",
    ...(timeLimitSec > 0 ? ["-V", String(timeLimitSec)] : []),
    "--",
    exe,
  ];
  return Bun.spawn(argv, {
    cwd: FUZZ,
    env: quiet ? { ...env, AFL_NO_UI: "1" } : env,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
}

const children: ReturnType<typeof Bun.spawn>[] = [];
children.push(spawnAfl("-M", "main", false));
for (let j = 1; j < jobs; j++) {
  children.push(spawnAfl("-S", `secondary-${String(j).padStart(2, "0")}`, true));
}
const codes = await Promise.all(children.map((c) => c.exited));
const rc = codes.find((c) => c !== 0) ?? 0;

const imported = importAflFindings();
if (imported.queue > 0 || imported.crashes > 0) {
  console.log(`\nmerged into shared dirs: ${imported.queue} corpus input(s), ${imported.crashes} crash(es)`);
}
const fresh = listFiles(CRASHES).filter((f) => !beforeCrashes.has(f));
if (fresh.length > 0) {
  console.log(`\n${fresh.length} new crash artifact(s) in ${CRASHES}:`);
  for (const f of fresh) {
    console.log(`  ${f}`);
    console.log(`    reproduce: bun cmd/fuzz.ts -target ${target} -repro ${join(CRASHES, f)}`);
  }
  process.exit(1);
}
process.exit(rc);
