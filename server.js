try { require("dotenv").config({ quiet: true }); } catch {}
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ─── Terminal styling (zero deps — NO_COLOR / CI aware) ──────────────────────
const SUPPORTS_COLOR =
  !process.env.NO_COLOR &&
  !process.env.CI &&
  process.stdout.isTTY !== false;

const ESC = SUPPORTS_COLOR
  ? { reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m",
      cyan:"\x1b[36m", green:"\x1b[32m", yellow:"\x1b[33m", red:"\x1b[31m" }
  : Object.fromEntries(
      ["reset","bold","dim","cyan","green","yellow","red"].map((k) => [k, ""])
    );

function styled(code, text) {
  return SUPPORTS_COLOR ? `${code}${text}${ESC.reset}` : text;
}
const clrBold   = (t) => styled(ESC.bold,   t);
const clrDim    = (t) => styled(ESC.dim,    t);
const clrCyan   = (t) => styled(ESC.cyan,   t);
const clrGreen  = (t) => styled(ESC.green,  t);
const clrYellow = (t) => styled(ESC.yellow, t);
const clrRed    = (t) => styled(ESC.red,    t);

function formatDuration(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatTimestamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_MODELS = ["muse-spark-1.2-contributor-free"];
const DEFAULT_REASONING_CACHE_PATH = path.join(
  os.homedir(),
  ".claude",
  "deepseek-v4-opencode-claude-code-bridge-reasoning-cache.json",
);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 0;
const DEFAULT_REASONING_CACHE_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES = 200 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_COMPLETIONS_RESPONSE_HEADERS = ["content-type", "cache-control"];
const warnedFinishReasons = new Set();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveMaybeRelative(value, baseDir) {
  const expanded = expandHome(value);
  if (!expanded || path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

function configValue(config, keys, fallback) {
  let cursor = config;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined || cursor === null ? fallback : cursor;
}

function numberConfig(name, value, fallback, options = {}) {
  const number = Number(value === undefined || value === null ? fallback : value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid numeric config ${name}: ${JSON.stringify(value)}`);
  }
  if (options.integer && !Number.isInteger(number)) {
    throw new Error(`Invalid integer config ${name}: ${JSON.stringify(value)}`);
  }
  if (options.min !== undefined && number < options.min) {
    throw new Error(`Invalid config ${name}: ${number} is below ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw new Error(`Invalid config ${name}: ${number} is above ${options.max}`);
  }
  return number;
}

function envValue(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

function loadConfig() {
  // Source of truth is .env — no config.json
  return {
    configPath: path.join(__dirname, ".env"),
    listenHost: envValue("CLAUDE_OPENCODE_PROXY_HOST", "127.0.0.1"),
    port: numberConfig("listen.port", envValue("CLAUDE_OPENCODE_PROXY_PORT", 8787), 8787, { integer: true, min: 1, max: 65535 }),
    upstreamEndpoint: envValue("ENDPOINT", "") || "",
    upstreamBaseUrl: normalizeBaseUrl(envValue("CLAUDE_OPENCODE_PROXY_UPSTREAM_BASE_URL", envValue("BASE_URL", DEFAULT_BASE_URL))),
    primaryModel: envValue("MODEL", DEFAULT_MODELS[0]),
    opencodeKey: envValue("OPENCODE_API_KEY", envValue("ANTHROPIC_API_KEY", "")),
    reasoningCachePath: resolveMaybeRelative(
      envValue("CLAUDE_OPENCODE_REASONING_CACHE", DEFAULT_REASONING_CACHE_PATH),
      __dirname,
    ),
    reasoningCacheMaxEntries: numberConfig("reasoningCacheMaxEntries", envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_ENTRIES", DEFAULT_REASONING_CACHE_MAX_ENTRIES), DEFAULT_REASONING_CACHE_MAX_ENTRIES, { integer: true, min: 0 }),
    reasoningCacheMaxAgeMs: numberConfig("reasoningCacheMaxAgeMs", envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS", DEFAULT_REASONING_CACHE_MAX_AGE_MS), DEFAULT_REASONING_CACHE_MAX_AGE_MS, { integer: true, min: 0 }),
    reasoningCacheMaxSizeBytes: numberConfig("reasoningCacheMaxSizeBytes", envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES", DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES), DEFAULT_REASONING_CACHE_MAX_SIZE_BYTES, { integer: true, min: 0 }),
    reasoningContentMode: envValue("CLAUDE_OPENCODE_REASONING_CONTENT", "auto"),
    requestBodyLimitBytes: numberConfig("requestBodyLimitBytes", envValue("CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES", DEFAULT_REQUEST_BODY_LIMIT_BYTES), DEFAULT_REQUEST_BODY_LIMIT_BYTES, { integer: true, min: 1 }),
    upstreamTimeoutMs: numberConfig("upstreamTimeoutMs", envValue("CLAUDE_OPENCODE_UPSTREAM_TIMEOUT_MS", DEFAULT_UPSTREAM_TIMEOUT_MS), DEFAULT_UPSTREAM_TIMEOUT_MS, { integer: true, min: 0 }),
    models: [envValue("MODEL", DEFAULT_MODELS[0])].filter(Boolean),
    endpointMode: String(envValue("CLAUDE_OPENCODE_ENDPOINT_MODE", "auto")).toLowerCase(),
  };
}

function normalizeBaseUrl(url) {
  const base = (url || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function isResponsesModel(model) {
  // Zen/Go Responses API models (OpenAI Responses): muse-spark, gpt-5.x, grok, claude
  // Chat-completions models: deepseek, glm, kimi, mimo, qwen, etc.
  if (!model || typeof model !== "string") return false;
  return /muse-spark|gpt-5|grok|claude-(fable|opus|sonnet|haiku)/i.test(model);
}

function resolveUpstreamPath(model, endpointMode) {
  const mode = String(endpointMode || CONFIG.endpointMode || "auto").toLowerCase();
  if (mode === "responses") return "/responses";
  if (mode === "chat" || mode === "chat_completions") return "/chat/completions";
  // auto: detect by model name
  return isResponsesModel(model) ? "/responses" : "/chat/completions";
}

const CONFIG = loadConfig();
const reasoningByToolCallId = new Map();
const reasoningByAssistantText = new Map();
const reasoningByToolContext = new Map();
const PLACEHOLDER_REASONING =
  "Compatibility bridge placeholder reasoning for prior assistant history.";

function sha256(text) {
  return crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
}

function cacheFileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

function normalizeReasoningEntry(value, fallbackUpdatedAt = Date.now()) {
  if (typeof value === "string") {
    return { reasoning: value, updatedAt: fallbackUpdatedAt };
  }
  if (!value || typeof value !== "object" || typeof value.reasoning !== "string") {
    return null;
  }
  const updatedAt = Number(value.updatedAt);
  return {
    reasoning: value.reasoning,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : fallbackUpdatedAt,
  };
}

function isReasoningEntryExpired(entry, now = Date.now()) {
  const maxAgeMs = CONFIG.reasoningCacheMaxAgeMs;
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - entry.updatedAt > maxAgeMs;
}

function loadReasoningCache() {
  const cache = readJson(CONFIG.reasoningCachePath);
  if (!cache || typeof cache !== "object") return;
  const fallbackUpdatedAt = Number.isFinite(Number(cache.updatedAt))
    ? Number(cache.updatedAt)
    : cacheFileMtimeMs(CONFIG.reasoningCachePath);

  for (const [id, value] of Object.entries(cache.toolCallReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof id === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolCallId, id, entry, { touch: false });
    }
  }

  for (const [hash, value] of Object.entries(cache.assistantTextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByAssistantText, hash, entry, { touch: false });
    }
  }

  for (const [hash, value] of Object.entries(cache.toolContextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolContext, hash, entry, { touch: false });
    }
  }

  trimReasoningCaches();
}

let saveReasoningTimer = null;
let reasoningCacheDirty = false;

function reasoningCachePayloadObject() {
  return {
    version: 2,
    note: "DeepSeek V4 reasoning_content cache for the OpenCode Go Claude Code bridge. It is required for thinking-mode tool-call history replay.",
    updatedAt: Date.now(),
    maxEntriesPerBucket: CONFIG.reasoningCacheMaxEntries,
    maxAgeMs: CONFIG.reasoningCacheMaxAgeMs,
    maxSizeBytes: CONFIG.reasoningCacheMaxSizeBytes,
    toolCallReasoning: Object.fromEntries(reasoningByToolCallId.entries()),
    assistantTextReasoning: Object.fromEntries(reasoningByAssistantText.entries()),
    toolContextReasoning: Object.fromEntries(reasoningByToolContext.entries()),
  };
}

function reasoningCachePayload() {
  trimReasoningCaches();
  return reasoningCachePayloadObject();
}

function saveReasoningCacheNow() {
  try {
    const data = JSON.stringify(reasoningCachePayload(), null, 2);
    const tmp = `${CONFIG.reasoningCachePath}.tmp`;
    fs.mkdirSync(path.dirname(CONFIG.reasoningCachePath), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, CONFIG.reasoningCachePath);
    reasoningCacheDirty = false;
    return true;
  } catch (error) {
    console.error(`Failed to save reasoning cache: ${error.message}`);
    return false;
  }
}

function flushReasoningCache() {
  if (saveReasoningTimer) {
    clearTimeout(saveReasoningTimer);
    saveReasoningTimer = null;
  }
  if (reasoningCacheDirty) saveReasoningCacheNow();
}

function scheduleSaveReasoningCache() {
  reasoningCacheDirty = true;
  if (saveReasoningTimer) return;
  saveReasoningTimer = setTimeout(() => {
    saveReasoningTimer = null;
    saveReasoningCacheNow();
  }, 100);
}

function trimMap(map) {
  const maxEntries = CONFIG.reasoningCacheMaxEntries;
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function trimExpiredMap(map, now) {
  for (const [key, entry] of map.entries()) {
    if (isReasoningEntryExpired(entry, now)) map.delete(key);
  }
}

function reasoningCacheSerializedSize() {
  return Buffer.byteLength(JSON.stringify(reasoningCachePayloadObject()), "utf8");
}

function deleteOldestReasoningEntry() {
  const candidates = [
    { name: "tool", map: reasoningByToolCallId },
    { name: "assistant", map: reasoningByAssistantText },
    { name: "context", map: reasoningByToolContext },
  ];
  let oldest = null;
  for (const candidate of candidates) {
    for (const [key, entry] of candidate.map.entries()) {
      if (!oldest || entry.updatedAt < oldest.entry.updatedAt) {
        oldest = { ...candidate, key, entry };
      }
    }
  }
  if (!oldest) return false;
  oldest.map.delete(oldest.key);
  return true;
}

function trimReasoningCacheSize() {
  const maxSizeBytes = CONFIG.reasoningCacheMaxSizeBytes;
  if (!Number.isFinite(maxSizeBytes) || maxSizeBytes <= 0) return;
  while (reasoningCacheSerializedSize() > maxSizeBytes) {
    if (!deleteOldestReasoningEntry()) return;
  }
}

function trimReasoningCaches() {
  const now = Date.now();
  trimExpiredMap(reasoningByToolCallId, now);
  trimExpiredMap(reasoningByAssistantText, now);
  trimExpiredMap(reasoningByToolContext, now);
  trimMap(reasoningByToolCallId);
  trimMap(reasoningByAssistantText);
  trimMap(reasoningByToolContext);
  trimReasoningCacheSize();
}

function setMapRecent(map, key, value, options = {}) {
  const entry = normalizeReasoningEntry(value);
  if (!entry) return;
  if (options.touch !== false) entry.updatedAt = Date.now();
  if (map.has(key)) map.delete(key);
  map.set(key, entry);
  trimMap(map);
}

function getMapRecent(map, key) {
  if (!map.has(key)) return null;
  const entry = map.get(key);
  if (isReasoningEntryExpired(entry)) {
    map.delete(key);
    scheduleSaveReasoningCache();
    return null;
  }
  setMapRecent(map, key, entry);
  return entry.reasoning;
}

function setToolReasoning(id, reasoning) {
  if (!id || !reasoning) return;
  setMapRecent(reasoningByToolCallId, id, reasoning);
  scheduleSaveReasoningCache();
}

function getToolReasoning(id) {
  if (!id) return null;
  return getMapRecent(reasoningByToolCallId, id);
}

function getAssistantReasoning(text) {
  return getMapRecent(reasoningByAssistantText, sha256(text));
}

function setAssistantReasoning(text, reasoning) {
  if (!text || !reasoning) return;
  setMapRecent(reasoningByAssistantText, sha256(text), reasoning);
  scheduleSaveReasoningCache();
}

function toolUseSignature(tool) {
  return `tool_use:${tool.id || ""}:${tool.name || ""}:${JSON.stringify(tool.input || {})}`;
}

function toolResultSignature(result) {
  return `tool_result:${result.tool_use_id || result.id || ""}:${stringifyToolResultContent(result.content)}`;
}

function toolContextKey(parts, assistantText) {
  if (!parts || !parts.length || !assistantText) return null;
  return sha256(`${parts.join("\n")}\nassistant:${assistantText}`);
}

function getToolContextReasoning(parts, assistantText) {
  const key = toolContextKey(parts, assistantText);
  return key ? getMapRecent(reasoningByToolContext, key) : null;
}

function setToolContextReasoning(parts, assistantText, reasoning) {
  const key = toolContextKey(parts, assistantText);
  if (!key || !reasoning) return;
  setMapRecent(reasoningByToolContext, key, reasoning);
  scheduleSaveReasoningCache();
}

function currentToolContextParts(messages) {
  let hadToolCall = false;
  let parts = [];

  for (const msg of messages || []) {
    const blocks = Array.isArray(msg && msg.content) ? msg.content : [];
    const text = typeof (msg && msg.content) === "string"
      ? msg.content
      : blocks
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
    const toolResults = blocks.filter((block) => block && block.type === "tool_result");
    const toolUses = blocks.filter((block) => block && block.type === "tool_use");

    if (msg && msg.role === "user") {
      if (!toolResults.length && text) {
        hadToolCall = false;
        parts = [];
      }
      for (const result of toolResults) {
        if (hadToolCall) parts.push(toolResultSignature(result));
      }
      continue;
    }

    if (msg && msg.role === "assistant" && toolUses.length) {
      hadToolCall = true;
      parts = toolUses.map(toolUseSignature);
    }
  }

  return hadToolCall ? parts : [];
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = "invalid_request_error") {
  sendJson(res, status, {
    type: "error",
    error: { type, message },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;

    function cleanup() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }

    function fail(error) {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
      req.resume();
    }

    function onData(chunk) {
      if (done) return;
      data += chunk;
      if (data.length > CONFIG.requestBodyLimitBytes) {
        const error = new Error("Request body exceeds requestBodyLimitBytes.");
        error.status = 413;
        error.type = "invalid_request_error";
        fail(error);
      }
    }

    function onEnd() {
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    }

    function onError(error) {
      fail(error);
    }

    req.setEncoding("utf8");
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    const parseError = new Error(`Invalid JSON request body: ${error.message}`);
    parseError.status = 400;
    parseError.type = "invalid_request_error";
    throw parseError;
  }
}

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function thinkingFromAnthropicContent(content) {
  if (!Array.isArray(content)) return "";
  // TODO: Anthropic redacted_thinking blocks are opaque encrypted data. DeepSeek
  // expects readable reasoning_content, so there is no safe lossless mapping yet.
  return content
    .filter((block) => block && block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((block) => {
      if (!block) return "";
      if (block.type === "text") return block.text || "";
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToOpenAi(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textFromAnthropicContent(system);
  return String(system);
}

function shouldSendReasoningContent(model) {
  const mode = String(CONFIG.reasoningContentMode || "auto").toLowerCase();
  if (["always", "true", "on"].includes(mode)) return true;
  if (["never", "false", "off", "none"].includes(mode)) return false;
  return isReasoningModel(model);
}

function isReasoningModel(model) {
  return typeof model === "string" && /(deepseek|muse-spark|mimo|grok|gpt-5|claude)/i.test(model);
}

function anthropicMessagesToOpenAi(messages, includeReasoningContent) {
  const out = [];
  let currentUserTurnHadToolCall = false;
  let currentToolContext = [];

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;

    if (typeof msg.content === "string") {
      if (msg.role === "user") currentUserTurnHadToolCall = false;
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const thinking = thinkingFromAnthropicContent(blocks);

    const toolResults = blocks.filter((block) => block && block.type === "tool_result");
    const toolUses = blocks.filter((block) => block && block.type === "tool_use");

    if (msg.role === "user") {
      if (toolResults.length) {
        for (const result of toolResults) {
          if (currentUserTurnHadToolCall) currentToolContext.push(toolResultSignature(result));
          out.push({
            role: "tool",
            tool_call_id: result.tool_use_id || result.id || "call_unknown",
            content: stringifyToolResultContent(result.content),
          });
        }
        if (text) {
          currentUserTurnHadToolCall = false;
          currentToolContext = [];
          out.push({ role: "user", content: text });
        }
      } else {
        currentUserTurnHadToolCall = false;
        currentToolContext = [];
        if (text) out.push({ role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const assistant = { role: "assistant", content: text || null };
      if (toolUses.length) {
        currentUserTurnHadToolCall = true;
        currentToolContext = toolUses.map(toolUseSignature);
        assistant.tool_calls = toolUses.map((tool, index) => ({
          id: tool.id || `call_${index}`,
          type: "function",
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }));
        if (includeReasoningContent) {
          const reasoning = toolUses
            .map((tool) => getToolReasoning(tool.id))
            .filter(Boolean)
            .join("\n");
          assistant.reasoning_content = thinking || reasoning || PLACEHOLDER_REASONING;
        }
      } else if (text && currentUserTurnHadToolCall) {
        if (includeReasoningContent) {
          assistant.reasoning_content =
            thinking ||
            getToolContextReasoning(currentToolContext, text) ||
            getAssistantReasoning(text) ||
            PLACEHOLDER_REASONING;
        }
      }
      out.push(assistant);
      continue;
    }

    out.push({ role: msg.role, content: text });
  }

  return sanitizeOpenAiToolMessageSequence(coalesceAdjacentAssistantToolCalls(out));
}

function mergeAssistantContent(left, right) {
  const parts = [];
  if (typeof left === "string" && left) parts.push(left);
  if (typeof right === "string" && right) parts.push(right);
  return parts.length ? parts.join("\n") : null;
}

function coalesceAdjacentAssistantToolCalls(messages) {
  const out = [];

  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      msg &&
      prev.role === "assistant" &&
      msg.role === "assistant" &&
      Array.isArray(prev.tool_calls) &&
      prev.tool_calls.length &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length
    ) {
      prev.content = mergeAssistantContent(prev.content, msg.content);
      prev.tool_calls.push(...msg.tool_calls);
      if (msg.reasoning_content) {
        prev.reasoning_content = [prev.reasoning_content, msg.reasoning_content]
          .filter(Boolean)
          .join("\n");
      }
      continue;
    }

    out.push(msg);
  }

  return out;
}

function assistantWithoutToolCalls(message) {
  if (!message || message.role !== "assistant") return null;
  const out = { ...message };
  delete out.tool_calls;
  if (out.content === null || out.content === undefined || out.content === "") {
    return null;
  }
  return out;
}

function orphanToolMessageToUser(message) {
  if (!message || message.role !== "tool") return null;
  const id = message.tool_call_id || "unknown";
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
  return {
    role: "user",
    content: `Tool result without a matching tool call (${id}):\n${content}`,
  };
}

function sanitizeOpenAiToolMessageSequence(messages) {
  const out = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];

    if (message && message.role === "assistant" && toolCalls.length) {
      const toolMessages = [];
      let j = i + 1;
      while (j < messages.length && messages[j] && messages[j].role === "tool") {
        toolMessages.push(messages[j]);
        j += 1;
      }

      if (!toolMessages.length && j === messages.length) {
        out.push(message);
        continue;
      }

      const expectedIds = new Set(toolCalls.map((call) => call && call.id).filter(Boolean));
      const toolById = new Map();
      const orphanTools = [];
      for (const toolMessage of toolMessages) {
        const id = toolMessage.tool_call_id;
        if (expectedIds.has(id) && !toolById.has(id)) {
          toolById.set(id, toolMessage);
        } else {
          orphanTools.push(toolMessage);
        }
      }

      const fulfilledCalls = toolCalls.filter((call) => call && toolById.has(call.id));
      if (fulfilledCalls.length) {
        out.push({ ...message, tool_calls: fulfilledCalls });
        for (const call of fulfilledCalls) out.push(toolById.get(call.id));
      } else {
        const fallback = assistantWithoutToolCalls(message);
        if (fallback) out.push(fallback);
      }

      for (const orphan of orphanTools) {
        const userMessage = orphanToolMessageToUser(orphan);
        if (userMessage) out.push(userMessage);
      }
      i = j - 1;
      continue;
    }

    if (message && message.role === "tool") {
      const userMessage = orphanToolMessageToUser(message);
      if (userMessage) out.push(userMessage);
      continue;
    }

    out.push(message);
  }

  return out;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }));
}

function anthropicToolChoiceToOpenAi(choice, model) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (isReasoningModel(model)) {
    // Reasoning models reject forced function tool_choice, so any/tool are
    // converted to system instructions instead.
    return undefined;
  }
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function toolChoiceInstruction(choice, model) {
  if (!choice || typeof choice !== "object") return null;
  if (!isReasoningModel(model)) return null;
  if (choice.type === "any") {
    return "The caller requires a tool call for this turn. Call one of the available tools instead of answering directly.";
  }
  if (choice.type === "tool" && choice.name) {
    return `The caller requires a tool call for this turn. Call the available tool named ${JSON.stringify(choice.name)} instead of answering directly.`;
  }
  return null;
}

function thinkingToOpenAi(thinking) {
  if (!thinking || typeof thinking !== "object") return undefined;
  if (thinking.type === "enabled") {
    return { type: thinking.type };
  }
  // DeepSeek rejects {type:"disabled"} when reasoning_effort is set.
  // Omitting the field entirely lets DeepSeek use its default behavior.
  return undefined;
}

function reasoningEffortToOpenAi(outputConfig) {
  // Claude Code may send Anthropic-format output_config.effort. DeepSeek V4's
  // OpenAI-compatible API accepts high/max and maps low/medium to high itself;
  // we normalize here so the upstream payload is explicit and stable.
  const effort = outputConfig && typeof outputConfig === "object" ? outputConfig.effort : undefined;
  if (typeof effort !== "string") return undefined;
  const normalized = effort.toLowerCase();
  if (normalized === "max" || normalized === "xhigh") return "max";
  if (normalized === "high" || normalized === "medium" || normalized === "low") return "high";
  return undefined;
}

function anthropicToOpenAi(body, stream) {
  const messages = [];
  const sendReasoningExtensions = isReasoningModel(body.model);
  const extraSystem = toolChoiceInstruction(body.tool_choice, body.model);
  const system = [systemToOpenAi(body.system), extraSystem].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessagesToOpenAi(body.messages, shouldSendReasoningContent(body.model)));

  const payload = {
    model: body.model || CONFIG.primaryModel || CONFIG.models[0],
    messages,
    stream,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: anthropicToolsToOpenAi(body.tools),
    tool_choice: anthropicToolChoiceToOpenAi(body.tool_choice, body.model),
    thinking: sendReasoningExtensions ? thinkingToOpenAi(body.thinking) : undefined,
    reasoning_effort: sendReasoningExtensions ? reasoningEffortToOpenAi(body.output_config) : undefined,
    stream_options: stream ? { include_usage: true } : undefined,
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  if (Array.isArray(payload.tools) && payload.tools.length === 0) delete payload.tools;
  return payload;
}

// ─── Responses API (muse-spark, gpt-5, grok) ──────────────────
function anthropicContentToResponsesInput(content, role = "user") {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: textType, text: block.text });
    } else if (block.type === "tool_result") {
      // Tool results → always as input_text (user role)
      const text = stringifyToolResultContent(block.content);
      out.push({ type: "input_text", text: `Tool result for ${block.tool_use_id || block.id || "unknown"}:\n${text}` });
    } else if (block.type === "tool_use") {
      // Tool use in history → encode as text for context
      out.push({ type: textType, text: `Tool call ${block.name}(${JSON.stringify(block.input || {})})` });
    } else if (block.type === "thinking") {
      // Skip thinking blocks for responses input
      continue;
    }
  }
  return out;
}

function anthropicMessagesToResponsesInput(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    if (msg.role === "system") {
      const text = systemToOpenAi(msg.content) || textFromAnthropicContent(msg.content);
      if (text) out.push({ role: "system", content: [{ type: "input_text", text }] });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const hasToolUse = blocks.some((b) => b && b.type === "tool_use");
    const hasToolResult = blocks.some((b) => b && b.type === "tool_result");
    // Assistant tool_use cannot be sent as input_text - skip, tool_result will carry context
    if (msg.role === "assistant" && hasToolUse) {
      const textBlocks = blocks.filter((b) => b && b.type === "text" && b.text);
      if (textBlocks.length) {
        const input = anthropicContentToResponsesInput(textBlocks, "assistant");
        if (input.length) out.push({ role: "assistant", content: input });
      }
      continue;
    }
    if (msg.role === "user" || msg.role === "assistant") {
      const input = anthropicContentToResponsesInput(msg.content, msg.role);
      if (input.length) out.push({ role: msg.role, content: input });
    }
  }
  return out;
}

function anthropicToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    }));
}

