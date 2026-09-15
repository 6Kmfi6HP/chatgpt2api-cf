# chatgpt2api-cf

<p align="center">
  <b>基于 Cloudflare Workers 的 Serverless OpenAI 兼容聊天接口网关</b><br>
  使用 <a href="https://hono.dev">Hono</a> 框架与 Cloudflare KV 构建，深度逆向自 ChatGPT 官方 Android 匿名免登录协议。
</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README_zh.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Cloudflare%20Workers-orange?logo=cloudflare" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Framework-Hono-E36002?logo=hono" alt="Hono" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tests-112%20Passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/Bundle%20Size-~44%20KiB-success" alt="Bundle Size" />
  <img src="https://img.shields.io/badge/License-MIT-lightgrey" alt="License" />
</p>

---

`chatgpt2api-cf` 是 [chatgpt2api](https://github.com/6Kmfi6HP/chatgpt2api) 的 Cloudflare Workers 原生移植版本。它将逆向获得的 **ChatGPT 官方 Android 匿名对话协议**转换为标准的 OpenAI `/v1/chat/completions` API，完全运行在 Cloudflare 全球边缘网络上。

**无需注册账号、无需登录，不需要提供 OpenAI API Key。** 身份凭据以随机生成的 Android 设备 UUID 形式维护在 Cloudflare KV 中。当某个设备被上游限流（HTTP 429）时，网关会自动让其冷却，淘汰旧凭据并自动补足全新设备，在同一次请求中就地平滑重试。

---

## 🌟 核心特性

- **⚡️ 纯粹的 Serverless 边缘运行**：完全跑在 Cloudflare Workers 上，冷启动仅约 5~10ms，打包体积仅 ~44 KiB，免去一切常驻服务器/VPS 维护成本。
- **🔄 Cloudflare KV 设备池与平滑轮换**：在 KV 中维护受控容量的设备身份池，辅以 Worker 内存 L1 高速缓存；日常请求在健康设备间按 LRU / Round-Robin 均摊流量。
- **🛡 429 限流自动冷却与就地重试**：精准捕获 429 / 403 / 401 状态，自动遵循 `Retry-After` 退避；淘汰被限流的凭据，自动生成新 UUID 补齐，单次请求内最多自动重试 3 次，客户端完全无感知。
- **✂️ 快照差分与 PUA 引用清洗**：
  - 差分上游给出的累积快照（Cumulative Snapshot），转换为标准 OpenAI 增量流式 Delta。
  - 清洗 PUA 私有字符（`\ue200` ~ `\ue201`）以及未包含标记的 ASCII 引用（如 `turn0news...`）。
  - 解析搜索结果元数据，将引用标记自动替换为 Markdown 链接（`[来源标题](URL)`）。
  - 自动暂留并处理跨 SSE 帧边界的未闭合引用碎片，避免漏字或泄漏未完成标签。
- **🛑 客户端流式中断响应（AbortSignal）**：全链路监听客户端断开连接。当用户在前端点击“停止生成”或关闭网页时，立即中止与 OpenAI 的上游请求，彻底杜绝 Worker CPU 与上游额度浪费。
- **🌏 精确的中日韩（CJK）Token 统计**：针对汉字/假名/谚文字符进行加权统计（中文约 1.5 token/字），与官方 `tiktoken` 表现高度贴近。
- **🔑 双鉴权请求头支持**：同时支持标准的 `Authorization: Bearer <key>` 与 `x-api-key: <key>`，方便与各类客户端集成。
- **💬 真实的多轮连续对话**：每条 OpenAI 消息映射为一个上游原生消息帧。后续轮次将完整历史作为真实对话轮次重放，匿名模型会把先前上下文视作自身记忆（带角色标记的拼接文本在历史变长后会被模型当作不可信内容而"失忆"）。
- **📋 动态真实模型目录**：`GET /v1/models` 不再读静态配置，改为实时代理上游匿名目录（`GET backend-anon/models`）：`gpt-5-5`、`gpt-5-6`、`gpt-5-3-mini`、`gpt-5-5-mini`、`gpt-5-6-mini`、`auto`。KV 缓存 1 小时，上游不可达时回退 `["auto"]`。**无名称映射**：客户端传入的 slug 原样透传，可自选 gpt-5-6 或更省配额的 mini。
- **🔎 联网搜索默认开启**：所有请求自动携带 `forceUseSearch: true`，引用自动渲染为 Markdown 链接。单次关闭：`"search": false`。
- **🖼 匿名图片理解（看图）**：OpenAI `image_url` / `input_image` 内容部分（data URL 或 http(s) URL）会被透明地重新上传到上游匿名文件管线，并以 `image_asset_pointer` 形式随消息发送 —— 无需登录。支持单条消息多图与流式输出。
- **🛠 OpenAI 工具调用（Function Calling）**：传入标准 `tools` 定义即可；网关把工具协议编译进上游 system 消息，解析模型工具调用回复，返回 assistant `tool_calls` 与 `finish_reason: "tool_calls"`（含流式 delta）。执行后以 `role: "tool"` 消息回灌即可进入下一轮。
- **📍 可配置 Placement / 出站区域**：`wrangler.jsonc` 内置 `"placement": { "region": "aws:us-west-2" }`，使 Worker 无论客户端从哪里接入均在美国机房执行（修复香港等地边缘出站被区域封锁的问题）。

---

## 🏗 系统架构与数据流

```text
客户端 (OpenAI SDK / NextChat / Cursor / curl)
        │
        ▼ POST /v1/chat/completions
Hono 路由中心 (src/index.ts)
        │
        ├─ 1. 设备池与凭据管理 (src/device.ts)
        │     • 从 Cloudflare KV 选取最久未调用的未冷却设备 (Round-Robin)
        │     • 检查 Sentinel Token (~9分钟有效)，临期自动刷新
        │
        ├─ 2. 请求消息扁平化转换 (src/translate.ts)
        │     • 将 OpenAI 多轮会话逐条映射为上游原生消息帧 (多轮历史作为真实对话轮次重放, 模型视其为自身记忆)
        │     • 构造上游 Android 匿名协议 DTO (model: "auto")
        │
        ├─ 3. 上游三阶段认证客户端 (src/client.ts)
        │     • 阶段 1: POST /backend-anon/sentinel/chat-requirements
        │     • 阶段 2: POST /backend-anon/f/conversation/prepare  (获取 conduit token)
        │     • 阶段 3: POST /backend-anon/f/conversation          (建立 SSE 连接)
        │     • 伪装官方 Android 客户端指纹标头 (OAI-Device-Id, User-Agent 等)
        │
        └─ 4. 流式差分与引用处理器 (src/stream.ts & src/citations.ts)
              • 快照差分 (累积快照 → 增量 OpenAI chunk)
              • 清洗 / 转换 PUA 字符与网络搜索引用为 Markdown 链接
              • 响应客户端 AbortSignal 中断信号
              • 输出 OpenAI chat.completion.chunk 流或完整 JSON 响应
```

---

## 🚀 快速上手

### 1. 环境准备

- [Node.js](https://nodejs.org/) v18+ 与 [pnpm](https://pnpm.io/)（或 npm / bun）
- 已登录 Cloudflare 账号的 [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI（执行 `pnpm exec wrangler login`）

### 2. 克隆与安装

```bash
git clone https://github.com/6Kmfi6HP/chatgpt2api-cf.git
cd chatgpt2api-cf
pnpm install
```

### 3. 创建 Cloudflare KV 命名空间

执行以下命令创建远程 KV 命名空间：

```bash
pnpm exec wrangler kv namespace create CHATGPT_KV
```

控制台会返回类似如下的信息，将其中的 `id` 填入 `wrangler.jsonc` 中：

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "CHATGPT_KV",
      "id": "<你的_KV_NAMESPACE_ID>"
    }
  ]
}
```

### 4. 本地开发调试

启动本地模拟开发服务器：

```bash
pnpm dev
```

本地服务默认运行在 `http://localhost:8787`。

