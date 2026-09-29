import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

import { normalizeChannel } from "../desktop/config/channel.mjs";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseDesktopArguments(arguments_) {
  const channelIndex = arguments_.indexOf("--channel");
  const inline = arguments_.find(argument => argument.startsWith("--channel="));
  const value = inline?.slice("--channel=".length)
    ?? (channelIndex >= 0 ? arguments_[channelIndex + 1] : undefined);
  return { channel: normalizeChannel(value) };
}

export function createDesktopCommand(arguments_ = process.argv.slice(2)) {
  const { channel } = parseDesktopArguments(arguments_);
  return {
    command: electronPath,
    arguments: [projectDir, `--channel=${channel}`],
    options: {
      cwd: projectDir,
      env: { ...process.env, DOCPRONTO_CHANNEL: channel },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    },
  };
}

export async function runDesktop(arguments_ = process.argv.slice(2)) {
  const invocation = createDesktopCommand(arguments_);
  const child = spawn(invocation.command, invocation.arguments, invocation.options);
  return new Promise((resolveRun, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Electron stopped by signal ${signal}.`));
      else resolveRun(code ?? 1);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDesktop();
}
