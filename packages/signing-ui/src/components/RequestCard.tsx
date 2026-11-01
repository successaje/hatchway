import { useState } from "preact/hooks";
import type {
  DecodedArg,
  RequestView,
  SessionSnapshot,
  TransactionReview,
} from "../../../hatchway/src/core/protocol.ts";
import {
  CheckIcon,
  CrossIcon,
  formatRemaining,
  Hex,
  Notices,
  Pill,
  Row,
  Spinner,
} from "./common.tsx";

interface Props {
  request: RequestView;
  snapshot: SessionSnapshot;
  now: number;
  walletName: string;
  busy: boolean;
  error: string | undefined;
  /** True when this tab handed the request to the wallet (false after a refresh). */
  initiatedHere: boolean;
  blocked: string | undefined;
  onApprove: () => void;
  onReject: () => void;
}

const ACTION_LABEL: Record<TransactionReview["action"], string> = {
  deploy: "Contract creation",
  deploy_create2: "Deterministic deployment (CREATE2)",
  call: "Contract call",
  transfer: "Native transfer",
};

export function RequestCard(props: Props) {
  const { request, snapshot } = props;
  const position = `${request.kind === "signature" ? "Signature" : "Transaction"} ${request.index}`;
  const title = request.review?.title ?? request.signatureReview?.title ?? "Request";

  return (
    <section class="card enter" aria-labelledby={`request-${request.id}`} key={request.id}>
      <div class="card-top">
        <p class="eyebrow">{position}</p>
        <StateBadge request={request} />
      </div>
      <h1 id={`request-${request.id}`}>{title}</h1>
      {request.review ? (
        <TransactionDetails review={request.review} request={request} snapshot={snapshot} />
      ) : null}
      {request.signatureReview ? <SignatureDetails request={request} /> : null}
      <Footer {...props} />
    </section>
  );
}

function StateBadge({ request }: { request: RequestView }) {
  switch (request.state) {
    case "review":
      return <Pill tone="live">Needs review</Pill>;
    case "in_wallet":
      return <Pill tone="live">In wallet</Pill>;
    case "submitted":
      return <Pill tone="neutral">Confirming</Pill>;
    case "confirmed":
      return <Pill tone="good">Confirmed</Pill>;
    case "signed":
      return <Pill tone="good">Signed</Pill>;
    case "reverted":
      return <Pill tone="bad">Reverted</Pill>;
    case "rejected":
      return <Pill tone="bad">Rejected</Pill>;
    default:
      return <Pill tone="neutral">{request.state}</Pill>;
  }
}

function TransactionDetails({
  review,
  request,
  snapshot,
}: {
  review: TransactionReview;
  request: RequestView;
  snapshot: SessionSnapshot;
}) {
  const [showData, setShowData] = useState(false);
  const explorer = snapshot.chain?.explorerUrl;
  const sim = review.simulation;
  const wallet =
    request.wallet.method === "eth_sendTransaction" ? request.wallet.params[0] : undefined;
  return (
    <>
      <p class="subtitle">
        {ACTION_LABEL[review.action]}
        {review.contractName && review.contractSource === "artifact" && review.sourcePath ? (
          <span class="dim"> · {review.sourcePath}</span>
        ) : null}
      </p>

      <div class="chips">
        <span class={`chip chip-sim-${sim.status}`} title={sim.message ?? ""}>
          {sim.status === "passed" ? <CheckIcon /> : sim.status === "failed" ? <CrossIcon /> : null}
          {sim.status === "passed"
            ? "Simulation passed"
            : sim.status === "failed"
              ? "Simulation failed"
              : "Simulation unavailable"}
        </span>
        {review.fee ? (
          <span
            class="chip"
            title={review.fee.maxDisplay ? `Maximum ${review.fee.maxDisplay}` : ""}
          >
            Est. fee <strong>{review.fee.estimatedDisplay}</strong>
          </span>
        ) : null}
        <span class={`chip ${review.value !== "0" ? "chip-warn" : ""}`}>
          Value <strong>{review.valueDisplay}</strong>
        </span>
      </div>
      {sim.status === "failed" && sim.message ? <p class="sim-detail">{sim.message}</p> : null}

      <dl class="rows">
        <Row label="From">
          <Hex value={review.from} />
        </Row>
        {review.action === "deploy" ? (
          <Row label="Creates">
            {review.predictedAddress ? (
              <span class="stack">
                <Hex value={review.predictedAddress} />
                <span class="dim small">predicted address</span>
              </span>
            ) : (
              "New contract"
            )}
          </Row>
        ) : null}
        {review.to ? (
          <Row label={review.action === "deploy_create2" ? "Via" : "To"}>
            <span class="stack">
              <Hex
                value={review.to}
                href={explorer ? `${explorer}/address/${review.to}` : undefined}
              />
              {review.toLabel ? <span class="dim small">{review.toLabel}</span> : null}
            </span>
          </Row>
        ) : null}
        {review.action === "deploy_create2" && review.predictedAddress ? (
          <Row label="Creates">
            <Hex value={review.predictedAddress} />
          </Row>
        ) : null}
        {review.functionSignature ? (
          <Row label="Function">
            <code class="mono">{review.functionSignature}</code>
          </Row>
        ) : null}
        {review.constructorArgs && review.constructorArgs.length > 0 ? (
          <Row label="Arguments">
            <Args args={review.constructorArgs} />
          </Row>
        ) : null}
        {review.args && review.args.length > 0 ? (
          <Row label={review.action === "deploy_create2" ? "Salt" : "Arguments"}>
            <Args args={review.args} />
          </Row>
        ) : null}
        {review.fee?.maxDisplay ? <Row label="Max fee">{review.fee.maxDisplay}</Row> : null}
        {review.gasLimit ? (
          <Row label="Gas limit">{Number(review.gasLimit).toLocaleString("en-US")}</Row>
        ) : null}
        {review.nonce !== undefined ? <Row label="Nonce">{review.nonce}</Row> : null}
        <Row label="Chain ID">
          {wallet ? Number.parseInt(wallet.chainId, 16) : snapshot.chain?.id}
        </Row>
        <Row label="Data">
          <span class="stack">
            <span>
              {review.dataSize.toLocaleString("en-US")} bytes{" "}
              <button
                type="button"
                class="link"
                onClick={() => setShowData(!showData)}
                aria-expanded={showData}
              >
                {showData ? "Hide" : "Show"}
              </button>
            </span>
            {showData && wallet ? <code class="mono data-block">{wallet.data}</code> : null}
          </span>
        </Row>
      </dl>
      <Notices notices={review.notices} />
    </>
  );
}

