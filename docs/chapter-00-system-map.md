# Chapter 0 — System Map & Verification (2026-09-01)

## ১. ফোল্ডার স্ট্রাকচার
```
deepseek-v4-opencode-claude-code-bridge/  (local: deepseek-v4-... , remote: claude-to-opencode-proxy-server)
├── config.json              → upstream https://opencode.ai/zen/v1, models 5, endpointMode auto
├── server.js                → 1800+ lines, hybrid proxy (chat + responses)
├── package.json             → 0.2.1, name still deepseek-... (rename pending)
└── docs/chapter-00-system-map.md (this file)

my-router/
├── .claude/settings.json    → ANTHROPIC_API_KEY=sk-2Ebw... , BASE_URL 8787, MODEL muse-spark-free
└── .claude/memory/          → 20+ md files

~/.claude/
├── settings.json            → global: model deepseek-v4-pro[1m], theme dark (no API key)
└── .credentials.json        → {} (logged out)
```

## ২. Config Verification ✅
- `config.json:7` baseUrl `https://opencode.ai/zen/v1` ✅ (Zen)
- `config.json:10` models 5: muse-spark-free, deepseek-v4-pro, deepseek-v4-flash, glm-5, kimi-k2.6
- `config.json:11` endpointMode `auto` ✅
- `server.js:177` isResponsesModel() → regex `muse-spark|gpt-5|grok|claude` ✅
- `server.js:184` resolveUpstreamPath() → auto → /responses vs /chat/completions ✅
- `server.js:901` anthropicContentToResponsesInput() → role aware input_text/output_text ✅
- `server.js:1213` fallback sk-ant-* → opencode key ✅

## ৩. Settings Verification ✅
- my-router local: sk-2EbwG6UJj... len 67 ✅
- global: no key (correct, project owns key)
- proxy health: http://127.0.0.1:8787/health → ok:true ✅ (PID 8504 earlier, now test via curl)
- Zen models: 40+ including muse-spark-free, deepseek-v4-free, gpt-5.6, grok-4.6
- Go models: 30+ including deepseek-v4-pro, muse-spark-contributor (paid, needs opt-in)

## ৪. Flow Verification ✅
- Direct Zen /responses with sk-2Ebw → 200 OK (Hi there)
- Via proxy curl with sk-2Ebw → 200 OK (হাই, কেমন আছো?)
- Via proxy with sk-ant-* → fallback → 200 OK (after fix)
- VS Code extension → still sends sk-ant-* len108 → fallback handles ✅

## ৫. Known Issues (Chapter 0)
- Folder name mismatch: local `deepseek-v4-...` vs remote `claude-to-opencode-proxy-server` → rename or keep alias
- package.json name still `deepseek-v4-opencode-claude-code-bridge` → should rename to `claude-to-opencode-proxy-server`
- Proxy health shows `upstream: .../chat/completions` even when model is responses → should show dynamic
- Global settings still has old model deepseek-v4-pro[1m] → should sync or leave as is

## ৬. Next → Chapter 1: Key Priority Chain Research
