// chm-info.ts -- list CHM entries using chmdec or upstream CHMLib.
import { buildDumpers, findChmFiles, flagsText, readDump } from "./chm-common";

function usage(): never {
  console.error("usage: bun cmd/chm-info.ts [-chmlib] <file.chm|directory>");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let useChmLib = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "-chmlib" || arg === "--chmlib") {
      useChmLib = true;
    } else {
      paths.push(arg);
    }
  }
  if (paths.length !== 1) usage();

  const files = findChmFiles(paths[0]);
  const dumpers = await buildDumpers();
  const exe = useChmLib ? dumpers.chmlib : dumpers.ours;
  let failed = 0;

  for (const file of files) {
    try {
      const dump = await readDump(exe, file, false);
      console.log(`${file}: ${dump.entries.length} entries (${useChmLib ? "chmlib" : "ours"})`);
      const entries = [...dump.entries].sort((a, b) => a.path.localeCompare(b.path));
      for (const entry of entries) {
        const start = entry.start.toString().padStart(10);
        const length = entry.length.toString().padStart(10);
        console.log(`  ${start} ${length} ${flagsText(entry.flags).padEnd(24)} ${entry.path}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${file}`);
      console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed > 0) process.exit(1);
}

await main();
