# Chapter 4 — Final Global Testing (2026-09-03)

## Test Results ✅ All 200 OK

### 1. my-router (with .claude/settings.json)
```bash
cd my-router && claude -p "2+2 koto?" --max-turns 1
→ 2+2 = **4** 😄
```
- Client sent `muse-spark` + `sk-2Ebw` → Proxy used `.env` → 200

### 2. kabir-hotspot-setup (old settings: deepseek + sk-LABQ)
```bash
cd kabir-hotspot-setup && claude -p "2+2 koto?" --max-turns 1
→ 2+2 = 4
```
- Client sent `deepseek` + `sk-LABQ` → Proxy overrode to `muse-spark` + `sk-2Ebw` → 200 (global override works)

### 3. No-settings project (no .claude folder)
```bash
mkdir /tmp/test-global && claude -p "2+2 koto?"
→ 2+2 = 4
```
- No settings.json → Used global `~/.claude/settings.json` BASE_URL → Proxy → 200 (no project dependency confirmed)

## Global Architecture Confirmed
- `~/.claude/settings.json` → `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`
- `bridge/.env` → `OPENCODE_API_KEY`, `MODEL`, `BASE_URL` (single source of truth)
- All projects → via global BASE_URL → proxy owns key+model

## Next: Chapter 5 Docs & Finalize