function anthropicToResponses(body, stream) {
  const systemText = [systemToOpenAi(body.system), toolChoiceInstruction(body.tool_choice, body.model)].filter(Boolean).join("\n\n");
  const input = anthropicMessagesToResponsesInput(body.messages);
  // System as first message if present
  if (systemText) input.unshift({ role: "system", content: [{ type: "input_text", text: systemText }] });

  const payload = {
    model: body.model || CONFIG.primaryModel || CONFIG.models[0],
    input,
    stream: stream || undefined,
    instructions: undefined,
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: body.max_tokens && body.max_tokens >= 1024 ? body.max_tokens : undefined,
    tools: anthropicToolsToResponsesTools(body.tools),
    tool_choice: anthropicToolChoiceToOpenAi(body.tool_choice, body.model),
    parallel_tool_calls: true,
  };
  // Reasoning effort for muse-spark
  const effort = reasoningEffortToOpenAi(body.output_config);
  if (effort) payload.reasoning = { effort: effort === "max" ? "high" : effort };

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  if (Array.isArray(payload.tools) && payload.tools.length === 0) delete payload.tools;
  return payload;
}

function parseJsonObject(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function reasoningFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  if (typeof message.reasoning === "string") return message.reasoning;
  if (message.reasoning && typeof message.reasoning.content === "string") {
    return message.reasoning.content;
  }
  if (typeof message.thinking === "string") return message.thinking;
  if (message.thinking && typeof message.thinking.content === "string") {
    return message.thinking.content;
  }
  return "";
}

