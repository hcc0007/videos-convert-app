import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const server = spawn(node, [path.join(root, "server", "index.mjs")], {
  cwd: root,
  stdio: "inherit",
});

const expo = spawn(node, [path.join(root, "node_modules", "expo", "bin", "cli"), "start", "--web"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

function shutdown() {
  if (!server.killed) server.kill();
  if (!expo.killed) expo.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

server.on("exit", (code) => {
  if (code) {
    shutdown();
    process.exit(code);
  }
});