### 5. 一键部署上线

部署至 Cloudflare Workers 全球边缘：

```bash
pnpm run deploy
```

#### 配置 Placement（出站区域）

Worker 的**出口位置**（OpenAI 看到的 IP 地区）由 `wrangler.jsonc` 中的
[`placement`](https://developers.cloudflare.com/workers/configuration/smart-placement/) 段控制：

```jsonc
"placement": {
  // "mode": "smart"                    // Cloudflare 自动学习（需要多地流量，约 15 分钟）
  "region": "aws:us-west-2"             // 固定到某个云区域（aws:/gcp:/azure: 前缀）← 本项目默认
  // "host": "db.example.com:5432"      // TCP 探测提示
  // "hostname": "api.example.com"      // HTTP HEAD 探测（对 anycast 域名无效）
}
```

上游 `android.chat.openai.com` 是 Cloudflare anycast 域名，因此 `hostname` 提示**无效**（官方文档明示 anycast/多播资源不适用）。固定美国出口请使用 `region`（如 `aws:us-west-2` → 西雅图）。验证：查看响应头 `cf-placement`（`remote-SEA` 即已在西雅图执行）。

**改动后重新 deploy 即生效**；复查 `cf-placement` 头即可确认路由结果。

部署完成后会输出你的公网 Worker 访问地址（例如 `https://chatgpt2api-cf.<your-subdomain>.workers.dev`）。

---

## ⚙️ 环境变量与配置说明

可在 `wrangler.jsonc` 的 `vars` 中或在 Cloudflare 控制台的 Worker Secrets 中配置：

| 变量名 | 默认值 | 作用说明 |
|---|---|---|
| `API_KEYS` | `""` | 允许访问的 API Key 列表（逗号分隔）。留空则为**公开模式**，无需鉴权。 |
| ~~`MODELS`~~ | — | **已移除。** 模型列表不再可手工配置，也无映射逻辑：`GET /v1/models` 实时拉取匿名上游目录（KV 缓存 1 小时，失败回退 `auto`），请求模型 slug 原样透传。 |
| `DEVICE_POOL_SIZE` | `"3"` | 维护在 Cloudflare KV 内部的设备身份池严格容量上限。 |

---

## 📖 接口调用示例

本项目支持标准 OpenAI 格式接口：

- `GET /`：网关状态与发布模型概览。
- `GET /health` 或 `GET /healthz`：健康检查接口。
- `GET /v1/models`：OpenAI 规范的模型列表。
- `POST /v1/chat/completions`：聊天补全核心接口（支持 `stream: true` 与 `stream: false`）。

### 1. cURL 命令行调用

#### 流式对话 (`stream: true`):

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-6",
    "messages": [
      {"role": "user", "content": "请用简练的三句话解释量子计算。"}
    ],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

#### 非流式对话 (`stream: false`):

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-6",
    "messages": [
      {"role": "system", "content": "你是一个严谨的助手。"},
      {"role": "user", "content": "你好！"}
    ]
  }'
