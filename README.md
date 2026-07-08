# MCP-webfetch

通过 SOCKS5 代理抓取网页内容的 MCP 服务器。基于 opencode 官方 webfetch 实现，添加了代理支持。

## 功能

- 通过 `127.0.0.1:10808` SOCKS5 代理获取网页
- 支持格式：markdown（默认）、text、html
- HTML→Markdown 转换（TurndownService）
- HTML→Text 提取（htmlparser2）
- 自动跟进重定向（防循环检测）
- Cloudflare 反爬检测 + 自动重试
- MIME 类型校验（图片/二进制自动拒绝）
- Body 大小限制（5MB）

## 安装

```bash
# 1. 克隆或复制本目录
cd D:\workplace\MCP-webfetch

# 2. 安装依赖（htmlparser2 + turndown）
npm install
```

## 配置 opencode

在 `opencode.json` 中添加：

```json
{
  "mcp": {
    "webfetch-proxy": {
      "type": "local",
      "command": ["node", "D:\\workplace\\MCP-webfetch\\webfetch-proxy.js"],
      "enabled": true
    }
  },
  "permission": {
    "webfetch": "deny"
  }
}
```

- **项目级**: 当前目录下的 `opencode.json`
- **全局级**: `~/.config/opencode/opencode.json`

### 禁止内置 webfetch（可选）

在 `permission` 中设置 `webfetch: "deny"`，让 AI 只能使用本 MCP 工具。

```json
{
  "permission": {
    "webfetch": "deny"
  }
}
```

## 配置代理地址

编辑 `webfetch-proxy.js` 顶部：

```js
const PROXY_HOST = "127.0.0.1";
const PROXY_PORT = 10808;
```

## 重启 opencode

每次修改配置后需要重启 opencode 生效。

## 测试

```bash
node -e "
const { spawn } = require('child_process');
const proc = spawn('node', ['D:\\\\workplace\\\\MCP-webfetch\\\\webfetch-proxy.js']);
proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'t',version:'1'}}})+'\n');
setTimeout(() => {
  proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'webfetch',arguments:{url:'https://httpbin.org/get',format:'text',timeout:5}}})+'\n');
}, 500);
setTimeout(() => { proc.kill(); process.exit(); }, 5000);
proc.stdout.on('data', (d) => { console.log(d.toString()); });
"
```

## 依赖

- `effect` — 函数式运行时（HttpClient、Stream、Effect）
- `htmlparser2` — HTML 解析（文本提取）
- `socks-proxy-agent` — SOCKS5 代理客户端
- `turndown` — HTML→Markdown 转换
