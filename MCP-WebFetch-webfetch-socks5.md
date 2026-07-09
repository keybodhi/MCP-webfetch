# MCP-WebFetch：一个可平替 opencode 内置 WebFetch 的代理增强版

## 一、为什么还需要另一个 webfetch？

opencode 内置的 webfetch 工具功能完善，但它有一个硬约束：**网络请求受限于 opencode 主进程的运行环境**。对于跑在沙箱（NSJail）、容器内或受限网络中的用户，内置 webfetch 可能根本连不上目标网站。

MCP（Model Context Protocol）提供了一种解耦方案——把工具做成独立进程，通过 stdin/stdout 和主程序通信。MCP-webfetch 正是基于这个思路：它把 opencode 的 webfetch 核心逻辑提取出来，封装成一个独立的 MCP 服务器，**核心行为完全兼容，同时额外支持 SOCKS5 代理**。

换句话说：你可以关掉内置 webfetch，用这个 MCP 代理完全替代它，而且能走代理上网。

## 二、三个实现，一套心脏

opencode 项目里 webfetch 有两个实现，加上 MCP-webfetch，一共三个版本：

| 版本 | 位置 | 角色 |
|---|---|---|
| V2 Core | `packages/core/src/tool/webfetch.ts` | opencode 新一代核心工具 |
| OpenCode variant | `packages/opencode/src/tool/webfetch.ts` | opencode CLI 层工具（支持图片） |
| MCP-webfetch | `webfetch-proxy.js` | 独立 MCP 服务器（本文主角） |

三个版本的 HTTP 请求、MIME 分类、内容转换、超时控制逻辑来自同一套设计。下面逐项对比，证明 MCP-webfetch 可以放心平替。

## 三、逐项代码对比

### 3.1 工具描述与输入参数

三个版本的 tool name、描述、参数结构完全一致：

| 字段 | V2 Core | OpenCode variant | MCP-webfetch |
|---|---|---|---|
| `name` | `"webfetch"` | `"webfetch"` | `"webfetch"` |
| `description` | 带"Use a more targeted tool..." | 从 `webfetch.txt` 加载 | 字符串直接复制 |
| `url` | 必填，String | 必填，String | 必填，String |
| `format` | 可选，默认 `"markdown"` | 可选，默认 `"markdown"` | 可选，默认 `"markdown"` |
| `timeout` | 可选，最大 120 | 可选，最大 120 | 可选，最大 120 |

以 timeout 的校验逻辑为例，V2 Core 使用 Schema 约束：

```typescript
const Timeout = Schema.Number.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS)
)
```

MCP-webfetch 用等价的运行时检查：

```javascript
if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS)) {
  send({ jsonrpc: "2.0", id, error: { code: -32602, message: `timeout must be a number between 1 and ${MAX_TIMEOUT_SECONDS}` } })
}
```

效果完全一致。

### 3.2 Accept 头部与 User-Agent

三个版本的 Accept 头生成逻辑一字不差：

```javascript
const acceptHeader = (format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
  return "*/*"
}
```

V2 Core 的 `acceptHeader` 函数完全一样。User-Agent 也都是同一个 Chrome 143 字符串。

请求头部也完全一致：

```javascript
const requestHeaders = (format, userAgent) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})
```

### 3.3 Cloudflare 挑战检测与重试

三个版本都用同一个模式判断 Cloudflare 挑战：**HTTP 403 + `cf-mitigated: challenge` 响应头**，检测到后换 `"opencode"` 这个 User-Agent 重试一次。

```javascript
const isCloudflareChallenge = (error) => {
  if (!error || typeof error !== "object" || !("reason" in error)) return false
  const reason = error.reason
  if (!reason || typeof reason !== "object" || !("_tag" in reason) || reason._tag !== "StatusCodeError" || !("response" in reason)) return false
  const response = reason.response
  return response.status === 403 && response.headers["cf-mitigated"] === "challenge"
}
```

V2 Core 的 `isCloudflareChallenge` 和 OpenCode variant 的 `catchIf` 条件完全等价。这意味着三个版本对 Cloudflare 保护网站的访问行为一致。

```typescript
// V2 Core
Effect.catchIf(isCloudflareChallenge, () => execute(http, input.url, input.format, "opencode"))
```

```javascript
// MCP-webfetch
Effect.catchIf(
  isCloudflareChallenge,
  () => execute(httpFollow, urlString, format, "opencode").pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  ),
)
```

### 3.4 MIME 类型判断

`mimeFrom`、`isImageAttachment`、`isTextualMime` 三个辅助函数在三处代码中**完全相同**：

