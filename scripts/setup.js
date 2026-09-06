#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const http = require("http");
const { spawnSync } = require("child_process");

// Load local proxy .env if present
try { require("dotenv").config({ quiet: true }); } catch {}

const DEFAULT_PORT = parseInt(process.env.CLAUDE_OPENCODE_PROXY_PORT || "8787", 10);
const PROXY_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

// Styling helpers
const SUPPORTS_COLOR = !process.env.NO_COLOR && !process.env.CI && process.stdout.isTTY !== false;
const ESC = SUPPORTS_COLOR
  ? { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" }
  : { reset: "", bold: "", dim: "", cyan: "", green: "", yellow: "", red: "" };

const cBold = (t) => `${ESC.bold}${t}${ESC.reset}`;
const cDim = (t) => `${ESC.dim}${t}${ESC.reset}`;
const cCyan = (t) => `${ESC.cyan}${t}${ESC.reset}`;
const cGreen = (t) => `${ESC.green}${t}${ESC.reset}`;
const cYellow = (t) => `${ESC.yellow}${t}${ESC.reset}`;
const cRed = (t) => `${ESC.red}${t}${ESC.reset}`;

function getClaudeConfigPaths() {
  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const backupFile = path.join(claudeDir, "settings.json.backup");
  return { claudeDir, settingsFile, backupFile };
}

function readClaudeSettings() {
  const { settingsFile } = getClaudeConfigPaths();
  if (!fs.existsSync(settingsFile)) {
    return { exists: false, data: {} };
  }
  try {
    const raw = fs.readFileSync(settingsFile, "utf8");
    const data = JSON.parse(raw);
    return { exists: true, data };
  } catch (err) {
    return { exists: true, data: {}, parseError: err.message };
  }
}

function getClaudeState(port = DEFAULT_PORT) {
  const { settingsFile, backupFile } = getClaudeConfigPaths();
  const { exists, data, parseError } = readClaudeSettings();
  const backupExists = fs.existsSync(backupFile);

  if (!exists) {
    return { state: "fresh", label: "Fresh (No config)", url: null, backupExists, settingsFile };
  }
  if (parseError) {
    return { state: "corrupt", label: "Corrupt JSON", error: parseError, backupExists, settingsFile };
  }

  const currentUrl = (data.env && data.env.ANTHROPIC_BASE_URL) || data.ANTHROPIC_BASE_URL || null;
  const isLinked = currentUrl && currentUrl.includes(String(port));

  if (isLinked) {
    return { state: "linked", label: "Linked to Proxy", url: currentUrl, backupExists, settingsFile };
  }
  return { state: "unlinked", label: "Pointing to Official Claude API", url: currentUrl, backupExists, settingsFile };
}

function connectToProxy() {
  const { claudeDir, settingsFile, backupFile } = getClaudeConfigPaths();

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const { exists, data } = readClaudeSettings();

  // Backup original settings if not already backed up
  if (exists && !fs.existsSync(backupFile)) {
    try {
      fs.copyFileSync(settingsFile, backupFile);
      console.log(`  ${cGreen("✔")} Created original backup at ${cDim(backupFile)}`);
    } catch (err) {
      console.warn(`  ${cYellow("⚠️")} Failed to create backup: ${err.message}`);
    }
  }

  const newSettings = { ...data };
  if (!newSettings.env || typeof newSettings.env !== "object") {
    newSettings.env = {};
  }
  newSettings.env.ANTHROPIC_BASE_URL = PROXY_URL;

  fs.writeFileSync(settingsFile, JSON.stringify(newSettings, null, 2), "utf8");

  // Check if repo .env exists, if not copy from .env.example
  const repoEnv = path.join(__dirname, "..", ".env");
  const repoEnvExample = path.join(__dirname, "..", ".env.example");
  if (!fs.existsSync(repoEnv) && fs.existsSync(repoEnvExample)) {
    try {
      fs.copyFileSync(repoEnvExample, repoEnv);
      console.log(`  ${cGreen("✔")} Initialized .env from .env.example`);
    } catch {}
  }

  console.log(`\n  ${cGreen("✔")} ${cBold("Successfully linked Claude Code to Proxy!")}`);
  console.log(`    • Target Config: ${cDim(settingsFile)}`);
  console.log(`    • Base URL:      ${cBold(PROXY_URL)}`);
  console.log(`    • Model Backend: ${cBold(process.env.MODEL || "muse-spark-1.2-contributor-free")}`);
  console.log(`\n  ${cDim("You can now run 'npm start' or 'npm run dev' and start using Claude Code.")}\n`);
}

function restoreOfficialClaude() {
  const { settingsFile, backupFile } = getClaudeConfigPaths();
  const { exists, data } = readClaudeSettings();

  if (fs.existsSync(backupFile)) {
    try {
      fs.copyFileSync(backupFile, settingsFile);
      console.log(`\n  ${cGreen("✔")} ${cBold("Restored settings from original backup!")}`);
      console.log(`    • Restored: ${cDim(settingsFile)}`);
      console.log(`\n  ${cDim("Claude Code is now pointing back to the Official Anthropic API.")}\n`);
      return;
    } catch (err) {
      console.warn(`  ${cYellow("⚠️")} Could not copy backup file (${err.message}). Falling back to clean edit.`);
    }
  }

  if (exists) {
    const newSettings = { ...data };
    if (newSettings.env && newSettings.env.ANTHROPIC_BASE_URL) {
      delete newSettings.env.ANTHROPIC_BASE_URL;
      if (Object.keys(newSettings.env).length === 0) {
        delete newSettings.env;
      }
    }
    if (newSettings.ANTHROPIC_BASE_URL) {
      delete newSettings.ANTHROPIC_BASE_URL;
    }
    fs.writeFileSync(settingsFile, JSON.stringify(newSettings, null, 2), "utf8");
    console.log(`\n  ${cGreen("✔")} ${cBold("Proxy overrides removed!")}`);
    console.log(`    • Config: ${cDim(settingsFile)}`);
    console.log(`\n  ${cDim("Claude Code is now pointing back to the Official Anthropic API.")}\n`);
  } else {
    console.log(`\n  ${cYellow("ℹ️")} No Claude settings file found. Claude will use default Official API.\n`);
  }
}

function checkProxyServerRunning(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        method: "GET",
        timeout: 1000,
      },
      (res) => resolve(true)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function getWindowsServiceStatus() {
  if (process.platform !== "win32") return { supported: false, installed: false, running: false };
  try {
    const res = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$t = Get-ScheduledTask -TaskName 'DeepSeekV4OpenCodeClaudeCodeBridge' -ErrorAction SilentlyContinue; if ($t) { Write-Output ($t.State.ToString()) } else { Write-Output 'NotFound' }",
      ],
      { encoding: "utf8", timeout: 3000 }
    );
    const output = (res.stdout || "").trim();
    if (!output || output === "NotFound") {
      return { supported: true, installed: false, running: false, state: "Not Installed" };
    }
    return {
      supported: true,
      installed: true,
      running: output === "Ready" || output === "Running",
      state: output,
    };
  } catch {
    return { supported: true, installed: false, running: false, state: "Unknown" };
  }
}

