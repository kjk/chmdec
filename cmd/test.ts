// test.ts -- compare chmdec extraction against upstream CHMLib.
import { buildDumpers, findChmFiles, readDump, type ChmDump, type ChmDumpEntry } from "./chm-common";

type DumpResult = { ok: true; dump: ChmDump } | { ok: false; error: string };

async function tryDump(exe: string, file: string): Promise<DumpResult> {
  try {
    return { ok: true, dump: await readDump(exe, file) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function usage(): never {
  console.error("usage: bun cmd/test.ts [-rand N] <file.chm|directory>");
  process.exit(2);
}

// Randomly pick n files from the list (Fisher-Yates partial shuffle).
function pickRandom<T>(items: T[], n: number): T[] {
  const arr = items.slice();
  const count = Math.min(n, arr.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count);
}

function entryMap(entries: ChmDumpEntry[], label: string): Map<string, ChmDumpEntry> {
  const map = new Map<string, ChmDumpEntry>();
  for (const entry of entries) {
    if (map.has(entry.path)) throw new Error(`${label} has duplicate entry: ${entry.path}`);
    map.set(entry.path, entry);
  }
  return map;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function compareEntries(ours: ChmDumpEntry[], theirs: ChmDumpEntry[]): string[] {
  const errors: string[] = [];
  const ourMap = entryMap(ours, "ours");
  const chmLibMap = entryMap(theirs, "chmlib");
  const allPaths = Array.from(new Set([...ourMap.keys(), ...chmLibMap.keys()])).sort();

  for (const path of allPaths) {
    const a = ourMap.get(path);
    const b = chmLibMap.get(path);
    if (!a) {
      errors.push(`missing from ours: ${path}`);
      continue;
    }
    if (!b) {
      errors.push(`extra in ours: ${path}`);
      continue;
    }
    if (a.start !== b.start) errors.push(`${path}: start ours=${a.start} chmlib=${b.start}`);
    if (a.length !== b.length) errors.push(`${path}: length ours=${a.length} chmlib=${b.length}`);
    if (a.flags !== b.flags) errors.push(`${path}: flags ours=${a.flags} chmlib=${b.flags}`);
    // chmlib is the oracle for readability per-entry too: if it could read the
    // entry but we couldn't, that's a regression; if the bytes differ, that's
    // corruption. Entries both fail to read (or that only chmlib fails) are fine.
    if (b.readOk && !a.readOk) {
      errors.push(`${path}: content unreadable by ours but chmlib read it (${b.data.length} bytes)`);
    } else if (a.readOk && b.readOk && !sameBytes(a.data, b.data)) {
      errors.push(`${path}: content differs (${a.data.length} vs ${b.data.length} bytes)`);
    }
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);

  let rand = 0;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-rand") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n <= 0) usage();
      rand = n;
    } else {
      rest.push(args[i]);
    }
  }
  if (rest.length !== 1) usage();

  let files = findChmFiles(rest[0]);
  if (files.length === 0) {
    console.log("no .chm files found");
    return;
  }
  if (rand > 0) {
    files = pickRandom(files, rand).sort((a, b) => a.localeCompare(b));
    console.log(`picked ${files.length} random file${files.length === 1 ? "" : "s"}`);
  }

  const dumpers = await buildDumpers();
  console.log(`comparing ${files.length} chm file${files.length === 1 ? "" : "s"}`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let better = 0;
  for (const file of files) {
    const [ours, chmlib] = await Promise.all([
      tryDump(dumpers.ours, file),
      tryDump(dumpers.chmlib, file),
    ]);

    // chmlib is the oracle only for *readability*. If both fail to read the
    // file, our failing to read it is acceptable.
    if (!ours.ok && !chmlib.ok) {
      console.log(`SKIP ${file} (both fail: ${ours.error})`);
      skipped++;
      continue;
    }
    // Only ours failing where chmlib succeeds is a regression. The reverse
    // (we read a file chmlib chokes on) means we are strictly more robust, not
    // that we are wrong, so it is not a failure.
    if (!ours.ok) {
      console.error(`FAIL ${file}`);
      console.error(`  ours failed but chmlib succeeded: ${ours.error}`);
      failed++;
      continue;
    }
    if (!chmlib.ok) {
      console.log(`BETTER ${file} (ours ok; chmlib failed: ${(chmlib as { error: string }).error})`);
      better++;
      continue;
    }

    const errors = compareEntries((ours as { dump: ChmDump }).dump.entries, (chmlib as { dump: ChmDump }).dump.entries);
    if (errors.length === 0) {
      console.log(`OK ${file} (${(ours as { dump: ChmDump }).dump.entries.length} entries)`);
      passed++;
    } else {
      console.error(`FAIL ${file}`);
      for (const error of errors.slice(0, 25)) console.error(`  ${error}`);
      if (errors.length > 25) console.error(`  ... ${errors.length - 25} more`);
      failed++;
    }
  }

  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped, ${better} better (chmlib-only failures)`);
  if (failed > 0) process.exit(1);
}

await main();
