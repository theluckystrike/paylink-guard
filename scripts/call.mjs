// Calls one tool on dist/plugin.mjs the way the PayBox sandbox does: one fresh process per operation.
//   node scripts/call.mjs <tool> '<json arguments>'      prints the tools/call result as JSON
//   node scripts/call.mjs --list                         prints tool names
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const artifact = resolve(process.cwd(), "dist/plugin.mjs");
const [tool, rawArgs = "{}"] = process.argv.slice(2);
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "paylink-demo", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const request = tool === "--list"
  ? { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } }
  : { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: JSON.parse(rawArgs), _meta: meta } };

const started = Date.now();
const child = spawn(process.execPath, [artifact], { stdio: ["pipe", "pipe", "ignore"] });
const timer = setTimeout(() => { console.error("timeout after 10 s"); child.kill("SIGKILL"); process.exit(2); }, 10_000);
child.stdin.write(`${JSON.stringify(request)}\n`);
for await (const line of createInterface({ input: child.stdout })) {
  const message = JSON.parse(line);
  if (message.id !== 2) continue;
  clearTimeout(timer);
  child.kill();
  const ms = Date.now() - started;
  if (tool === "--list") console.log(message.result.tools.map((t) => t.name).join("\n"));
  else console.log(JSON.stringify({ ms, ...message }, null, 2));
  process.exit(message.error || message.result?.isError ? 1 : 0);
}
