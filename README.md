# Alarm.com plugin for Homebridge

![Homebridge and Alarm.com logos combined](/Assets/homebridge_alarm_combined.jpg)

Alarm.com plugin for [Homebridge](https://github.com/homebridge/homebridge) using the [node-alarm-dot-com](https://github.com/node-alarm-dot-com/node-alarm-dot-com) interface.

[![NPM](https://nodei.co/npm/homebridge-node-alarm-dot-com.png?downloads=true&downloadRank=true&stars=true)](https://nodei.co/npm/homebridge-node-alarm-dot-com/)

[![npm](https://img.shields.io/npm/dm/homebridge-node-alarm-dot-com.svg)](https://www.npmjs.com/package/homebridge-node-alarm-dot-com)
[![npm](https://img.shields.io/npm/v/homebridge-node-alarm-dot-com.svg)](https://www.npmjs.com/package/homebridge-node-alarm-dot-com)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

This is a plugin for Homebridge, allowing communication with Alarm.com endpoints.

# Supported Features

- Two-Factor Authentication
- Querying panels
  - Arming
  - Disarming
- Sensors (due to lag and capabilities in Alarm.com's web API, these features are partially supported)
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

# Installation

1. Install homebridge: `npm install -g homebridge`
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
  "logLevel": 4,
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
- `useMFA`: boolean indicating if your account requires MFA (required)
- `mfaCookie`: MFA cookie to be sent with your API requests. Only needed if "useMFA" is set to `true`
- `armingModes`: Object of objects with arming mode options of boolean choices (**WARNING:** the Alarm.com webAPI does not support setting silent arming to true and this feature does not work at this time)
- `authTimeoutMinutes`: Timeout to Re-Authenticate session (**WARNING:** choosing a time less than 10 minutes could possibly ban/disable your account from Alarm.com)
- `pollTimeoutSeconds`: Device polling interval (**WARNING:** choosing a time less than 60 seconds could possibly ban/disable your account from Alarm.com)
- `logLevel`: Adjust what gets reported in the logs
  - 0 = NO LOG ENTRIES
  - 1 = ONLY ERRORS
  - 2 = ONLY WARNINGS and ERRORS
  - **3 = GENERAL NOTICES, ERRORS and WARNINGS (default)**
  - 4 = VERBOSE (everything including development output, this also generates a file `ADC-SystemStates.json` with the payload details from Alarm.com in the same folder as the Homebridge config.json file)
- `ignoredDevices`: An array of IDs for Alarm.com accessories you wish to hide in Homekit

# Troubleshooting

Before assuming that something is wrong with the plugin, please review the [issues on this project's github repository](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/issues?utf8=%E2%9C%93&q=sort%3Aupdated-desc+) to see if there's already a similar issue reported where a solution has been proposed or the outcome is expected due to limitations with the Alarm.com web API.

## Devices not responding after upgrading to v1.9.0

Due to changes in the way sensors are polled in v1.9.0, there have reports of needing to clear your device cache after this upgrade. See [this issue](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/issues/107) for more information.

## Migrating from Bryan Bartow's homebridge-alarm.com

If you are replacing the Bryan Bartow's Homebridge plugin with this implementation, you may be required to delete the `~/.homebridge/accessories/cachedAccessories` file for the new platform to show up with the new panel, accessories and devices.

**WARNING:** If you delete the contents of the `~/.homebridge/persist` folder, your Homebridge and devices will become unresponsive and you will have to entirely re-pair the Homebridge bridge (remove and re-scan the QR-code for Homebridge and set up all of your accessories/devices again).

## Logging

The default setting for log entries is set to report critical errors, warnings about devices and notices about connecting to the Alarm.com account. Once you feel that your security system devices are being represented in HomeKit correctly you can choose to reduce the amount of information being output to the logs to save space or remove cruft while troubleshooting other Homebridge plugins.

To modify the log behaviour, add the "logLevel" field to the Alarmdotcom platform block in the Homebridge configuration file. The following example illustrates that we only want critical errors to be reported in the log.

## Ignoring Devices

Accessories that you wish to hide in Homekit (e.g., fobs) can be identified by finding the Serial Number in the settings of the accessory in the Apple Home app, or alternatively in your output log (log level 3 or higher) when Homebridge starts up. If the accessories still exist in Homekit, please make sure that you have typed the serial number exactly. If they still continue to be displayed (or vice-versa they still don't show up after un-ignoring them), then you may be required to delete the `~/.homebridge/accessories/cachedAccessories` file as they may still be stored in the cache within Homebridge.

# Credits

Forked from John Hurliman's FrontPoint\* plugin for Homebridge<small>[↗](https://github.com/jhurliman/homebridge-frontpoint)</small> to replace the branding and code namespace from FrontPoint to Alarm.com.

<small>\*FrontPoint is simply a rebranded service provider for Alarm.com, but FrontPoint is not needed for this plugin to work.</small>

A big thank you to [Mike Kormendy](https://github.com/mkormendy) for forking and working on this plugin so long!
