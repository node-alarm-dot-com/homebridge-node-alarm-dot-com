import { Logger, LogLevel } from 'homebridge';

/**
 * CustomLogger is a logger to replace the homebridge logger. The reason for this is
 * to allow user defined logging levels, where logs are not output if the user desires.
 */
export class CustomLogger implements Logger {
  public readonly logger: Logger;
  public readonly prefix: string;
  public readonly logLevel: CustomLogLevel;

  constructor(logger: Logger, logLevel: CustomLogLevel, prefix?: string) {
    this.prefix = prefix || '';
    this.logger = logger;
    this.logLevel = logLevel;
  }
  success(message: string, ...parameters: unknown[]): void {
    this.debug(message, parameters);
  }

  info(message: string, ...parameters: unknown[]): void {
    if (this.logLevel >= CustomLogLevel.NOTICE) this.logger.info(message, ...parameters);
  }

  warn(message: string, ...parameters: unknown[]): void {
    if (this.logLevel >= CustomLogLevel.WARN) this.logger.warn(message, ...parameters);
  }

  error(message: string, ...parameters: unknown[]): void {
    if (this.logLevel >= CustomLogLevel.ERROR) this.logger.error(message, ...parameters);
  }

  debug(message: string, ...parameters: unknown[]): void {
    if (this.logLevel >= CustomLogLevel.VERBOSE) this.logger.debug(message, ...parameters);
  }

  /**
   * @deprecated
   * @param level
   * @param message
   * @param parameters
   */
  log(level: LogLevel, message: string, ...parameters: unknown[]): void {
    switch (level) {
      case LogLevel.DEBUG:
        this.debug(message, parameters);
        break;
      case LogLevel.ERROR:
        this.error(message, parameters);
        break;
      case LogLevel.INFO:
        this.info(message, parameters);
        break;
      case LogLevel.WARN:
        this.warn(message, parameters);
        break;
      default:
        break;
    }
  }
}

export enum CustomLogLevel {
  NONE,
  ERROR,
  WARN,
  NOTICE,
  VERBOSE
}