function installWindowsService() {
  if (process.platform !== "win32") {
    console.log(`\n  ${cYellow("⚠️")} Automatic service installation is configured for Windows.\n`);
    return;
  }
  console.log(`\n  ${cCyan("⚡")} ${cBold("Installing Windows Background Service...")}`);
  console.log(`  ${cDim("Registering Windows Scheduled Task to autostart proxy silently at logon...")}\n`);
  const scriptPath = path.join(__dirname, "install-autostart-windows.ps1");
  const res = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], { stdio: "inherit" });
  if (res.status === 0) {
    console.log(`\n  ${cGreen("✔")} ${cBold("Windows Background Service installed successfully!")}`);
    console.log(`  ${cDim("The proxy will run automatically on Windows boot. No terminal required.")}\n`);
  } else {
    console.log(`\n  ${cRed("✖")} ${cBold("Failed to install service. Try running as Administrator.")}\n`);
  }
}

function uninstallWindowsService() {
  if (process.platform !== "win32") {
    console.log(`\n  ${cYellow("⚠️")} Automatic service uninstallation is configured for Windows.\n`);
    return;
  }
  console.log(`\n  ${cYellow("🗑️")}  ${cBold("Uninstalling Windows Background Service...")}`);
  console.log(`  ${cDim("Stopping and removing Windows Scheduled Task...")}\n`);
  const scriptPath = path.join(__dirname, "uninstall-autostart-windows.ps1");
  const res = spawnSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath
  ], { stdio: "inherit" });
  if (res.status === 0) {
    console.log(`\n  ${cGreen("✔")} ${cBold("Windows Background Service removed successfully.")}\n`);
  } else {
    console.log(`\n  ${cRed("✖")} ${cBold("Failed to uninstall service.")}\n`);
  }
}

