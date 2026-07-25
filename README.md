# Alarm.com plugin for Homebridge

![Homebridge and Alarm.com logos combined](/Assets/homebridge_alarm_combined.jpg)

Alarm.com plugin for [Homebridge](https://github.com/homebridge/homebridge) using the [node-alarm-dot-com](https://github.com/node-alarm-dot-com/node-alarm-dot-com) interface.

[![NPM](https://nodei.co/npm/homebridge-node-alarm-dot-com.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/homebridge-node-alarm-dot-com/)

[![npm](https://img.shields.io/npm/dm/homebridge-node-alarm-dot-com.svg)](https://www.npmjs.com/package/homebridge-node-alarm-dot-com)
[![npm](https://img.shields.io/npm/v/homebridge-node-alarm-dot-com.svg)](https://www.npmjs.com/package/homebridge-node-alarm-dot-com)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

This is a plugin for Homebridge, allowing communication with Alarm.com endpoints.

**NOTICE: This plugin is in maintenance mode as I have proven not to have much time over the past several years. Issues will be worked on as I can get to them (which is not often). I would welcome contributions and an extra maintainer or two!**

# Supported Features

- Two-Factor Authentication
- WebSockets for near-instant updates
- Querying panels
  - Arming
  - Disarming
- Sensors
  - Contact sensor states
  - Water leak sensor states
  - Motion sensor states
- Lights
  - On/Off switch
  - Dimmer switch
- Locks
  - Lock/Unlock switch
- Garage Doors
  - Open/Close switch
- Thermostats
  - Set mode Off/Heat/Cool/Auto
  - Set desired Heat/Cool temperatures
  - View humidity
- Doorbells
  - Doorbells appear as a motion sensor for notifications only. Video/audio is not supported

# Installation

1. [Install homebridge](https://homebridge.io/how-to-install-homebridge)
2. Install this plugin: `npm install -g homebridge-node-alarm-dot-com`
3. Update your configuration file (see below).

# Configuration

## Sample config.json:

```json
{
  "name": "Security System",
  "username": "<YOUR ALARM.COM USERNAME>",
  "password": "<YOUR ALARM.COM PASSWORD>",
  "useMFA": true,
  "mfaCookie": "<USE INSTRUCTIONS IN THE WIKI>",
  "logLevel": 2,
  "authTimeoutMinutes": 10,
  "pollTimeoutSeconds": 30,
  "armingModes": {
    "away": {
      "noEntryDelay": false,
      "silentArming": false,
      "nightArming": false,
      "forceBypass": false
    },
    "night": {
      "noEntryDelay": false,
      "silentArming": false,
      "nightArming": false,
      "forceBypass": false
    },
    "stay": {
      "noEntryDelay": false,
      "silentArming": false,
      "nightArming": false,
      "forceBypass": false
    }
  },
  "platform": "Alarmdotcom"
}
```

## Fields:

- `platform`: Must always be "Alarmdotcom" (required)
- `name`: Can be anything (required)
- `username`: Alarm.com login username, same as app (required)
- `password`: Alarm.com login password, same as app (required)
- `useMFA`: boolean indicating if your account requires MFA (required and highly recommended)
- `mfaCookie`: MFA cookie to be sent with your API requests. Only needed if "useMFA" is set to `true`
- `armingModes`: Object of objects with arming mode options of boolean choices (**WARNING:** older versions of the plugin would ignore partition capabilities and send whichever flags you set here. This was a common issue with people setting nightArm on panels that don't support it, causing 422 errors. Please make sure your partition supports whichever flags you set.)
- `authTimeoutMinutes`: Timeout to Re-Authenticate session (**WARNING:** choosing a time less than 10 minutes could possibly ban/disable your account from Alarm.com).
- `pollTimeoutSeconds`: Device polling interval, only used as a fallback if the WebSocket connection repeatedly fails to establish (**WARNING:** choosing a time less than 60 seconds could possibly ban/disable your account from Alarm.com).
- `logLevel`: Adjust what gets reported in the logs
  - 0 = NO LOG ENTRIES
  - 1 = ONLY ERRORS
  - **2 = ONLY WARNINGS and ERRORS (default)**
  - 3 = GENERAL NOTICES, ERRORS and WARNINGS
  - 4 = VERBOSE (everything including development output, this also generates a file `ADC-SystemStates.json` with the payload details from Alarm.com in the same folder as the Homebridge config.json file)
- `ignoredDevices`: An array of IDs for Alarm.com accessories you wish to ignore.

# Troubleshooting

Before assuming that something is wrong with the plugin, please review the [issues on this project's github repository](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/issues?utf8=%E2%9C%93&q=sort%3Aupdated-desc+) to see if there's already a similar issue reported where a solution has been proposed or the outcome is expected due to limitations with the Alarm.com web API.

## Devices not responding after upgrading to v1.9.0

Due to changes in the way sensors are polled in v1.9.0, there have reports of needing to clear your device cache after this upgrade. See [this issue](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/issues/107) for more information.

## Logging

The default setting for log entries is set to report critical errors and warnings about devices. Once you feel that your security system devices are being represented in HomeKit correctly you can choose to reduce the amount of information being output to the logs to save space or remove cruft while troubleshooting other Homebridge plugins.

To modify the log behaviour, add the "logLevel" field to the Alarmdotcom platform block in the Homebridge configuration file, or through the web UI.

## Ignoring Devices

Accessories that you wish to hide in Homekit (e.g., fobs) can be identified by finding the Serial Number in the settings of the accessory in the Apple Home app, or alternatively in your output log (log level 3 or higher) when Homebridge starts up. If the accessories still exist in Homekit, please make sure that you have typed the serial number exactly. If they still continue to be displayed (or vice-versa they still don't show up after un-ignoring them), then you may be required to delete the `~/.homebridge/accessories/cachedAccessories` file as they may still be stored in the cache within Homebridge.

# Credits

Forked from John Hurliman's FrontPoint\* plugin for Homebridge<small>[↗](https://github.com/jhurliman/homebridge-frontpoint)</small> to replace the branding and code namespace from FrontPoint to Alarm.com.

<small>\*FrontPoint is simply a rebranded service provider for Alarm.com, but FrontPoint is not needed for this plugin to work.</small>

A big thank you to [Mike Kormendy](https://github.com/mkormendy) for forking and working on this plugin so long!
