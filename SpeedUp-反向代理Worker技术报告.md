# SpeedUp 反向代理 Worker 项目技术报告

> 生成日期：2026-09-08 · 技术栈：Cloudflare Workers（零依赖，单个 `src/index.js`）· 最新部署版本 `f0fc790a`

---

## 1. 项目概述

一个部署在 Cloudflare Workers 上的通用反向代理。核心思路：把**源站 host 用 Base32 编码成 `*.mc-lhz.de5.net` 下的一级子域**，访问该子域即代理到源站。借助免费 **Universal SSL** 自动覆盖 `*.mc-lhz.de5.net`，因此无需为每个源站单独申请证书。

```
github.com  --Base32-->  MFRGGIBTGI
访问 https://mfrggibtgi.mc-lhz.de5.net/   ===>  代理到 https://github.com/
```

## 2. 要解决的核心问题

用户环境里，本地 **hosts 把 GitHub 等域名指向 `127.0.0.1`**（由本地加速器写入），浏览器在一个公共来源（如 `https://m5uxi2dvmixgg33n.mc-lhz.de5.net` 代理页面）下发起对这些域名的请求时，Chrome 的 **Private Network Access（PNA）** 会判定「公共来源 → 回环地址」为越权，直接拦截：

```
Access to ... from origin 'https://m5uxi2dvmixgg33n.mc-lhz.de5.net'
has been blocked by CORS policy: Permission was denied for this request
to access the `loopback` address space.
```

**解决目标：让浏览器对所有资源请求都走本代理（`*.mc-lhz.de5.net`），彻底绕开本地 hosts 里的 `127.0.0.1` 映射，从而不再触发 loopback 拦截。**

## 3. 总体架构

```
浏览器 ── https://<base32(host)>.mc-lhz.de5.net/<path> ──> Cloudflare Workers ── 原生 fetch ──> 源站
   │   （页面所有资源经 HTML 改替换 / 内联脚本 / Service Worker 三类改写，全部指向回本代理）
   └─ 本地 hosts 里 github→127.0.0.1 的映射不再被命中
```

Worker 一次请求的处理流程：

1. 取一级子域 → `base32Decode` 还原源站 host → 重组 `https://` 目标 URL。
2. 剥离请求头里的 `Accept-Encoding`（保证 HTML 未压缩、可被 `HTMLRewriter` 改写）。
3. 用原生 `fetch` 请求源站，复制响应头，补 `Access-Control-Allow-Origin: *`，删除上游 CSP。
4. 按 `Content-Type` 分流：**text/html** 做「HTML 链接替换 + 内联首屏脚本 + 注册 SW」；其余**原样透传**。

## 4. Base32 单层子域编码

- **编码**：RFC4648 无填充，字母表 `A-Z 2-7`，仅用于 DNS 单标签（≤63 字符），大小写不敏感，无连字符歧义。
- **为何不用 Base64/十六进制**：Base64 含 `+/=`、纯十六进制能承载的 host 字符集与可读性均不理想；Base32 子域最省事且免费证书全覆盖。
- **防二次编码**：`rewriteOneUrl` 与运行时脚本都会跳过 `hostname.endsWith(".suffix")` 的 URL，避免把代理子域再编码一次造成目录/循环。
- **无效 label 保护**：缺失/解码失败时 `upstreamHost` 为空，后续 `fetch` 会自然报错（5xx），不返回自定义 400。

## 5. 三层资源改写机制（核心）

目标是把「页面里的每个资源请求」都改写成走本代理。三层分工不同、相互配合：

### 5.1 Worker 侧 HTML 链接替换（HTMLRewriter）

对 `text/html` 响应用 `HTMLRewriter`＋显式「元素+属性」选择器，把标签属性里的绝对 `http(s)` URL 的 host 改写成 `base32(host).suffix`：

| 选择器 | 属性 |
|---|---|
| `a, area, link` | `href` |
| `script, img, iframe, embed, source, video, audio` | `src` |
| `img, source` | `srcset`（含 `URL+尺寸` 混合串） |
| `form` | `action` |
| `link` | `data-href, data-base-href` |
| `img` | `data-src` |
| `meta` | `content`（og:url / og:image 等） |

> 技术要点：**不要用 `on("*")`** 遍历所有元素——实测会在首个元素处截断整个 HTML 转换流，导致页面只剩一行（"空页面只有 CF 脚本"）。必须改用逐组显式注册处理器。

### 5.2 首屏请求处理器（内联脚本，即时拦截层）

直接**内联**在返回 HTML 的 `<head>` 里（随 HTML 立即执行，不依赖独立文件下载），在 SW 激活前先把页面发起的请求改写走代理，弥补首次导航空窗：

- 补丁 `window.fetch`：经 `rewriteInput()` 同时改写字符串 URL 与 **`Request` 对象**（GitHub 前端常以 `fetch(request)` 调用，纯字符串补丁拦不到）。
- 补丁 `XMLHttpRequest.prototype.open`：改写 XHR 的 url。

**限制**：只能兜住「补丁之后、显式通过 `window.fetch`/XHR」发起的请求；若调用方早已缓存原生 `fetch` 引用、或走非标准发起通道，则漏网——这正是需要 SW 兜底的原因。

### 5.3 Service Worker（网络层全拦截）

`/service-worker-request-handler.js` 由 `head` 内注入的注册脚本以 `scope:"/"` 注册，并 `skipWaiting()` + `clients.claim()` 尽快接管页面：

