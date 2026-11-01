/**
 * Structured errors. Every failure a user can hit maps to a stable code, an actionable
 * message, and a process exit code. Stack traces are only shown with --debug.
 */

export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
  Rejected: 3,
  Timeout: 4,
  Network: 5,
  WalletMismatch: 6,
  ToolMissing: 7,
  Reverted: 8,
  Integrity: 9,
  Cancelled: 10,
  Interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode =
  | "USAGE"
  | "USER_REJECTED"
  | "SESSION_EXPIRED"
  | "APPROVAL_TIMEOUT"
  | "SESSION_CANCELLED"
  | "SESSION_CLOSED"
  | "RPC_UNREACHABLE"
  | "RPC_ERROR"
  | "WRONG_NETWORK"
  | "WRONG_ACCOUNT"
  | "UNSUPPORTED_SIGNER"
  | "UNSUPPORTED_TRANSACTION"
  | "INVALID_TRANSACTION"
  | "NONCE_CONFLICT"
  | "TRANSACTION_REVERTED"
  | "PREVIOUS_FAILED"
  | "INTEGRITY_MISMATCH"
  | "TRANSACTION_REPLACED"
  | "WALLET_ERROR"
  | "TOOL_NOT_FOUND"
  | "TOOL_FAILED"
  | "PROJECT_NOT_FOUND"
  | "ARTIFACT_NOT_FOUND"
  | "PORT_IN_USE"
  | "INTERRUPTED"
  | "INTERNAL";

const EXIT_CODES: Record<ErrorCode, ExitCode> = {
  USAGE: ExitCode.Usage,
  USER_REJECTED: ExitCode.Rejected,
  SESSION_EXPIRED: ExitCode.Timeout,
  APPROVAL_TIMEOUT: ExitCode.Timeout,
  SESSION_CANCELLED: ExitCode.Cancelled,
  SESSION_CLOSED: ExitCode.Cancelled,
  RPC_UNREACHABLE: ExitCode.Network,
  RPC_ERROR: ExitCode.Network,
  WRONG_NETWORK: ExitCode.WalletMismatch,
  WRONG_ACCOUNT: ExitCode.WalletMismatch,
  UNSUPPORTED_SIGNER: ExitCode.Usage,
  UNSUPPORTED_TRANSACTION: ExitCode.Failure,
  INVALID_TRANSACTION: ExitCode.Failure,
  NONCE_CONFLICT: ExitCode.Failure,
  TRANSACTION_REVERTED: ExitCode.Reverted,
  PREVIOUS_FAILED: ExitCode.Failure,
  INTEGRITY_MISMATCH: ExitCode.Integrity,
  TRANSACTION_REPLACED: ExitCode.Integrity,
  WALLET_ERROR: ExitCode.Failure,
  TOOL_NOT_FOUND: ExitCode.ToolMissing,
  TOOL_FAILED: ExitCode.Failure,
  PROJECT_NOT_FOUND: ExitCode.Usage,
  ARTIFACT_NOT_FOUND: ExitCode.Usage,
  PORT_IN_USE: ExitCode.Failure,
  INTERRUPTED: ExitCode.Interrupted,
  INTERNAL: ExitCode.Failure,
};

/**
 * JSON-RPC error codes returned to tools (forge, Hardhat) that call the local bridge.
 * 4001 / 4100 / 4200 / 4900 / 4901 follow EIP-1193 so callers recognise them.
 */
const RPC_CODES: Partial<Record<ErrorCode, number>> = {
  USER_REJECTED: 4001,
  WRONG_ACCOUNT: 4100,
  UNSUPPORTED_SIGNER: 4200,
  UNSUPPORTED_TRANSACTION: 4200,
  WRONG_NETWORK: 4901,
  SESSION_CLOSED: 4900,
  INVALID_TRANSACTION: -32602,
};

export class HatchwayError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HatchwayError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): ExitCode {
    return EXIT_CODES[this.code];
  }

  get rpcCode(): number {
    return RPC_CODES[this.code] ?? -32000;
  }
}

export function isHatchwayError(error: unknown): error is HatchwayError {
  return error instanceof HatchwayError;
}

export function toHatchwayError(error: unknown): HatchwayError {
  if (isHatchwayError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new HatchwayError("INTERNAL", message, { cause: error });
}
