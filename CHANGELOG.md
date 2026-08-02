# Changelog

All notable changes to this project are documented in this file, based on the
[GitHub releases](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/releases).

## [1.13.1-Beta]

### Bugs Squished

- Fixed smoke detectors being labeled as "Heat Sensor"; smoke, heat, and CO detectors now map state independently and glass-break/water sensors resolve correctly on cached setup. (#171)
- Fixed the duplicate-accessory guard never running because the accessories array was pushed before the existence check. (#172)
- Fixed accessories being registered after the Alarm.com WebSocket opened, which could drop early device events and force a delayed full refresh. (#170)
- Fixed thermostat AUTO mode being mapped to OFF and pushed onto the wrong HomeKit characteristic; AUTO now works correctly in HomeKit. (#168)
- Fixed login/session failures being swallowed instead of failing closed, which could crash callers with missing systems. (#166)
- Fixed overlapping WebSocket connect/retry attempts causing double connections and 403 token churn after reconnect. (#163)
- Improved WebSocket error logging to include close codes, reason, and underlying error causes for easier diagnosis.
- Fix stale cached accessories not being removed properly.

## [1.13.0]

### Enhancements

- Added support for doorbells appearing as motion sensors. (#144)
- Changed default logging level to WARN, reducing log spam.

### Bugs Squished

- Fixed issue with C/F temp conversion when setting thermostats. (#158)
- Fixed issue where plugin would error or crash when not receiving or sending proper extendedArmingOptions.
- 'Night' arm no longer appears for partitions which do not support night arming. (#147)
- Fixed a couple of issues where loops were not being cleaned up properly.

## [1.12.0] - 2026-05-31

- Big refactor of the code base:
  - Device handlers are now separated into their own files.
  - Code base now adheres to TypeScript strict mode.
  - Updated packages and removed unused dependencies.
- Added support for WebSockets. The plugin can now use WebSockets instead of polling to refresh
  device state, resulting in near-instantaneous notifications about device changes. **Experimental** —
  must be enabled in config to use.

## [1.11.0] - 2026-05-17

> This plugin is in maintenance mode; issues are addressed as time allows. Contributions and
> additional maintainers are welcome.

- Updated packages:
  - Support for Node 22 and 24.
  - Support for TypeScript 6 and ESLint 9.
- Declared compatibility with Homebridge 2.0.
- Cleaned up a potential memory leak with the timer when stopping the plugin.
- Published NPM packages using OIDC.

## [1.10.2] - 2024-12-14

- Support `forceBypass` under `armingModes` ([#138](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/138), thanks @DouweM).
- Fixed inverted state for glass break sensors.

## [1.10.1] - 2024-09-21

- Fixed night arming option ([#118](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/118), thanks @jdrahoz).
- Fixed heat and glass sensors reporting inverted state.
- Fixed a plugin crash when account settings retrieval fails.
- Updated minimum supported Node versions.
- General package updates.

## [1.10.0] - 2023-10-09

- Added thermostat support ([#111](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/111), thanks @pb30).
- Cleaned up logging to prevent excessive log spam.
- General linting cleanup.

## [1.9.0] - 2023-01-29

- Adopted Prettier and ESLint for code cleanup.
- Compatibility with Node-HAP 0.11.0 and Homebridge 1.6.0.
- Added new sensor types (clearing the accessories cache may be required).
- Fixed 404 errors when too many sensors are present.
- Fixed several issues with dimmable/non-dimmable lights.
- Improved logging of unknown sensors ([#68](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/68), thanks @andrewheavin).
- Fixed log level not suppressing logs as expected.
- **Breaking:** Dropped support for Node 12 and 14.
- Fixed `desiredLockState` erroring out when lock state is unknown.

## [1.8.0] - 2021-08-22

- Updated `node-alarm-dot-com` to v1.11.0, adding:
  - Multi-factor authentication support.
  - Recovery from expired authentication (`ECONNECT` errors) (thanks @DMBlakeley).
- Updated Config UI X schema for clarity and current features.
- Fixed night arming not working, and added a warning for it.
- Improved logging of unknown sensors (thanks @andrewheavin).
- Fixed the device cache not restoring devices correctly.
- Fixed ignored devices not being ignored/removed from the plugin.
- Fixed accessory ordering so locks/lights are no longer mixed together.
- Added randomness to the refresh timer to avoid overloading Alarm.com's servers.

## [1.7.1] - 2021-02-06

- Attempted fix for `node-alarm-dot-com` import issues causing undefined errors when reading `ARM_STAY`.

## [1.7.0] - 2021-02-06

- Project rewritten in TypeScript.
- Improved reliability of light control, especially around dimmers.
- Fixed night arming.

## [1.6.5] - 2020-10-24

- Updated README links to the organization URL.
- Updated README with garage door control documentation.

## [1.6.4] - 2020-08-01

- No user-facing changes.

## [1.6.3] - 2020-08-01

- Fixed dependency issues in `package.json`.

## [1.6.2] - 2020-08-01

- Fixed an error on systems without garage doors producing an undefined error.

## [1.6.1] - 2020-08-01

- Updated `package-lock.json`.

## [1.6.0] - 2020-08-01

- Added garage door support ([#45](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/45)).
- Adjusted repository URL in `package.json`.
- Added "Verified by Homebridge" badge to README.

## [1.5.1] - 2020-07-15

- Fixed "No lights found" error for security-system-only setups ([#44](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/44), thanks @DMBlakeley).

## [1.5.0] - 2020-07-15

- Code rearrangement and cleanup.
- Added the ability to export the Alarm.com response payload to a file for troubleshooting.
- Plugin no longer crashes Homebridge if the configuration, username, or password is missing;
  satisfies Homebridge/Config UI X "Verified" requirements.
- Added `config.schema.json` for Config UI X support ([#36](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/36)).
- Documentation and minor code cleanup.

## [1.4.3] - 2020-03-20

- Updated dependencies.

## [1.4.2] - 2020-03-20

- Updated dependencies to fix login issues.
- Fixed API inconsistencies with device sections reporting incorrect device types.

## [1.4.1] - 2020-01-15

- Updated Node package files.
- Renamed method calls following a `node-alarm-dot-com` refactor.

## [1.4.0] - 2020-01-13

- Fixed issue #23 and added a graceful warning for non-existent accessories.

## [1.3.2] - 2019-11-19

- Updated dependency for latest `node-alarm-dot-com` light and lock implementations.

## [1.3.1] - 2019-11-19

- README cleanup.

## [1.3.0] - 2019-11-19

- Added support for locks and lights.
- Added dimmer detection for lights.

## [1.2.0] - 2019-05-20

- Added an "ignore devices" feature (issues #4 and #13).

## [1.1.11] - 2019-01-21

- Added/updated issue templates and README badges.

## [1.1.10] - 2019-01-21

- Added Stale bot configuration to the repo.

## [1.1.9] - 2018-12-26

- Code reorganizing.

## [1.1.8] - 2018-12-24

- Fixed the details flyout for error options.

## [1.1.7] - 2018-12-24

- Added the ability to limit log output and change authentication/device-state polling intervals.

## [1.1.6] - 2018-09-23

- Documented the unavoidable lag in the Alarm.com web API.
- Renamed the project from FrontPoint to Alarm.com nomenclature throughout.
- Fixed the manufacturer name and plugin naming.
- Extended config to support "silent arm" and "no entry delay" preferences per arming mode ([#9](https://github.com/node-alarm-dot-com/homebridge-node-alarm-dot-com/pull/9)).
- Made cached accessories functional before the first refresh; fixed arm/disarm flow.
- Switched from `setValue`/`getValue` to `updateValue`/`setValue` and proper HAP enums.
- Initial release.