function thinkingContentBlock(reasoning) {
  return {
    type: "thinking",
    thinking: reasoning,
    signature: "",
  };
}

function mapFinishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason && !warnedFinishReasons.has(reason)) {
    warnedFinishReasons.add(reason);
    console.warn(`Unknown upstream finish_reason: ${reason}`);
  }
  return reason || "end_turn";
}

function openAiToAnthropic(body, originalModel, toolContextParts = []) {
  const choice = body.choices && body.choices[0] ? body.choices[0] : {};
  const message = choice.message || {};
  const reasoning = reasoningFromMessage(message);
  const content = [];

  if (reasoning) {
    content.push(thinkingContentBlock(reasoning));
  }

  if (message.content) {
    if (reasoning) {
      setAssistantReasoning(message.content, reasoning);
      setToolContextReasoning(toolContextParts, message.content, reasoning);
    }
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.tool_calls || []) {
    if (reasoning) {
      setToolReasoning(call.id, reasoning);
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function && call.function.name,
      input: parseJsonObject(call.function && call.function.arguments),
    });
  }

  return {
    id: body.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: body.model || originalModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: openAiUsageToAnthropic(body.usage),
  };
}

function reasoningFromResponsesOutput(output) {
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (item && item.type === "reasoning" && item.summary && Array.isArray(item.summary)) {
      const texts = item.summary.map((s) => s.text || "").filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (item && item.type === "reasoning" && typeof item.encrypted_content === "string") {
      // Encrypted content not decodable, but we can use summary if present
      continue;
    }
  }
  return "";
}