```javascript
const mimeFrom = (contentType) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
```

SVG 和 FastBidSheet 被排除在图片之外，保持为文本处理。`application/json`、各种 `+json`、`+xml`、`application/javascript` 都被识别为可读文本。

唯一差异是图片的处理策略——V2 Core 拒绝图片，MCP-webfetch 和 OpenCode variant 接受图片并返回 base64。这是 OpenCode variant 的设计选择，MCP-webfetch 跟的是这个行为，属于有意增强。

### 3.5 响应体流式收集与大小限制

MCP-webfetch 的 `collectBoundedBody` 和 V2 Core 的 `collectBoundedResponseBody`（来自 `http-body.ts`）逻辑完全一致：

（1）检查 `content-length` 头，如果声明大小超过 5MB 直接拒绝。
（2）流式读取响应体，每收到一块数据检查累计大小是否超限。
（3）缓冲区按需扩展（翻倍策略），避免预先分配过大的内存。

```javascript
if (size + chunk.byteLength > maximumBytes) return Effect.fail(tooLarge())
if (size + chunk.byteLength > body.byteLength) {
  const grown = Buffer.allocUnsafe(Math.min(maximumBytes,
    Math.max(size + chunk.byteLength, body.byteLength * 2)))
  body.copy(grown, 0, 0, size)
  body = grown
}
```

OpenCode variant 用了更简单的 `response.arrayBuffer` + 事后检查大小，逻辑效果等价，但流式版本对大响应更友好，不会把整个响应一次性加载到内存。

### 3.6 HTML 格式转换

两个转换函数——`extractTextFromHTML` 和 `convertHTMLToMarkdown`——在三个版本中代码逐行相同。

`extractTextFromHTML` 使用 `htmlparser2`，跳过 `<script>`、`<style>`、`<noscript>`、`<iframe>`、`<object>`、`<embed>` 标签内的内容，其余文本拼接后返回：

```javascript
function extractTextFromHTML(html) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}
```

`convertHTMLToMarkdown` 使用 TurndownService，配置完全一致：ATX 标题风格、`---` 水平线、`-` 无序列表、围栏代码块、`*` 强调。跳过的元素也是 script、style、meta、link。

### 3.7 Effect 超时控制

三个版本都依赖 Effect-TS 的 `Effect.timeoutOrElse` 实现超时控制，默认 30 秒，最大 120 秒：

```javascript
Effect.timeoutOrElse({
  duration: Duration.seconds(timeoutSeconds),
  orElse: () => Effect.fail(new Error("Request timed out")),
})
```

V2 Core 完全一致。OpenCode variant 把秒转成毫秒后再传给 timeout，效果等价。

## 四、MCP-webfetch 的独特优势

### 4.1 SOCKS5 代理

这是 MCP-webfetch 区别于内置版本的核心能力。它通过 `socks-proxy-agent` 接管所有 HTTP/HTTPS 请求，走 SOCKS5 代理：

```javascript
const socksAgent = new SocksProxyAgent("socks5://127.0.0.1:10808")
```

实现方式是用自定义的 `socksFetch` 函数替换 Effect-TS HttpClient 底层的 Fetch 实现，通过 `Layer` 机制注入（下方代码为简化示意，完整实现还处理了 Uint8Array、ReadableStream 等 body 类型）：

```javascript
async function socksFetch(input, init = {}) {
  const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  const mod = new URL(url).protocol === "https:" ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: init.method || "GET",
      headers: init.headers || {},
      agent: socksAgent,
      signal: init.signal,
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const body = Buffer.concat(chunks)
        const flatHeaders = {}
        for (const [k, v] of Object.entries(res.headers || {})) {
          flatHeaders[k] = Array.isArray(v) ? v.join(", ") : v
        }
        resolve(new Response(body, {
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: flatHeaders,
        }))
      })
    })
    req.on("error", reject)
    req.end()
  })
}

const socksLayer = Layer.effect(FetchHttpClient.Fetch, Effect.sync(() => socksFetch))
const appLayer = Layer.merge(FetchHttpClient.layer, socksLayer)
```

这样做的好处是：**上层业务逻辑（Cloudflare 重试、body 收集、格式转换）完全不需要修改**，换一个网络层就能走代理。这是一种典型的依赖注入（Dependency Injection）架构——网络层和业务逻辑通过 Effect-TS 的 Layer 系统解耦。

### 4.2 独立部署

