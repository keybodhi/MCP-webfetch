// MCP-webfetch — MIT License
// Derived from opencode's webfetch tool (https://github.com/anomalyco/opencode) — MIT
// Modifications: proxy support, MCP protocol, redirect following, JS port

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const readline = require("readline");
const { Parser } = require("htmlparser2");
const TurndownService = require("turndown");

const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 10808;

const name = "webfetch";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.`;

const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────

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

const headers = (format, userAgent) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
});

const assertHttpUrl = (url) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must use http:// or https://");
};

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

// ── Cloudflare detection ──────────────────────────────────────────────────

const isCloudflareChallenge = (error) => {
  if (!error || typeof error !== "object" || !("reason" in error)) return false;
  const reason = error.reason;
  if (
    !reason ||
    typeof reason !== "object" ||
    !("_tag" in reason) ||
    reason._tag !== "StatusCodeError" ||
    !("response" in reason)
  )
    return false;
  const response = reason.response;
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge";
};

// ── Body collector ────────────────────────────────────────────────────────

const collectBoundedResponseBody = (responseBody, resHeaders) => {
  const contentLength = resHeaders["content-length"];
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined;
  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined;
  if (declaredSize !== undefined && declaredSize > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`);
  }
  if (responseBody.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`);
  }
  return responseBody;
};

// ── HTTP via proxy: uses Node's llhttp C parser ───────────────────────────

const executeHttp = (urlString, format, userAgent, timeoutSeconds) =>
  new Promise((resolve, reject) => {
    const h = headers(format, userAgent);
    const req = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      path: urlString,
      method: "GET",
      headers: { ...h, Host: new URL(urlString).hostname },
      timeout: (timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000,
    });
    req.on("response", (res) => {
      let body = Buffer.alloc(0);
      res.on("data", (chunk) => { body = Buffer.concat([body, chunk]); });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });

// ── HTTPS via proxy: CONNECT tunnel + TLS ─────────────────────────────────

const executeHttps = (urlString, format, userAgent, timeoutSeconds) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const socket = net.connect(PROXY_PORT, PROXY_HOST, () => {
      socket.write(`CONNECT ${parsed.hostname}:${parsed.port || 443} HTTP/1.1\r\nHost: ${parsed.hostname}:${parsed.port || 443}\r\n\r\n`);
    });
    let proxyBuf = "";
    const onData = (data) => {
      proxyBuf += data.toString();
      const idx = proxyBuf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.removeAllListeners("data");
      const statusLine = proxyBuf.slice(0, proxyBuf.indexOf("\r\n"));
      if (!statusLine.includes("200")) {
        socket.destroy();
        return reject(new Error("CONNECT failed: " + statusLine));
      }
      const leftover = proxyBuf.slice(idx + 4);
      if (leftover.length > 0) socket.unshift(Buffer.from(leftover, "utf-8"));
      const tlsSocket = tls.connect({ socket, servername: parsed.hostname });
      tlsSocket.on("secureConnect", () => {
        const h = headers(format, userAgent);
        tlsSocket.write(
          `GET ${parsed.pathname + parsed.search} HTTP/1.1\r\n` +
          `Host: ${parsed.hostname}\r\n` +
          `User-Agent: ${h["User-Agent"]}\r\n` +
          `Accept: ${h.Accept}\r\n` +
          `Accept-Language: ${h["Accept-Language"]}\r\n` +
          `Connection: close\r\n\r\n`
        );
        let raw = Buffer.alloc(0);
        tlsSocket.on("data", (chunk) => { raw = Buffer.concat([raw, chunk]); });
        tlsSocket.on("end", () => processRawHttps(raw, resolve, reject));
      });
      tlsSocket.on("error", reject);
      tlsSocket.setTimeout(30000, () => { tlsSocket.destroy(); reject(new Error("TLS timeout")); });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(30000, () => { socket.destroy(); reject(new Error("CONNECT timeout")); });
  });

function processRawHttps(raw, resolve, reject) {
  if (raw.length === 0) return reject(new Error("Empty response"));
  try {
    const idx = raw.indexOf("\r\n\r\n");
    if (idx === -1) return reject(new Error("Incomplete HTTP response"));
    const headerStr = raw.subarray(0, idx).toString();
    const body = raw.subarray(idx + 4);
    const statusMatch = headerStr.match(/^HTTP\/\d\.\d\s+(\d+)(?:\s+(.*))?$/m);
    if (!statusMatch) return reject(new Error("Malformed status line"));
    const statusCode = parseInt(statusMatch[1], 10);

    // Skip interim 1xx responses (e.g. 100 Continue)
    if (statusCode >= 100 && statusCode < 200) {
      return processRawHttps(body, resolve, reject);
    }

    const lines = headerStr.split("\r\n");
    const resHeaders = {};
    for (let i = 1; i < lines.length; i++) {
      if (/^[ \t]/.test(lines[i])) {
        const k = Object.keys(resHeaders).pop();
        if (k) resHeaders[k] += " " + lines[i].trim();
        continue;
      }
      const m = lines[i].match(/^([^:]+):\s*(.*)/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "set-cookie") resHeaders[key] = resHeaders[key] ? [].concat(resHeaders[key], val) : val;
      else resHeaders[key] = val;
    }
    const isChunked = (resHeaders["transfer-encoding"] || "").toLowerCase().split(",").map(s => s.trim()).includes("chunked");
    let decoded = isChunked ? decodeChunkedBody(body) : body;

    // Consume chunked trailers (headers after last chunk)
    if (isChunked && decoded.length > 0) {
      const trailerIdx = decoded.indexOf("\r\n\r\n");
      if (trailerIdx !== -1) {
        decoded = decoded.subarray(trailerIdx + 4);
      }
    }

    resolve({ statusCode, headers: resHeaders, body: decoded });
  } catch (e) {
    reject(e);
  }
}

function decodeChunkedBody(data) {
  const chunks = [];
  let pos = 0;
  while (pos < data.length) {
    const crlf = data.indexOf("\r\n", pos);
    if (crlf === -1) break;
    const sizeStr = data.subarray(pos, crlf).toString("utf-8").trim();
    const size = parseInt(sizeStr, 16);
    if (isNaN(size)) break;
    pos = crlf + 2;
    if (size === 0) break;
    if (pos + size > data.length) break;
    chunks.push(data.subarray(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(chunks);
}

// ── Process response (MIME checks → collect body → decode → convert) ─────

const processResponse = ({ statusCode, headers, body }, format) => {
  const contentType = headers["content-type"] || "";
  const mime = mimeFrom(contentType);

  if (statusCode === 403 && headers["cf-mitigated"] === "challenge") {
    const challenge = new Error("Cloudflare challenge");
    challenge.reason = { _tag: "StatusCodeError", response: { status: 403, headers: { "cf-mitigated": "challenge" } } };
    throw challenge;
  }

  if (isImageAttachment(mime)) throw new Error("Unsupported fetched image content type: " + mime);
  if (!isTextualMime(mime)) throw new Error("Unsupported fetched file content type: " + mime);

  const rawBody = collectBoundedResponseBody(body, headers);
  const content = new TextDecoder().decode(rawBody);
  const output = convert(content, contentType, format);
  return { output, contentType, statusCode, headers };
};

// ── Main fetch ────────────────────────────────────────────────────────────

const fetchUrl = async (urlString, format, timeoutSeconds, seen) => {
  const parsed = new URL(urlString);
  assertHttpUrl(parsed);
  if (seen.has(urlString)) throw new Error("Redirect loop");
  seen.add(urlString);

  const isHttps = parsed.protocol === "https:";
  const execute = isHttps ? executeHttps : executeHttp;
  const ua = browserUserAgent;

  let result;
  try {
    result = await withTimeout(execute(urlString, format, ua, timeoutSeconds), (timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000 + 5000, "Request timed out");
  } catch (e) {
    if (isCloudflareChallenge(e)) {
      result = await withTimeout(execute(urlString, format, "opencode", timeoutSeconds), (timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000 + 5000, "Request timed out");
    } else {
      throw e;
    }
  }

  const processed = processResponse(result, format);
  const { statusCode, headers, output, contentType } = processed;

  if (statusCode >= 300 && statusCode < 400) {
    const loc = headers["location"];
    if (loc) {
      const nextUrl = new URL(loc, urlString).href;
      if (seen.has(nextUrl)) throw new Error("Redirect loop");
      return fetchUrl(nextUrl, format, timeoutSeconds, seen);
    }
  }

  return { output, contentType };
};

const withTimeout = (promise, ms, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });

// ── extractTextFromHTML (htmlparser2 with skipDepth) ──────────────────────

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

// ── convertHTMLToMarkdown (TurndownService) ───────────────────────────────

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

turndown.remove(["script", "style", "meta", "link"]);

function convertHTMLToMarkdown(html) {
  return turndown.turndown(html);
}

// ── MCP handlers ─────────────────────────────────────────────────────────

rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
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
        assertHttpUrl(new URL(url));
      } catch {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "URL must use http:// or https://" } });
        break;
      }
      const safeTimeout = typeof timeout === "number" && timeout > 0
        ? Math.min(timeout, MAX_TIMEOUT_SECONDS)
        : DEFAULT_TIMEOUT_SECONDS;
      try {
        const result = await fetchUrl(url, format, safeTimeout, new Set());
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result.output }] },
        });
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
