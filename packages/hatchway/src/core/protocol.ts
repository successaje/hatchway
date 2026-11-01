/**
 * Wire protocol between the local Hatchway server and the browser signing page.
 *
 * This file is imported by both the Node.js side and the browser bundle, so it must stay
 * free of runtime imports. Every value that crosses the wire is JSON: bigints travel as
 * decimal strings (amounts) or 0x-prefixed hex strings (wallet transaction fields).
 */

export const PROTOCOL_VERSION = 1;

export type SessionState =
  /** No browser has opened the session link yet. */
  | "waiting_for_browser"
  /** A browser is attached but no wallet account is bound yet. */
  | "waiting_for_wallet"
  /** A wallet account is bound; requests are processed as they arrive. */
  | "ready"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type RequestState =
  | "queued"
  /** Shown to the user for review; the wallet has not been asked yet. */
  | "review"
  /** The wallet has been asked and the page is waiting for its answer. */
  | "in_wallet"
  /** The wallet returned a transaction hash; waiting for inclusion. */
  | "submitted"
  | "confirmed"
  | "reverted"
  | "signed"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export const TERMINAL_REQUEST_STATES: readonly RequestState[] = [
  "confirmed",
  "reverted",
  "signed",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

export type WalletIssue = "wrong_chain" | "wrong_account" | "disconnected";

export type SessionPurposeKind = "forge" | "hardhat" | "deploy" | "connect";

export interface SessionPurpose {
  kind: SessionPurposeKind;
  /** Short, human readable description, e.g. "forge script script/Deploy.s.sol". */
  title: string;
  /** Project directory relative to where the command was run, when known. */
  project?: string;
}

/** EIP-3085 `wallet_addEthereumChain` parameter. */
export interface AddChainParameter {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

export interface ChainSummary {
  id: number;
  name: string;
  nativeSymbol: string;
  testnet: boolean;
  /** A local development node such as Anvil or Hardhat node. */
  local: boolean;
  explorerUrl?: string;
  /** Present when the page can offer to add this network to the wallet safely. */
  addChain?: AddChainParameter;
}

export interface WalletSummary {
  address: string;
  /** Wallet display name from EIP-6963 (e.g. "MetaMask"), or a best-effort legacy label. */
  name: string;
  rdns?: string;
  chainId: number;
}

/** Exact parameters the page passes to the wallet's `eth_sendTransaction`. */
export interface WalletTransaction {
  from: string;
  to?: string;
  value: string;
  data: string;
  gas?: string;
  nonce?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  chainId: string;
}

export interface DecodedArg {
  name: string;
  type: string;
  value: string;
}

export type SimulationStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface Notice {
  level: "info" | "warning" | "danger";
  message: string;
}

export interface TransactionReview {
  action: "deploy" | "deploy_create2" | "call" | "transfer";
  title: string;
  contractName?: string;
  /** How the contract name was determined. */
  contractSource?: "artifact" | "session" | "selector";
  sourcePath?: string;
  from: string;
  to?: string;
  toLabel?: string;
  value: string;
  valueDisplay: string;
  nonce?: number;
  gasLimit?: string;
  fee?: {
    /** Typical cost: gas limit x (base fee + priority fee), in wei. */
    estimated: string;
    estimatedDisplay: string;
    /** Worst case: gas limit x max fee, in wei. */
    max?: string;
    maxDisplay?: string;
    source: "request" | "network";
  };
  functionSignature?: string;
  args?: DecodedArg[];
  constructorArgs?: DecodedArg[];
  predictedAddress?: string;
  dataSize: number;
  dataPreview: string;
  simulation: { status: SimulationStatus; message?: string };
  notices: Notice[];
}

export interface SignatureReview {
  title: string;
  from: string;
  /** Human readable message (UTF-8 decoded when possible) or pretty-printed typed data. */
  content: string;
  contentKind: "text" | "hex" | "typed_data";
  domain?: { name?: string; version?: string; chainId?: string; verifyingContract?: string };
  primaryType?: string;
  notices: Notice[];
}

export type WalletRequestPayload =
  | { method: "eth_sendTransaction"; params: [WalletTransaction] }
  | { method: "personal_sign"; params: [string, string] }
  | { method: "eth_signTypedData_v4"; params: [string, string] };

export interface RequestResult {
  hash?: string;
  signature?: string;
  explorerUrl?: string;
  blockNumber?: string;
  contractAddress?: string;
  gasUsed?: string;
  feePaid?: string;
  feePaidDisplay?: string;
}

export interface RequestView {
  id: string;
  /** 1-based position within the session. */
  index: number;
  kind: "transaction" | "signature";
  state: RequestState;
  createdAt: number;
  /** Epoch milliseconds after which the request expires if not answered. */
  deadline?: number;
  /** Why a queued request is not yet shown for review. */
  waitingFor?: "previous_confirmation" | "wallet" | "review";
  review?: TransactionReview;
  signatureReview?: SignatureReview;
  wallet: WalletRequestPayload;
  payloadHash: string;
  result?: RequestResult;
  error?: { code: string; message: string };
}

export interface SessionSnapshot {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  state: SessionState;
  purpose: SessionPurpose;
  createdAt: number;
  expiresAt: number;
  /** Server clock, so the page can compute countdowns without trusting its own clock. */
  now: number;
  chain?: ChainSummary;
  expectedAddress?: string;
  wallet?: WalletSummary;
  walletIssue?: WalletIssue;
  requests: RequestView[];
  endedReason?: string;
}

// ---- Browser -> server messages -------------------------------------------------------

export interface ClaimRequest {
  code: string;
}

export interface ClaimResponse {
  token: string;
  protocol: typeof PROTOCOL_VERSION;
}

export interface WalletUpdate {
  /** Empty string when the wallet reports no connected accounts. */
  address: string;
  chainId: number;
  name: string;
  rdns?: string;
}

export interface BeginRequest {
  payloadHash: string;
  address: string;
  chainId: number;
}

export type ResultRequest =
  | { payloadHash: string; outcome: "submitted"; hash: string }
  | { payloadHash: string; outcome: "signed"; signature: string }
  | { payloadHash: string; outcome: "rejected"; message?: string }
  | { payloadHash: string; outcome: "error"; code?: number; message: string };

export interface ApiError {
  error: string;
  message: string;
}