内置 webfetch 依赖 opencode 主进程的 HttpClient 和权限系统。MCP-webfetch 是一个独立的 Node.js 进程，通过 MCP 协议（JSON-RPC 2.0 over stdin/stdout）与主程序通信：

```javascript
const rl = readline.createInterface({ input: process.stdin })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}
```

这意味着：
- 可以跑在 opencode 沙箱之外，网络不受限
- 可以单独配置代理地址和端口
- 进程崩溃不影响主程序（MCP 有重启机制）
- 可以由其他支持 MCP 的客户端使用，不限于 opencode

### 4.3 图片返回支持

V2 Core 遇到图片 MIME 会直接报错：

```typescript
if (isImageAttachment(mime))
  return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
```

MCP-webfetch 会把图片作为 base64 数据返回：

```javascript
if (result.isImage) {
  send({
    jsonrpc: "2.0", id,
    result: { content: [{ type: "image", data: result.imageData.toString("base64"), mimeType: result.contentType }] },
  })
}
```

这和 OpenCode variant 的设计一致，是更有用的行为。

### 4.4 重定向追踪

MCP-webfetch 显式调用了 `HttpClient.followRedirects(http, 10)`，而 V2 Core 和 OpenCode variant 都没有。如果底层 HTTP 客户端不自动跟随重定向，内置版本会在 3xx 响应上失败。MCP-webfetch 在这里更健壮。

```javascript
const httpFollow = HttpClient.followRedirects(http, 10)
const response = yield* execute(httpFollow, urlString, format, browserUserAgent)...
```

## 五、微小差异与注意事项

### 5.1 权限系统

内置版本有完整的权限检查（`PermissionV2.assert` / `ctx.ask`），用户可以在 opencode 配置里控制 webfetch 的 allow/ask/deny 行为。MCP-webfetch 作为独立进程不处理权限——权限由主程序（opencode）在调用 MCP 工具时管控。

### 5.2 错误信息

三个版本都对用户屏蔽了具体的错误原因。V2 Core 用 `Effect.mapError(() => new ToolFailure(...))` 把所有错误统一为 `"Unable to fetch"`，但 Effect 的 `Cause` 内部保留了原始错误类型，方便内部诊断。MCP-webfetch 则用 `try/catch` 完全抹平，仅返回错误码和泛化消息。两者对 LLM 呈现的信息同样模糊。

### 5.3 依赖条件

MCP-webfetch 默认硬编码了 `127.0.0.1:10808` 作为代理地址。如果本地没有 SOCKS5 代理运行，请求会失败。使用时需要确保代理服务可用，或者把代理地址改为可配置项。

## 六、总结

MCP-webfetch 的核心逻辑——Accept 头部、User-Agent、Cloudflare 挑战处理、MIME 分类、流式 body 收集、HTML-to-Markdown 转换——与 opencode 源码完全一致。**它不是一个"新实现"，而是同一个实现、不同部署方式。**

| 场景 | 用内置 webfetch | 用 MCP-webfetch |
|---|---|---|
| 网络直连 | ✅ 直接可用 | ✅ 需要配置 MCP |
| 代理上网 | ❌ 不支持 | ✅ SOCKS5 |
| 沙箱环境 | ❌ 网络受限 | ✅ 独立进程 |
| 图片获取 | ❌ V2 Core 拒绝 | ✅ 支持 |
| 权限控制 | ✅ 原生支持 | ❌ 委托给主程序 |
| 重定向处理 | ⚠️ 依赖底层 | ✅ 显式跟随 |

如果你的环境需要走代理，或者希望 webfetch 不依赖 opencode 主进程运行，MCP-webfetch 是安全的平替方案。

## 七、webfetch 返回后的后续处理

webfetch 拿到网页内容只是第一步。数据返回后，opencode 还要经过一套后处理管线，才能最终送到 LLM 的上下文中。

### 7.1 内置 webfetch 的完整链路

以 opencode 内置的 webfetch 为例，从执行到 LLM 看到结果，经过的环节如下：

```
（1）webfetch.execute()
       │ 获取网页 → 5MB body 上限 → 转换 HTML → markdown/text/html
       ▼
（2）Tool.settle()
       │ Schema.encodeEffect() → 验证输出格式
       │ toModelOutput() → [{ type: "text", text: output }]
       ▼
（3）ToolOutputStore.bound()          ← 关键：截断判断
       │
       ├── 小于 2000 行 AND 小于 50KB
       │     └→ 原样返回
       │
       └── 超过任一阈值
             ├→ 完整内容写入文件
             ├→ 构造预览：前 1000 行 + ...truncated... + 后 1000 行
             │   （如果行预览仍超 50KB，改为前 25KB + 后 25KB 字节级截断）
             └→ 返回 { output: [预览文本], outputPaths: [完整文件路径] }
       │
       ▼
（4）ToolOutput.toResultValue()
       │ → { type: "text", value: "<预览文本>" }
       ▼
（5）LLMEvent.toolResult()
       │ → 发布到事件存储 → 持久化到数据库
       ▼
（6）下一轮 LLM 调用
       AI 看到的只有截断后的预览文本
```

