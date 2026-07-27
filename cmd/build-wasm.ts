// build-wasm.ts -- build split chm.js + chm.wasm into dist/wasm/.
//
//   bun cmd/build-wasm.ts            # bootstrap emsdk if needed, then build
//   bun cmd/build-wasm.ts -clean     # wipe/re-activate the local emsdk
//
// Outputs:
//   dist/wasm/chm.js
//   dist/wasm/chm.wasm
//   dist/wasm/demo.html   (copied from cmd/wasm-demo.html)
//
// Emscripten isn't assumed to be on PATH: if `emcc` is missing we git-clone the
// emsdk into deps/emsdk and `install/activate latest` there (one-time, cached).
// Same pattern as heicdec / djvudec.
//
// Serve the demo with: bun cmd/run-wasm-demo.ts
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureDist, DIST_C } from "./build-dist";

const ROOT = path.resolve(import.meta.dir, "..");
export const WASM_DIR = path.join(ROOT, "dist", "wasm");
export const WASM_JS = path.join(WASM_DIR, "chm.js");
export const WASM_BIN = path.join(WASM_DIR, "chm.wasm");
const DEMO_SRC = path.join(ROOT, "cmd", "wasm-demo.html");
const API_C = path.join(ROOT, "cmd", "chm_wasm_api.c");
const EMSDK = path.join(ROOT, "deps", "emsdk");
const isWin = process.platform === "win32";
const EMSDK_ENV = path.join(EMSDK, isWin ? "emsdk_env.bat" : "emsdk_env.sh");

