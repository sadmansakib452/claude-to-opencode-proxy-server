# Chapter 1 — Key Priority Chain Research (2026-09-01)

## পর্যবেক্ষণ
- `my-router/.claude/settings.json:3` → `sk-2Ebw...` (opencode, len 67)
- `~/.claude/settings.json:1` → কোনো `ANTHROPIC_API_KEY` নেই
- `~/.claude/.credentials.json` → `{}` (logged out)
- `VS Code extension` → এখনো `sk-ant-... len108` পাঠায় (SecretStorage cache)

## Claude Code ডকস অনুযায়ী প্রায়োরিটি
1. `export ANTHROPIC_API_KEY` (process env) → সবচেয়ে উপরে
2. `--settings` ফাইলের `env.ANTHROPIC_API_KEY` → দ্বিতীয়
3. `project .claude/settings.json` এর `env` → তৃতীয়
4. `global ~/.claude/settings.json` এর `env` → চতুর্থ
5. `SecretStorage / OAuth` (`sk-ant-`, keychain) → সবশেষে, কিন্তু `VS Code extension` এ ক্যাশ থাকলে ওটা আগে পাঠায়
6. `--bare` মোডে → শুধু `ANTHROPIC_API_KEY` বা `apiKeyHelper` পড়ে, keychain ইগনোর (ডকস: `CLAUDE_CODE_SIMPLE=1`)

## টেস্ট রেজাল্ট
- `curl` দিয়ে `x-api-key: sk-2Ebw` → proxy `200 OK` ✅
- `curl` খালি কী → proxy `Upstream API key is not set` ❌
- `VS Code extension` (sk-ant- len108) → proxy fallback → `sk-2Ebw` তে সুইচ → `200 OK` ✅ (hack)
- `export ANTHROPIC_API_KEY=sk-2Ebw && claude -p hi` → `হাই Sadman` ✅ (env wins)

## সিদ্ধান্ত (Wizard এর জন্য)
- **নির্ভরযোগ্য না:** `export` (শুধু ওই টার্মিনালে), `SecretStorage` (ক্যাশ বাগ)
- **নির্ভরযোগ্য:** `proxy নিজে কী ওন করবে` (Option B)
- Wizard `API Key` টা `bridge/config.json` বা `bridge/.env` এ লিখবে, proxy `requestAuthToken` ইগনোর করে নিজের কী ইউজ করবে
- প্রজেক্ট `settings.json` এ শুধু `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` থাকবে, `ANTHROPIC_API_KEY` ডামি বা না থাকলেও চলবে
- `Apply to: [x] all` মানে শুধু `MODEL` কপি হবে, `KEY` এক জায়গায়

## Next → Chapter 2: Wizard UX Design
