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
- **📋 Live Model Catalog**: `GET /v1/models` proxies the real anonymous catalog from upstream (`GET backend-anon/models`): `gpt-5-5`, `gpt-5-6`, `gpt-5-3-mini`, `gpt-5-5-mini`, `gpt-5-6-mini`, `auto`. Cached 1h in KV; falls back to `["auto"]` if upstream is unreachable. **No name mapping** — the slug you request is passed through verbatim, so you can select `gpt-5-6` or a cheaper mini yourself.
- **🔎 Web Search ON by Default**: Requests are sent with `forceUseSearch: true`; citations auto-format as Markdown links. Per-request opt-out: `"search": false`.
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
        │     • Flattens multi-turn OpenAI messages → labeled transcript
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

### 3. Third-Party Clients (NextChat, Chatbox, Cursor, etc.)

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
- **Multimodal**: Only `text` parts are forwarded; images/audio parts are stripped.
- **Regional Restrictions**: Requests originating from Cloudflare edge locations in unsupported countries (e.g. Hong Kong, China) may trigger OpenAI's regional 403 blocks. Deploying with location hints or Smart Placement resolves this.

---

## 📄 License & Disclaimer

MIT License.

This project is created for interoperability research and personal experimentation. It is not affiliated with or endorsed by OpenAI. Please use responsibly and do not abuse the service.
