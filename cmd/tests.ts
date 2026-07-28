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
  console.log("all tests passed");
}

main();
