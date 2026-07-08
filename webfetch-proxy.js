const { Effect, Duration, Layer, Stream } = require("effect");
const { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } = require("effect/unstable/http");
const { Parser } = require("htmlparser2");
const TurndownService = require("turndown");
const http = require("http");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");
const readline = require("readline");

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 10808;
const PROXY_URL = `socks5://${PROXY_HOST}:${PROXY_PORT}`;

const name = "webfetch";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`;

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const socksAgent = new SocksProxyAgent(PROXY_URL);

async function socksFetch(input, init = {}) {
  const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const mod = new URL(url).protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: init.method || "GET",
      headers: init.headers || {},
      agent: socksAgent,
      signal: init.signal,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const flatHeaders = {};
        for (const [k, v] of Object.entries(res.headers || {})) {
          flatHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve(new Response(body, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: flatHeaders,
        }));
      });
    });
    req.on("error", reject);
    if (init.body) {
      if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
        req.write(Buffer.from(init.body));
      } else if (typeof init.body === "string") {
        req.write(init.body);
      } else if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) { req.end(); return; }
          req.write(Buffer.from(value));
          pump();
        }).catch(reject);
        pump();
        return;
      }
    }
    req.end();
  });
}

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const acceptHeader = (format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
  return "*/*";
};

const requestHeaders = (format, userAgent) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
});

const mimeFrom = (contentType) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
const isImageAttachment = (mime) => mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet";
const isTextualMime = (mime) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript";

const convert = (content, contentType, format) => {
  if (!contentType.includes("text/html")) return content;
  if (format === "markdown") return convertHTMLToMarkdown(content);
  if (format === "text") return extractTextFromHTML(content);
  return content;
};

const isCloudflareChallenge = (error) => {
  if (!error || typeof error !== "object" || !("reason" in error)) return false;
  const reason = error.reason;
  if (
    !reason || typeof reason !== "object" ||
    !("_tag" in reason) || reason._tag !== "StatusCodeError" ||
    !("response" in reason)
  ) return false;
  const response = reason.response;
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge";
};

const oversizedError = () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`);

const collectBoundedBody = (response, maximumBytes, tooLarge) =>
  Effect.gen(function* () {
    const contentLength = response.headers["content-length"];
    const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined;
    const declaredSize = parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined;
    if (declaredSize !== undefined && declaredSize > maximumBytes) return yield* Effect.fail(tooLarge());
    let body = Buffer.allocUnsafe(Math.min(maximumBytes, declaredSize || 64 * 1024));
    let size = 0;
    yield* Stream.runForEach(
      response.stream,
      (chunk) => {
        if (chunk.byteLength === 0) return Effect.void;
        if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge());
        if (size + chunk.byteLength > body.byteLength) {
          const grown = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(size + chunk.byteLength, body.byteLength * 2)));
          body.copy(grown, 0, 0, size);
          body = grown;
        }
        body.set(chunk, size);
        size += chunk.byteLength;
        return Effect.void;
      },
    );
    return body.subarray(0, size);
  });

const execute = (http, urlString, format, userAgent) =>
  http.execute(
    HttpClientRequest.get(urlString).pipe(
      HttpClientRequest.setHeaders(requestHeaders(format, userAgent)),
    ),
  );

const fetchUrl = (urlString, format, timeoutSeconds) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const httpFollow = HttpClient.followRedirects(http, 10);

    const result = yield* Effect.gen(function* () {
      const response = yield* execute(httpFollow, urlString, format, browserUserAgent).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.catchIf(
          isCloudflareChallenge,
          () => execute(httpFollow, urlString, format, "opencode").pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
          ),
        ),
      );

      const contentType = response.headers["content-type"] || "";
      const mime = mimeFrom(contentType);

      if (isImageAttachment(mime)) {
        const body = yield* collectBoundedBody(response, MAX_RESPONSE_BYTES, oversizedError);
        return { imageData: body, contentType, isImage: true };
      }

      if (!isTextualMime(mime)) {
        return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`));
      }

      const body = yield* collectBoundedBody(response, MAX_RESPONSE_BYTES, oversizedError);
      const content = new TextDecoder().decode(body);
      const output = yield* Effect.try({
        try: () => convert(content, contentType, format),
        catch: (error) => error,
      });
      return { output, contentType };
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(timeoutSeconds),
        orElse: () => Effect.fail(new Error("Request timed out")),
      }),
    );

    return result;
  }).pipe(
    Effect.mapError(() => new Error(`Unable to fetch ${urlString}`)),
  );

const socksLayer = Layer.effect(
  FetchHttpClient.Fetch,
  Effect.sync(() => socksFetch),
);

const appLayer = Layer.merge(FetchHttpClient.layer, socksLayer);

function extractTextFromHTML(html) {
  let text = "";
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++;
    },
    ontext(input) {
      if (skipDepth === 0) text += input;
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

function convertHTMLToMarkdown(html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "meta", "link"]);
  return turndown.turndown(html);
}

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "webfetch-proxy", version: "3.0.0" },
        },
      });
      break;

    case "notifications/initialized":
      break;

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name,
              description,
              inputSchema: {
                type: "object",
                properties: {
                  url: { type: "string", description: "The HTTP or HTTPS URL to fetch content from" },
                  format: {
                    type: "string",
                    enum: ["text", "markdown", "html"],
                    description: "The format to return the content in. Defaults to markdown.",
                  },
                  timeout: {
                    type: "number",
                    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
                  },
                },
                required: ["url"],
              },
            },
          ],
        },
      });
      break;

    case "tools/call":
      if (!params || params.name !== name) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Unknown tool: " + (params ? params.name : "undefined") },
        });
        break;
      }
      let url, format, timeout;
      try {
        ({ url, format = "markdown", timeout } = params.arguments || {});
      } catch {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing arguments" } });
        break;
      }
      if (!url || typeof url !== "string") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "url is required" } });
        break;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "URL must use http:// or https://" } });
        break;
      }
      if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `timeout must be a number between 1 and ${MAX_TIMEOUT_SECONDS}` } });
        break;
      }
      const safeTimeout = typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT_SECONDS;
      try {
        const result = await Effect.runPromise(
          Effect.provide(fetchUrl(url, format, safeTimeout), appLayer),
        );
        if (result.isImage) {
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "image", data: result.imageData.toString("base64"), mimeType: result.contentType }] },
          });
        } else {
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: result.output }] },
          });
        }
      } catch (e) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: `Unable to fetch ${url}` },
        });
      }
      break;

    default:
      if (id) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
  }
});