function textFromResponsesOutput(output) {
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (item && item.type === "message" && item.content) {
      const texts = item.content.filter((c) => c.type === "output_text").map((c) => c.text || "");
      if (texts.length) return texts.join("\n");
    }
  }
  return "";
}

function toolCallsFromResponsesOutput(output) {
  if (!Array.isArray(output)) return [];
  const calls = [];
  for (const item of output) {
    if (item && item.type === "function_call") {
      calls.push({
        id: item.call_id || item.id || `call_${calls.length}`,
        name: item.name,
        input: parseJsonObject(item.arguments),
      });
    }
  }
  return calls;
}

function responsesToAnthropic(body, originalModel, toolContextParts = []) {
  const output = body.output || [];
  const reasoning = reasoningFromResponsesOutput(output);
  const text = textFromResponsesOutput(output);
  const toolCalls = toolCallsFromResponsesOutput(output);
  const content = [];
  if (reasoning) content.push(thinkingContentBlock(reasoning));
  if (text) {
    if (reasoning) {
      setAssistantReasoning(text, reasoning);
      setToolContextReasoning(toolContextParts, text, reasoning);
    }
    content.push({ type: "text", text });
  }
  for (const call of toolCalls) {
    if (reasoning) setToolReasoning(call.id, reasoning);
    content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }
  // Usage: responses uses input_tokens/output_tokens
  const usage = body.usage
    ? {
        input_tokens: body.usage.input_tokens || 0,
        output_tokens: body.usage.output_tokens || 0,
      }
    : { input_tokens: 0, output_tokens: 0 };

  return {
    id: body.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: content.length ? content : [{ type: "text", text: "" }],
    model: body.model || originalModel,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage,
  };
}

