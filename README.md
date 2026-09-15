# chatgpt2api-cf

<p align="center">
  <b>Serverless OpenAI-compatible Chat Completions Gateway on Cloudflare Workers</b><br>
  Powered by <a href="https://hono.dev">Hono</a> & Cloudflare KV, reverse engineered from the anonymous ChatGPT Android API.
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

`chatgpt2api-cf` is a Cloudflare Workers port of [chatgpt2api](https://github.com/6Kmfi6HP/chatgpt2api). It transforms the reverse-engineered **anonymous** ChatGPT Android API into an OpenAI-compatible `/v1/chat/completions` gateway that runs entirely on Cloudflare's global edge network.

**No account, no login, and no OpenAI API key required.** Identity is maintained as a pool of anonymous device UUIDs in Cloudflare KV. When upstream rate-limits an identity (HTTP 429), the gateway cools it down, auto-provisions a fresh replacement, and retries seamlessly in the same request.

---

## 🌟 Key Highlights

- **⚡️ 100% Serverless & Ultra-Fast**: Runs on Cloudflare Workers with ~5-10ms cold boot and zero server maintenance. Bundles to just ~44 KiB.
- **🔄 Cloudflare KV Device Pool & Round-Robin**: Manages a bounded pool of device identities in KV with L1 memory caching and round-robin load distribution.
- **🛡 Automated 429 Cooldown & In-Flight Retry**: Catches 429/403/401 errors, evicts burned credentials, provisions fresh UUIDs, and retries up to 3 times before returning to the client.
- **✂️ Snapshot Diffing & PUA Citation Cleaning**:
  - Translates cumulative upstream snapshots into true incremental OpenAI SSE deltas.
  - Cleans PUA Unicode markers (`\ue200` ~ `\ue201`) and ASCII citation tags (`turn0news...`).
  - Converts search citations into inline Markdown links (`[Attribution](URL)`).
  - Withholds partial citation markers split across SSE frame boundaries.
- **🛑 Client Abort & Stream Cancellation**: Full `AbortSignal` propagation. If a client disconnects or clicks "Stop Generating", upstream fetching and reading are canceled immediately, saving CPU and quota.
- **🌏 Accurate Token Estimation**: CJK-aware token estimator (~1.5 tokens/char for Chinese/Japanese/Korean) and chars/4 for ASCII.
- **🔑 Dual Authentication Support**: Compatible with standard `Authorization: Bearer <key>` and `x-api-key: <key>`.
- **💬 True Multi-Turn Continuity**: every OpenAI message maps to a native upstream frame. Follow-up turns replay the full history as real conversation turns, so the anonymous model treats prior context as its own memory (labeled-transcript prompts get disowned as untrusted content on longer histories).
- **📋 Live Model Catalog**: `GET /v1/models` proxies the real anonymous catalog from upstream (`GET backend-anon/models`): `gpt-5-5`, `gpt-5-6`, `gpt-5-3-mini`, `gpt-5-5-mini`, `gpt-5-6-mini`, `auto`. Cached 1h in KV; falls back to `["auto"]` if upstream is unreachable. **No name mapping** — the slug you request is passed through verbatim, so you can select `gpt-5-6` or a cheaper mini yourself.
- **🔎 Web Search ON by Default**: Requests are sent with `forceUseSearch: true`; citations auto-format as Markdown links. Per-request opt-out: `"search": false`.
- **🖼 Anonymous Image Understanding**: OpenAI `image_url` / `input_image` parts (data URLs or http(s) URLs) are transparently re-uploaded to the upstream anonymous file pipeline and attached as `image_asset_pointer` parts — no login required. Multi-image and streaming supported.
- **🛠 OpenAI Tool Calling (function calling)**: pass standard `tools` definitions; the gateway compiles them into the upstream protocol, parses model tool-call replies, and returns assistant `tool_calls` with `finish_reason: "tool_calls"` (streaming deltas included). Feed results back as `role: "tool"` messages for the next turn.
- **📍 Configurable Placement / Egress Region**: `wrangler.jsonc` ships with `"placement": { "region": "aws:us-west-2" }` so the Worker executes in the US regardless of where the client connects from (fixes regional 403 blocks, e.g. requests received at HK edge).

---

## 🏗 Architecture

```text
Client (OpenAI SDK / NextChat / Cursor / curl)
        │
        ▼ POST /v1/chat/completions
Hono Router (src/index.ts)
        │
        ├─ 1. Device Manager & KV Store (src/device.ts)
        │     • Selects least-recently-used healthy device from Cloudflare KV
        │     • Verifies sentinel token (~9 min TTL) & auto-refreshes before expiry
        │
        ├─ 2. Request Translation (src/translate.ts)
        │     • Maps each OpenAI message to a native upstream frame (multi-turn
        │       history is replayed as real conversation turns the model treats
        │       as its own memory; labeled-transcript prompts get disowned)
        │     • Builds anonymous conversation DTO (model: "auto")
        │
        ├─ 3. Upstream 3-Stage Client (src/client.ts)
        │     • Stage 1: POST /backend-anon/sentinel/chat-requirements
        │     • Stage 2: POST /backend-anon/f/conversation/prepare  (conduit token)
        │     • Stage 3: POST /backend-anon/f/conversation          (SSE stream)
        │     • Carries genuine Android client headers (OAI-Device-Id, User-Agent, etc.)
        │
        └─ 4. Streaming Processor & Citation Formatter (src/stream.ts & src/citations.ts)
              • Snapshot diffing (cumulative snapshots → incremental chunks)
              • Strips / converts PUA & ASCII citations into Markdown links
              • Listens for client AbortSignal to cancel upstream streaming
              • Emits OpenAI chat.completion.chunk stream or JSON completion
```

---

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18+ & [pnpm](https://pnpm.io/) (or npm / bun)
- Cloudflare account with [Wrangler](https://developers.cloudflare.com/workers/wrangler/) authenticated (`pnpm exec wrangler login`)

### 2. Clone & Install

```bash
git clone https://github.com/6Kmfi6HP/chatgpt2api-cf.git
cd chatgpt2api-cf
pnpm install
```

### 3. Create Cloudflare KV Namespace

Create the remote KV namespace:

```bash
pnpm exec wrangler kv namespace create CHATGPT_KV
```

Copy the generated `id` into `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "CHATGPT_KV",
      "id": "<YOUR_KV_NAMESPACE_ID>"
    }
  ]
}
```

### 4. Local Development

Run the local development server:

```bash
pnpm dev
```

Your service is now running at `http://localhost:8787`.

### 5. Deploy to Cloudflare Workers

Deploy globally with one command:

```bash
pnpm run deploy
```

#### Configuring Placement (outbound region)

The worker's *egress* location (the IP region OpenAI sees) is controlled by the
[`placement` block](https://developers.cloudflare.com/workers/configuration/smart-placement/) in `wrangler.jsonc`:

```jsonc
"placement": {
  // "mode": "smart"                    // Cloudflare auto-learns (needs multi-region traffic)
  "region": "aws:us-west-2"             // run in/near a US region (aws:/gcp:/azure: regions)
  // "host": "db.example.com:5432"      // TCP probe hint
  // "hostname": "api.example.com"      // HTTP HEAD probe hint (ineffective for anycast hosts)
}
```

`android.chat.openai.com` is Cloudflare-anycast, so `hostname` hints do NOT work (documented upstream). Use a fixed `region` to pin egress (e.g. `aws:us-west-2` → Seattle). Verify with the `cf-placement` response header (`remote-SEA` = executed in Seattle).

After changing it: `pnpm run deploy`. Effect is immediate; `cf-placement` tells you per-request where the Worker actually ran.

---

## ⚙️ Configuration

Environment variables can be set in `wrangler.jsonc` or as Cloudflare Worker Secrets:

| Variable | Default | Description |
|---|---|---|
| `API_KEYS` | `""` | Comma-separated list of allowed API keys. If empty, the proxy is public. |
| ~~`MODELS`~~ | — | **Removed.** Models are no longer configurable or mappable: `GET /v1/models` fetches the live anonymous catalog (KV-cached 1h, fallback `auto`) and every requested slug is passed through verbatim. |
| `DEVICE_POOL_SIZE` | `"3"` | Bounded pool capacity of device identities maintained in KV. |

---

## 📖 API Usage Examples

The gateway exposes standard OpenAI endpoints:

- `GET /`: Gateway status, models, and service info.
- `GET /health` or `GET /healthz`: Health check endpoint.
- `GET /v1/models`: OpenAI-compatible models catalog.
- `POST /v1/chat/completions`: Chat completions endpoint (supports both streaming and non-streaming).

### 1. Curl

#### Streaming (`stream: true`):

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-6",
    "messages": [
      {"role": "user", "content": "Explain quantum computing in 3 sentences."}
    ],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

#### Non-Streaming (`stream: false`):

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-6",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### 2. Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="none"  # Or your configured API_KEYS
)

response = client.chat.completions.create(
    model="gpt-5-6",
    messages=[{"role": "user", "content": "Write a haiku about Cloudflare."}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### 3. Image Understanding (Vision)

Send standard OpenAI `image_url` content parts (data URL or public http(s) URL). The gateway
re-uploads the image to the upstream anonymous file pipeline and attaches it to the message —
no login, no API key on the upstream side:

```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "How many white squares are in the image?"},
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
            {"type": "text", "text": "Describe this image."},
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
        ],
    }],
)
```

Notes:
- `input_image` (Responses-style string field) parts are also recognized; `input_text` counts as text.
- Multiple images per request are supported (attached in order).
- Uploads use the per-device anonymous quota (~10/day per pooled device); the device pool rotates automatically on 429.
- Image URLs are fetched by the Worker — private/intranet URLs are not reachable.

### 4. Tool Calling (Function Calling)

Standard OpenAI `tools` + `tool_calls` flow works through the gateway:

```python
tools = [{
    "type": "function",
    "function": {
        "name": "lookup_employee_floor",
        "description": "Look up which floor an employee works on, by full name",
        "parameters": {
            "type": "object",
            "properties": {"employee_name": {"type": "string"}},
            "required": ["employee_name"],
        },
    },
}]

# Turn 1: model requests a tool call
response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Which floor does John Hartman work on?"}],
    tools=tools,
)
tc = response.choices[0].message.tool_calls[0]
# response.choices[0].finish_reason == "tool_calls"

# Turn 2: execute the tool, feed the result back (one request)
response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "Which floor does John Hartman work on?"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": tc.id, "type": "function",
             "function": {"name": "lookup_employee_floor", "arguments": tc.function.arguments}},
        ]},
        {"role": "tool", "tool_call_id": tc.id, "name": "lookup_employee_floor",
         "content": '{"floor": 7, "building": "HQ-North"}'},
    ],
    tools=tools,
)
print(response.choices[0].message.content)  # "John Hartman works on the 7th floor of HQ-North."
```

Streaming emits `delta.tool_calls` frames and `finish_reason: "tool_calls"`.

### 5. Third-Party Clients (NextChat, Chatbox, Cursor, etc.)

- **Base URL / Endpoint**: `https://<your-worker>.workers.dev/v1`
- **API Key**: Any dummy string (e.g. `sk-test`) if `API_KEYS` is empty, or your secret key.
- **Model**: `auto`, `gpt-5-5`, `gpt-5-6`, `gpt-5-3-mini`, `gpt-5-5-mini`, `gpt-5-6-mini` (see `GET /v1/models` for the live catalog).

---

## 🧪 Testing

The test suite contains **112 tests** covering citations, translations, client protocol, device pooling, SSE streaming, and Hono routing:

```bash
# Run Vitest test suite
pnpm test

# Run TypeScript type check
pnpm exec tsc --noEmit
```

---

## 📋 Honest Limitations

- **Model Pass-through**: No name mapping. The slug you send goes upstream verbatim; unknown/empty models resolve to `auto`. See `GET /v1/models` for the real anonymous catalog.
- **Web Search ON by default**: requests send `forceUseSearch: true`; reply citations are auto-formatted as Markdown links. Per-request opt-out: `"search": false`.
- **Sampling Knobs**: Knobs like `temperature`, `top_p`, `seed`, and function calling/tools are accepted for client compatibility, but ignored by upstream.
- **Multimodal**: Image parts are supported (re-uploaded to the anonymous file pipeline, ~10 uploads/day per pooled device, pooled automatically). Audio and other attachment types are stripped. Image upload throttling upstream is per-device; the device pool rotates on 429 automatically.
- **Tool calling**: implemented via a compiled system protocol (the anonymous upstream has no native tools API). Model adherence varies across anonymous replicas; retries may be needed. Requests with tools default `search` off (the upstream web tool can hijack tool-call turns); set `"search": true` to override. `tool_choice: "none"` disables tool-calling.
- **Regional Restrictions**: Requests originating from Cloudflare edge locations in unsupported countries (e.g. Hong Kong, China) may trigger OpenAI's regional 403 blocks. Deploying with location hints or Smart Placement resolves this.

---

## 📄 License & Disclaimer

MIT License.

This project is created for interoperability research and personal experimentation. It is not affiliated with or endorsed by OpenAI. Please use responsibly and do not abuse the service.
