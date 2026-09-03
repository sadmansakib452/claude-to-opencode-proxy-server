# Chapter 1 — Global Architecture Verify (2026-09-03)

## Global Settings
- `~/.claude/settings.json` → added `env.ANTHROPIC_BASE_URL=http://127.0.0.1:8787` ✅
- Now any project without `.claude/settings.json` will still hit proxy

## Test: No Project Settings
- Created `C:\Users\sadman\AppData\Local\Temp\opencode\test-no-settings` (no .claude folder)
- Ran `claude -p "hi" --max-turns 1` with global BASE_URL
- Result: `Hey — I'm Claude...` → 200 OK ✅ (proxy used .env key+model)

## Test: With Project Settings (my-router)
- `my-router/.claude/settings.json` still has `sk-2Ebw` + `muse-spark`
- Proxy overrides client's model → `muse-spark` (from .env) ✅
- Even with dummy client key, proxy uses .env key → 200 OK

## Conclusion
- Global proxy works — no project dependency needed
- Project `settings.json` can stay, but not required for key/model
- Next: Chapter 2 → Simple .env is already done, so jump to Chapter 3 (Testing)