function makeAbortError(upstreamContext) {
  const error = new Error(upstreamContext.abortMessage);
  error.status = upstreamContext.abortStatus;
  error.type = "proxy_error";
  return error;
}

function normalizeUpstreamError(error, upstreamContext) {
  if (upstreamContext && upstreamContext.signal.aborted && !error.status) {
    return makeAbortError(upstreamContext);
  }
  return error;
}

function payloadDebugSummary(payload) {
  // Chat Completions uses payload.messages; Responses API uses payload.input.
  const isResponsesPayload = Array.isArray(payload && payload.input);
  const messages = isResponsesPayload
    ? payload.input
    : Array.isArray(payload && payload.messages) ? payload.messages : [];

  const summary = {
    model: payload && payload.model,
    api: isResponsesPayload ? "responses" : "chat_completions",
    stream: Boolean(payload && payload.stream),
    message_count: messages.length,
  };

  if (isResponsesPayload) {
    // Responses API: payload.input items have role + content[]
    summary.input = messages.map((item, index) => ({
      index,
      role: item && item.role,
      content_count: Array.isArray(item && item.content) ? item.content.length : 0,
    }));
  } else {
    // Chat Completions: payload.messages items have role + tool_calls
    summary.messages = messages.map((message, index) => {
      const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
      const item = { index, role: message && message.role };
      if (message && message.name) item.name = message.name;
      if (message && message.tool_call_id) item.tool_call_id = message.tool_call_id;
      if (toolCalls.length) {
        item.tool_call_ids = toolCalls.map((call) => call && call.id).filter(Boolean);
      }
      return item;
    });
  }

  return summary;
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "localhost" || normalized.startsWith("127.");
}

