"use strict";

const CHANNELS = Object.freeze({ LAB: "lab", STABLE: "stable" });

const CHANNEL_CONFIGS = Object.freeze({
  [CHANNELS.LAB]: Object.freeze({
    channel: CHANNELS.LAB,
    productName: "DOCPronto Laboratorio",
    appId: "br.com.docpronto.desktop.lab",
    userDataName: "DOCPronto-Laboratorio",
    updateChannel: "lab",
    isLab: true,
  }),
  [CHANNELS.STABLE]: Object.freeze({
    channel: CHANNELS.STABLE,
    productName: "DOCPronto",
    appId: "br.com.docpronto.desktop",
    userDataName: "DOCPronto",
    updateChannel: "latest",
    isLab: false,
  }),
});

function normalizeChannel(value = CHANNELS.LAB) {
  if (value === CHANNELS.LAB || value === CHANNELS.STABLE) return value;
  const error = new Error(`Invalid release channel: ${String(value)}`);
  error.code = "INVALID_RELEASE_CHANNEL";
  throw error;
}

function getChannelConfig(channel) {
  return CHANNEL_CONFIGS[normalizeChannel(channel)];
}

function resolveRuntimeChannel({
  isPackaged = false,
  packageChannel,
  arguments: runtimeArguments = [],
  environment = {},
} = {}) {
  if (isPackaged) {
    if (!packageChannel) {
      const error = new Error("Packaged DOCPronto is missing its release channel.");
      error.code = "PACKAGED_CHANNEL_MISSING";
      throw error;
    }
    return normalizeChannel(packageChannel);
  }

  const channelArgument = runtimeArguments.find(argument => argument.startsWith("--channel="));
  return normalizeChannel(
    channelArgument?.slice("--channel=".length)
      || environment.DOCPRONTO_CHANNEL
      || packageChannel,
  );
}

module.exports = { CHANNELS, getChannelConfig, normalizeChannel, resolveRuntimeChannel };
