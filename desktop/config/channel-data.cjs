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

module.exports = { CHANNELS, getChannelConfig, normalizeChannel };