function requestProcessShutdown(server) {
  setImmediate(() => {
    console.log("Received local shutdown request; flushing reasoning cache and shutting down.");
    flushReasoningCache();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

async function callOpenCode(req, payload, upstreamContext, opts = {}) {
  // Global proxy: .env OPENCODE_API_KEY is always preferred.
  // Client-provided sk-ant- keys are Anthropic keys and will be rejected by opencode.
  // If no .env key is configured, fall back to whatever the client sent.
  const clientKey = requestAuthToken(req);
  const upstreamApiKey = CONFIG.opencodeKey || clientKey || "";
  if (!upstreamApiKey) {
    throw new Error(
      "Upstream API key is not set. Set OPENCODE_API_KEY in .env or ANTHROPIC_API_KEY in settings.",
    );
  }
  const upstreamPathResolved = opts.upstreamPath || "/chat/completions";
  // If .env ENDPOINT is full URL (contains /responses or /chat), use it directly.
  // NOTE: When ENDPOINT is a full URL, model-based auto-routing (resolveUpstreamPath /
  // isResponsesModel) is bypassed — all models hit the single ENDPOINT URL regardless.
  const fullUpstreamUrl = CONFIG.upstreamEndpoint && CONFIG.upstreamEndpoint.startsWith("http") && (CONFIG.upstreamEndpoint.includes("/responses") || CONFIG.upstreamEndpoint.includes("/chat"))
    ? CONFIG.upstreamEndpoint
    : `${CONFIG.upstreamBaseUrl}${upstreamPathResolved}`;
  console.log(`[upstream] key: set len=${upstreamApiKey.length} url=${fullUpstreamUrl} model=${payload.model || "?"}`);
  const response = await fetch(fullUpstreamUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${upstreamApiKey}`,
      "content-type": "application/json",
    },
    signal: upstreamContext.signal,
    body: JSON.stringify(payload),
  }).catch((error) => {
    if (upstreamContext.signal.aborted) throw makeAbortError(upstreamContext);
    throw error;
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Upstream payload summary: ${JSON.stringify(payloadDebugSummary(payload))} path=${upstreamPathResolved}`);
    const error = new Error(`OpenCode Go returned ${response.status}: ${text}`);
    error.status = response.status;
    error.type = response.status >= 500 ? "proxy_error" : "upstream_error";
    throw error;
  }

  return response;
}

function sse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeMessageStart(res, model) {
  const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Anthropic sends input_tokens in message_start, but OpenAI-compatible
      // streaming usage only arrives near the end. We report output usage in
      // message_delta and leave input_tokens at 0 to avoid buffering the stream.
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function contentBlockStart(res, index, block) {
  sse(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function contentBlockDelta(res, index, delta) {
  sse(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  });
}

function contentBlockStop(res, index) {
  sse(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

function requestAuthToken(req) {
  const authorization = req.headers.authorization || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return req.headers["x-api-key"] || "";
}

function truncateForLog(value, maxLength = 500) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function requestLabel(req) {
  // Kept for internal error message construction — display uses logRequest/logRequestError.
  return `${req.method || "?"} ${req.url || "?"}`;
}

function parsedPathname(req) {
  try { return new URL(req.url || "/", "http://x").pathname; } catch { return req.url || "/"; }
}

function logRequest(req, res, startedAt) {
  const ms = Date.now() - startedAt;
  const status = res.statusCode;
  const method = (req.method || "?").padEnd(5);
  const pathname = parsedPathname(req).padEnd(22);

  const icon = status >= 500 ? clrRed("✖") : status >= 400 ? clrYellow("–") : clrGreen("✔");
  const coloredStatus =
    status >= 500 ? clrRed(String(status)) :
    status >= 400 ? clrYellow(String(status)) :
    clrGreen(String(status));

  console.log(
    `${clrDim(formatTimestamp())}  ${icon}  ${clrBold(method)}${clrDim(pathname)} ` +
    `${coloredStatus}  ${clrDim(formatDuration(ms))}`
  );
}

function logRequestError(req, status, error) {
  const message = error && error.message ? error.message : String(error);
  const method  = (req.method || "?").padEnd(5);
  const pathname = parsedPathname(req).padEnd(22);
  console.error(
    `${clrDim(formatTimestamp())}  ${clrRed("✖")}  ${clrBold(method)}${clrDim(pathname)} ` +
    `${clrRed(String(status))}  ${clrDim(message)}`
  );
}

function upstreamResponseHeaders(headers) {
  const out = {
    "access-control-allow-origin": "*",
  };
  for (const name of CHAT_COMPLETIONS_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function openAiUsageToAnthropic(usage) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const out = {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  };
  if (usage.prompt_cache_hit_tokens) {
    out.cache_read_input_tokens = usage.prompt_cache_hit_tokens;
  }
  if (usage.prompt_cache_miss_tokens) {
    // Compatibility estimate: DeepSeek/OpenCode Go reports cache-miss input,
    // not Anthropic-style cache creation. Mapping it here makes Claude Code
    // /usage show the uncached side of DeepSeek billing as "cache write".
    out.cache_creation_input_tokens = usage.prompt_cache_miss_tokens;
  }
  return out;
}

function createUpstreamContext(res) {
  const controller = new AbortController();
  let abortStatus = 504;
  let abortMessage = `Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`;
  let timer = null;

  function abort(message, status) {
    if (controller.signal.aborted) return;
    abortMessage = message;
    abortStatus = status;
    controller.abort();
  }

  if (CONFIG.upstreamTimeoutMs > 0) {
    timer = setTimeout(
      () => abort(`Upstream request timed out after ${CONFIG.upstreamTimeoutMs}ms`, 504),
      CONFIG.upstreamTimeoutMs,
    );
  }

  const onClose = () => {
    if (!res.writableEnded) abort("Client disconnected before upstream response completed", 499);
  };
  res.on("close", onClose);

  return {
    signal: controller.signal,
    get abortStatus() {
      return abortStatus;
    },
    get abortMessage() {
      return abortMessage;
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      res.off("close", onClose);
    },
  };
}

async function probeUpstream(req) {
  const upstreamApiKey = requestAuthToken(req);
  if (!upstreamApiKey) {
    const error = new Error("OpenCode Go API key is required for upstream health probe.");
    error.status = 400;
    error.type = "invalid_request_error";
    throw error;
  }

  const controller = new AbortController();
  const timer = CONFIG.upstreamTimeoutMs > 0
    ? setTimeout(() => controller.abort(), Math.min(CONFIG.upstreamTimeoutMs, 15000))
    : null;

  try {
    const response = await fetch(`${CONFIG.upstreamBaseUrl}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamApiKey}` },
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Upstream health probe timed out.");
      timeoutError.status = 504;
      timeoutError.type = "proxy_error";
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamOpenAiAsAnthropic(upstream, res, model, toolContextParts = [], upstreamContext = null) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  writeMessageStart(res, model);

  const decoder = new TextDecoder();
  let buffer = "";
  let thinkingBlockIndex = null;
  let thinkingBlockStopped = false;
  let textBlockIndex = null;
  let nextBlockIndex = 0;
  let stopReason = "end_turn";
  const toolBlocks = new Map();
  let reasoningContent = "";
  let textContent = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let streamInterrupted = false;

  function ensureThinkingBlock() {
    if (thinkingBlockIndex !== null) return thinkingBlockIndex;
    thinkingBlockIndex = nextBlockIndex++;
    contentBlockStart(res, thinkingBlockIndex, { type: "thinking", thinking: "", signature: "" });
    return thinkingBlockIndex;
  }

  function stopThinkingBlockIfOpen() {
    if (thinkingBlockIndex === null || thinkingBlockStopped) return;
    contentBlockDelta(res, thinkingBlockIndex, {
      type: "signature_delta",
      signature: "",
    });
    contentBlockStop(res, thinkingBlockIndex);
    thinkingBlockStopped = true;
  }

  function ensureTextBlock() {
    stopThinkingBlockIfOpen();
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    contentBlockStart(res, textBlockIndex, { type: "text", text: "" });
    return textBlockIndex;
  }

  function ensureToolBlock(callIndex, chunk) {
    stopThinkingBlockIfOpen();
    if (toolBlocks.has(callIndex)) return toolBlocks.get(callIndex);
    const blockIndex = nextBlockIndex++;
    const id = chunk.id || `call_${callIndex}_${Date.now().toString(36)}`;
    const name = chunk.function && chunk.function.name || `tool_${callIndex}`;
    contentBlockStart(res, blockIndex, {
      type: "tool_use",
      id,
      name,
      input: {},
    });
    const state = { blockIndex, id, name };
    toolBlocks.set(callIndex, state);
    return state;
  }

  function handleChunk(obj) {
    const choice = obj.choices && obj.choices[0];
    if (obj.usage) {
      usage = openAiUsageToAnthropic(obj.usage);
      if (process.env.CLAUDE_OPENCODE_LOG_USAGE) {
        console.error(`usage raw=${JSON.stringify(obj.usage)} translated=${JSON.stringify(usage)}`);
      }
    }
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.content) {
      textContent += delta.content;
      contentBlockDelta(res, ensureTextBlock(), {
        type: "text_delta",
        text: delta.content,
      });
    }

    const reasoningDelta = reasoningFromMessage(delta);
    if (reasoningDelta) {
      reasoningContent += reasoningDelta;
      // DeepSeek V4 emits reasoning before text/tool content. If another
      // upstream interleaves late reasoning after visible content starts, keep
      // caching it for replay but do not reopen a closed Anthropic thinking block.
      if (!thinkingBlockStopped) {
        contentBlockDelta(res, ensureThinkingBlock(), {
          type: "thinking_delta",
          thinking: reasoningDelta,
        });
      }
    }

    for (const call of delta.tool_calls || []) {
      const callIndex = call.index || 0;
      const state = ensureToolBlock(callIndex, call);
      const args = call.function && call.function.arguments;
      if (args) {
        contentBlockDelta(res, state.blockIndex, {
          type: "input_json_delta",
          partial_json: args,
        });
      }
    }

    if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
  }

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const part of parts) {
        const dataLines = part
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        if (data === "[DONE]") continue;
        try {
          handleChunk(JSON.parse(data));
        } catch (error) {
          console.error(
            `Failed to parse upstream SSE chunk: ${error.message}; data=${truncateForLog(data)}`,
          );
        }
      }
    }
  } catch (error) {
    console.error(`Upstream stream failed: ${error.message}`);
    streamInterrupted = true;
    stopReason = "end_turn";
  } finally {
    stopThinkingBlockIfOpen();
    if (streamInterrupted) {
      contentBlockDelta(res, ensureTextBlock(), {
        type: "text_delta",
        text: "\n\n[stream interrupted]",
      });
    }
    if (textBlockIndex !== null) contentBlockStop(res, textBlockIndex);
    if (textContent && reasoningContent) {
      setAssistantReasoning(textContent, reasoningContent);
      setToolContextReasoning(toolContextParts, textContent, reasoningContent);
    }
    for (const state of toolBlocks.values()) {
      if (reasoningContent) setToolReasoning(state.id, reasoningContent);
      contentBlockStop(res, state.blockIndex);
    }

    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    sse(res, "message_stop", { type: "message_stop" });
    if (!res.writableEnded && !res.destroyed) res.end();
    if (upstreamContext) upstreamContext.cleanup();
  }
}

async function handleMessages(req, res) {
  const body = await readJsonBody(req);
  // Global proxy: override model with .env MODEL if set.
  // Claude Code always sends its own model name; .env MODEL silently wins every request.
  // Log only in debug mode to avoid noise on every request.
  if (CONFIG.primaryModel && body.model !== CONFIG.primaryModel) {
    if (process.env.CLAUDE_OPENCODE_DEBUG) {
      console.log(`[model] override ${body.model} → ${CONFIG.primaryModel} (from .env)`);
    }
    body.model = CONFIG.primaryModel;
  }
  const wantsStream = body.stream === true;
  const toolContextParts = currentToolContextParts(body.messages);
  const useResponses = isResponsesModel(body.model);
  const upstreamPath = resolveUpstreamPath(body.model, CONFIG.endpointMode);
  const upstreamContext = createUpstreamContext(res);
  let upstream;

  try {
    if (useResponses) {
      const payload = anthropicToResponses(body, false);
      // Guard: opencode returns 500 when input is empty. Return 400 early with a clear message.
      if (!Array.isArray(payload.input) || payload.input.length === 0) {
        const err = new Error("Responses API input is empty after translation — no user messages found.");
        err.status = 400;
        err.type = "invalid_request_error";
        throw err;
      }
      upstream = await callOpenCode(req, payload, upstreamContext, { upstreamPath });
      let respBody;
      try {
        respBody = await upstream.json();
      } catch (parseErr) {
        const err = new Error(`Upstream returned non-JSON response: ${parseErr.message}`);
        err.status = 502;
        err.type = "proxy_error";
        throw err;
      }
      const anthropicBody = responsesToAnthropic(respBody, body.model, toolContextParts);
      if (wantsStream) {
        // Simulate streaming for Responses API (upstream is always non-streaming here).
        // Trade-off: the full upstream response is buffered before any SSE event is emitted,
        // so time-to-first-token is higher than a true streaming path. This is a known
        // limitation of the Responses API — it does not support streaming in this bridge.
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        writeMessageStart(res, body.model);
        let idx = 0;
        for (const block of anthropicBody.content) {
          if (block.type === "thinking") {
            contentBlockStart(res, idx, { type: "thinking", thinking: "", signature: "" });
            contentBlockDelta(res, idx, { type: "thinking_delta", thinking: block.thinking });
            contentBlockDelta(res, idx, { type: "signature_delta", signature: "" });
            contentBlockStop(res, idx);
          } else if (block.type === "text") {
            contentBlockStart(res, idx, { type: "text", text: "" });
            contentBlockDelta(res, idx, { type: "text_delta", text: block.text });
            contentBlockStop(res, idx);
          } else if (block.type === "tool_use") {
            contentBlockStart(res, idx, { type: "tool_use", id: block.id, name: block.name, input: {} });
            contentBlockDelta(res, idx, { type: "input_json_delta", partial_json: JSON.stringify(block.input) });
            contentBlockStop(res, idx);
          }
          idx++;
        }
        sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: anthropicBody.stop_reason, stop_sequence: null }, usage: anthropicBody.usage });
        sse(res, "message_stop", { type: "message_stop" });
        res.end();
        upstreamContext.cleanup();
        return;
      }
      sendJson(res, 200, anthropicBody);
      return;
    }

    // Legacy chat/completions path
    const payload = anthropicToOpenAi(body, wantsStream);
    // Guard: some upstreams return 400/500 when messages is empty or has only a system message.
    const nonSystemMessages = (payload.messages || []).filter((m) => m.role !== "system");
    if (nonSystemMessages.length === 0) {
      const err = new Error("Chat Completions messages is empty after translation — no user or assistant messages found.");
      err.status = 400;
      err.type = "invalid_request_error";
      throw err;
    }
    upstream = await callOpenCode(req, payload, upstreamContext, { upstreamPath });

    if (wantsStream) {
      await streamOpenAiAsAnthropic(upstream, res, body.model, toolContextParts, upstreamContext);
      return;
    }

    const openAiBody = await upstream.json();
    sendJson(res, 200, openAiToAnthropic(openAiBody, body.model, toolContextParts));
  } catch (error) {
    throw normalizeUpstreamError(error, upstreamContext);
  } finally {
    upstreamContext.cleanup();
  }
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const upstreamContext = createUpstreamContext(res);
  let upstream;
  const model = body.model || "";
  const upstreamPath = isResponsesModel(model) ? "/responses" : "/chat/completions";

  try {
    upstream = await callOpenCode(req, body, upstreamContext, { upstreamPath });
    res.writeHead(upstream.status, upstreamResponseHeaders(upstream.headers));
    if (upstream.body) {
      try {
        for await (const chunk of upstream.body) {
          if (!res.writableEnded && !res.destroyed) res.write(chunk);
        }
      } catch (streamErr) {
        // Client likely disconnected — log and fall through to res.end()
        console.error(`handleChatCompletions stream error: ${streamErr.message}`);
      }
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    throw normalizeUpstreamError(error, upstreamContext);
  } finally {
    upstreamContext.cleanup();
  }
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    res.on("finish", () => logRequest(req, res, startedAt));

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*",
        });
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/health") {
        const body = {
          ok: true,
          config: CONFIG.configPath,
          listen: `http://${CONFIG.listenHost}:${CONFIG.port}`,
          upstream: CONFIG.upstreamEndpoint || `${CONFIG.upstreamBaseUrl}/chat/completions`,
          upstream_key_source: CONFIG.upstreamEndpoint ? "env ENDPOINT" : "request",
        };
        if (url.searchParams.get("probe") === "upstream") {
          body.upstream_probe = await probeUpstream(req);
        }
        sendJson(res, 200, body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendError(res, 403, "Shutdown is only allowed from a local loopback client.", "forbidden_error");
          return;
        }
        sendJson(res, 200, { ok: true, shutting_down: true });
        requestProcessShutdown(server);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: CONFIG.models.map((id) => ({ id, object: "model", owned_by: "opencode-go" })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessages(req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletions(req, res);
        return;
      }

      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, "not_found_error");
    } catch (error) {
      const status = error.status && Number.isInteger(error.status) ? error.status : 500;
      const type = error.type || (status >= 500 ? "proxy_error" : "invalid_request_error");
      logRequestError(req, status, error);
      if (!res.headersSent && !res.destroyed) {
        sendError(res, status, error && error.message ? error.message : String(error), type);
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });
  return server;
}

