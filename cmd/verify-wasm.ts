// verify-wasm.ts — smoke-test dist/wasm/chm.js by opening a CHM through the
// same exports the web demo uses.
//
//   bun cmd/verify-wasm.ts <file.chm>
//   bun cmd/verify-wasm.ts fuzz/crashes/crash-uninit-lzx.chm
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { buildWasm, WASM_BIN, WASM_JS } from "./build-wasm";

const ROOT = path.resolve(import.meta.dir, "..");
const file = process.argv[2];
if (!file) {
  console.error(
    `usage: bun cmd/verify-wasm.ts <file.chm>

Example (tracked sample that opens cleanly):
  bun cmd/verify-wasm.ts fuzz/crashes/crash-uninit-lzx.chm`,
  );
  process.exit(2);
}

const abs = path.resolve(ROOT, file);
if (!existsSync(abs)) {
  console.error(`no such file: ${abs}`);
  process.exit(1);
}

await buildWasm();
if (!existsSync(WASM_JS)) throw new Error("dist/wasm/chm.js missing after build");
if (!existsSync(WASM_BIN)) throw new Error("dist/wasm/chm.wasm missing after build");

/* Glue is built for ENVIRONMENT=web,worker; provide the globals it probes. */
(globalThis as any).self = globalThis;

const createChmModule = (await import(WASM_JS)).default;
const M: any = await createChmModule({
  // Prefer binary injection so node/bun need no HTTP fetch for the .wasm.
  wasmBinary: readFileSync(WASM_BIN),
  locateFile: (p: string) => (p.endsWith(".wasm") ? WASM_BIN : p),
});

const bytes = new Uint8Array(readFileSync(abs));
const buf = M._malloc(bytes.length);
if (!buf) throw new Error("malloc failed");
M.HEAPU8.set(bytes, buf);

const ctx = M._chm_wasm_open(buf, bytes.length);
if (!ctx) throw new Error("chm_wasm_open failed");

const n = M._chm_wasm_entry_count(ctx);
console.log(`${path.basename(abs)}: ${n} entr${n === 1 ? "y" : "ies"}`);
if (n < 1) throw new Error("expected at least one entry");

// Sample first few paths / lengths.
const sample = Math.min(n, 5);
for (let i = 0; i < sample; i++) {
  const pathPtr = M._chm_wasm_entry_path(ctx, i);
  const ep = pathPtr ? M.UTF8ToString(pathPtr) : "(null)";
  const len = M._chm_wasm_entry_length(ctx, i);
  const isDir = M._chm_wasm_entry_is_dir(ctx, i);
  const isFile = M._chm_wasm_entry_is_file(ctx, i);
  console.log(
    `  [${i}] ${isDir ? "dir" : isFile ? "file" : "?"} ${ep} len=${len}`,
  );
}

M._chm_wasm_close(ctx);
M._free(buf);
console.log("✓ wasm open/list OK");
