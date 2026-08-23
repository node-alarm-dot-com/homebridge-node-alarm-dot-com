import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger, LogLevel } from 'homebridge';
import { CustomLogger, CustomLogLevel } from './CustomLogger';

interface LoggedCall {
  method: string;
  message: string;
}

function createStubLogger(): { logger: Logger; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const logger: Logger = {
    info: (message: string) => calls.push({ method: 'info', message }),
    success: (message: string) => calls.push({ method: 'success', message }),
    warn: (message: string) => calls.push({ method: 'warn', message }),
    error: (message: string) => calls.push({ method: 'error', message }),
    debug: (message: string) => calls.push({ method: 'debug', message }),
    log: (level: LogLevel, message: string) => calls.push({ method: level, message })
  };
  return { logger, calls };
}

describe('CustomLogger', () => {
  it('suppresses all levels when logLevel is NONE', () => {
    const { logger, calls } = createStubLogger();
    const customLogger = new CustomLogger(logger, CustomLogLevel.NONE);

    customLogger.error('boom');
    customLogger.warn('careful');
    customLogger.info('fyi');
    customLogger.debug('trace');

    assert.deepEqual(calls, []);
  });

  it('forwards only messages at or below the configured level', () => {
    const { logger, calls } = createStubLogger();
    const customLogger = new CustomLogger(logger, CustomLogLevel.WARN);

    customLogger.error('boom');
    customLogger.warn('careful');
    customLogger.info('fyi');
    customLogger.debug('trace');

    assert.deepEqual(calls, [
      { method: 'error', message: 'boom' },
      { method: 'warn', message: 'careful' }
    ]);
  });

  it('forwards everything when logLevel is VERBOSE', () => {
    const { logger, calls } = createStubLogger();
    const customLogger = new CustomLogger(logger, CustomLogLevel.VERBOSE);

    customLogger.error('boom');
    customLogger.warn('careful');
    customLogger.info('fyi');
    customLogger.debug('trace');

    assert.deepEqual(calls, [
      { method: 'error', message: 'boom' },
      { method: 'warn', message: 'careful' },
      { method: 'info', message: 'fyi' },
      { method: 'debug', message: 'trace' }
    ]);
  });

  it('routes the deprecated log() method through the matching level check', () => {
    const { logger, calls } = createStubLogger();
    const customLogger = new CustomLogger(logger, CustomLogLevel.ERROR);

    customLogger.log(LogLevel.ERROR, 'boom');
    customLogger.log(LogLevel.WARN, 'careful');

    assert.deepEqual(calls, [{ method: 'error', message: 'boom' }]);
  });
});
