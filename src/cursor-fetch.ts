import * as http from "http";
import * as https from "https";

function headerMap(h?: HeadersInit): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  if (!h) return out;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return { ...(h as Record<string, string>) };
}

function bodyBuf(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("Unsupported fetch body");
}

/** Chromium fetch in Obsidian is CORS-blocked; Node/Electron net is not. */
export function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || "GET").toUpperCase();
  const headers = headerMap(init.headers);
  const payload = bodyBuf(init.body);
  if (payload && headers["content-length"] == null) headers["content-length"] = payload.length;
  const u = new URL(url);
  const lib = u.protocol === "http:" ? http : https;
  const signal = init.signal;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      },
      (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else h.set(k, v);
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            });
            res.on("error", (err) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        resolve(
          new Response(stream, {
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            headers: h,
          })
        );
      }
    );
    req.on("error", (err) => reject(err instanceof Error ? err : new Error("Request failed")));
    const onAbort = () => {
      req.destroy();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (payload) req.write(payload);
    req.end();
  });
}

function electronFetch(): typeof fetch | null {
  try {
    const req = (window as { require?: (id: string) => { net?: { fetch?: typeof fetch } } }).require;
    const net = req?.("electron")?.net;
    if (typeof net?.fetch === "function") return (input: RequestInfo | URL, init?: RequestInit) => net.fetch!(input, init);
  } catch {
    /* renderer without electron.net */
  }
  return null;
}

export function installCursorFetch(): () => void {
  const prev = window.fetch; // eslint-disable-line @typescript-eslint/unbound-method -- restore the previous fetch on uninstall
  window.fetch = electronFetch() || nodeFetch;
  return () => {
    window.fetch = prev;
  };
}
