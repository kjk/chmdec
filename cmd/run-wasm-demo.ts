// run-wasm-demo.ts -- serve dist/wasm (demo.html + chm.js + chm.wasm).
//
//   bun cmd/run-wasm-demo.ts
//   bun cmd/run-wasm-demo.ts -port 9000
//   bun cmd/run-wasm-demo.ts -build   # run build-wasm first
//
// Opens http://localhost:<port>/demo.html
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, normalize, extname, resolve } from "path";
import { WASM_DIR } from "./build-wasm";

const ROOT = `${import.meta.dir}/..`.replaceAll("\\", "/");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function usage(): never {
  console.error("usage: bun cmd/run-wasm-demo.ts [-port N] [-build]");
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let port = 8765;
  let build = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-port" || a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) usage();
      port = n | 0;
    } else if (a === "-build" || a === "--build") {
      build = true;
    } else if (a === "-h" || a === "--help") {
      usage();
    } else {
      usage();
    }
  }
  return { port, build };
}

/** Resolve url path under root; null if missing or outside root. */
function resolveUnder(root: string, urlPath: string): string | null {
  let rel = decodeURIComponent((urlPath.split("?")[0] || "/").replace(/^\/+/, ""));
  if (!rel || rel === "") rel = "demo.html";
  if (rel.includes("\0") || rel.split(/[/\\]/).includes("..")) return null;
  const full = resolve(root, rel);
  const rootAbs = resolve(root);
  if (full !== rootAbs && !full.startsWith(rootAbs + "\\") && !full.startsWith(rootAbs + "/")) {
    return null;
  }
  return full;
}

async function main() {
  const { port, build } = parseArgs(process.argv.slice(2));

  if (build) {
    const { buildWasm } = await import("./build-wasm");
    await buildWasm();
  }

  // Refresh demo.html from source so HTML edits show without a full wasm rebuild.
  const demoSrc = join(ROOT, "cmd", "wasm-demo.html");
  const demoDst = join(WASM_DIR, "demo.html");
  if (existsSync(demoSrc)) {
    mkdirSync(WASM_DIR, { recursive: true });
    copyFileSync(demoSrc, demoDst);
  }

  if (!existsSync(join(WASM_DIR, "chm.js")) || !existsSync(join(WASM_DIR, "chm.wasm"))) {
    console.warn("warning: dist/wasm/chm.js or chm.wasm missing — run: bun cmd/build-wasm.ts");
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "") {
        return Response.redirect("/demo.html", 302);
      }
      const path = resolveUnder(WASM_DIR, url.pathname);
      if (!path) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }
      const type = MIME[extname(path).toLowerCase()] || "application/octet-stream";
      return new Response(file, {
        headers: {
          "Content-Type": type,
          "Cache-Control": "no-store",
        },
      });
    },
  });

  console.log(`chmdec wasm demo: http://localhost:${server.port}/demo.html`);
  console.log(`serving ${normalize(WASM_DIR)}`);
}

await main();
