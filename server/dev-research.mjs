import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const node = process.execPath;
const webPort = Number(process.env.OPENCHARTS_WEB_PORT ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error("OPENCHARTS_WEB_PORT must be a valid TCP port");
}
const children = [
  spawn(node, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(webPort)], { cwd: root, stdio: "inherit" }),
  spawn(node, ["--env-file-if-exists=.env", "server/index.mjs"], { cwd: root, stdio: "inherit" }),
  // crypto-ai-analysis.FORWARD_SIMULATION.7
  spawn(node, ["--experimental-strip-types", "--env-file-if-exists=.env", "server/forward-simulation.mjs"], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode == null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 1_000).unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Research service failed to start:", error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping && code !== 0) stop(code ?? 1);
  });
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
