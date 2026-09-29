"use strict";

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LAB_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-lab\.(?:0|[1-9]\d*)$/;

function releaseError(code, message) {
  return Object.assign(new Error(message), { code });
}

function value(environment, name) {
  const candidate = environment?.[name];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function publisherNames(environment) {
  return value(environment, "DOCPRONTO_PUBLISHER_NAME")
    .split(/[;,]/)
    .map(name => name.trim())
    .filter(Boolean);
}

function resolveChannelVersion(channel, packageVersion) {
  if (channel === "lab") {
    if (LAB_VERSION.test(packageVersion ?? "")) return packageVersion;
    if (STABLE_VERSION.test(packageVersion ?? "")) return `${packageVersion}-lab.0`;
    throw releaseError("INVALID_LAB_PACKAGE_VERSION", "Laboratory builds require X.Y.Z or X.Y.Z-lab.N.");
  }
  if (channel === "stable") {
    if (STABLE_VERSION.test(packageVersion ?? "")) return packageVersion;
    throw releaseError("INVALID_STABLE_PACKAGE_VERSION", "Stable builds require an exact X.Y.Z version.");
  }
  throw releaseError("INVALID_RELEASE_CHANNEL", `Invalid release channel: ${String(channel)}`);
}

function validateSigningEnvironment({ channel, environment = {}, requireSigned = false } = {}) {
  if (channel !== "lab" && channel !== "stable") {
    throw releaseError("INVALID_RELEASE_CHANNEL", `Invalid release channel: ${String(channel)}`);
  }
  const certificate = value(environment, "CSC_LINK");
  const password = value(environment, "CSC_KEY_PASSWORD");
  const publishers = publisherNames(environment);
  const configuredCount = Number(Boolean(certificate)) + Number(Boolean(password)) + Number(publishers.length > 0);

  if (configuredCount > 0 && configuredCount < 3) {
    throw releaseError(
      "INCOMPLETE_SIGNING_CONFIGURATION",
      "Signing requires CSC_LINK, CSC_KEY_PASSWORD and DOCPRONTO_PUBLISHER_NAME together.",
    );
  }
  if (configuredCount === 0) {
    if (requireSigned) {
      throw releaseError("RELEASE_SIGNING_REQUIRED", "This release channel requires an Authenticode certificate.");
    }
    return Object.freeze({
      integrityMode: "checksum-only",
      publisherNames: Object.freeze([]),
      signed: false,
    });
  }
  return Object.freeze({
    integrityMode: "checksum+authenticode",
    publisherNames: Object.freeze(publishers),
    signed: true,
  });
}

module.exports = { resolveChannelVersion, validateSigningEnvironment };