这个链路的第（3）步是关键：opencode 对所有工具输出都做截断处理，无论工具返回多长的内容。默认阈值是 2000 行或 50KB，只要超过其中一个，就会截断。

截断策略是"头尾预览"——保留开头的 1000 行和末尾的 1000 行，中间用一句提示替代。这么设计的原因很实际：一篇文章的开头通常是简介，末尾通常有结论，中间可能是冗长的论述。保留头尾比只保留头部能给 AI 更完整的上下文。

如果头尾预览的字节数仍然超过 50KB，进一步退化为字节级截断：保留前 25KB 和后 25KB。对应的代码实现来自 `tool-output-store.ts` 的 `preview` 函数：

```typescript
const headLines = Math.ceil(maxLines / 2)    // 1000
const tailLines = Math.floor(maxLines / 2)   // 1000
// ...
const headBytes = Math.ceil(maxBytes / 2)     // 25KB
const tailBytes = Math.floor(maxBytes / 2)   // 25KB
```

### 7.2 MCP 工具的后续处理

MCP 服务器返回数据后，opencode 的处理稍有不同——它走的是另一条截断管线，但阈值和配置是同一套。

```
MCP 服务器返回
       │ result.content: [{ type: "text", text: "<完整网页内容>" }]
       ▼
session/tools.ts
       │ 提取 textParts，用 "\n\n" 拼接
       ▼
Truncate.Service.output()             ← MCP 的截断入口
       │
       ├── 小于 2000 行 AND 小于 50KB
       │     └→ { content: "<完整内容>", truncated: false }
       │
       └── 超过任一阈值
             ├→ 完整内容写入文件
             ├→ 构造预览：默认只保留头部（direction: "head"）
             ├→ 追加提示信息：指向保存的文件路径
             └→ { content: "<截断预览>", truncated: true, outputPath: "<文件路径>" }
```

两者的核心差异在于截断策略：

| 对比项 | 内置工具（V2 管线） | MCP 工具（V1 管线） |
|---|---|---|
| 截断入口 | `ToolOutputStore.bound()` | `Truncate.Service.output()` |
| 截断策略 | 头尾预览（前 50% + 后 50%） | 方向截断（默认只保留头部） |
| 保存目录 | `tool-output/tool_<id>` | `tool-output/tool_<id>`（相同） |
| 阈值 | 2000 行 / 50KB | 2000 行 / 50KB（相同） |
| 可配置 | `tool_output.max_lines` / `max_bytes` | 同上 |

V2 管线在 `boundedPreview` 中实现头尾预览，MCP 管线在 `Truncate.output` 中默认只保留头部（`direction: "head"`）。两者都会把完整内容写入文件并返回文件路径，给 AI 提供通过 Task/Read 工具查看完整内容的线索。

### 7.3 这意味着什么

一个重要的认知：**MCP 服务器不需要自己实现截断逻辑**。无论返回多长的内容，opencode 都会在外部统一做截断处理。`Truncate.Service` 行数检测、字节检测、文件存储、预览生成都在主进程中完成。

这意味着 `webfetch-proxy.js` 只需要做三件事：

1. **正确获取网页内容**（走代理）
2. **正确解析 HTTP 响应**（MIME 校验、大小限制、HTML 转换）
3. **原样返回完整内容**（截断由 opencode 处理）

这个设计是合理的：MCP 服务器是"无状态工具提供者"，只管做好自己的事。格式验证、长度控制、上下文管理等是宿主框架（opencode）的职责。两者各司其职，互不干扰。

### 7.4 配置截断阈值

如果你希望 AI 能看到更长的页面内容，可以在 `opencode.json` 中调整阈值：

```json
{
  "tool_output": {
    "max_lines": 5000,
    "max_bytes": 200000
  }
}
```

设置后需重启 opencode 生效。两个管线的阈值来自同一处配置，改一处同时影响内置工具和 MCP 工具的截断行为——这进一步保证了设计一致性。

---

**仓库地址**：[https://github.com/keybodhi/MCP-webfetch](https://github.com/keybodhi/MCP-webfetch)

**（完）**
