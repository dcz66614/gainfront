/**
 * GainFront Core Error Definitions
 *
 * Provides stable error codes and human-readable messages.
 * Natural language error parsing is strictly forbidden by project contracts.
 */

export type ErrorCode =
  | 'INVALID_CONSTRAINTS'
  | 'INVALID_TICK'
  | 'INVALID_PRESET_ID'
  | 'INVALID_SOURCE_REF'
  | 'INVALID_PCM'
  | 'INVALID_MEASUREMENT'
  | 'INVALID_SESSION'
  | 'UNKNOWN_FIELD'
  | 'NON_FINITE_VALUE'
  | 'UNSUPPORTED_WAV'
  | 'OUT_OF_SCOPE'
  | 'NO_PROGRAM'
  | 'SOURCE_REQUIRED'
  | 'OPERATION_CANCELLED'
  | 'WORKER_ERROR';

export interface ErrorDetails {
  [key: string]: unknown;
}

export class GainFrontError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = 'GainFrontError';
    this.code = code;
    this.details = details;

    Object.setPrototypeOf(this, GainFrontError.prototype);
  }

  public toJSON(): { name: string; code: ErrorCode; message: string; details?: ErrorDetails } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function isGainFrontError(error: unknown): error is GainFrontError {
  return error instanceof GainFrontError;
}
