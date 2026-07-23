# Supported models

> Generated from the pi model registry ([models.dev](https://models.dev)) — do not edit by hand.
> Regenerate with `make models-list`.

codegenie is multi-provider: **1092 models** across **37 providers**. Use any of them as:

- `codegenie review --provider <provider> --model <model> [--reasoning <level>]`
- `codegenie provider use <fuzzy>` (e.g. `use opus`) to set a default
- the GitHub Action `model` input: `provider/model[:reasoning]`, e.g. `anthropic/claude-opus-4-8:xhigh`

The **Reasoning levels** column shows each model's native thinking levels from the registry (a dash means none).
codegenie's `--reasoning` flag (and the `:reasoning` suffix) accepts `low`, `medium`, `high`, `xhigh`, or `auto`
and maps onto whatever the model natively supports. Listing here means the model is known, not authenticated —
connect a provider with `codegenie provider login <provider>` (or env vars / the Action's `llm-api-key`).

## amazon-bedrock

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `amazon.nova-2-lite-v1:0` | Nova 2 Lite | 128k | 4096 | minimal, low, medium, high |
| `amazon.nova-lite-v1:0` | Nova Lite | 300k | 8192 | — |
| `amazon.nova-micro-v1:0` | Nova Micro | 128k | 8192 | — |
| `amazon.nova-pro-v1:0` | Nova Pro | 300k | 8192 | — |
| `anthropic.claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic.claude-opus-4-1-20250805-v1:0` | Claude Opus 4.1 | 200k | 32k | minimal, low, medium, high |
| `anthropic.claude-opus-4-5-20251101-v1:0` | Claude Opus 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic.claude-opus-4-6-v1` | Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `anthropic.claude-opus-4-7` | Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic.claude-opus-4-8` | Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 | 1000k | 64k | minimal, low, medium, high, max |
| `anthropic.claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `au.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 (AU) | 200k | 64k | minimal, low, medium, high |
| `au.anthropic.claude-opus-4-6-v1` | AU Anthropic Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `au.anthropic.claude-opus-4-8` | Claude Opus 4.8 (AU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `au.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (AU) | 200k | 64k | minimal, low, medium, high |
| `au.anthropic.claude-sonnet-4-6` | AU Anthropic Claude Sonnet 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `au.anthropic.claude-sonnet-5` | Claude Sonnet 5 (AU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `deepseek.r1-v1:0` | DeepSeek-R1 | 128k | 32768 | minimal, low, medium, high |
| `deepseek.v3-v1:0` | DeepSeek-V3.1 | 163840 | 81920 | minimal, low, medium, high |
| `deepseek.v3.2` | DeepSeek-V3.2 | 163840 | 81920 | minimal, low, medium, high |
| `eu.anthropic.claude-fable-5` | Claude Fable 5 (EU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 (EU) | 200k | 64k | minimal, low, medium, high |
| `eu.anthropic.claude-opus-4-5-20251101-v1:0` | Claude Opus 4.5 (EU) | 200k | 64k | minimal, low, medium, high |
| `eu.anthropic.claude-opus-4-6-v1` | Claude Opus 4.6 (EU) | 1000k | 128k | minimal, low, medium, high, max |
| `eu.anthropic.claude-opus-4-7` | Claude Opus 4.7 (EU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `eu.anthropic.claude-opus-4-8` | Claude Opus 4.8 (EU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (EU) | 200k | 64k | minimal, low, medium, high |
| `eu.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 (EU) | 1000k | 64k | minimal, low, medium, high, max |
| `eu.anthropic.claude-sonnet-5` | Claude Sonnet 5 (EU) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `global.anthropic.claude-fable-5` | Claude Fable 5 (Global) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 (Global) | 200k | 64k | minimal, low, medium, high |
| `global.anthropic.claude-opus-4-5-20251101-v1:0` | Claude Opus 4.5 (Global) | 200k | 64k | minimal, low, medium, high |
| `global.anthropic.claude-opus-4-6-v1` | Claude Opus 4.6 (Global) | 1000k | 128k | minimal, low, medium, high, max |
| `global.anthropic.claude-opus-4-7` | Claude Opus 4.7 (Global) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `global.anthropic.claude-opus-4-8` | Claude Opus 4.8 (Global) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (Global) | 200k | 64k | minimal, low, medium, high |
| `global.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 (Global) | 1000k | 64k | minimal, low, medium, high, max |
| `global.anthropic.claude-sonnet-5` | Claude Sonnet 5 (Global) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `google.gemma-3-27b-it` | Google Gemma 3 27B Instruct | 202752 | 8192 | — |
| `google.gemma-3-4b-it` | Gemma 3 4B IT | 128k | 4096 | — |
| `jp.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 (JP) | 200k | 64k | minimal, low, medium, high |
| `jp.anthropic.claude-opus-4-7` | Claude Opus 4.7 (JP) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `jp.anthropic.claude-opus-4-8` | Claude Opus 4.8 (JP) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (JP) | 200k | 64k | minimal, low, medium, high |
| `jp.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 (JP) | 1000k | 64k | minimal, low, medium, high, max |
| `jp.anthropic.claude-sonnet-5` | Claude Sonnet 5 (JP) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `meta.llama3-1-70b-instruct-v1:0` | Llama 3.1 70B Instruct | 128k | 4096 | — |
| `meta.llama3-1-8b-instruct-v1:0` | Llama 3.1 8B Instruct | 128k | 4096 | — |
| `meta.llama3-3-70b-instruct-v1:0` | Llama 3.3 70B Instruct | 128k | 4096 | — |
| `meta.llama4-maverick-17b-instruct-v1:0` | Llama 4 Maverick 17B Instruct | 1000k | 16384 | — |
| `meta.llama4-scout-17b-instruct-v1:0` | Llama 4 Scout 17B Instruct | 3500k | 16384 | — |
| `minimax.minimax-m2` | MiniMax M2 | 204608 | 128k | minimal, low, medium, high |
| `minimax.minimax-m2.1` | MiniMax M2.1 | 204800 | 131072 | minimal, low, medium, high |
| `minimax.minimax-m2.5` | MiniMax M2.5 | 196608 | 98304 | minimal, low, medium, high |
| `mistral.devstral-2-123b` | Devstral 2 123B | 256k | 8192 | — |
| `mistral.magistral-small-2509` | Magistral Small 1.2 | 128k | 40k | minimal, low, medium, high |
| `mistral.ministral-3-14b-instruct` | Ministral 14B 3.0 | 128k | 4096 | — |
| `mistral.ministral-3-3b-instruct` | Ministral 3 3B | 256k | 8192 | — |
| `mistral.ministral-3-8b-instruct` | Ministral 3 8B | 128k | 4096 | — |
| `mistral.mistral-large-3-675b-instruct` | Mistral Large 3 | 256k | 8192 | — |
| `mistral.pixtral-large-2502-v1:0` | Pixtral Large (25.02) | 128k | 8192 | — |
| `mistral.voxtral-mini-3b-2507` | Voxtral Mini 3B 2507 | 128k | 4096 | — |
| `mistral.voxtral-small-24b-2507` | Voxtral Small 24B 2507 | 32k | 8192 | — |
| `moonshot.kimi-k2-thinking` | Kimi K2 Thinking | 262143 | 16k | minimal, low, medium, high |
| `moonshotai.kimi-k2.5` | Kimi K2.5 | 262143 | 16k | minimal, low, medium, high |
| `nvidia.nemotron-nano-12b-v2` | NVIDIA Nemotron Nano 12B v2 VL BF16 | 128k | 4096 | — |
| `nvidia.nemotron-nano-3-30b` | NVIDIA Nemotron Nano 3 30B | 128k | 4096 | minimal, low, medium, high |
| `nvidia.nemotron-nano-9b-v2` | NVIDIA Nemotron Nano 9B v2 | 128k | 4096 | — |
| `nvidia.nemotron-super-3-120b` | NVIDIA Nemotron 3 Super 120B A12B | 262144 | 131072 | minimal, low, medium, high |
| `openai.gpt-5.4` | GPT-5.4 | 272k | 128k | minimal, low, medium, high, xhigh |
| `openai.gpt-5.5` | GPT-5.5 | 272k | 128k | minimal, low, medium, high, xhigh |
| `openai.gpt-5.6-luna` | GPT-5.6 Luna | 272k | 128k | minimal, low, medium, high, xhigh |
| `openai.gpt-5.6-sol` | GPT-5.6 Sol | 272k | 128k | minimal, low, medium, high, xhigh |
| `openai.gpt-5.6-terra` | GPT-5.6 Terra | 272k | 128k | minimal, low, medium, high, xhigh |
| `openai.gpt-oss-120b` | gpt-oss-120b | 128k | 16384 | minimal, low, medium, high |
| `openai.gpt-oss-120b-1:0` | gpt-oss-120b | 128k | 16384 | minimal, low, medium, high |
| `openai.gpt-oss-20b` | gpt-oss-20b | 128k | 16384 | minimal, low, medium, high |
| `openai.gpt-oss-20b-1:0` | gpt-oss-20b | 128k | 16384 | minimal, low, medium, high |
| `openai.gpt-oss-safeguard-120b` | GPT OSS Safeguard 120B | 128k | 16384 | — |
| `openai.gpt-oss-safeguard-20b` | GPT OSS Safeguard 20B | 128k | 16384 | — |
| `qwen.qwen3-235b-a22b-2507-v1:0` | Qwen3 235B A22B 2507 | 262144 | 131072 | — |
| `qwen.qwen3-32b-v1:0` | Qwen3 32B (dense) | 16384 | 16384 | minimal, low, medium, high |
| `qwen.qwen3-coder-30b-a3b-v1:0` | Qwen3 Coder 30B A3B Instruct | 262144 | 131072 | — |
| `qwen.qwen3-coder-480b-a35b-v1:0` | Qwen3 Coder 480B A35B Instruct | 131072 | 65536 | — |
| `qwen.qwen3-coder-next` | Qwen3 Coder Next | 131072 | 65536 | minimal, low, medium, high |
| `qwen.qwen3-next-80b-a3b` | Qwen/Qwen3-Next-80B-A3B-Instruct | 262k | 262k | — |
| `qwen.qwen3-vl-235b-a22b` | Qwen/Qwen3-VL-235B-A22B-Instruct | 262k | 262k | — |
| `us.anthropic.claude-fable-5` | Claude Fable 5 (US) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Claude Haiku 4.5 (US) | 200k | 64k | minimal, low, medium, high |
| `us.anthropic.claude-opus-4-1-20250805-v1:0` | Claude Opus 4.1 (US) | 200k | 32k | minimal, low, medium, high |
| `us.anthropic.claude-opus-4-5-20251101-v1:0` | Claude Opus 4.5 (US) | 200k | 64k | minimal, low, medium, high |
| `us.anthropic.claude-opus-4-6-v1` | Claude Opus 4.6 (US) | 1000k | 128k | minimal, low, medium, high, max |
| `us.anthropic.claude-opus-4-7` | Claude Opus 4.7 (US) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `us.anthropic.claude-opus-4-8` | Claude Opus 4.8 (US) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | Claude Sonnet 4.5 (US) | 200k | 64k | minimal, low, medium, high |
| `us.anthropic.claude-sonnet-4-6` | Claude Sonnet 4.6 (US) | 1000k | 64k | minimal, low, medium, high, max |
| `us.anthropic.claude-sonnet-5` | Claude Sonnet 5 (US) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `us.deepseek.r1-v1:0` | DeepSeek-R1 (US) | 128k | 32768 | minimal, low, medium, high |
| `us.meta.llama4-maverick-17b-instruct-v1:0` | Llama 4 Maverick 17B Instruct (US) | 1000k | 16384 | — |
| `us.meta.llama4-scout-17b-instruct-v1:0` | Llama 4 Scout 17B Instruct (US) | 3500k | 16384 | — |
| `writer.palmyra-x4-v1:0` | Palmyra X4 | 122880 | 8192 | minimal, low, medium, high |
| `writer.palmyra-x5-v1:0` | Palmyra X5 | 1040k | 8192 | minimal, low, medium, high |
| `xai.grok-4.3` | Grok 4.3 | 1000k | 131072 | minimal, low, medium, high |
| `zai.glm-4.7` | GLM-4.7 | 204800 | 131072 | minimal, low, medium, high |
| `zai.glm-4.7-flash` | GLM-4.7-Flash | 200k | 131072 | minimal, low, medium, high |
| `zai.glm-5` | GLM-5 | 202752 | 101376 | minimal, low, medium, high |

## ant-ling

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `Ling-2.6-1T` | Ling 2.6 1T | 262144 | 65536 | — |
| `Ling-2.6-flash` | Ling 2.6 Flash | 262144 | 65536 | — |
| `Ring-2.6-1T` | Ring 2.6 1T | 262144 | 65536 | high, xhigh |

## anthropic

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-haiku-4-5` | Claude Haiku 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-1` | Claude Opus 4.1 (latest) | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4-1-20250805` | Claude Opus 4.1 | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4-5` | Claude Opus 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-5-20251101` | Claude Opus 4.5 | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `claude-opus-4-7` | Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-opus-4-8` | Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 (latest) | 1000k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 | 1000k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |

## azure-openai-responses

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gpt-4` | GPT-4 | 8192 | 8192 | — |
| `gpt-4-turbo` | GPT-4 Turbo | 128k | 4096 | — |
| `gpt-4.1` | GPT-4.1 | 1047576 | 32768 | — |
| `gpt-4.1-mini` | GPT-4.1 mini | 1047576 | 32768 | — |
| `gpt-4.1-nano` | GPT-4.1 nano | 1047576 | 32768 | — |
| `gpt-4o` | GPT-4o | 128k | 16384 | — |
| `gpt-4o-2024-05-13` | GPT-4o (2024-05-13) | 128k | 4096 | — |
| `gpt-4o-2024-08-06` | GPT-4o (2024-08-06) | 128k | 16384 | — |
| `gpt-4o-2024-11-20` | GPT-4o (2024-11-20) | 128k | 16384 | — |
| `gpt-4o-mini` | GPT-4o mini | 128k | 16384 | — |
| `gpt-5` | GPT-5 | 400k | 128k | minimal, low, medium, high |
| `gpt-5-chat-latest` | GPT-5 Chat Latest | 128k | 16384 | — |
| `gpt-5-codex` | GPT-5-Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5-mini` | GPT-5 Mini | 400k | 128k | minimal, low, medium, high |
| `gpt-5-nano` | GPT-5 Nano | 400k | 128k | minimal, low, medium, high |
| `gpt-5-pro` | GPT-5 Pro | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1` | GPT-5.1 | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-chat-latest` | GPT-5.1 Chat | 128k | 16384 | minimal, low, medium, high |
| `gpt-5.1-codex` | GPT-5.1 Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex mini | 400k | 128k | minimal, low, medium, high |
| `gpt-5.2` | GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-chat-latest` | GPT-5.2 Chat | 128k | 16384 | minimal, low, medium, high, xhigh |
| `gpt-5.2-codex` | GPT-5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-pro` | GPT-5.2 Pro | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-chat-latest` | GPT-5.3 Chat (latest) | 128k | 16384 | — |
| `gpt-5.3-codex` | GPT-5.3 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | 128k | 32k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-nano` | GPT-5.4 nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-pro` | GPT-5.4 Pro | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5-pro` | GPT-5.5 Pro | 1050k | 128k | medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-realtime-2.1` | GPT-Realtime-2.1 | 128k | 32k | minimal, low, medium, high |
| `o1` | o1 | 200k | 100k | minimal, low, medium, high |
| `o1-pro` | o1-pro | 200k | 100k | minimal, low, medium, high |
| `o3` | o3 | 200k | 100k | minimal, low, medium, high |
| `o3-deep-research` | o3-deep-research | 200k | 100k | minimal, low, medium, high |
| `o3-mini` | o3-mini | 200k | 100k | minimal, low, medium, high |
| `o3-pro` | o3-pro | 200k | 100k | minimal, low, medium, high |
| `o4-mini` | o4-mini | 200k | 100k | minimal, low, medium, high |
| `o4-mini-deep-research` | o4-mini-deep-research | 200k | 100k | minimal, low, medium, high |

## cerebras

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gemma-4-31b` | Gemma 4 31B IT | 131072 | 40960 | minimal, low, medium, high |
| `gpt-oss-120b` | GPT OSS 120B | 131072 | 40960 | minimal, low, medium, high |
| `zai-glm-4.7` | Z.AI GLM-4.7 | 131072 | 40960 | minimal, low, medium, high |

## cloudflare-ai-gateway

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `claude-3-5-haiku` | Claude Haiku 3.5 (latest) | 200k | 8192 | — |
| `claude-3-haiku` | Claude Haiku 3 | 200k | 4096 | — |
| `claude-3-opus` | Claude Opus 3 | 200k | 4096 | — |
| `claude-3-sonnet` | Claude Sonnet 3 | 200k | 4096 | — |
| `claude-3.5-haiku` | Claude Haiku 3.5 (latest) | 200k | 8192 | — |
| `claude-3.5-sonnet` | Claude Sonnet 3.5 v2 | 200k | 8192 | — |
| `claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-haiku-4-5` | Claude Haiku 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4` | Claude Opus 4 (latest) | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4-1` | Claude Opus 4.1 (latest) | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4-5` | Claude Opus 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 (latest) | 1000k | 128k | minimal, low, medium, high, max |
| `claude-opus-4-7` | Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-opus-4-8` | Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-sonnet-4` | Claude Sonnet 4 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1000k | 64k | minimal, low, medium, high, max |
| `claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-4` | GPT-4 | 8192 | 8192 | — |
| `gpt-4-turbo` | GPT-4 Turbo | 128k | 4096 | — |
| `gpt-4o` | GPT-4o | 128k | 16384 | — |
| `gpt-4o-mini` | GPT-4o mini | 128k | 16384 | — |
| `gpt-5.1` | GPT-5.1 | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex` | GPT-5.1 Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5.2` | GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-codex` | GPT-5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-codex` | GPT-5.3 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `o1` | o1 | 200k | 100k | minimal, low, medium, high |
| `o3` | o3 | 200k | 100k | minimal, low, medium, high |
| `o3-mini` | o3-mini | 200k | 100k | minimal, low, medium, high |
| `o3-pro` | o3-pro | 200k | 100k | minimal, low, medium, high |
| `o4-mini` | o4-mini | 200k | 100k | minimal, low, medium, high |
| `workers-ai/@cf/moonshotai/kimi-k2.5` | Kimi K2.5 | 256k | 256k | minimal, low, medium, high |
| `workers-ai/@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 256k | 256k | minimal, low, medium, high |
| `workers-ai/@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k | 256k | minimal, low, medium, high |
| `workers-ai/@cf/zai-org/glm-4.7-flash` | GLM-4.7-Flash | 131072 | 131072 | minimal, low, medium, high |
| `workers-ai/@cf/zai-org/glm-5.2` | Glm 5.2 | 262144 | 262144 | minimal, low, medium, high |

## cloudflare-workers-ai

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `@cf/google/gemma-4-26b-a4b-it` | Gemma 4 26B A4B IT | 256k | 16384 | minimal, low, medium, high |
| `@cf/ibm-granite/granite-4.0-h-micro` | Granite 4.0 H Micro | 131k | 131k | — |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Llama 3.3 70B Instruct fp8 Fast | 24k | 24k | — |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout 17B 16E Instruct | 131k | 16384 | — |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Mistral Small 3.1 24B Instruct | 128k | 128k | — |
| `@cf/moonshotai/kimi-k2.6` | Kimi K2.6 | 262144 | 256k | minimal, low, medium, high |
| `@cf/moonshotai/kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `@cf/nvidia/nemotron-3-120b-a12b` | Nemotron 3 Super 120B | 256k | 256k | minimal, low, medium, high |
| `@cf/openai/gpt-oss-120b` | GPT OSS 120B | 128k | 16384 | minimal, low, medium, high |
| `@cf/openai/gpt-oss-20b` | GPT OSS 20B | 128k | 16384 | minimal, low, medium, high |
| `@cf/qwen/qwen3-30b-a3b-fp8` | Qwen3 30B A3b fp8 | 32768 | 32768 | minimal, low, medium, high |
| `@cf/zai-org/glm-4.7-flash` | GLM-4.7-Flash | 131072 | 131072 | minimal, low, medium, high |
| `@cf/zai-org/glm-5.2` | Glm 5.2 | 262144 | 262144 | minimal, low, medium, high |

## deepseek

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | high, max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | high, max |

## fireworks

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `accounts/fireworks/models/deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | minimal, low, medium, high |
| `accounts/fireworks/models/deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | minimal, low, medium, high |
| `accounts/fireworks/models/glm-5p1` | GLM 5.1 | 202800 | 131072 | minimal, low, medium, high |
| `accounts/fireworks/models/glm-5p2` | GLM 5.2 | 1048575 | 131072 | low, medium, high, max |
| `accounts/fireworks/models/gpt-oss-120b` | GPT OSS 120B | 131072 | 32768 | minimal, low, medium, high |
| `accounts/fireworks/models/gpt-oss-20b` | GPT OSS 20B | 131072 | 32768 | minimal, low, medium, high |
| `accounts/fireworks/models/kimi-k2p6` | Kimi K2.6 | 262k | 262k | minimal, low, medium, high |
| `accounts/fireworks/models/kimi-k2p7-code` | Kimi K2.7 Code | 262k | 262k | minimal, low, medium, high |
| `accounts/fireworks/models/minimax-m2p7` | MiniMax-M2.7 | 196608 | 196608 | minimal, low, medium, high |
| `accounts/fireworks/models/minimax-m3` | MiniMax-M3 | 512k | 512k | minimal, low, medium, high |
| `accounts/fireworks/models/qwen3p7-plus` | Qwen 3.7 Plus | 262144 | 65536 | minimal, low, medium, high |
| `accounts/fireworks/routers/glm-5p1-fast` | GLM 5.1 Fast | 202800 | 131072 | minimal, low, medium, high |
| `accounts/fireworks/routers/glm-5p2-fast` | GLM 5.2 Fast | 1048575 | 131072 | low, medium, high, max |
| `accounts/fireworks/routers/kimi-k2p6-fast` | Kimi K2.6 Fast | 262k | 262k | minimal, low, medium, high |
| `accounts/fireworks/routers/kimi-k2p6-turbo` | Kimi K2.6 Turbo | 262k | 262k | minimal, low, medium, high |
| `accounts/fireworks/routers/kimi-k2p7-code-fast` | Kimi K2.7 Code Fast | 262k | 262k | minimal, low, medium, high |

## github-copilot

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-haiku-4.5` | Claude Haiku 4.5 (latest) | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4.5` | Claude Opus 4.5 (latest) | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4.6` | Claude Opus 4.6 | 1000k | 32k | minimal, low, medium, high, max |
| `claude-opus-4.7` | Claude Opus 4.7 | 1000k | 32k | minimal, low, medium, high, xhigh, max |
| `claude-opus-4.8` | Claude Opus 4.8 | 1000k | 64k | minimal, low, medium, high, xhigh, max |
| `claude-sonnet-4` | Claude Sonnet 4 (latest) | 216k | 16k | minimal, low, medium, high |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 (latest) | 200k | 32k | minimal, low, medium, high |
| `claude-sonnet-4.6` | Claude Sonnet 4.6 | 1000k | 32k | minimal, low, medium, high, max |
| `claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `gemini-2.5-pro` | Gemini 2.5 Pro | 128k | 64k | minimal, low, medium, high |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | 128k | 64k | minimal, low, medium, high |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | 1000k | 64k | minimal, low, medium, high |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 200k | 64k | minimal, low, medium, high |
| `gpt-4.1` | GPT-4.1 | 128k | 16384 | — |
| `gpt-5-mini` | GPT-5 Mini | 264k | 64k | minimal, low, medium, high |
| `gpt-5.2` | GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-codex` | GPT-5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-codex` | GPT-5.3 Codex | 1000k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 1000k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-nano` | GPT-5.4 nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 1000k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `kimi-k2.7-code` | Kimi K2.7 Code | 256k | 32k | minimal, low, medium, high |
| `mai-code-1-flash-picker` | MAI-Code-1-Flash | 256k | 128k | minimal, low, medium, high |

## google-vertex

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash-Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | 1048576 | 65536 | low, high |
| `gemini-3.1-pro-preview-customtools` | Gemini 3.1 Pro Preview Custom Tools | 1048576 | 65536 | low, high |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-flash-latest` | Gemini Flash Latest | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-flash-lite-latest` | Gemini Flash-Lite Latest | 1048576 | 65536 | minimal, low, medium, high |

## google

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gemini-2.0-flash` | Gemini 2.0 Flash | 1048576 | 8192 | — |
| `gemini-2.0-flash-lite` | Gemini 2.0 Flash-Lite | 1048576 | 8192 | — |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash-Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3-pro-preview` | Gemini 3 Pro Preview | 1048576 | 65536 | low, high |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | 1048576 | 65536 | low, high |
| `gemini-3.1-pro-preview-customtools` | Gemini 3.1 Pro Preview Custom Tools | 1048576 | 65536 | low, high |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.6-flash` | Gemini 3.6 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-flash-latest` | Gemini Flash Latest | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-flash-lite-latest` | Gemini Flash-Lite Latest | 1048576 | 65536 | minimal, low, medium, high |
| `gemma-4-26b-a4b-it` | Gemma 4 26B A4B IT | 262144 | 32768 | minimal, high |
| `gemma-4-31b-it` | Gemma 4 31B IT | 262144 | 32768 | minimal, high |

## groq

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `llama-3.1-8b-instant` | Llama 3.1 8B | 131072 | 131072 | — |
| `llama-3.3-70b-versatile` | Llama 3.3 70B | 131072 | 32768 | — |
| `meta-llama/llama-4-scout-17b-16e-instruct` | Llama 4 Scout 17B 16E | 131072 | 8192 | — |
| `openai/gpt-oss-120b` | GPT OSS 120B | 131072 | 65536 | minimal, low, medium, high |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131072 | 65536 | minimal, low, medium, high |
| `openai/gpt-oss-safeguard-20b` | Safety GPT OSS 20B | 131072 | 65536 | minimal, low, medium, high |
| `qwen/qwen3-32b` | Qwen3-32B | 131072 | 40960 | high |

## huggingface

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-R1` | DeepSeek-R1 | 64k | 32768 | minimal, low, medium, high |
| `deepseek-ai/DeepSeek-R1-0528` | DeepSeek-R1-0528 | 163840 | 163840 | minimal, low, medium, high |
| `deepseek-ai/DeepSeek-V3.2` | DeepSeek-V3.2 | 163840 | 65536 | minimal, low, medium, high |
| `deepseek-ai/DeepSeek-V4-Flash` | DeepSeek V4 Flash | 1048576 | 384k | minimal, low, medium, high |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek V4 Pro | 1048576 | 393216 | minimal, low, medium, high |
| `google/gemma-4-26B-A4B-it` | Gemma 4 26B A4B IT | 262144 | 32768 | minimal, low, medium, high |
| `google/gemma-4-31B-it` | Gemma 4 31B IT | 262144 | 32768 | minimal, low, medium, high |
| `meta-llama/Llama-3.3-70B-Instruct` | Llama-3.3-70B-Instruct | 131072 | 4096 | — |
| `MiniMaxAI/MiniMax-M2` | MiniMax-M2 | 204800 | 128k | minimal, low, medium, high |
| `MiniMaxAI/MiniMax-M2.1` | MiniMax-M2.1 | 204800 | 131072 | minimal, low, medium, high |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax-M2.5 | 204800 | 131072 | minimal, low, medium, high |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax-M2.7 | 204800 | 131072 | minimal, low, medium, high |
| `MiniMaxAI/MiniMax-M3` | MiniMax-M3 | 524288 | 128k | minimal, low, medium, high |
| `moonshotai/Kimi-K2-Instruct` | Kimi-K2-Instruct | 131072 | 16384 | — |
| `moonshotai/Kimi-K2-Instruct-0905` | Kimi-K2-Instruct-0905 | 262144 | 16384 | — |
| `moonshotai/Kimi-K2-Thinking` | Kimi-K2-Thinking | 262144 | 262144 | minimal, low, medium, high |
| `moonshotai/Kimi-K2.5` | Kimi-K2.5 | 262144 | 262144 | minimal, low, medium, high |
| `moonshotai/Kimi-K2.6` | Kimi-K2.6 | 262144 | 262144 | minimal, low, medium, high |
| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `openai/gpt-oss-120b` | GPT OSS 120B | 131072 | 32768 | minimal, low, medium, high |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131072 | 32768 | minimal, low, medium, high |
| `Qwen/Qwen3-235B-A22B` | Qwen3 235B-A22B | 40960 | 16384 | minimal, low, medium, high |
| `Qwen/Qwen3-235B-A22B-Thinking-2507` | Qwen3-235B-A22B-Thinking-2507 | 262144 | 131072 | minimal, low, medium, high |
| `Qwen/Qwen3-32B` | Qwen3 32B | 131072 | 16384 | minimal, low, medium, high |
| `Qwen/Qwen3-Coder-30B-A3B-Instruct` | Qwen3-Coder 30B-A3B Instruct | 262144 | 65536 | — |
| `Qwen/Qwen3-Coder-480B-A35B-Instruct` | Qwen3-Coder-480B-A35B-Instruct | 262144 | 66536 | — |
| `Qwen/Qwen3-Coder-Next` | Qwen3-Coder-Next | 262144 | 65536 | — |
| `Qwen/Qwen3-Next-80B-A3B-Instruct` | Qwen3-Next-80B-A3B-Instruct | 262144 | 66536 | — |
| `Qwen/Qwen3-Next-80B-A3B-Thinking` | Qwen3-Next-80B-A3B-Thinking | 262144 | 131072 | — |
| `Qwen/Qwen3.5-122B-A10B` | Qwen3.5 122B-A10B | 262144 | 65536 | minimal, low, medium, high |
| `Qwen/Qwen3.5-27B` | Qwen3.5 27B | 262144 | 65536 | minimal, low, medium, high |
| `Qwen/Qwen3.5-35B-A3B` | Qwen3.5 35B-A3B | 262144 | 65536 | minimal, low, medium, high |
| `Qwen/Qwen3.5-397B-A17B` | Qwen3.5-397B-A17B | 262144 | 32768 | minimal, low, medium, high |
| `Qwen/Qwen3.5-9B` | Qwen3.5 9B | 262144 | 65536 | minimal, low, medium, high |
| `Qwen/Qwen3.6-27B` | Qwen3.6 27B | 262144 | 65536 | minimal, low, medium, high |
| `Qwen/Qwen3.6-35B-A3B` | Qwen3.6 35B-A3B | 262144 | 65536 | minimal, low, medium, high |
| `stepfun-ai/Step-3.5-Flash` | Step 3.5 Flash | 262144 | 256k | minimal, low, medium, high |
| `stepfun-ai/Step-3.7-Flash` | Step 3.7 Flash | 262144 | 256k | minimal, low, medium, high |
| `XiaomiMiMo/MiMo-V2-Flash` | MiMo-V2-Flash | 262144 | 4096 | minimal, low, medium, high |
| `XiaomiMiMo/MiMo-V2.5-Pro` | MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `zai-org/GLM-4.5` | GLM-4.5 | 131072 | 98304 | minimal, low, medium, high |
| `zai-org/GLM-4.5-Air` | GLM-4.5-Air | 131072 | 98304 | minimal, low, medium, high |
| `zai-org/GLM-4.5V` | GLM-4.5V | 65536 | 16384 | minimal, low, medium, high |
| `zai-org/GLM-4.6` | GLM-4.6 | 204800 | 131072 | minimal, low, medium, high |
| `zai-org/GLM-4.7` | GLM-4.7 | 204800 | 131072 | minimal, low, medium, high |
| `zai-org/GLM-4.7-Flash` | GLM-4.7-Flash | 200k | 128k | minimal, low, medium, high |
| `zai-org/GLM-5` | GLM-5 | 202752 | 131072 | minimal, low, medium, high |
| `zai-org/GLM-5.1` | GLM-5.1 | 202752 | 131072 | minimal, low, medium, high |
| `zai-org/GLM-5.2` | GLM-5.2 | 262144 | 131072 | minimal, low, medium, high |

## kimi-coding

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `k3` | Kimi K3 | 1048576 | 131072 | low, high, max |
| `kimi-for-coding` | Kimi K2.7 Code | 262144 | 32768 | minimal, low, medium, high |
| `kimi-for-coding-highspeed` | Kimi For Coding HighSpeed | 262144 | 32768 | minimal, low, medium, high |

## minimax-cn

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `MiniMax-M2.7` | MiniMax-M2.7 | 204800 | 131072 | minimal, low, medium, high |
| `MiniMax-M2.7-highspeed` | MiniMax-M2.7-highspeed | 204800 | 131072 | minimal, low, medium, high |
| `MiniMax-M3` | MiniMax-M3 | 1000k | 128k | minimal, low, medium, high |

## minimax

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `MiniMax-M2.7` | MiniMax-M2.7 | 204800 | 131072 | minimal, low, medium, high |
| `MiniMax-M2.7-highspeed` | MiniMax-M2.7-highspeed | 204800 | 131072 | minimal, low, medium, high |
| `MiniMax-M3` | MiniMax-M3 | 1000k | 128k | minimal, low, medium, high |

## mistral

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `codestral-latest` | Codestral (latest) | 256k | 4096 | — |
| `devstral-2512` | Devstral 2 | 262144 | 262144 | — |
| `devstral-latest` | Devstral 2 | 262144 | 262144 | — |
| `devstral-medium-2507` | Devstral Medium | 128k | 128k | — |
| `devstral-medium-latest` | Devstral 2 (latest) | 262144 | 262144 | — |
| `devstral-small-2505` | Devstral Small 2505 | 128k | 128k | — |
| `devstral-small-2507` | Devstral Small | 128k | 128k | — |
| `labs-devstral-small-2512` | Devstral Small 2 | 256k | 256k | — |
| `magistral-medium-latest` | Magistral Medium (latest) | 128k | 16384 | minimal, low, medium, high |
| `magistral-small` | Magistral Small | 128k | 128k | minimal, low, medium, high |
| `ministral-3b-latest` | Ministral 3B (latest) | 128k | 128k | — |
| `ministral-8b-latest` | Ministral 8B (latest) | 128k | 128k | — |
| `mistral-large-2411` | Mistral Large 2.1 | 131072 | 16384 | — |
| `mistral-large-2512` | Mistral Large 3 | 262144 | 262144 | — |
| `mistral-large-latest` | Mistral Large (latest) | 262144 | 262144 | — |
| `mistral-medium-2505` | Mistral Medium 3 | 131072 | 131072 | — |
| `mistral-medium-2508` | Mistral Medium 3.1 | 262144 | 262144 | — |
| `mistral-medium-2604` | Mistral Medium 3.5 | 262144 | 262144 | minimal, low, medium, high |
| `mistral-medium-3.5` | Mistral Medium 3.5 | 262144 | 262144 | minimal, low, medium, high |
| `mistral-medium-latest` | Mistral Medium (latest) | 262144 | 262144 | minimal, low, medium, high |
| `mistral-nemo` | Mistral Nemo | 128k | 128k | — |
| `mistral-small-2506` | Mistral Small 3.2 | 128k | 16384 | — |
| `mistral-small-2603` | Mistral Small 4 | 256k | 256k | minimal, low, medium, high |
| `mistral-small-latest` | Mistral Small (latest) | 256k | 256k | minimal, low, medium, high |
| `open-mistral-7b` | Mistral 7B | 8k | 8k | — |
| `open-mistral-nemo` | Open Mistral Nemo | 128k | 128k | — |
| `open-mixtral-8x22b` | Mixtral 8x22B | 64k | 64k | — |
| `open-mixtral-8x7b` | Mixtral 8x7B | 32k | 32k | — |
| `pixtral-12b` | Pixtral 12B | 128k | 128k | — |
| `pixtral-large-latest` | Pixtral Large (latest) | 128k | 128k | — |

## moonshotai-cn

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `kimi-k2-0711-preview` | Kimi K2 0711 | 131072 | 16384 | — |
| `kimi-k2-0905-preview` | Kimi K2 0905 | 262144 | 262144 | — |
| `kimi-k2-thinking` | Kimi K2 Thinking | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2-turbo-preview` | Kimi K2 Turbo | 262144 | 262144 | — |
| `kimi-k2.5` | Kimi K2.5 | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.7-code-highspeed` | Kimi K2.7 Code HighSpeed | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k3` | Kimi K3 | 1048576 | 131072 | low, high, max |

## moonshotai

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `kimi-k2-0711-preview` | Kimi K2 0711 | 131072 | 16384 | — |
| `kimi-k2-0905-preview` | Kimi K2 0905 | 262144 | 262144 | — |
| `kimi-k2-thinking` | Kimi K2 Thinking | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2-turbo-preview` | Kimi K2 Turbo | 262144 | 262144 | — |
| `kimi-k2.5` | Kimi K2.5 | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k2.7-code-highspeed` | Kimi K2.7 Code HighSpeed | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k3` | Kimi K3 | 1048576 | 131072 | low, high, max |

## nvidia

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `meta/llama-3.1-70b-instruct` | Llama 3.1 70b Instruct | 128k | 4096 | — |
| `meta/llama-3.1-8b-instruct` | Llama 3.1 8B Instruct | 16k | 4096 | — |
| `meta/llama-3.2-11b-vision-instruct` | Llama 3.2 11b Vision Instruct | 128k | 4096 | — |
| `meta/llama-3.2-90b-vision-instruct` | Llama-3.2-90B-Vision-Instruct | 128k | 8192 | — |
| `meta/llama-3.3-70b-instruct` | Llama 3.3 70b Instruct | 128k | 4096 | — |
| `minimaxai/minimax-m3` | MiniMax-M3 | 1000k | 16384 | minimal, low, medium, high |
| `mistralai/mistral-large-3-675b-instruct-2512` | Mistral Large 3 675B Instruct 2512 | 262144 | 262144 | — |
| `mistralai/mistral-small-4-119b-2603` | mistral-small-4-119b-2603 | 128k | 8192 | minimal, low, medium, high |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | 262144 | 262144 | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-30b-a3b` | nemotron-3-nano-30b-a3b | 131072 | 131072 | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Nemotron 3 Nano Omni | 256k | 65536 | minimal, low, medium, high |
| `nvidia/nemotron-3-super-120b-a12b` | Nemotron 3 Super | 262144 | 262144 | minimal, low, medium, high |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra 550B A55B | 1000k | 65536 | minimal, low, medium, high |
| `nvidia/nvidia-nemotron-nano-9b-v2` | nvidia-nemotron-nano-9b-v2 | 131072 | 131072 | minimal, low, medium, high |
| `openai/gpt-oss-120b` | GPT-OSS-120B | 128k | 8192 | minimal, low, medium, high |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131072 | 32768 | minimal, low, medium, high |
| `stepfun-ai/step-3.5-flash` | Step 3.5 Flash | 256k | 16384 | minimal, low, medium, high |
| `stepfun-ai/step-3.7-flash` | Step 3.7 Flash | 256k | 16384 | minimal, low, medium, high |
| `z-ai/glm-5.2` | GLM-5.2 | 1000k | 131072 | minimal, low, medium, high |

## openai-codex

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | 128k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 272k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 mini | 272k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 272k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 272k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 272k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 272k | 128k | minimal, low, medium, high, xhigh, max |

## openai

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `gpt-4` | GPT-4 | 8192 | 8192 | — |
| `gpt-4-turbo` | GPT-4 Turbo | 128k | 4096 | — |
| `gpt-4.1` | GPT-4.1 | 1047576 | 32768 | — |
| `gpt-4.1-mini` | GPT-4.1 mini | 1047576 | 32768 | — |
| `gpt-4.1-nano` | GPT-4.1 nano | 1047576 | 32768 | — |
| `gpt-4o` | GPT-4o | 128k | 16384 | — |
| `gpt-4o-2024-05-13` | GPT-4o (2024-05-13) | 128k | 4096 | — |
| `gpt-4o-2024-08-06` | GPT-4o (2024-08-06) | 128k | 16384 | — |
| `gpt-4o-2024-11-20` | GPT-4o (2024-11-20) | 128k | 16384 | — |
| `gpt-4o-mini` | GPT-4o mini | 128k | 16384 | — |
| `gpt-5` | GPT-5 | 400k | 128k | minimal, low, medium, high |
| `gpt-5-chat-latest` | GPT-5 Chat Latest | 128k | 16384 | — |
| `gpt-5-codex` | GPT-5-Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5-mini` | GPT-5 Mini | 400k | 128k | minimal, low, medium, high |
| `gpt-5-nano` | GPT-5 Nano | 400k | 128k | minimal, low, medium, high |
| `gpt-5-pro` | GPT-5 Pro | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1` | GPT-5.1 | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-chat-latest` | GPT-5.1 Chat | 128k | 16384 | minimal, low, medium, high |
| `gpt-5.1-codex` | GPT-5.1 Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex mini | 400k | 128k | minimal, low, medium, high |
| `gpt-5.2` | GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-chat-latest` | GPT-5.2 Chat | 128k | 16384 | minimal, low, medium, high, xhigh |
| `gpt-5.2-codex` | GPT-5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-pro` | GPT-5.2 Pro | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-chat-latest` | GPT-5.3 Chat (latest) | 128k | 16384 | — |
| `gpt-5.3-codex` | GPT-5.3 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | GPT-5.3 Codex Spark | 128k | 32k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 272k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-nano` | GPT-5.4 nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-pro` | GPT-5.4 Pro | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 272k | 128k | low, medium, high, xhigh |
| `gpt-5.5-pro` | GPT-5.5 Pro | 1050k | 128k | medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 272k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 272k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 272k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-realtime-2.1` | GPT-Realtime-2.1 | 128k | 32k | minimal, low, medium, high |
| `o1` | o1 | 200k | 100k | minimal, low, medium, high |
| `o1-pro` | o1-pro | 200k | 100k | minimal, low, medium, high |
| `o3` | o3 | 200k | 100k | minimal, low, medium, high |
| `o3-deep-research` | o3-deep-research | 200k | 100k | minimal, low, medium, high |
| `o3-mini` | o3-mini | 200k | 100k | minimal, low, medium, high |
| `o3-pro` | o3-pro | 200k | 100k | minimal, low, medium, high |
| `o4-mini` | o4-mini | 200k | 100k | minimal, low, medium, high |
| `o4-mini-deep-research` | o4-mini-deep-research | 200k | 100k | minimal, low, medium, high |

## opencode-go

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | high, max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | high, max |
| `glm-5.1` | GLM-5.1 | 202752 | 32768 | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | high, max |
| `grok-4.5` | Grok 4.5 | 500k | 500k | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 65536 | high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `kimi-k3` | Kimi K3 (2x usage) | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5` | MiMo V2.5 | 1000k | 128k | minimal, low, medium, high |
| `mimo-v2.5-pro` | MiMo V2.5 Pro | 1048576 | 128k | minimal, low, medium, high |
| `minimax-m2.7` | MiniMax-M2.7 | 204800 | 131072 | minimal, low, medium, high |
| `minimax-m3` | MiniMax-M3 | 1000k | 131072 | minimal, low, medium, high |
| `qwen3.6-plus` | Qwen3.6 Plus | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-max` | Qwen3.7 Max | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-plus` | Qwen3.7 Plus | 1000k | 65536 | minimal, low, medium, high |

## opencode

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `big-pickle` | Big Pickle | 200k | 32k | minimal, low, medium, high |
| `claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-1` | Claude Opus 4.1 | 200k | 32k | minimal, low, medium, high |
| `claude-opus-4-5` | Claude Opus 4.5 | 200k | 64k | minimal, low, medium, high |
| `claude-opus-4-6` | Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `claude-opus-4-7` | Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-opus-4-8` | Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `claude-sonnet-4` | Claude Sonnet 4 | 200k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | 200k | 64k | minimal, low, medium, high |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 1000k | 64k | minimal, low, medium, high, max |
| `claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | high, max |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash Free | 200k | 128k | high, max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | high, max |
| `gemini-3-flash` | Gemini 3 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.1-pro` | Gemini 3.1 Pro Preview | 1048576 | 65536 | low, high |
| `gemini-3.5-flash` | Gemini 3.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `gemini-3.6-flash` | Gemini 3.6 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `glm-5` | GLM-5 | 204800 | 131072 | minimal, low, medium, high |
| `glm-5.1` | GLM-5.1 | 204800 | 131072 | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | minimal, low, medium, high |
| `gpt-5` | GPT-5 | 400k | 128k | minimal, low, medium, high |
| `gpt-5-codex` | GPT-5 Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5-nano` | GPT-5 Nano | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1` | GPT-5.1 | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex` | GPT-5.1 Codex | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max | 400k | 128k | minimal, low, medium, high |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | 400k | 128k | minimal, low, medium, high |
| `gpt-5.2` | GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.2-codex` | GPT-5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.3-codex` | GPT-5.3 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4` | GPT-5.4 | 272k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4 Mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-nano` | GPT-5.4 Nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.4-pro` | GPT-5.4 Pro | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5` | GPT-5.5 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `gpt-5.5-pro` | GPT-5.5 Pro | 1050k | 128k | medium, high, xhigh |
| `gpt-5.6-luna` | GPT-5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | GPT-5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | GPT-5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `grok-4.5` | Grok 4.5 | 500k | 500k | minimal, low, medium, high |
| `grok-build-0.1` | Grok Build 0.1 | 256k | 256k | high |
| `kimi-k2.5` | Kimi K2.5 | 262144 | 65536 | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 65536 | minimal, low, medium, high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `mimo-v2.5-free` | MiMo V2.5 Free | 200k | 32k | minimal, low, medium, high |
| `minimax-m2.5` | MiniMax-M2.5 | 204800 | 131072 | minimal, low, medium, high |
| `minimax-m2.7` | MiniMax-M2.7 | 204800 | 131072 | minimal, low, medium, high |
| `minimax-m3` | MiniMax-M3 | 512k | 128k | minimal, low, medium, high |
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1000k | 128k | minimal, low, medium, high |
| `north-mini-code-free` | North Mini Code Free | 256k | 64k | minimal, low, medium, high |
| `qwen3.5-plus` | Qwen3.5 Plus | 262144 | 65536 | minimal, low, medium, high |
| `qwen3.6-plus` | Qwen3.6 Plus | 262144 | 65536 | minimal, low, medium, high |

## openrouter

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `~anthropic/claude-fable-latest` | Anthropic: Claude Fable Latest | 1000k | 128k | minimal, low, medium, high |
| `~anthropic/claude-haiku-latest` | Anthropic Claude Haiku Latest | 200k | 64k | minimal, low, medium, high |
| `~anthropic/claude-opus-latest` | Anthropic: Claude Opus Latest | 1000k | 128k | minimal, low, medium, high |
| `~anthropic/claude-sonnet-latest` | Anthropic Claude Sonnet Latest | 1000k | 128k | minimal, low, medium, high |
| `~google/gemini-flash-latest` | Google Gemini Flash Latest | 1048576 | 65536 | minimal, low, medium, high |
| `~google/gemini-pro-latest` | Google Gemini Pro Latest | 1048576 | 65536 | minimal, low, medium, high |
| `~moonshotai/kimi-latest` | MoonshotAI Kimi Latest | 1048576 | 131072 | minimal, low, medium, high |
| `~openai/gpt-latest` | OpenAI GPT Latest | 1050k | 128k | minimal, low, medium, high |
| `~openai/gpt-mini-latest` | OpenAI GPT Mini Latest | 400k | 128k | minimal, low, medium, high |
| `~x-ai/grok-latest` | xAI: Grok Latest | 500k | 4096 | minimal, low, medium, high |
| `ai21/jamba-large-1.7` | AI21: Jamba Large 1.7 | 256k | 4096 | — |
| `aion-labs/aion-2.0` | AionLabs: Aion-2.0 | 131072 | 32768 | minimal, low, medium, high |
| `aion-labs/aion-3.0` | AionLabs: Aion-3.0 | 131072 | 32768 | minimal, low, medium, high |
| `aion-labs/aion-3.0-mini` | AionLabs: Aion-3.0-Mini | 131072 | 32768 | minimal, low, medium, high |
| `amazon/nova-2-lite-v1` | Amazon: Nova 2 Lite | 1000k | 65535 | minimal, low, medium, high |
| `amazon/nova-lite-v1` | Amazon: Nova Lite 1.0 | 300k | 5120 | — |
| `amazon/nova-micro-v1` | Amazon: Nova Micro 1.0 | 128k | 5120 | — |
| `amazon/nova-premier-v1` | Amazon: Nova Premier 1.0 | 1000k | 32k | — |
| `amazon/nova-pro-v1` | Amazon: Nova Pro 1.0 | 300k | 5120 | — |
| `anthropic/claude-fable-5` | Anthropic: Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-haiku-4.5` | Anthropic: Claude Haiku 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic/claude-opus-4.1` | Anthropic: Claude Opus 4.1 | 200k | 32k | minimal, low, medium, high |
| `anthropic/claude-opus-4.5` | Anthropic: Claude Opus 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic/claude-opus-4.6` | Anthropic: Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `anthropic/claude-opus-4.7` | Anthropic: Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.7-fast` | Anthropic: Claude Opus 4.7 (Fast) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.8` | Anthropic: Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.8-fast` | Anthropic: Claude Opus 4.8 (Fast) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-sonnet-4.5` | Anthropic: Claude Sonnet 4.5 | 1000k | 64k | minimal, low, medium, high |
| `anthropic/claude-sonnet-4.6` | Anthropic: Claude Sonnet 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `anthropic/claude-sonnet-5` | Anthropic: Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `arcee-ai/trinity-large-thinking` | Arcee AI: Trinity Large Thinking | 262144 | 80k | minimal, low, medium, high |
| `arcee-ai/virtuoso-large` | Arcee AI: Virtuoso Large | 131072 | 64k | — |
| `auto` | Auto | 2000k | 30k | minimal, low, medium, high |
| `bytedance-seed/seed-1.6` | ByteDance Seed: Seed 1.6 | 262144 | 32768 | minimal, low, medium, high |
| `bytedance-seed/seed-1.6-flash` | ByteDance Seed: Seed 1.6 Flash | 262144 | 32768 | minimal, low, medium, high |
| `bytedance-seed/seed-2.0-lite` | ByteDance Seed: Seed-2.0-Lite | 262144 | 131072 | minimal, low, medium, high |
| `bytedance-seed/seed-2.0-mini` | ByteDance Seed: Seed-2.0-Mini | 262144 | 131072 | minimal, low, medium, high |
| `cohere/command-r-08-2024` | Cohere: Command R (08-2024) | 128k | 4k | — |
| `cohere/command-r-plus-08-2024` | Cohere: Command R+ (08-2024) | 128k | 4k | — |
| `cohere/north-mini-code:free` | Cohere: North Mini Code (free) | 256k | 64k | minimal, low, medium, high |
| `deepseek/deepseek-chat` | DeepSeek: DeepSeek V3 | 128k | 16k | — |
| `deepseek/deepseek-chat-v3-0324` | DeepSeek: DeepSeek V3 0324 | 163840 | 65536 | — |
| `deepseek/deepseek-chat-v3.1` | DeepSeek: DeepSeek V3.1 | 163840 | 32768 | minimal, low, medium, high |
| `deepseek/deepseek-r1` | DeepSeek: R1 | 64k | 16k | minimal, low, medium, high |
| `deepseek/deepseek-r1-0528` | DeepSeek: R1 0528 | 163840 | 32768 | minimal, low, medium, high |
| `deepseek/deepseek-v3.1-terminus` | DeepSeek: DeepSeek V3.1 Terminus | 131072 | 32768 | minimal, low, medium, high |
| `deepseek/deepseek-v3.2` | DeepSeek: DeepSeek V3.2 | 163840 | 65536 | minimal, low, medium, high |
| `deepseek/deepseek-v3.2-exp` | DeepSeek: DeepSeek V3.2 Exp | 163840 | 65536 | minimal, low, medium, high |
| `deepseek/deepseek-v4-flash` | DeepSeek: DeepSeek V4 Flash | 1048575 | 4096 | high, xhigh |
| `deepseek/deepseek-v4-pro` | DeepSeek: DeepSeek V4 Pro | 1048576 | 384k | high, xhigh |
| `google/gemini-2.5-flash` | Google: Gemini 2.5 Flash | 1048576 | 65535 | minimal, low, medium, high |
| `google/gemini-2.5-flash-lite` | Google: Gemini 2.5 Flash Lite | 1048576 | 65535 | minimal, low, medium, high |
| `google/gemini-2.5-pro` | Google: Gemini 2.5 Pro | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-2.5-pro-preview` | Google: Gemini 2.5 Pro Preview 06-05 | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-2.5-pro-preview-05-06` | Google: Gemini 2.5 Pro Preview 05-06 | 1048576 | 65535 | minimal, low, medium, high |
| `google/gemini-3-flash-preview` | Google: Gemini 3 Flash Preview | 1048576 | 65535 | minimal, low, medium, high |
| `google/gemini-3-pro-image` | Google: Nano Banana Pro (Gemini 3 Pro Image) | 65536 | 32768 | minimal, low, medium, high |
| `google/gemini-3.1-flash-lite` | Google: Gemini 3.1 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.1-flash-lite-preview` | Google: Gemini 3.1 Flash Lite Preview | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.1-pro-preview` | Google: Gemini 3.1 Pro Preview | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.1-pro-preview-customtools` | Google: Gemini 3.1 Pro Preview Custom Tools | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.5-flash` | Google: Gemini 3.5 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.5-flash-lite` | Google: Gemini 3.5 Flash-Lite | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3.6-flash` | Google: Gemini 3.6 Flash | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemma-3-12b-it` | Google: Gemma 3 12B | 131072 | 16384 | — |
| `google/gemma-3-27b-it` | Google: Gemma 3 27B | 110k | 4096 | — |
| `google/gemma-4-26b-a4b-it` | Google: Gemma 4 26B A4B  | 262144 | 16384 | minimal, low, medium, high |
| `google/gemma-4-26b-a4b-it:free` | Google: Gemma 4 26B A4B  (free) | 131072 | 32768 | minimal, low, medium, high |
| `google/gemma-4-31b-it` | Google: Gemma 4 31B | 262144 | 16384 | minimal, low, medium, high |
| `google/gemma-4-31b-it:free` | Google: Gemma 4 31B (free) | 262144 | 32768 | minimal, low, medium, high |
| `ibm-granite/granite-4.1-8b` | IBM: Granite 4.1 8B | 131072 | 131072 | — |
| `inception/mercury-2` | Inception: Mercury 2 | 128k | 50k | minimal, low, medium, high |
| `inclusionai/ling-2.6-1t` | inclusionAI: Ling-2.6-1T | 262144 | 32768 | — |
| `inclusionai/ling-2.6-flash` | inclusionAI: Ling-2.6-flash | 262144 | 32768 | — |
| `inclusionai/ring-2.6-1t` | inclusionAI: Ring-2.6-1T | 262144 | 65536 | minimal, low, medium, high |
| `kwaipilot/kat-coder-air-v2.5` | Kwaipilot: KAT-Coder-Air V2.5 | 256k | 80k | — |
| `kwaipilot/kat-coder-pro-v2` | Kwaipilot: KAT-Coder-Pro V2 | 256k | 80k | — |
| `kwaipilot/kat-coder-pro-v2.5` | Kwaipilot: KAT-Coder-Pro V2.5 | 256k | 80k | — |
| `meituan/longcat-2.0` | Meituan: LongCat 2.0 | 1048756 | 262144 | minimal, low, medium, high |
| `meta-llama/llama-3.1-70b-instruct` | Meta: Llama 3.1 70B Instruct | 131072 | 16384 | — |
| `meta-llama/llama-3.1-8b-instruct` | Meta: Llama 3.1 8B Instruct | 131072 | 131072 | — |
| `meta-llama/llama-3.3-70b-instruct` | Meta: Llama 3.3 70B Instruct | 131072 | 128k | — |
| `meta-llama/llama-4-maverick` | Meta: Llama 4 Maverick | 1048576 | 16384 | — |
| `meta-llama/llama-4-scout` | Meta: Llama 4 Scout | 327680 | 16384 | — |
| `meta/muse-spark-1.1` | Meta: Muse Spark 1.1 | 1048576 | 4096 | minimal, low, medium, high |
| `minimax/minimax-m1` | MiniMax: MiniMax M1 | 1000k | 40k | minimal, low, medium, high |
| `minimax/minimax-m2` | MiniMax: MiniMax M2 | 204800 | 131072 | minimal, low, medium, high |
| `minimax/minimax-m2.1` | MiniMax: MiniMax M2.1 | 204800 | 131072 | minimal, low, medium, high |
| `minimax/minimax-m2.5` | MiniMax: MiniMax M2.5 | 196608 | 196608 | minimal, low, medium, high |
| `minimax/minimax-m2.7` | MiniMax: MiniMax M2.7 | 196608 | 131072 | minimal, low, medium, high |
| `minimax/minimax-m3` | MiniMax: MiniMax M3 | 524288 | 512k | minimal, low, medium, high |
| `mistralai/codestral-2508` | Mistral: Codestral 2508 | 256k | 4096 | — |
| `mistralai/devstral-2512` | Mistral: Devstral 2 2512 | 262144 | 4096 | — |
| `mistralai/ministral-14b-2512` | Mistral: Ministral 3 14B 2512 | 262144 | 4096 | — |
| `mistralai/ministral-3b-2512` | Mistral: Ministral 3 3B 2512 | 131072 | 4096 | — |
| `mistralai/ministral-8b-2512` | Mistral: Ministral 3 8B 2512 | 262144 | 4096 | — |
| `mistralai/mistral-large` | Mistral Large | 128k | 4096 | — |
| `mistralai/mistral-large-2407` | Mistral Large 2407 | 131072 | 4096 | — |
| `mistralai/mistral-large-2512` | Mistral: Mistral Large 3 2512 | 262144 | 4096 | — |
| `mistralai/mistral-medium-3` | Mistral: Mistral Medium 3 | 131072 | 4096 | — |
| `mistralai/mistral-medium-3-5` | Mistral: Mistral Medium 3.5 | 262144 | 4096 | minimal, low, medium, high |
| `mistralai/mistral-medium-3.1` | Mistral: Mistral Medium 3.1 | 131072 | 4096 | — |
| `mistralai/mistral-nemo` | Mistral: Mistral Nemo | 131072 | 16384 | — |
| `mistralai/mistral-saba` | Mistral: Saba | 32768 | 4096 | — |
| `mistralai/mistral-small-2603` | Mistral: Mistral Small 4 | 262144 | 4096 | minimal, low, medium, high |
| `mistralai/mistral-small-3.2-24b-instruct` | Mistral: Mistral Small 3.2 24B | 131072 | 4096 | — |
| `mistralai/mixtral-8x22b-instruct` | Mistral: Mixtral 8x22B Instruct | 65536 | 4096 | — |
| `mistralai/voxtral-small-24b-2507` | Mistral: Voxtral Small 24B 2507 | 32k | 4096 | — |
| `moonshotai/kimi-k2` | MoonshotAI: Kimi K2 0711 | 131072 | 100352 | — |
| `moonshotai/kimi-k2-0905` | MoonshotAI: Kimi K2 0905 | 262144 | 100352 | — |
| `moonshotai/kimi-k2-thinking` | MoonshotAI: Kimi K2 Thinking | 262144 | 100352 | minimal, low, medium, high |
| `moonshotai/kimi-k2.5` | MoonshotAI: Kimi K2.5 | 262144 | 4096 | minimal, low, medium, high |
| `moonshotai/kimi-k2.6` | MoonshotAI: Kimi K2.6 | 262144 | 262144 | minimal, low, medium, high |
| `moonshotai/kimi-k2.7-code` | MoonshotAI: Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `moonshotai/kimi-k3` | MoonshotAI: Kimi K3 | 1048576 | 131072 | minimal, low, medium, high |
| `nex-agi/nex-n2-mini` | Nex AGI: Nex-N2-Mini | 262144 | 262144 | minimal, low, medium, high |
| `nex-agi/nex-n2-pro` | Nex AGI: Nex-N2-Pro | 262144 | 262144 | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA: Nemotron 3 Nano 30B A3B | 262144 | 228k | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-30b-a3b:free` | NVIDIA: Nemotron 3 Nano 30B A3B (free) | 256k | 4096 | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | NVIDIA: Nemotron 3 Nano Omni (free) | 256k | 65536 | minimal, low, medium, high |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA: Nemotron 3 Super | 262144 | 4096 | minimal, low, medium, high |
| `nvidia/nemotron-3-super-120b-a12b:free` | NVIDIA: Nemotron 3 Super (free) | 262144 | 262144 | minimal, low, medium, high |
| `nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA: Nemotron 3 Ultra | 512288 | 4096 | minimal, low, medium, high |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | NVIDIA: Nemotron 3 Ultra (free) | 1000k | 65536 | minimal, low, medium, high |
| `nvidia/nemotron-nano-12b-v2-vl:free` | NVIDIA: Nemotron Nano 12B 2 VL (free) | 128k | 128k | minimal, low, medium, high |
| `nvidia/nemotron-nano-9b-v2:free` | NVIDIA: Nemotron Nano 9B V2 (free) | 128k | 4096 | minimal, low, medium, high |
| `openai/gpt-3.5-turbo` | OpenAI: GPT-3.5 Turbo | 16385 | 4096 | — |
| `openai/gpt-3.5-turbo-0613` | OpenAI: GPT-3.5 Turbo (older v0613) | 4095 | 4096 | — |
| `openai/gpt-3.5-turbo-16k` | OpenAI: GPT-3.5 Turbo 16k | 16385 | 4096 | — |
| `openai/gpt-4` | OpenAI: GPT-4 | 8191 | 4096 | — |
| `openai/gpt-4-turbo` | OpenAI: GPT-4 Turbo | 128k | 4096 | — |
| `openai/gpt-4-turbo-preview` | OpenAI: GPT-4 Turbo Preview | 128k | 4096 | — |
| `openai/gpt-4.1` | OpenAI: GPT-4.1 | 1047576 | 32768 | — |
| `openai/gpt-4.1-mini` | OpenAI: GPT-4.1 Mini | 1047576 | 32768 | — |
| `openai/gpt-4.1-nano` | OpenAI: GPT-4.1 Nano | 1047576 | 32768 | — |
| `openai/gpt-4o` | OpenAI: GPT-4o | 128k | 16384 | — |
| `openai/gpt-4o-2024-05-13` | OpenAI: GPT-4o (2024-05-13) | 128k | 4096 | — |
| `openai/gpt-4o-2024-08-06` | OpenAI: GPT-4o (2024-08-06) | 128k | 16384 | — |
| `openai/gpt-4o-2024-11-20` | OpenAI: GPT-4o (2024-11-20) | 128k | 16384 | — |
| `openai/gpt-4o-mini` | OpenAI: GPT-4o-mini | 128k | 16384 | — |
| `openai/gpt-4o-mini-2024-07-18` | OpenAI: GPT-4o-mini (2024-07-18) | 128k | 16384 | — |
| `openai/gpt-5` | OpenAI: GPT-5 | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-codex` | OpenAI: GPT-5 Codex | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-mini` | OpenAI: GPT-5 Mini | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-nano` | OpenAI: GPT-5 Nano | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-pro` | OpenAI: GPT-5 Pro | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1` | OpenAI: GPT-5.1 | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-chat` | OpenAI: GPT-5.1 Chat | 128k | 16384 | — |
| `openai/gpt-5.1-codex` | OpenAI: GPT-5.1-Codex | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-codex-max` | OpenAI: GPT-5.1-Codex-Max | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-codex-mini` | OpenAI: GPT-5.1-Codex-Mini | 400k | 100k | minimal, low, medium, high |
| `openai/gpt-5.2` | OpenAI: GPT-5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.2-chat` | OpenAI: GPT-5.2 Chat | 128k | 16384 | — |
| `openai/gpt-5.2-codex` | OpenAI: GPT-5.2-Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.2-pro` | OpenAI: GPT-5.2 Pro | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.3-chat` | OpenAI: GPT-5.3 Chat | 128k | 16384 | — |
| `openai/gpt-5.3-codex` | OpenAI: GPT-5.3-Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4` | OpenAI: GPT-5.4 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-mini` | OpenAI: GPT-5.4 Mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-nano` | OpenAI: GPT-5.4 Nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-pro` | OpenAI: GPT-5.4 Pro | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.5` | OpenAI: GPT-5.5 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.5-pro` | OpenAI: GPT-5.5 Pro | 1050k | 128k | medium, high, xhigh |
| `openai/gpt-5.6-luna` | OpenAI: GPT-5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-5.6-luna-pro` | OpenAI: GPT-5.6 Luna Pro | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-5.6-sol` | OpenAI: GPT-5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-5.6-sol-pro` | OpenAI: GPT-5.6 Sol Pro | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-5.6-terra` | OpenAI: GPT-5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-5.6-terra-pro` | OpenAI: GPT-5.6 Terra Pro | 1050k | 128k | minimal, low, medium, high, xhigh, max |
| `openai/gpt-audio` | OpenAI: GPT Audio | 128k | 16384 | — |
| `openai/gpt-audio-mini` | OpenAI: GPT Audio Mini | 128k | 16384 | — |
| `openai/gpt-chat-latest` | OpenAI: GPT Chat Latest | 400k | 128k | — |
| `openai/gpt-oss-120b` | OpenAI: gpt-oss-120b | 131072 | 131072 | minimal, low, medium, high |
| `openai/gpt-oss-20b` | OpenAI: gpt-oss-20b | 131072 | 131072 | minimal, low, medium, high |
| `openai/gpt-oss-20b:free` | OpenAI: gpt-oss-20b (free) | 131072 | 32768 | minimal, low, medium, high |
| `openai/gpt-oss-safeguard-20b` | OpenAI: gpt-oss-safeguard-20b | 131072 | 65536 | minimal, low, medium, high |
| `openai/o1` | OpenAI: o1 | 200k | 100k | minimal, low, medium, high |
| `openai/o3` | OpenAI: o3 | 200k | 100k | minimal, low, medium, high |
| `openai/o3-deep-research` | OpenAI: o3 Deep Research | 200k | 100k | minimal, low, medium, high |
| `openai/o3-mini` | OpenAI: o3 Mini | 200k | 100k | minimal, low, medium, high |
| `openai/o3-mini-high` | OpenAI: o3 Mini High | 200k | 100k | minimal, low, medium, high |
| `openai/o3-pro` | OpenAI: o3 Pro | 200k | 100k | minimal, low, medium, high |
| `openai/o4-mini` | OpenAI: o4 Mini | 200k | 100k | minimal, low, medium, high |
| `openai/o4-mini-deep-research` | OpenAI: o4 Mini Deep Research | 200k | 100k | minimal, low, medium, high |
| `openai/o4-mini-high` | OpenAI: o4 Mini High | 200k | 100k | minimal, low, medium, high |
| `openrouter/auto` | Auto Router | 2000k | 4096 | minimal, low, medium, high |
| `openrouter/auto-beta` | Auto Router (Beta) | 2000k | 4096 | minimal, low, medium, high |
| `openrouter/free` | Free Models Router | 200k | 4096 | minimal, low, medium, high |
| `openrouter/fusion` | OpenRouter: Fusion | 1000k | 30k | minimal, low, medium, high |
| `poolside/laguna-m.1` | Poolside: Laguna M.1 | 262144 | 32768 | minimal, low, medium, high |
| `poolside/laguna-m.1:free` | Poolside: Laguna M.1 (free) | 262144 | 32768 | minimal, low, medium, high |
| `poolside/laguna-xs-2.1` | Poolside: Laguna XS 2.1 | 262144 | 32768 | minimal, low, medium, high |
| `poolside/laguna-xs-2.1:free` | Poolside: Laguna XS 2.1 (free) | 262144 | 32768 | minimal, low, medium, high |
| `qwen/qwen-2.5-72b-instruct` | Qwen2.5 72B Instruct | 32768 | 16384 | — |
| `qwen/qwen-2.5-7b-instruct` | Qwen: Qwen2.5 7B Instruct | 32768 | 32768 | — |
| `qwen/qwen-plus` | Qwen: Qwen-Plus | 1000k | 32768 | — |
| `qwen/qwen-plus-2025-07-28` | Qwen: Qwen Plus 0728 | 1000k | 32768 | — |
| `qwen/qwen-plus-2025-07-28:thinking` | Qwen: Qwen Plus 0728 (thinking) | 1000k | 32768 | minimal, low, medium, high |
| `qwen/qwen3-14b` | Qwen: Qwen3 14B | 40960 | 16384 | minimal, low, medium, high |
| `qwen/qwen3-235b-a22b` | Qwen: Qwen3 235B A22B | 131072 | 8192 | minimal, low, medium, high |
| `qwen/qwen3-235b-a22b-2507` | Qwen: Qwen3 235B A22B Instruct 2507 | 262144 | 16384 | — |
| `qwen/qwen3-235b-a22b-thinking-2507` | Qwen: Qwen3 235B A22B Thinking 2507 | 131072 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-30b-a3b` | Qwen: Qwen3 30B A3B | 131072 | 8192 | minimal, low, medium, high |
| `qwen/qwen3-30b-a3b-instruct-2507` | Qwen: Qwen3 30B A3B Instruct 2507 | 262144 | 4096 | — |
| `qwen/qwen3-30b-a3b-thinking-2507` | Qwen: Qwen3 30B A3B Thinking 2507 | 81920 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-32b` | Qwen: Qwen3 32B | 40960 | 16384 | minimal, low, medium, high |
| `qwen/qwen3-8b` | Qwen: Qwen3 8B | 131072 | 8192 | minimal, low, medium, high |
| `qwen/qwen3-coder` | Qwen: Qwen3 Coder 480B A35B | 262144 | 65536 | — |
| `qwen/qwen3-coder-30b-a3b-instruct` | Qwen: Qwen3 Coder 30B A3B Instruct | 160k | 32768 | — |
| `qwen/qwen3-coder-flash` | Qwen: Qwen3 Coder Flash | 1000k | 65536 | — |
| `qwen/qwen3-coder-next` | Qwen: Qwen3 Coder Next | 262144 | 262144 | — |
| `qwen/qwen3-coder-plus` | Qwen: Qwen3 Coder Plus | 1000k | 65536 | — |
| `qwen/qwen3-max` | Qwen: Qwen3 Max | 262144 | 32768 | — |
| `qwen/qwen3-max-thinking` | Qwen: Qwen3 Max Thinking | 262144 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-next-80b-a3b-instruct` | Qwen: Qwen3 Next 80B A3B Instruct | 131072 | 32768 | — |
| `qwen/qwen3-next-80b-a3b-thinking` | Qwen: Qwen3 Next 80B A3B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-vl-235b-a22b-instruct` | Qwen: Qwen3 VL 235B A22B Instruct | 131072 | 32768 | — |
| `qwen/qwen3-vl-235b-a22b-thinking` | Qwen: Qwen3 VL 235B A22B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-vl-30b-a3b-instruct` | Qwen: Qwen3 VL 30B A3B Instruct | 131072 | 32768 | — |
| `qwen/qwen3-vl-30b-a3b-thinking` | Qwen: Qwen3 VL 30B A3B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `qwen/qwen3-vl-32b-instruct` | Qwen: Qwen3 VL 32B Instruct | 131072 | 32768 | — |
| `qwen/qwen3-vl-8b-instruct` | Qwen: Qwen3 VL 8B Instruct | 131072 | 32768 | — |
| `qwen/qwen3-vl-8b-thinking` | Qwen: Qwen3 VL 8B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `qwen/qwen3.5-122b-a10b` | Qwen: Qwen3.5-122B-A10B | 262144 | 65536 | minimal, low, medium, high |
| `qwen/qwen3.5-27b` | Qwen: Qwen3.5-27B | 262144 | 81920 | minimal, low, medium, high |
| `qwen/qwen3.5-35b-a3b` | Qwen: Qwen3.5-35B-A3B | 262144 | 262144 | minimal, low, medium, high |
| `qwen/qwen3.5-397b-a17b` | Qwen: Qwen3.5 397B A17B | 262144 | 65536 | minimal, low, medium, high |
| `qwen/qwen3.5-9b` | Qwen: Qwen3.5-9B | 262144 | 262144 | minimal, low, medium, high |
| `qwen/qwen3.5-flash-02-23` | Qwen: Qwen3.5-Flash | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.5-plus-02-15` | Qwen: Qwen3.5 Plus 2026-02-15 | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.5-plus-20260420` | Qwen: Qwen3.5 Plus 2026-04-20 | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.6-27b` | Qwen: Qwen3.6 27B | 262144 | 65536 | minimal, low, medium, high |
| `qwen/qwen3.6-35b-a3b` | Qwen: Qwen3.6 35B A3B | 262144 | 262144 | minimal, low, medium, high |
| `qwen/qwen3.6-flash` | Qwen: Qwen3.6 Flash | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.6-max-preview` | Qwen: Qwen3.6 Max Preview | 262144 | 65536 | minimal, low, medium, high |
| `qwen/qwen3.6-plus` | Qwen: Qwen3.6 Plus | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.7-max` | Qwen: Qwen3.7 Max | 1000k | 65536 | minimal, low, medium, high |
| `qwen/qwen3.7-plus` | Qwen: Qwen3.7 Plus | 1000k | 65536 | minimal, low, medium, high |
| `rekaai/reka-edge` | Reka Edge | 16384 | 16384 | — |
| `relace/relace-search` | Relace: Relace Search | 256k | 128k | — |
| `sakana/fugu-ultra` | Sakana: Fugu Ultra | 1000k | 128k | minimal, low, medium, high |
| `sao10k/l3.1-euryale-70b` | Sao10K: Llama 3.1 Euryale 70B v2.2 | 131072 | 16384 | — |
| `stepfun/step-3.5-flash` | StepFun: Step 3.5 Flash | 262144 | 65536 | minimal, low, medium, high |
| `stepfun/step-3.7-flash` | StepFun: Step 3.7 Flash | 256k | 256k | minimal, low, medium, high |
| `tencent/hy3` | Tencent: Hy3 | 262144 | 262144 | minimal, low, medium, high |
| `tencent/hy3-preview` | Tencent: Hy3 preview | 262144 | 4096 | minimal, low, medium, high |
| `thedrummer/unslopnemo-12b` | TheDrummer: UnslopNemo 12B | 32768 | 32768 | — |
| `thinkingmachines/inkling` | Thinking Machines: Inkling | 524288 | 4096 | minimal, low, medium, high |
| `upstage/solar-pro-3` | Upstage: Solar Pro 3 | 128k | 4096 | minimal, low, medium, high |
| `x-ai/grok-4.20` | xAI: Grok 4.20 | 2000k | 4096 | minimal, low, medium, high |
| `x-ai/grok-4.3` | xAI: Grok 4.3 | 1000k | 4096 | minimal, low, medium, high |
| `x-ai/grok-4.5` | xAI: Grok 4.5 | 500k | 4096 | minimal, low, medium, high |
| `x-ai/grok-build-0.1` | xAI: Grok Build 0.1 | 256k | 4096 | minimal, low, medium, high |
| `xiaomi/mimo-v2.5` | Xiaomi: MiMo-V2.5 | 1048576 | 131072 | minimal, low, medium, high |
| `xiaomi/mimo-v2.5-pro` | Xiaomi: MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `z-ai/glm-4.5` | Z.ai: GLM 4.5 | 131072 | 98304 | minimal, low, medium, high |
| `z-ai/glm-4.5-air` | Z.ai: GLM 4.5 Air | 131072 | 98304 | minimal, low, medium, high |
| `z-ai/glm-4.5v` | Z.ai: GLM 4.5V | 65536 | 16384 | minimal, low, medium, high |
| `z-ai/glm-4.6` | Z.ai: GLM 4.6 | 202752 | 131072 | minimal, low, medium, high |
| `z-ai/glm-4.6v` | Z.ai: GLM 4.6V | 131072 | 32768 | minimal, low, medium, high |
| `z-ai/glm-4.7` | Z.ai: GLM 4.7 | 202752 | 131072 | minimal, low, medium, high |
| `z-ai/glm-4.7-flash` | Z.ai: GLM 4.7 Flash | 131072 | 131072 | minimal, low, medium, high |
| `z-ai/glm-5` | Z.ai: GLM 5 | 204800 | 131072 | minimal, low, medium, high |
| `z-ai/glm-5-turbo` | Z.ai: GLM 5 Turbo | 202752 | 131072 | minimal, low, medium, high |
| `z-ai/glm-5.1` | Z.ai: GLM 5.1 | 200k | 128k | minimal, low, medium, high |
| `z-ai/glm-5.2` | Z.ai: GLM 5.2 | 1048576 | 131072 | minimal, low, medium, high, xhigh |
| `z-ai/glm-5v-turbo` | Z.ai: GLM 5V Turbo | 202752 | 131072 | minimal, low, medium, high |

## qwen-token-plan-cn

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-v3.2` | DeepSeek V3.2 | 131072 | 65536 | minimal, low, medium, high |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | high, max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | high, max |
| `glm-5` | GLM-5 | 202752 | 16384 | minimal, low, medium, high |
| `glm-5.1` | GLM-5.1 | 202752 | 128k | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | minimal, low, medium, high |
| `kimi-k2.5` | Kimi K2.5 | 262144 | 32768 | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 16384 | minimal, low, medium, high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `MiniMax-M2.5` | MiniMax-M2.5 | 196608 | 24576 | minimal, low, medium, high |
| `qwen3.6-flash` | Qwen3.6 Flash | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.6-plus` | Qwen3.6 Plus | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-max` | Qwen3.7 Max | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-plus` | Qwen3.7 Plus | 1000k | 64k | minimal, low, medium, high |
| `qwen3.8-max-preview` | Qwen3.8 Max Preview | 1000k | 131072 | minimal, low, medium, high |

## qwen-token-plan

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-v3.2` | DeepSeek V3.2 | 131072 | 65536 | minimal, low, medium, high |
| `deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | high, max |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | high, max |
| `glm-5` | GLM-5 | 202752 | 16384 | minimal, low, medium, high |
| `glm-5.1` | GLM-5.1 | 202752 | 128k | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | minimal, low, medium, high |
| `kimi-k2.5` | Kimi K2.5 | 262144 | 32768 | minimal, low, medium, high |
| `kimi-k2.6` | Kimi K2.6 | 262144 | 16384 | minimal, low, medium, high |
| `kimi-k2.7-code` | Kimi K2.7 Code | 262144 | 262144 | minimal, low, medium, high |
| `MiniMax-M2.5` | MiniMax-M2.5 | 196608 | 24576 | minimal, low, medium, high |
| `qwen3.6-flash` | Qwen3.6 Flash | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.6-plus` | Qwen3.6 Plus | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-max` | Qwen3.7 Max | 1000k | 65536 | minimal, low, medium, high |
| `qwen3.7-plus` | Qwen3.7 Plus | 1000k | 64k | minimal, low, medium, high |
| `qwen3.8-max-preview` | Qwen3.8 Max Preview | 1000k | 131072 | minimal, low, medium, high |

## together

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek V4 Pro | 512k | 384k | high |
| `google/gemma-4-31B-it` | Gemma 4 31B Instruct | 262144 | 131072 | high |
| `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Llama 3.3 70B | 131072 | 131072 | — |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax-M2.7 | 202752 | 131072 | high |
| `MiniMaxAI/MiniMax-M3` | MiniMax-M3 | 524288 | 250k | high |
| `moonshotai/Kimi-K2.6` | Kimi K2.6 | 262144 | 131k | high |
| `moonshotai/Kimi-K2.7-Code` | Kimi K2.7 Code | 262144 | 131072 | high |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra 550B A55B | 512300 | 512300 | high |
| `openai/gpt-oss-120b` | GPT OSS 120B | 131072 | 131072 | low, medium, high |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131072 | 131072 | low, medium, high |
| `Qwen/Qwen2.5-7B-Instruct-Turbo` | Qwen 2.5 7B Instruct Turbo | 32768 | 32768 | — |
| `Qwen/Qwen3.5-9B` | Qwen3.5 9B | 262144 | 65536 | high |
| `Qwen/Qwen3.6-Plus` | Qwen3.6 Plus | 1000k | 500k | high |
| `Qwen/Qwen3.7-Max` | Qwen3.7 Max | 1000k | 500k | — |
| `thinkingmachines/Inkling` | Inkling | 524288 | 131072 | high |
| `zai-org/GLM-5.2` | GLM-5.2 | 262144 | 164k | high |

## vercel-ai-gateway

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `alibaba/qwen-3-14b` | Qwen3-14B | 40960 | 16384 | minimal, low, medium, high |
| `alibaba/qwen-3-235b` | Qwen3 235B A22B | 262144 | 16384 | minimal, low, medium, high |
| `alibaba/qwen-3-30b` | Qwen3-30B-A3B | 40960 | 16384 | minimal, low, medium, high |
| `alibaba/qwen-3-32b` | Qwen 3 32B | 128k | 8192 | minimal, low, medium, high |
| `alibaba/qwen-3.6-max-preview` | Qwen 3.6 Max Preview | 240k | 64k | minimal, low, medium, high |
| `alibaba/qwen3-235b-a22b-thinking` | Qwen3 VL 235B A22B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `alibaba/qwen3-coder` | Qwen3 Coder 480B A35B Instruct | 262144 | 65536 | — |
| `alibaba/qwen3-coder-30b-a3b` | Qwen 3 Coder 30B A3B Instruct | 262144 | 8192 | — |
| `alibaba/qwen3-coder-next` | Qwen3 Coder Next | 256k | 256k | — |
| `alibaba/qwen3-coder-plus` | Qwen3 Coder Plus | 1000k | 65536 | — |
| `alibaba/qwen3-max` | Qwen3 Max | 262144 | 32768 | — |
| `alibaba/qwen3-max-preview` | Qwen3 Max Preview | 262144 | 32768 | — |
| `alibaba/qwen3-max-thinking` | Qwen 3 Max Thinking | 256k | 65536 | minimal, low, medium, high |
| `alibaba/qwen3-next-80b-a3b-instruct` | Qwen3 Next 80B A3B Instruct | 131072 | 32768 | — |
| `alibaba/qwen3-next-80b-a3b-thinking` | Qwen3 Next 80B A3B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `alibaba/qwen3-vl-235b-a22b-instruct` | Qwen3 VL 235B A22B Instruct | 131072 | 129024 | — |
| `alibaba/qwen3-vl-instruct` | Qwen3 VL 235B A22B Instruct | 131072 | 129024 | — |
| `alibaba/qwen3-vl-thinking` | Qwen3 VL 235B A22B Thinking | 131072 | 32768 | minimal, low, medium, high |
| `alibaba/qwen3.5-flash` | Qwen 3.5 Flash | 1000k | 64k | minimal, low, medium, high |
| `alibaba/qwen3.5-plus` | Qwen 3.5 Plus | 1000k | 64k | minimal, low, medium, high |
| `alibaba/qwen3.6-27b` | Qwen 3.6 27B | 256k | 256k | minimal, low, medium, high |
| `alibaba/qwen3.6-plus` | Qwen 3.6 Plus | 1000k | 64k | minimal, low, medium, high |
| `alibaba/qwen3.7-max` | Qwen 3.7 Max | 991k | 64k | minimal, low, medium, high |
| `alibaba/qwen3.7-plus` | Qwen 3.7 Plus | 1000k | 64k | minimal, low, medium, high |
| `amazon/nova-2-lite` | Nova 2 Lite | 1000k | 1000k | minimal, low, medium, high |
| `amazon/nova-lite` | Nova Lite | 300k | 8192 | — |
| `amazon/nova-micro` | Nova Micro | 128k | 8192 | — |
| `amazon/nova-pro` | Nova Pro | 300k | 8192 | — |
| `anthropic/claude-fable-5` | Claude Fable 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-haiku-4.5` | Claude Haiku 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic/claude-opus-4.1` | Claude Opus 4.1 | 200k | 32k | minimal, low, medium, high |
| `anthropic/claude-opus-4.5` | Claude Opus 4.5 | 200k | 64k | minimal, low, medium, high |
| `anthropic/claude-opus-4.6` | Claude Opus 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `anthropic/claude-opus-4.7` | Claude Opus 4.7 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.7-fast` | Claude Opus 4.7 (Fast) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.8` | Claude Opus 4.8 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-opus-4.8-fast` | Claude Opus 4.8 (Fast) | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `anthropic/claude-sonnet-4.5` | Claude Sonnet 4.5 | 1000k | 64k | minimal, low, medium, high |
| `anthropic/claude-sonnet-4.6` | Claude Sonnet 4.6 | 1000k | 128k | minimal, low, medium, high, max |
| `anthropic/claude-sonnet-5` | Claude Sonnet 5 | 1000k | 128k | minimal, low, medium, high, xhigh, max |
| `arcee-ai/trinity-large-thinking` | Trinity Large Thinking | 262100 | 80k | minimal, low, medium, high |
| `arcee-ai/trinity-mini` | Trinity Mini | 131072 | 131072 | — |
| `bytedance/seed-1.6` | Seed 1.6 | 256k | 32k | minimal, low, medium, high |
| `bytedance/seed-1.8` | Bytedance Seed 1.8 | 256k | 64k | minimal, low, medium, high |
| `cohere/command-a` | Command A | 256k | 8k | — |
| `deepseek/deepseek-r1` | DeepSeek-R1 | 128k | 8192 | minimal, low, medium, high |
| `deepseek/deepseek-v3` | DeepSeek V3 0324 | 163840 | 163840 | — |
| `deepseek/deepseek-v3.1` | DeepSeek V3.1 | 163840 | 128k | minimal, low, medium, high |
| `deepseek/deepseek-v3.1-terminus` | DeepSeek V3.1 Terminus | 131072 | 65536 | minimal, low, medium, high |
| `deepseek/deepseek-v3.2` | DeepSeek V3.2 | 128k | 8k | — |
| `deepseek/deepseek-v3.2-thinking` | DeepSeek V3.2 Thinking | 128k | 8k | minimal, low, medium, high |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | 1000k | 384k | minimal, low, medium, high |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1000k | 384k | minimal, low, medium, high |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash | 1000k | 65536 | minimal, low, medium, high |
| `google/gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro | 1048576 | 65536 | minimal, low, medium, high |
| `google/gemini-3-flash` | Gemini 3 Flash | 1000k | 65k | minimal, low, medium, high |
| `google/gemini-3-pro-preview` | Gemini 3 Pro Preview | 1000k | 64k | minimal, low, medium, high |
| `google/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1000k | 65k | minimal, low, medium, high |
| `google/gemini-3.1-flash-lite-preview` | Gemini 3.1 Flash Lite Preview | 1000k | 65k | minimal, low, medium, high |
| `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | 1000k | 64k | minimal, low, medium, high |
| `google/gemini-3.5-flash` | Gemini 3.5 Flash | 1000k | 64k | minimal, low, medium, high |
| `google/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | 1000k | 65k | minimal, low, medium, high |
| `google/gemini-3.6-flash` | Gemini 3.6 Flash | 1000k | 64k | minimal, low, medium, high |
| `google/gemma-4-26b-a4b-it` | Gemma 4 26B A4B IT | 262144 | 131072 | minimal, low, medium, high |
| `google/gemma-4-31b-it` | Gemma 4 31B IT | 262144 | 131072 | minimal, low, medium, high |
| `inception/mercury-2` | Mercury 2 | 128k | 128k | minimal, low, medium, high |
| `inception/mercury-coder-small` | Mercury Coder Small Beta | 32k | 16384 | — |
| `interfaze/interfaze-beta` | Interfaze Beta | 1000k | 32k | minimal, low, medium, high |
| `kwaipilot/kat-coder-air-v2.5` | Kat Coder Air V2.5 | 256k | 80k | minimal, low, medium, high |
| `kwaipilot/kat-coder-pro-v1` | KAT-Coder-Pro V1 | 256k | 32k | — |
| `kwaipilot/kat-coder-pro-v2` | Kat Coder Pro V2 | 256k | 256k | minimal, low, medium, high |
| `kwaipilot/kat-coder-pro-v2.5` | Kat Coder Pro V2.5 | 256k | 80k | minimal, low, medium, high |
| `meta/llama-3.1-70b` | Llama 3.1 70B Instruct | 128k | 8192 | — |
| `meta/llama-3.1-8b` | Llama 3.1 8B Instruct | 128k | 8192 | — |
| `meta/llama-3.3-70b` | Llama 3.3 70B Instruct | 128k | 8192 | — |
| `meta/llama-4-maverick` | Llama 4 Maverick 17B Instruct | 128k | 8192 | — |
| `meta/llama-4-scout` | Llama 4 Scout 17B Instruct | 128k | 8192 | — |
| `meta/muse-spark-1.1` | Muse Spark 1.1 | 1048576 | 1048576 | minimal, low, medium, high |
| `minimax/minimax-m2` | MiniMax M2 | 205k | 205k | minimal, low, medium, high |
| `minimax/minimax-m2.1` | MiniMax M2.1 | 204800 | 131072 | minimal, low, medium, high |
| `minimax/minimax-m2.1-lightning` | MiniMax M2.1 Lightning | 204800 | 131072 | minimal, low, medium, high |
| `minimax/minimax-m2.5` | MiniMax M2.5 | 204800 | 131k | minimal, low, medium, high |
| `minimax/minimax-m2.5-highspeed` | MiniMax M2.5 High Speed | 204800 | 131k | minimal, low, medium, high |
| `minimax/minimax-m2.7` | MiniMax M2.7 | 204800 | 131k | minimal, low, medium, high |
| `minimax/minimax-m2.7-highspeed` | MiniMax M2.7 High Speed | 204800 | 131100 | minimal, low, medium, high |
| `minimax/minimax-m3` | MiniMax M3 | 1000k | 1000k | minimal, low, medium, high |
| `mistral/codestral` | Mistral Codestral | 128k | 4k | — |
| `mistral/devstral-2` | Devstral 2 | 256k | 256k | — |
| `mistral/devstral-small-2` | Devstral Small 2 | 256k | 256k | — |
| `mistral/magistral-medium` | Magistral Medium 2509 | 128k | 64k | minimal, low, medium, high |
| `mistral/magistral-small` | Magistral Small 2509 | 128k | 64k | minimal, low, medium, high |
| `mistral/ministral-14b` | Ministral 14B | 256k | 256k | — |
| `mistral/ministral-3b` | Ministral 3B | 128k | 4k | — |
| `mistral/ministral-8b` | Ministral 8B | 128k | 4k | — |
| `mistral/mistral-large-3` | Mistral Large 3 | 256k | 256k | — |
| `mistral/mistral-medium` | Mistral Medium 3.1 | 128k | 64k | — |
| `mistral/mistral-medium-3.5` | Mistral Medium Latest | 256k | 256k | minimal, low, medium, high |
| `mistral/mistral-nemo` | Mistral Nemo 12B | 128k | 128k | — |
| `mistral/mistral-small` | Mistral Small | 32k | 4k | — |
| `mistral/pixtral-12b` | Pixtral 12B 2409 | 128k | 4k | — |
| `moonshotai/kimi-k2` | Kimi K2 Instruct | 131072 | 131072 | — |
| `moonshotai/kimi-k2-thinking` | Kimi K2 Thinking | 216144 | 216144 | minimal, low, medium, high |
| `moonshotai/kimi-k2.5` | Kimi K2.5 | 262114 | 262114 | minimal, low, medium, high |
| `moonshotai/kimi-k2.6` | Kimi K2.6 | 262k | 262k | minimal, low, medium, high |
| `moonshotai/kimi-k2.7-code` | Kimi K2.7 Code | 256k | 32768 | minimal, low, medium, high |
| `moonshotai/kimi-k2.7-code-highspeed` | Kimi K2.7 Code High Speed | 262144 | 32768 | minimal, low, medium, high |
| `moonshotai/kimi-k3` | Kimi K3 | 1000k | 131072 | minimal, low, medium, high |
| `nvidia/nemotron-3-nano-30b-a3b` | Nemotron 3 Nano 30B A3B | 262144 | 262144 | minimal, low, medium, high |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA Nemotron 3 Super 120B A12B | 256k | 32k | minimal, low, medium, high |
| `nvidia/nemotron-3-ultra-550b-a55b` | Nemotron 3 Ultra | 1000k | 65k | minimal, low, medium, high |
| `nvidia/nemotron-nano-12b-v2-vl` | Nvidia Nemotron Nano 12B V2 VL | 131072 | 131072 | minimal, low, medium, high |
| `nvidia/nemotron-nano-9b-v2` | Nvidia Nemotron Nano 9B V2 | 131072 | 131072 | minimal, low, medium, high |
| `openai/gpt-3.5-turbo` | GPT-3.5 Turbo | 16385 | 4096 | — |
| `openai/gpt-4-turbo` | GPT-4 Turbo | 128k | 4096 | — |
| `openai/gpt-4.1` | GPT-4.1 | 1047576 | 32768 | — |
| `openai/gpt-4.1-mini` | GPT-4.1 mini | 1047576 | 32768 | — |
| `openai/gpt-4.1-nano` | GPT-4.1 nano | 1047576 | 32768 | — |
| `openai/gpt-4o` | GPT-4o | 128k | 16384 | — |
| `openai/gpt-4o-mini` | GPT-4o mini | 128k | 16384 | — |
| `openai/gpt-5` | GPT-5 | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-chat` | GPT 5 Chat | 128k | 16384 | — |
| `openai/gpt-5-codex` | GPT-5-Codex | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-mini` | GPT-5 mini | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-nano` | GPT-5 nano | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5-pro` | GPT-5 pro | 400k | 272k | minimal, low, medium, high |
| `openai/gpt-5.1-codex` | GPT-5.1-Codex | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-codex-max` | GPT 5.1 Codex Max | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-codex-mini` | GPT 5.1 Codex Mini | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.1-instant` | GPT-5.1 Instant | 128k | 16384 | — |
| `openai/gpt-5.1-thinking` | GPT 5.1 Thinking | 400k | 128k | minimal, low, medium, high |
| `openai/gpt-5.2` | GPT 5.2 | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.2-chat` | GPT 5.2 Chat | 128k | 16384 | — |
| `openai/gpt-5.2-codex` | GPT 5.2 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.2-pro` | GPT 5.2  | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.3-chat` | GPT-5.3 Chat | 128k | 16384 | — |
| `openai/gpt-5.3-codex` | GPT 5.3 Codex | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4` | GPT 5.4 | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-mini` | GPT 5.4 Mini | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-nano` | GPT 5.4 Nano | 400k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.4-pro` | GPT 5.4 Pro | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.5` | GPT 5.5 | 1000k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.5-pro` | GPT 5.5 Pro | 1000k | 128k | medium, high, xhigh |
| `openai/gpt-5.6-luna` | GPT 5.6 Luna | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.6-sol` | GPT 5.6 Sol | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-5.6-terra` | GPT 5.6 Terra | 1050k | 128k | minimal, low, medium, high, xhigh |
| `openai/gpt-oss-120b` | GPT OSS 120B | 131072 | 131072 | minimal, low, medium, high |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131072 | 8192 | minimal, low, medium, high |
| `openai/gpt-oss-safeguard-20b` | GPT OSS Safeguard 20B | 131072 | 65536 | minimal, low, medium, high |
| `openai/o1` | o1 | 200k | 100k | minimal, low, medium, high |
| `openai/o3` | o3 | 200k | 100k | minimal, low, medium, high |
| `openai/o3-deep-research` | o3-deep-research | 200k | 100k | minimal, low, medium, high |
| `openai/o3-mini` | o3-mini | 200k | 100k | minimal, low, medium, high |
| `openai/o3-pro` | o3 Pro | 200k | 100k | minimal, low, medium, high |
| `openai/o4-mini` | o4-mini | 200k | 100k | minimal, low, medium, high |
| `sakana/fugu-ultra` | Fugu Ultra | 1000k | 1000k | minimal, low, medium, high |
| `stepfun/step-3.5-flash` | StepFun 3.5 Flash | 262114 | 262114 | minimal, low, medium, high |
| `stepfun/step-3.7-flash` | Step 3.7 Flash | 256k | 256k | minimal, low, medium, high |
| `thinkingmachines/inkling` | Inkling | 256k | 256k | minimal, low, medium, high |
| `xai/grok-4.1-fast-non-reasoning` | Grok 4.1 Fast Non-Reasoning | 1000k | 1000k | — |
| `xai/grok-4.1-fast-reasoning` | Grok 4.1 Fast Reasoning | 1000k | 1000k | minimal, low, medium, high |
| `xai/grok-4.20-multi-agent` | Grok 4.20 Multi-Agent | 2000k | 2000k | minimal, low, medium, high |
| `xai/grok-4.20-multi-agent-beta` | Grok 4.20 Multi Agent Beta | 2000k | 2000k | minimal, low, medium, high |
| `xai/grok-4.20-non-reasoning` | Grok 4.20 Non-Reasoning | 2000k | 2000k | — |
| `xai/grok-4.20-non-reasoning-beta` | Grok 4.20 Beta Non-Reasoning | 2000k | 2000k | — |
| `xai/grok-4.20-reasoning` | Grok 4.20 Reasoning | 2000k | 2000k | minimal, low, medium, high |
| `xai/grok-4.20-reasoning-beta` | Grok 4.20 Beta Reasoning | 2000k | 2000k | minimal, low, medium, high |
| `xai/grok-4.3` | Grok 4.3 | 1000k | 1000k | minimal, low, medium, high |
| `xai/grok-4.5` | Grok 4.5 | 500k | 500k | minimal, low, medium, high |
| `xai/grok-build-0.1` | Grok Build 0.1 | 256k | 256k | minimal, low, medium, high |
| `xiaomi/mimo-v2.5` | MiMo M2.5 | 1050k | 131100 | minimal, low, medium, high |
| `xiaomi/mimo-v2.5-pro` | MiMo V2.5 Pro | 1050k | 131k | minimal, low, medium, high |
| `zai/glm-4.5` | GLM 4.5 | 128k | 96k | minimal, low, medium, high |
| `zai/glm-4.5-air` | GLM 4.5 Air | 128k | 96k | minimal, low, medium, high |
| `zai/glm-4.5v` | GLM 4.5V | 66k | 16k | minimal, low, medium, high |
| `zai/glm-4.6` | GLM 4.6 | 200k | 96k | minimal, low, medium, high |
| `zai/glm-4.6v` | GLM-4.6V | 128k | 24k | minimal, low, medium, high |
| `zai/glm-4.6v-flash` | GLM-4.6V-Flash | 128k | 24k | minimal, low, medium, high |
| `zai/glm-4.7` | GLM 4.7 | 200k | 120k | minimal, low, medium, high |
| `zai/glm-4.7-flash` | GLM 4.7 Flash | 200k | 131k | minimal, low, medium, high |
| `zai/glm-4.7-flashx` | GLM 4.7 FlashX | 200k | 128k | minimal, low, medium, high |
| `zai/glm-5` | GLM 5 | 202800 | 131100 | minimal, low, medium, high |
| `zai/glm-5-turbo` | GLM 5 Turbo | 202800 | 131100 | minimal, low, medium, high |
| `zai/glm-5.1` | GLM 5.1 | 202k | 202k | minimal, low, medium, high |
| `zai/glm-5.2` | GLM 5.2 | 1040k | 128k | minimal, low, medium, high |
| `zai/glm-5.2-fast` | GLM 5.2 Fast | 1000k | 128k | minimal, low, medium, high |
| `zai/glm-5v-turbo` | GLM 5V Turbo | 200k | 128k | minimal, low, medium, high |

## xai

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `grok-4.3` | Grok 4.3 | 1000k | 30k | minimal, low, medium, high |
| `grok-4.5` | Grok 4.5 | 500k | 500k | low, medium, high |
| `grok-build-0.1` | Grok Build 0.1 | 256k | 256k | minimal, low, medium, high |

## xiaomi-token-plan-ams

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `mimo-v2-pro` | MiMo-V2-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5` | MiMo-V2.5 | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |

## xiaomi-token-plan-cn

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `mimo-v2-pro` | MiMo-V2-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5` | MiMo-V2.5 | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |

## xiaomi-token-plan-sgp

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `mimo-v2-pro` | MiMo-V2-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5` | MiMo-V2.5 | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |

## xiaomi

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `mimo-v2-flash` | MiMo-V2-Flash | 262144 | 65536 | minimal, low, medium, high |
| `mimo-v2-omni` | MiMo-V2-Omni | 262144 | 131072 | minimal, low, medium, high |
| `mimo-v2-pro` | MiMo-V2-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5` | MiMo-V2.5 | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | 1048576 | 131072 | minimal, low, medium, high |
| `mimo-v2.5-pro-ultraspeed` | MiMo-V2.5-Pro-UltraSpeed | 1048576 | 131072 | minimal, low, medium, high |

## zai-coding-cn

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `glm-4.5-air` | GLM-4.5-Air | 131072 | 98304 | minimal, low, medium, high |
| `glm-4.7` | GLM-4.7 | 204800 | 131072 | minimal, low, medium, high |
| `glm-5-turbo` | GLM-5-Turbo | 200k | 131072 | minimal, low, medium, high |
| `glm-5.1` | GLM-5.1 | 200k | 131072 | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | low, medium, high, max |
| `glm-5v-turbo` | GLM-5V-Turbo | 200k | 131072 | minimal, low, medium, high |

## zai

| Model | Name | Context | Max output | Reasoning levels |
| --- | --- | --- | --- | --- |
| `glm-4.5-air` | GLM-4.5-Air | 131072 | 98304 | minimal, low, medium, high |
| `glm-4.7` | GLM-4.7 | 204800 | 131072 | minimal, low, medium, high |
| `glm-5-turbo` | GLM-5-Turbo | 200k | 131072 | minimal, low, medium, high |
| `glm-5.1` | GLM-5.1 | 200k | 131072 | minimal, low, medium, high |
| `glm-5.2` | GLM-5.2 | 1000k | 131072 | low, medium, high, max |
| `glm-5v-turbo` | GLM-5V-Turbo | 200k | 131072 | minimal, low, medium, high |

