import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface WebUiServerOptions {
  distDir: string;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const content = await readFile(path);
  const extension = extname(path).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "content-length": String(content.byteLength),
    "cache-control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") res.end();
  else res.end(content);
}

/**
 * Static web-client projection over the local runtime server.
 *
 * API ownership stays with the runtime. This layer only serves a built web
 * bundle and provides SPA fallback, so Chef works as a browser application
 * without requiring a separate Vite process or desktop shell.
 */
export function createWebUiServer(baseServer: Server, options: WebUiServerOptions): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  const distRoot = resolve(options.distDir);
  const indexPath = resolve(distRoot, "index.html");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Runtime routes and mutations always belong to the authoritative server.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
      await baseHandler(req, res);
      return;
    }

    try {
      const decodedPath = decodeURIComponent(url.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const candidate = resolve(distRoot, relativePath);

      if (isInside(distRoot, candidate) && await isFile(candidate)) {
        await sendFile(req, res, candidate);
        return;
      }

      // Client-side routes resolve to the app shell. Requests that look like
      // concrete missing assets still fall through to the runtime's 404.
      if (!extname(decodedPath) && await isFile(indexPath)) {
        await sendFile(req, res, indexPath);
        return;
      }
    } catch {
      // Invalid URL encoding or an unreadable bundle should behave like a
      // normal missing route rather than taking down the runtime server.
    }

    await baseHandler(req, res);
  });
}
