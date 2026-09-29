import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeChannel } from "../desktop/config/channel.mjs";

const require = createRequire(import.meta.url);
const { Arch, build, Platform } = require("electron-builder");
const { resolveBuilderConfig } = require("../electron-builder.config.cjs");
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseBuildArguments(arguments_) {
  const channelIndex = arguments_.indexOf("--channel");
  const inline = arguments_.find(argument => argument.startsWith("--channel="));
  const value = inline?.slice("--channel=".length)
    ?? (channelIndex >= 0 ? arguments_[channelIndex + 1] : undefined);
  if (!value) {
    throw Object.assign(new Error("Desktop build requires --channel lab or --channel stable."), {
      code: "MISSING_RELEASE_CHANNEL",
    });
  }
  return {
    channel: normalizeChannel(value),
    directory: arguments_.includes("--dir"),
    skipTests: arguments_.includes("--skip-tests"),
  };
}

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectDir,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

export async function buildDesktop(arguments_ = process.argv.slice(2)) {
  const options = parseBuildArguments(arguments_);
  if (!options.skipTests) await run(process.execPath, ["--test", "tests/desktop/*.test.mjs"]);
  const config = resolveBuilderConfig(options.channel, projectDir);
  const targets = Platform.WINDOWS.createTarget(
    options.directory ? ["dir"] : ["nsis", "portable"],
    Arch.x64,
  );
  const artifacts = await build({ projectDir, config, targets, publish: "never" });
  await run(process.execPath, ["--test", "tests/desktop/packaged-output.test.mjs"], {
    env: {
      ...process.env,
      DOCPRONTO_PACKAGED_RESOURCES: join(config.directories.output, "win-unpacked", "resources"),
    },
  });
  return artifacts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktop();
}
