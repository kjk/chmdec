// tests.ts -- smoke tests for chm.
import { $ } from "bun";
import { build } from "./build";
import { readdirSync } from "fs";
import { join } from "path";
import { getDeps } from "./get-deps";

const ROOT = `${import.meta.dir}/..`;

async function main() {
  const corpusDir = await getDeps();
  const exe = await build(true);
  const files = readdirSync(corpusDir).filter(f => f.toLowerCase().endsWith(".chm"));
  if (files.length === 0) {
    console.error("no .chm files under testfiles/chm (run: bun cmd/get-deps.ts)");
    process.exit(1);
  }
  const wrap = await $`${exe} -lzx-wrap`.cwd(ROOT).nothrow();
  if (wrap.exitCode !== 0) {
    console.error(wrap.stderr.toString());
    console.error("FAIL lzx-wrap");
    process.exit(1);
  }
  console.log("OK lzx-wrap");

  console.log(`testing ${files.length} chm files`);
  let passed = 0, failed = 0;
  for (const f of files) {
    const p = join(corpusDir, f);
    const out = await $`${exe} -list ${p}`.quiet().cwd(ROOT).nothrow();
    if (out.exitCode !== 0) {
      console.error("FAIL", f);
      failed++;
    } else {
      console.log("OK", f);
      passed++;
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  // Reusing a ctx: open a, read, close, open b on the same ctx; b's entries
  // must read the same as on a fresh ctx. Each file is paired with the next
  // one; exit code 2 means the pair can't exercise the case (different LZX
  // window or no entry in blocks 1..reset-1).
  let reuseOk = 0, reuseFail = 0;
  for (let i = 0; i < files.length; i++) {
    const a = join(corpusDir, files[i]!);
    const b = join(corpusDir, files[(i + 1) % files.length]!);
    if (a === b) continue;
    const out = await $`${exe} -reuse ${a} ${b}`.quiet().cwd(ROOT).nothrow();
    if (out.exitCode === 1) {
      console.error(out.stderr.toString().trim());
      console.error("FAIL reuse", files[i], "->", files[(i + 1) % files.length]);
      reuseFail++;
    } else if (out.exitCode === 0) {
      reuseOk++;
    }
  }
  console.log(`reuse ctx: ${reuseOk} pairs passed, ${reuseFail} failed`);
  if (reuseFail > 0) process.exit(1);
  if (reuseOk === 0) {
    console.error("FAIL reuse: no file pair in the corpus exercises it");
    process.exit(1);
  }
  console.log("all tests passed");
}

main();
