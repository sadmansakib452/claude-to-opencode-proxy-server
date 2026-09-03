# Chapter 2 — Wizard UX Design (2026-09-01)

## ফ্লো (4 স্ক্রিন)

### Screen 0: Welcome
```
🪄 Opencode Setup Wizard
   Proxy: http://127.0.0.1:8787
   Config: ./config.json
   Press Enter to start...
```

### Screen 1: API Key
```
🔑 Opencode API Key (https://opencode.ai/workplace)
   [input masked] sk-********************************

   Validating... ✅ Valid (Zen 40 models, Go 30 models)
   ❌ Invalid API key (401) → retry
```

### Screen 2: Model Select (API থেকে, free/paid গ্রুপ)
```
📦 Model Select (auto-detects endpoint)

   [free] (Zen free, responses)
     1. muse-spark-1.2-contributor-free  (recommended)
     2. deepseek-v4-flash-free
     3. mimo-v2.5-free

   [paid] (needs balance)
     4. deepseek-v4-pro
     5. gpt-5.6-luna (responses)
     6. grok-4.6 (responses)

   Select [1-6]: 1
```

### Screen 3: Apply (Proxy Owns Key)
```
💾 Apply

   Proxy config: bridge/config.json → opencodeKey updated ✅
   Proxy mode: auto (responses vs chat auto-detect)

   Projects (model only):
     [x] my-router (muse-spark-free → muse-spark-free)
     [x] kabir-hotspot-setup
     [ ] personal-agent
     [x] all (3 projects)

   Writing my-router/.claude/settings.json → ANTHROPIC_MODEL updated ✅
   Writing kabir-hotspot/.claude/settings.json → ANTHROPIC_MODEL updated ✅

   Guide:
     ✅ Done! Run: npm start  (proxy)
     ✅ Then: VS Code → Claude Panel → message
```

## প্রম্পট ডিটেইল
- Key input: `enquirer` password prompt, `sk-` prefix check
- Model list: `fetch https://opencode.ai/zen/v1/models + /zen/go/v1/models` → `id.includes("-free")` → free/paid → `isResponsesModel()` → tag
- Apply: default `[x] all` = সব `*/.claude/settings.json` এ `ANTHROPIC_MODEL` আপডেট, `ANTHROPIC_API_KEY` **লিখবে না** (proxy owns key)
- Backup: `settings.json.bak` তৈরি

## CLI কমান্ড
- `npm run setup` → wizard
- `npm run setup -- --list-models` → শুধু লিস্ট
- `node scripts/setup-wizard.js --key sk-... --model muse-spark-free --apply all` → non-interactive (CI)

## Verify
- Paper prototype → তুমি approve করলে Chapter 3 এ যাবো
