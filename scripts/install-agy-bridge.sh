#!/usr/bin/env bash
# Install the shared bridge once. Worker identity comes from the job environment.
set -euo pipefail

mode="install"
case "${1:-}" in
  "") ;;
  --uninstall) mode="uninstall" ;;
  *) echo "Usage: $0 [--uninstall]" >&2; exit 2 ;;
esac
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [--uninstall]" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bridge="$repo_root/dist/bridge/agent-bridge.js"
if [[ "$mode" == "install" && ! -f "$bridge" ]]; then
  echo "run npm run build first" >&2
  exit 1
fi
config="${AGY_MCP_CONFIG_PATH:-}"
if command -v cygpath >/dev/null 2>&1; then
  bridge="$(cygpath -w "$bridge")"
  if [[ -n "$config" ]]; then config="$(cygpath -w "$config")"; fi
fi

node --input-type=commonjs - "$mode" "$bridge" "$config" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
function main() {
const [, , mode, bridgeArg, override] = process.argv;
const bridge = path.resolve(bridgeArg);
const configPath = path.resolve(override || path.join(os.homedir(), ".gemini", "config", "mcp_config.json"));
if (mode === "install") {
  if (!fs.existsSync(bridge) || !fs.statSync(bridge).isFile()) {
    console.error("run npm run build first");
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const lockPath = configPath + ".agent-bridge.lock";
const lock = fs.openSync(lockPath, "wx", 0o600);
let temp;
try {
  let original;
  try {
    if (!fs.lstatSync(configPath).isFile()) throw new Error("MCP config must be a regular file");
    original = fs.readFileSync(configPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = original ? JSON.parse(original.toString("utf8").replace(/^\uFEFF/, "").trim() || "{}") : {};
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) throw new Error("Invalid MCP config object; no changes made");
  const entry = { command: process.execPath, args: [bridge], timeoutSeconds: 86500 };
  if (mode === "uninstall") {
    if (!config.mcpServers || !Object.hasOwn(config.mcpServers, "agent_bridge")) {
      console.log("agent_bridge is already absent");
      return;
    }
    delete config.mcpServers.agent_bridge;
  } else {
    config.mcpServers ??= {};
    if (JSON.stringify(config.mcpServers.agent_bridge) === JSON.stringify(entry)) {
      console.log("agent_bridge is already installed");
      return;
    }
    config.mcpServers.agent_bridge = entry;
  }
  if (original) {
    const backup = `${configPath}.backup-${Date.now()}-${crypto.randomUUID()}`;
    fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    console.log(`Original config backed up to ${backup}`);
  }
  temp = `${configPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, configPath);
  temp = undefined;
  console.log(`${mode === "install" ? "Installed" : "Removed"} agent_bridge in ${configPath}`);
} finally {
  if (temp) { try { fs.unlinkSync(temp); } catch {} }
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
}
}
main();
NODE