```

### 2. Python (官方 `openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="none"  # 若配置了 API_KEYS 则填入你的 key，未配置可填任意值
)

response = client.chat.completions.create(
    model="gpt-5-6",
    messages=[{"role": "user", "content": "写一首关于边缘计算的五言绝句。"}],
    stream=True
)

for chunk in response:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

### 3. 图片理解（看图）

使用标准 OpenAI `image_url` 内容部分（data URL 或公网 http(s) URL）即可。网关会把图片
重新上传到上游匿名文件管线并随消息附带 —— 上游侧无需登录、无需 API Key：

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "图里有几个白色方块？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
      ]
    }]
  }'
```

```python
response = client.chat.completions.create(
    model="auto",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "描述这张图片。"},
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
        ],
    }],
)
```

说明：
- 同时识别 `input_image`（Responses 风格字符串字段）；`input_text` 按文本处理。
- 支持单条消息多图（按顺序附带）。
- 上传使用每设备匿名配额（每池化设备每日约 10 次）；触发 429 时设备池自动轮换。
- 图片 URL 由 Worker 抓取 —— 内网/私有地址不可达。

### 4. 工具调用（Function Calling）

标准 OpenAI `tools` + `tool_calls` 流程即可使用：

```python
tools = [{
    "type": "function",
    "function": {
        "name": "lookup_employee_floor",
        "description": "按全名查询员工所在楼层",
        "parameters": {
            "type": "object",
            "properties": {"employee_name": {"type": "string"}},
            "required": ["employee_name"],
        },
    },
}]