async function showDiagnostics() {
  const state = getClaudeState();
  const isRunning = await checkProxyServerRunning();
  const envKeys = (process.env.OPENCODE_API_KEYS || process.env.OPENCODE_API_KEY || "").split(/[,;\s]+/).filter(Boolean);
  const fallbacks = (process.env.FALLBACK_MODELS || "")
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((item) => {
      if (item.includes("|")) {
        const [m, e] = item.split("|");
        return `${m.trim()} (${e.trim()})`;
      }
      return item.trim();
    });
  const service = getWindowsServiceStatus();

  console.log(`\n  ${cBold("Diagnostics Report:")}`);
  console.log(`  ${cDim("────────────────────────────────────────────────────────────")}`);
  console.log(`  • Proxy Server (127.0.0.1:${DEFAULT_PORT}): ${isRunning ? cGreen("● Running") : cYellow("○ Stopped")}`);
  console.log(`  • Claude Config State:             ${state.state === "linked" ? cGreen("✔ " + state.label) : cYellow("⚠️ " + state.label)}`);
  console.log(`  • Active ANTHROPIC_BASE_URL:       ${state.url ? cBold(state.url) : cDim("None (Official API)")}`);
  console.log(`  • Settings File Path:              ${cDim(state.settingsFile)}`);
  console.log(`  • Backup File Present:             ${state.backupExists ? cGreen("Yes") : cDim("No")}`);
  console.log(`  • Configured API Keys:             ${envKeys.length > 1 ? cGreen(`${envKeys.length} keys in pool (auto-rotating)`) : envKeys.length === 1 ? cGreen("1 key configured") : cRed("Missing API Key")}`);
  if (fallbacks.length > 0) {
    console.log(`  • Fallback Models Chain:           ${cDim(fallbacks.join(", "))}`);
  }
  if (service.supported) {
    const serviceLabel = service.installed
      ? (service.running ? cGreen(`Installed (● Running - ${service.state})`) : cYellow(`Installed (○ ${service.state})`))
      : cDim("Not Installed");
    console.log(`  • Windows Background Service:      ${serviceLabel}`);
  }
  console.log(`  • Local .env Config:               ${fs.existsSync(path.join(__dirname, "..", ".env")) ? cGreen("Found") : cRed("Missing (.env)")}`);
  console.log(`  ${cDim("────────────────────────────────────────────────────────────")}\n`);
}

function showBanner() {
  console.log("");
  console.log(cCyan("  ╔══════════════════════════════════════════════════════════╗"));
  console.log(cCyan("  ║") + cBold("   ⚡ Claude ↔ OpenCode Proxy Manager                     ") + cCyan("║"));
  console.log(cCyan("  ╚══════════════════════════════════════════════════════════╝"));
  console.log("");
}

async function runInteractiveMenu() {
  showBanner();
  const state = getClaudeState();
  const service = getWindowsServiceStatus();

  console.log(`  ${cDim("Current Status:")}`);
  console.log(`  • Claude CLI State: ${state.state === "linked" ? cGreen(state.label) : cYellow(state.label)}`);
  console.log(`  • Target Proxy URL: ${cBold(PROXY_URL)}`);
  if (service.supported) {
    console.log(`  • Background Task:  ${service.installed ? cGreen(`Installed (${service.state})`) : cDim("Not Installed")}`);
  }
  console.log(`  • Backup Available: ${state.backupExists ? cGreen("Yes") : cDim("No")}`);
  console.log("");
  console.log(`  ${cBold("Select an option:")}`);
  console.log(`    ${cBold("1)")} 🚀 ${cGreen("Connect Claude to Proxy")} (Safe Backup & Switch)`);
  console.log(`    ${cBold("2)")} 🔄 ${cYellow("Restore Official Claude Settings")} (Detach Proxy)`);
  console.log(`    ${cBold("3)")} ⚡ ${cCyan("Install Silent Windows Service")} (Always On, No Terminal)`);
  console.log(`    ${cBold("4)")} 🗑️  ${cDim("Uninstall Windows Background Service")}`);
  console.log(`    ${cBold("5)")} 🔍 Run Diagnostics & Status`);
  console.log(`    ${cBold("0)")} ❌ Exit`);
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question(`  ${cBold("Enter choice [0-5]: ")}`, async (answer) => {
    rl.close();
    const choice = (answer || "").trim();
    if (choice === "1") {
      connectToProxy();
    } else if (choice === "2") {
      restoreOfficialClaude();
    } else if (choice === "3") {
      installWindowsService();
    } else if (choice === "4") {
      uninstallWindowsService();
    } else if (choice === "5") {
      await showDiagnostics();
    } else {
      console.log(`\n  ${cDim("Exited without changes.")}\n`);
    }
  });
}

// CLI entry point
const args = process.argv.slice(2);
if (args.includes("--restore")) {
  showBanner();
  restoreOfficialClaude();
} else if (args.includes("--status") || args.includes("--diagnostics")) {
  showBanner();
  showDiagnostics();
} else if (args.includes("--connect")) {
  showBanner();
  connectToProxy();
} else if (args.includes("--install-service")) {
  showBanner();
  installWindowsService();
} else if (args.includes("--uninstall-service")) {
  showBanner();
  uninstallWindowsService();
} else {
  runInteractiveMenu();
}
