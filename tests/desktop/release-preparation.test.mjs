import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareDesktopRelease,
  validateReleaseTag,
  validateSigningEnvironment,
} from "../../scripts/prepare-desktop-release.mjs";

test("tag LAB corresponde exatamente a semver prerelease lab e feed lab", () => {
  assert.deepEqual(
    validateReleaseTag({
      tag: "lab-v0.2.0-lab.3",
      packageVersion: "0.2.0-lab.3",
      expectedChannel: "lab",
    }),
    {
      channel: "lab",
      feed: "lab",
      prerelease: true,
      tag: "lab-v0.2.0-lab.3",
      version: "0.2.0-lab.3",
    },
  );
});

test("versao estavel do repositorio deriva lab.0 sem mutar o package", () => {
  const input = {
    tag: "lab-v0.1.0-lab.0",
    packageVersion: "0.1.0",
    expectedChannel: "lab",
    environment: {},
  };
  const release = prepareDesktopRelease(input);
  assert.equal(release.version, "0.1.0-lab.0");
  assert.equal(input.packageVersion, "0.1.0");
});

test("tag estavel exige vX.Y.Z e versao exata sem prerelease", () => {
  const release = validateReleaseTag({
    tag: "v1.4.2",
    packageVersion: "1.4.2",
    expectedChannel: "stable",
  });
  assert.equal(release.feed, "latest");
  assert.equal(release.prerelease, false);

  for (const tag of ["v1.4.2-lab.1", "v1.4.2-beta.1", "lab-v1.4.2-lab.1"]) {
    assert.throws(
      () => validateReleaseTag({ tag, packageVersion: tag.replace(/^lab-v|^v/, ""), expectedChannel: "stable" }),
      error => error.code === "RELEASE_TAG_CHANNEL_MISMATCH" || error.code === "INVALID_STABLE_RELEASE_TAG",
    );
  }
});

test("tag e package version divergentes interrompem a release", () => {
  assert.throws(
    () => validateReleaseTag({
      tag: "lab-v0.2.0-lab.2",
      packageVersion: "0.2.0-lab.1",
      expectedChannel: "lab",
    }),
    error => error.code === "RELEASE_VERSION_MISMATCH",
  );
  assert.throws(
    () => validateReleaseTag({ tag: "v1.0.1", packageVersion: "1.0.0", expectedChannel: "stable" }),
    error => error.code === "RELEASE_VERSION_MISMATCH",
  );
});

test("LAB sem secrets e checksum-only e configuracao parcial e rejeitada", () => {
  assert.deepEqual(validateSigningEnvironment({ channel: "lab", environment: {} }), {
    integrityMode: "checksum-only",
    publisherNames: [],
    signed: false,
  });
  assert.throws(
    () => validateSigningEnvironment({
      channel: "lab",
      environment: { CSC_LINK: "base64-cert", DOCPRONTO_PUBLISHER_NAME: "DOCPronto" },
    }),
    error => error.code === "INCOMPLETE_SIGNING_CONFIGURATION",
  );
});

test("release assinada exige certificado senha e publisherName", () => {
  const environment = {
    CSC_LINK: "base64-cert",
    CSC_KEY_PASSWORD: "secret",
    DOCPRONTO_PUBLISHER_NAME: "DOCPronto Software Ltda",
  };
  assert.deepEqual(validateSigningEnvironment({ channel: "stable", environment, requireSigned: true }), {
    integrityMode: "checksum+authenticode",
    publisherNames: ["DOCPronto Software Ltda"],
    signed: true,
  });
  assert.throws(
    () => validateSigningEnvironment({ channel: "stable", environment: {}, requireSigned: true }),
    error => error.code === "RELEASE_SIGNING_REQUIRED",
  );
});

test("preparacao combina tag e assinatura sem modificar packageVersion", () => {
  const input = {
    tag: "lab-v0.3.0-lab.1",
    packageVersion: "0.3.0-lab.1",
    expectedChannel: "lab",
    environment: {},
  };
  const result = prepareDesktopRelease(input);
  assert.equal(input.packageVersion, "0.3.0-lab.1");
  assert.equal(result.integrityMode, "checksum-only");
  assert.equal(result.version, "0.3.0-lab.1");
  assert.equal(result.feed, "lab");
});
