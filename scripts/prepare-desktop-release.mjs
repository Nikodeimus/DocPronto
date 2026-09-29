import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { resolveChannelVersion, validateSigningEnvironment } = require("../desktop/update/signing-policy.cjs");
const STABLE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const LAB_TAG = /^lab-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-lab\.(?:0|[1-9]\d*))$/;

function releaseError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function validateReleaseTag({ tag, packageVersion, expectedChannel } = {}) {
  const pattern = expectedChannel === "lab" ? LAB_TAG : expectedChannel === "stable" ? STABLE_TAG : null;
  if (!pattern) throw releaseError("INVALID_RELEASE_CHANNEL", `Invalid release channel: ${String(expectedChannel)}`);
  const match = pattern.exec(tag ?? "");
  if (!match) {
    const code = expectedChannel === "stable" && /^v.+-/.test(tag ?? "")
      ? "INVALID_STABLE_RELEASE_TAG"
      : "RELEASE_TAG_CHANNEL_MISMATCH";
    throw releaseError(code, `Tag ${String(tag)} is not valid for channel ${expectedChannel}.`);
  }
  const version = match[1];
  const expectedVersion = resolveChannelVersion(expectedChannel, packageVersion);
  if (expectedVersion !== version) {
    throw releaseError(
      "RELEASE_VERSION_MISMATCH",
      `Tag version ${version} does not match package version ${String(packageVersion)}.`,
    );
  }
  return Object.freeze({
    channel: expectedChannel,
    feed: expectedChannel === "lab" ? "lab" : "latest",
    prerelease: expectedChannel === "lab",
    tag,
    version,
  });
}

export { validateSigningEnvironment };

export function prepareDesktopRelease({
  tag,
  packageVersion,
  expectedChannel,
  environment = {},
  requireSigned = false,
} = {}) {
  return Object.freeze({
    ...validateReleaseTag({ tag, packageVersion, expectedChannel }),
    ...validateSigningEnvironment({ channel: expectedChannel, environment, requireSigned }),
  });
}

function parseArguments(arguments_) {
  const read = name => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  return {
    tag: read("--tag"),
    expectedChannel: read("--channel"),
    packagePath: resolve(read("--package") ?? "package.json"),
    requireSigned: arguments_.includes("--require-signed"),
  };
}

async function writeOutputs(result, outputPath) {
  const outputs = {
    channel: result.channel,
    feed: result.feed,
    integrity_mode: result.integrityMode,
    prerelease: String(result.prerelease),
    publisher_names: JSON.stringify(result.publisherNames),
    signed: String(result.signed),
    version: result.version,
  };
  if (outputPath) {
    await appendFile(outputPath, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(outputs)}\n`);
  }
}

export async function run(arguments_ = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(arguments_);
  const packageMetadata = JSON.parse(await readFile(options.packagePath, "utf8"));
  const result = prepareDesktopRelease({
    ...options,
    packageVersion: packageMetadata.version,
    environment,
  });
  await writeOutputs(result, environment.GITHUB_OUTPUT);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