// Quote a path for the platform shell (skip quotes on Windows when unnecessary —
// cmd.exe /s /c treats embedded quotes literally and breaks git clone).
const q = (s: string) => {
  if (isWin) return /[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
};

// Run a shell command. On Windows uses cmd.exe + emsdk_env.bat; elsewhere bash.
function sh(cmd: string, opts: { cwd?: string; allowFail?: boolean; quiet?: boolean } = {}) {
  const cwd = opts.cwd ?? ROOT;
  const stdio = opts.quiet ? ("pipe" as const) : ("inherit" as const);
  // A git-bash parent leaks MSYSTEM into the env, which makes emsdk scripts
  // think they run in an MSYS shell and print `export` lines instead of
  // setting cmd.exe's PATH — emcc then never lands on PATH.
  const env = { ...process.env };
  delete env.MSYSTEM;
  const r = isWin
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", cmd], { cwd, stdio, encoding: "utf8", env })
    : spawnSync("bash", ["-lc", cmd], { cwd, stdio, encoding: "utf8", env });
  if (!opts.allowFail && r.status !== 0) {
    if (opts.quiet) process.stderr.write(r.stderr ?? "");
    throw new Error(`command failed (${r.status}): ${cmd}`);
  }
  return r;
}

function emccOnPath(): boolean {
  if (isWin) {
    return spawnSync("where", ["emcc"], { shell: true, encoding: "utf8" }).status === 0;
  }
  return spawnSync("bash", ["-lc", "command -v emcc"], { encoding: "utf8" }).status === 0;
}

// Return the shell prefix that puts `emcc` on PATH, or null if we must bootstrap.
function findEmcc(): string | null {
  if (emccOnPath()) return "";
  if (!existsSync(EMSDK_ENV)) return null;
  if (isWin) {
    const env = { ...process.env };
    delete env.MSYSTEM; // see sh()
    const r = spawnSync(
      "cmd.exe",
      ["/d", "/s", "/c", `call ${q(EMSDK_ENV)} >nul 2>&1 && where emcc`],
      { encoding: "utf8", env },
    );
    if (r.status === 0) return `call ${q(EMSDK_ENV)} >nul 2>&1 && `;
  } else {
    const r = spawnSync(
      "bash",
      ["-lc", `source ${q(EMSDK_ENV)} >/dev/null 2>&1 && command -v emcc`],
      { encoding: "utf8" },
    );
    if (r.status === 0) return `source ${q(EMSDK_ENV)} >/dev/null 2>&1 && `;
  }
  return null;
}

function bootstrapEmsdk() {
  console.log("• emcc not found — bootstrapping emsdk into deps/emsdk (one-time)…");
  mkdirSync(path.dirname(EMSDK), { recursive: true });
  if (!existsSync(path.join(EMSDK, ".git"))) {
    sh(`git clone --depth 1 https://github.com/emscripten-core/emsdk.git ${q(EMSDK)}`);
  }
  // Explicit path: with NoDefaultCurrentDirectoryInExePath set, cmd.exe won't
  // resolve a bare "emsdk.bat" against the cwd.
  const emsdk = isWin ? q(path.join(EMSDK, "emsdk.bat")) : "./emsdk";
  sh(`${emsdk} install latest`, { cwd: EMSDK });
  sh(`${emsdk} activate latest`, { cwd: EMSDK });
}

function ensureEmcc(): string {
  let prefix = findEmcc();
  if (prefix === null) {
    bootstrapEmsdk();
    prefix = findEmcc();
    if (prefix === null) throw new Error("emsdk bootstrap did not produce a working emcc");
  }
  const v = sh(`${prefix}emcc --version`, { quiet: true });
  console.log("• using " + (v.stdout ?? "").split("\n")[0]);
  return prefix;
}

const EXPORTS = [
  "_chm_wasm_open",
  "_chm_wasm_close",
  "_chm_wasm_entry_count",
  "_chm_wasm_entry_path",
  "_chm_wasm_entry_length",
  "_chm_wasm_entry_is_dir",
  "_chm_wasm_entry_is_file",
  "_malloc",
  "_free",
];

const RUNTIME = ["UTF8ToString", "HEAPU8"];

function installDemoHtml() {
  mkdirSync(WASM_DIR, { recursive: true });
  if (existsSync(DEMO_SRC)) {
    copyFileSync(DEMO_SRC, path.join(WASM_DIR, "demo.html"));
  }
}

/** emcc on Windows may emit CRLF in the JS glue; keep the drop LF-only. */
function ensureJsLf(file: string) {
  const raw = readFileSync(file);
  if (!raw.includes(0x0d)) return;
  writeFileSync(file, Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n")));
}

function compile(prefix: string) {
  mkdirSync(WASM_DIR, { recursive: true });
  const out = q(WASM_JS);
  // Split output: chm.js + chm.wasm (no SINGLE_FILE). Needs an HTTP server.
  const flags = [
    "-O2",
    "-sMODULARIZE=1",
    "-sEXPORT_NAME=createChmModule",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sENVIRONMENT=web,worker",
    "-sEXPORT_ES6=0",
    `-sEXPORTED_FUNCTIONS=${EXPORTS.join(",")}`,
    `-sEXPORTED_RUNTIME_METHODS=${RUNTIME.join(",")}`,
    `-I${q(path.join(ROOT, "dist"))}`,
  ].join(" ");

  const inputs = `${q(DIST_C)} ${q(API_C)}`;
  console.log("• compiling dist/chm.c + chm_wasm_api.c → dist/wasm/chm.js + chm.wasm");
  sh(`${prefix}emcc ${inputs} ${flags} -o ${out}`);

  if (!existsSync(WASM_BIN)) {
    throw new Error(`emcc did not write ${WASM_BIN}`);
  }
  ensureJsLf(WASM_JS);
  installDemoHtml();

  const jsKb = (Bun.file(WASM_JS).size / 1024).toFixed(0);
  const wasmKb = (Bun.file(WASM_BIN).size / 1024).toFixed(0);
  console.log(`✓ wrote dist/wasm/chm.js (${jsKb} KB) + dist/wasm/chm.wasm (${wasmKb} KB)`);
  console.log("  open the demo:  bun cmd/run-wasm-demo.ts   → http://localhost:8765/demo.html");
}

export async function buildWasm(opts: { cleanEmsdk?: boolean } = {}): Promise<void> {
  await ensureDist();
  installDemoHtml();
  if (opts.cleanEmsdk) rmSync(EMSDK, { recursive: true, force: true });
  const prefix = ensureEmcc();
  compile(prefix);
}

if (import.meta.main) {
  const clean = process.argv.includes("-clean");
  await buildWasm({ cleanEmsdk: clean });
}
