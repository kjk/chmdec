// build-dist.ts -- produce amalgamated dist/chm.h + dist/chm.c (sqlite style).
//
//   bun cmd/build-dist.ts
//
// dist/chm.h : license header + copy of src/chm.h
// dist/chm.c : license header + src/chm.h + src/chm_internal.h + src/lzx.c + src/chm.c (with local includes stripped)
import { $ } from "bun";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const ROOT = `${import.meta.dir}/..`.replaceAll("\\", "/");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

export const DIST_H = join(DIST, "chm.h");
export const DIST_C = join(DIST, "chm.c");

const MODULES = ["lzx.c", "chm.c"];

// License notice prepended to dist/chm.h and dist/chm.c. stripCComments removes
// the per-file license banners from src/, so the amalgamation needs its own.
const LICENSE_HEADER = `/* chmdec -- plain-C CHM reader. https://github.com/kjk/chmdec
 *
 * Derived from CHMLib by Jed Wing <jedwin@ugcs.caltech.edu>. The LZX
 * decompressor derives from cabextract by Stuart Caie, who granted permission
 * to re-license it under the LGPL for CHMLib.
 * Changes Copyright (c) 2026 Krzysztof Kowalczyk.
 *
 * This library is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or (at
 * your option) any later version. See LICENSE.md.
 */
`;

function stripLocalIncludes(text: string): string {
  // remove #include "chm.h" and #include "chm_internal.h" and old "lzx.h"
  return text.replace(/^[ \t]*#[ \t]*include[ \t]+"(?:chm\.h|chm_internal\.h|lzx\.h)"[ \t]*\r?\n/gm, "");
}

/** LF only, strip trailing whitespace, at most one blank line in a row. */
function normalizeSourceText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  let blank = false;
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line.length === 0) {
      if (blank) continue;
      blank = true;
      out.push("");
    } else {
      blank = false;
      out.push(line);
    }
  }
  // Drop leading blank lines; keep a single trailing newline.
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "\n" : out.join("\n") + "\n";
}

function stripCComments(code: string): string {
  // Normalize EOLs first so comment/blank handling never sees CRLF.
  code = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = i + 1 < n ? code[i + 1] : "";
    if (c === '"') {
      out += c; i++;
      while (i < n) {
        if (code[i] === "\\" && i + 1 < n) { out += code[i] + code[i + 1]; i += 2; }
        else if (code[i] === '"') { out += code[i]; i++; break; }
        else { out += code[i]; i++; }
      }
    } else if (c === "'" ) {
      out += c; i++;
      while (i < n) {
        if (code[i] === "\\" && i + 1 < n) { out += code[i] + code[i + 1]; i += 2; }
        else if (code[i] === "'") { out += code[i]; i++; break; }
        else { out += code[i]; i++; }
      }
    } else if (c === "/" && next === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c; i++;
    }
  }
  return normalizeSourceText(out);
}

// Always regenerate and re-verify the amalgamation. mtime-based caching risked
// compiling a stale dist/ (e.g. into wasm) when a src change wasn't detected.
export async function ensureDist() {
  await buildDist();
}

export async function buildDist() {
  mkdirSync(DIST, { recursive: true });

  const pub = normalizeSourceText(readFileSync(join(SRC, "chm.h"), "utf8"));

  let body = "";
  for (const m of MODULES) {
    let txt = readFileSync(join(SRC, m), "utf8");
    txt = stripLocalIncludes(txt);
    body += "\n" + txt;
  }

  // prepend internal after pub in the amalgam (internal not public)
  let intH = readFileSync(join(SRC, "chm_internal.h"), "utf8");
  intH = stripLocalIncludes(intH);

  // Final pass also collapses blank runs left at module boundaries.
  const amalgam = stripCComments(pub + "\n" + intH + "\n" + body);

  writeFileSync(DIST_H, LICENSE_HEADER + "\n" + pub);
  writeFileSync(DIST_C, LICENSE_HEADER + "\n" + amalgam);

  // verify compiles
  const tmp = join(DIST, "chk.c");
  writeFileSync(tmp, `#include "chm.c"\n`);
  try {
    await $`clang -fsyntax-only -I ${DIST} ${tmp}`.quiet();
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log("dist/ updated and verified");
}

if (import.meta.main) {
  // buildWasm() calls ensureDist() -> buildDist() first, so don't build dist
  // twice; this regenerates dist/ (always clean) and then the wasm drop-in.
  const { buildWasm } = await import("./build-wasm");
  await buildWasm();
}