function Args({ args }: { args: DecodedArg[] }) {
  return (
    <ul class="args">
      {args.map((arg, i) => (
        <li key={i}>
          <span class="arg-name">{arg.name}</span>
          <span class="arg-type">{arg.type}</span>
          <code class="mono arg-value">{arg.value}</code>
        </li>
      ))}
    </ul>
  );
}

function SignatureDetails({ request }: { request: RequestView }) {
  const review = request.signatureReview!;
  return (
    <>
      <p class="subtitle">Signature request · no transaction is sent</p>
      <dl class="rows">
        <Row label="Signer">
          <Hex value={review.from} />
        </Row>
        {review.domain?.name ? <Row label="App">{review.domain.name}</Row> : null}
        {review.domain?.verifyingContract ? (
          <Row label="Contract">
            <Hex value={review.domain.verifyingContract} />
          </Row>
        ) : null}
        {review.domain?.chainId ? <Row label="Chain ID">{review.domain.chainId}</Row> : null}
      </dl>
      <pre class="message mono" tabIndex={0} aria-label="Message to sign">
        {review.content}
      </pre>
      <Notices notices={review.notices} />
    </>
  );
}

function Footer({
  request,
  now,
  walletName,
  busy,
  error,
  initiatedHere,
  blocked,
  onApprove,
  onReject,
}: Props) {
  if (request.state === "review") {
    const remaining = request.deadline ? request.deadline - now : undefined;
    return (
      <div class="actions-wrap">
        {error ? (
          <p class="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {blocked ? (
          <p class="form-hint" role="status">
            {blocked}
          </p>
        ) : null}
        <div class="actions">
          <button
            type="button"
            class="btn btn-primary"
            onClick={onApprove}
            disabled={busy || blocked !== undefined}
          >
            {busy ? <Spinner /> : null}
            {request.kind === "signature" ? `Sign in ${walletName}` : `Confirm in ${walletName}`}
          </button>
          <button type="button" class="btn btn-ghost" onClick={onReject} disabled={busy}>
            Reject
          </button>
        </div>
        <p class="fineprint">
          Your wallet shows the final transaction and is the only place it can be signed.
          {remaining !== undefined && remaining > 0 ? (
            <> Expires in {formatRemaining(remaining)}.</>
          ) : null}
        </p>
      </div>
    );
  }
  if (request.state === "in_wallet") {
    return (
      <div class="waiting" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true" />
        <div>
          <p class="waiting-title">Waiting for {walletName}…</p>
          {initiatedHere ? (
            <p>Approve or reject the request in your wallet window.</p>
          ) : (
            <>
              <p>
                This request was sent to your wallet before the page reloaded. Answer it there; if
                you approve it, Hatchway picks up the transaction from the chain.
              </p>
              <button type="button" class="btn btn-ghost btn-small" onClick={onReject}>
                I rejected it — withdraw request
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
  if (request.state === "submitted") {
    const hash = request.result?.hash;
    return (
      <div class="waiting" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true" />
        <div>
          <p class="waiting-title">Submitted. Waiting for confirmation…</p>
          {hash ? <Hex value={hash} lead={10} tail={8} href={request.result?.explorerUrl} /> : null}
        </div>
      </div>
    );
  }

  return null;
}