function installShutdownHandlers(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; flushing reasoning cache and shutting down.`);
    flushReasoningCache();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("beforeExit", flushReasoningCache);

  // Catch synchronous throws that escape all try/catch blocks.
  // Flush the reasoning cache so in-flight reasoning isn't lost before dying.
  process.on("uncaughtException", (error) => {
    console.error(`[fatal] Uncaught exception: ${error && error.message ? error.message : error}`);
    console.error(error && error.stack ? error.stack : "");
    flushReasoningCache();
    process.exit(1);
  });

  // Catch unhandled Promise rejections (async throws with no .catch()).
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`[fatal] Unhandled promise rejection: ${message}`);
    if (reason instanceof Error && reason.stack) console.error(reason.stack);
    // Do NOT exit — Node.js >= 15 exits automatically on unhandledRejection.
    // Logging here ensures it is always captured before the default exit.
  });
}

function detectClaudeConfigState(port) {
  try {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) {
      return { state: "fresh", label: "No Claude config found" };
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const data = JSON.parse(raw);
    const currentUrl = (data.env && data.env.ANTHROPIC_BASE_URL) || data.ANTHROPIC_BASE_URL || null;
    if (currentUrl && currentUrl.includes(String(port))) {
      return { state: "linked", label: "Linked to this proxy (~/.claude/settings.json)" };
    }
    return {
      state: "unlinked",
      label: currentUrl ? `Custom API (${currentUrl})` : "Official Claude API (Not linked to proxy)",
    };
  } catch {
    return { state: "unknown", label: "Unable to inspect ~/.claude/settings.json" };
  }
}

function printBanner() {
  const effectiveUpstream = CONFIG.upstreamEndpoint
    ? CONFIG.upstreamEndpoint
    : `${CONFIG.upstreamBaseUrl}${resolveUpstreamPath(CONFIG.primaryModel, CONFIG.endpointMode)}`;
  const mode = isResponsesModel(CONFIG.primaryModel) ? "responses" : "chat_completions";
  const overrideNote = CONFIG.upstreamEndpoint ? clrYellow(" [ENDPOINT override active]") : "";
  const isDev = process.env.npm_lifecycle_event === "dev" || process.argv.includes("--watch");
  const claudeState = detectClaudeConfigState(CONFIG.port);

  console.log("");
  console.log(clrCyan("  ╔══════════════════════════════════════════════════════════╗"));
  console.log(clrCyan("  ║") + clrBold("   ⚡ Claude ↔ OpenCode Proxy           v0.3.0            ") + clrCyan("║"));
  console.log(clrCyan("  ╚══════════════════════════════════════════════════════════╝"));
  console.log("");
  console.log(`   ${clrDim("✦  Status   ")} ${clrGreen(clrBold("Ready"))}`);
  console.log(`   ${clrDim("✦  Listen   ")} ${clrBold(`http://${CONFIG.listenHost}:${CONFIG.port}`)}`);
  console.log(`   ${clrDim("✦  Model    ")} ${clrBold(CONFIG.primaryModel)}`);
  console.log(`   ${clrDim("✦  Upstream ")} ${clrBold(effectiveUpstream)}`);
  console.log(`   ${clrDim("✦  Mode     ")} ${clrBold(mode)}${overrideNote}`);
  console.log(`   ${clrDim("✦  Config   ")} ${clrDim(CONFIG.configPath)}`);

  if (claudeState.state === "linked") {
    console.log(`   ${clrDim("✦  Claude   ")} ${clrGreen("✔ " + claudeState.label)}`);
  } else if (claudeState.state === "unlinked") {
    console.log(`   ${clrDim("✦  Claude   ")} ${clrYellow("⚠️ " + claudeState.label)}`);
  } else {
    console.log(`   ${clrDim("✦  Claude   ")} ${clrDim("ℹ️ " + claudeState.label)}`);
  }

  if (isDev) {
    console.log("");
    console.log(`   ${clrYellow("⚡ Dev mode active")} ${clrDim("(auto-restart on .env or server.js change)")}`);
  }

  if (claudeState.state !== "linked") {
    console.log("");
    console.log(`   ${clrYellow("👉 Recommendation:")} Run ${clrBold("npm run setup")} to connect Claude to this proxy`);
  } else {
    console.log("");
    console.log(`   ${clrDim("💡 Tip:")} Run ${clrBold("npm run restore")} anytime to switch back to Official Claude`);
  }

  console.log("");
  console.log(clrDim("  ────────────────────────────────────────────────────────────"));
  console.log("");
}

function startServer() {
  loadReasoningCache();
  const server = createServer();
  installShutdownHandlers(server);

  // Handle port-in-use and other listen errors with a clear message.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `${clrDim(formatTimestamp())}  ${clrRed("✖")}  ${clrRed(`[error] Port ${CONFIG.port} is already in use. Is another instance running?`)}\n` +
        `       ${clrDim(`Change CLAUDE_OPENCODE_PROXY_PORT in .env to use a different port.`)}`
      );
    } else if (error.code === "EACCES") {
      console.error(
        `${clrDim(formatTimestamp())}  ${clrRed("✖")}  ${clrRed(`[error] Permission denied to listen on port ${CONFIG.port}.`)}\n` +
        `       ${clrDim(`Use a port > 1024 or run with elevated privileges.`)}`
      );
    } else {
      console.error(`${clrDim(formatTimestamp())}  ${clrRed("✖")}  ${clrRed(`[error] Server error: ${error.message}`)}`);
    }
    flushReasoningCache();
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.listenHost, () => {
    printBanner();
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi,
  anthropicToOpenAi,
  createServer,
  currentToolContextParts,
  expandHome,
  flushReasoningCache,
  getToolReasoning,
  loadReasoningCache,
  mapFinishReason,
  normalizeBaseUrl,
  openAiToAnthropic,
  reasoningFromMessage,
  requestAuthToken,
  saveReasoningCacheNow,
  setToolReasoning,
  startServer,
  streamOpenAiAsAnthropic,
  upstreamResponseHeaders,
};