- 在 `fetch` 事件中拦截该来源**所有出站请求**（含跨域资源），不关心由哪个脚本、以何种方式、何时发起。
- 对命中「任意外部域名」的请求改写为代理子域，经 `respondWith(fetch(代理地址, { method, headers, body }))` 发出。
- **不限于 GET/HEAD**：非 GET/HEAD 也会改写并透传 `method` 与 `body`。

### 5.4 首屏脚本 vs Service Worker 的区别

| 维度 | 首屏请求处理器（内联脚本） | Service Worker |
|---|---|---|
| 运行位置 | 页面主线程（`<head>` 内联） | 独立 Worker（浏览器层） |
| 生效时机 | 随首屏 HTML 立即生效 | 需先注册→激活，**首次加载后有刷新空窗** |
| 拦截范围 | 仅 `window.fetch("字符串"/Request)` / XHR | 该来源**所有**出站请求（网络层） |
| 拦截方式 | 改写调用参数 | `fetch` 事件全拦截 |
| 可靠性 | 中（缓存引用/非标准通道会漏） | 高（不依赖调用方式） |
| 角色定位 | 补首屏空窗 | 长稳的全拦截主力 |

### 5.5 SW 生命周期与各阶段能拦截什么

```
首次访问:
  HTML 请求(Worker) ──HTMLRewriter──> HTML(含内联首屏脚本 + SW注册脚本)
  └─ <head> 内联脚本立即执行（拦截 SW 激活前的请求）
  └─ 注册 script 注册 SW → ready 后若无 controller → reload() 一次
  刷新后: SW 已激活 + clients.claim() 已接管 → 该来源所有出站请求均经 SW 改写
```

- **install → `skipWaiting()`**：立即准备激活，不等到页面关闭。
- **activate → `clients.claim()`**：让 SW 不用刷新就接管已打开的页面。
- **fetch 事件**：一旦控制页面，所有出站请求都必须经过，SW 统一改写走代理。

## 6. 演进与修复记录

1. **Base32 子域**：取代早期连字符歧义方案。
2. **DNS NXDOMAIN**：补 `*` 通配 A 记录；本地 DNS 负缓存 flush 后生效。
3. **CORS**：`Access-Control-Allow-Origin:*`；**删除上游 CSP**，避免按源站域名写的 CSP 误杀代理子域下的同源子资源。
4. **裸 TCP `cloudflare:sockets` 去头（已弃用）**：手写 HTTP 报文绕过 CF 注入的 `CF-*`/`X-Forwarded-For`；后因完整性与可用性取舍，改回纯原生 fetch。
5. **HTML 改写**：先后经历 `on("*")` 截断流、显式处理器两种实现，最终用显式处理器并直接返回 `transform` 的 Response。
6. **manifest JSON 改写（曾加，后删）**：曾整块重写 manifest 图标绝对 URL；因精简随设计删除，现直接透传。
7. **拦截机制迭代**：
   - 一开始只有 HTML 属性替换 → `expanded_assets` 等 JS 运行时请求漏网；
   - 加独立文件 `first-screen-request-handler.js`；
   - 发现 `Request` 对象/缓存引用仍漏网 → 首屏脚本改为**内联 head** 并支持 `Request` 对象；
   - SW 从只拦 GET/HEAD 扩展到**全部方法**并透传 body；
   - SW 注册脚本增加 `forceControl`（无 controller 时 reload 一次 + sessionStorage 防循环）。
8. **备份清理**：删除历史 `.bak` 与备份目录，`src/` 仅保留当前 `index.js`。

## 7. 配置文件

```toml
# wrangler.toml
name = "speedup"
main = "src/index.js"
compatibility_date = "2025-01-01"

[vars]
SUFFIX = "mc-lhz.de5.net"

routes = [
  { pattern = "*.mc-lhz.de5.net/*", zone_name = "mc-lhz.de5.net" }
]
```

## 8. 已知边界与局限

- **目标站必须支持 HTTPS**：Worker 强制 `https:`。纯 HTTP 站点（如 `neverssl.com`、`example.com`）会因连接超时返回 **5xx**。
- **请求头/CSP 只删除不重写**：仅按当前需求删除 CSP；更细的跨域/安全头策略可按需扩展。
- **SW 首次注册空窗**：首次打开页面时 SW 尚未激活，可能仍有少量请求直连外部 → 被 PNA 拦；注册脚本会**自动刷新一次**让 `clients.claim()` 接管，且 inner 内联脚本已覆盖空窗期。仍建议首次访问后刷新一次最稳妥。
- **Web Components / 特殊属性**：个别非标准标签属性（如第三方埋点 `data-fs-script-domain`）未被显式选择器覆盖，但不影响资源加载。
- **hosts 根治仍在客户端**：要 100% 消灭 loopback 拦截，最彻底的是去除本地 hosts 里 github 等域名的 `127.0.0.1` 映射，或把加速器切成「系统代理」模式；代理侧机制是对此的补充兜底。

## 9. 验证结果（2026-09-08）

- `/service-worker-request-handler.js` 在任意代理子域返回 `200 text/javascript`，透传 `method`/`body` 的分支存在，旧 GET/HEAD 跳过逻辑已移除。
- 代理页 HTML：`<head>` 内联包含 `window.fetch` 补丁（含 `rewriteInput` 与 `instanceof Request` 分支）与 `navigator.serviceWorker.register("/service-worker-request-handler.js")`、`forceControl`；无残留独立文件引用。
- HTML 链接改写 132 处 githubassets 编码子域，body 完整（约 58 万字节）。
- Base32 编码/解码往返通过；可代理 `github.com`、`postman-echo` 等站点（返回上游状态码）。

---

*本文档仅记录本项目（SpeedUp 反向代理 Worker）的实现与决策；源代码见 `src/index.js`。*