# 第一轮: 模型发起工具调用
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "John Hartman 在几楼办公？"}],
    tools=tools,
)
tc = response.choices[0].message.tool_calls[0]
# response.choices[0].finish_reason == "tool_calls"

# 第二轮: 执行工具后回灌结果（一次请求完成）
response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "John Hartman 在几楼办公？"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": tc.id, "type": "function",
             "function": {"name": "lookup_employee_floor", "arguments": tc.function.arguments}},
        ]},
        {"role": "tool", "tool_call_id": tc.id, "name": "lookup_employee_floor",
         "content": '{"floor": 7, "building": "HQ-North"}'},
    ],
    tools=tools,
)
print(response.choices[0].message.content)  # "John Hartman 在 HQ-North 的 7 楼办公。"
```

流式模式会输出 `delta.tool_calls` 帧与 `finish_reason: "tool_calls"`。

### 5. 常见客户端配置（NextChat、Chatbox、Cursor、Cline 等）

- **接口地址 (Base URL / API Host)**: `https://<your-worker>.workers.dev/v1`
- **API Key**: 若环境变量 `API_KEYS` 留空，可填任意占位符（如 `sk-test`）；若设置了密钥则填入对应值。
- **模型名称 (Model)**: `auto`、`gpt-5-5`、`gpt-5-6`、`gpt-5-3-mini`、`gpt-5-5-mini`、`gpt-5-6-mini`（实时目录见 `GET /v1/models`）。

---

## 🧪 自动化测试与质量检验

本项目包含完整的单元测试与端到端测试套件，涵盖协议转换、引用清洗、三阶段状态机、KV 轮换淘汰与流式差分：

```bash
# 运行全部 112 项测试用例 (基于 Vitest)
pnpm test

# 严格 TypeScript 类型检查
pnpm exec tsc --noEmit
```

---

## 📋 客观局限性说明

- **模型透传**：不做名称映射，客户端传入的模型 slug 原样发往上层；空/无效回退为 `auto`。
- **联网搜索默认开启**：请求携带 `forceUseSearch: true`，引用自动整理为 Markdown 链接。单次请求关闭：`"search": false`。
- **采样参数**：上游匿名层不支持 `temperature`、`top_p`、`seed` 以及函数调用（Function Calling / Tools）；网关会正常吸收这些参数以兼容客户端，但不会影响上游输出。
- **多模态**：支持图片部分（自动重上传至匿名文件管线，每设备每日约 10 次上传配额，由设备池自动轮换）；音频及其他附件类型仍会被剔除。
- **工具调用**：通过编译的 system 协议实现（匿名上游无原生 tools API）。模型服从度因匿名副本而异，必要时重试。带 tools 的请求默认关闭联网搜索（上游 web 工具可能劫持工具调用轮次）；用 `"search": true` 可显式开启。`tool_choice: "none"` 完全禁用工具调用。
- **边缘地区限制**：OpenAI 对部分国家/地区（如中国香港节点）有 IP 封锁。若你的 Worker 请求正好经由受限地区节点出站，可能会遇到 OpenAI 的地区性 403。可配置 Cloudflare Smart Placement 或 Location Hint 优化出站。

---

## 📄 开源许可与免责声明

本项目采用 [MIT 许可证](./LICENSE)。

本项目仅用于协议互操作性研究、个人技术实验及学习用途，与 OpenAI 官方无任何关联或背书。请在遵循服务条款的前提下合理、合规使用。
