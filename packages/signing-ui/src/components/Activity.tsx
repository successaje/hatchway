import type { RequestView, SessionSnapshot } from "../../../hatchway/src/core/protocol.ts";
import { CheckIcon, CrossIcon, Hex, Spinner } from "./common.tsx";

const STATE_TEXT: Partial<Record<RequestView["state"], string>> = {
  queued: "Queued",
  review: "Needs review",
  in_wallet: "In wallet",
  submitted: "Confirming",
  confirmed: "Confirmed",
  signed: "Signed",
  reverted: "Reverted",
  rejected: "Rejected",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Withdrawn",
};

export function Activity({ snapshot, currentId }: { snapshot: SessionSnapshot; currentId: string | undefined }) {
  const requests = snapshot.requests;
  if (requests.length === 0) return null;
  const explorer = snapshot.chain?.explorerUrl;
  return (
    <section class="activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      <ol>
        {requests.map((request) => {
          const tone =
            request.state === "confirmed" || request.state === "signed"
              ? "good"
              : ["reverted", "rejected", "failed", "expired", "cancelled"].includes(request.state)
                ? "bad"
                : "live";
          const address = request.result?.contractAddress;
          const hash = request.result?.hash;
          return (
            <li key={request.id} class={`activity-item tone-${tone} ${request.id === currentId ? "is-current" : ""}`}>
              <span class="activity-icon" aria-hidden="true">
                {tone === "good" ? <CheckIcon /> : tone === "bad" ? <CrossIcon /> : request.state === "queued" ? <span class="dot" /> : <Spinner />}
              </span>
              <span class="activity-main">
                <span class="activity-title">
                  <span class="activity-index">{request.index}</span>
                  {request.review?.title ?? request.signatureReview?.title ?? "Request"}
                </span>
                {request.error && tone === "bad" ? <span class="activity-error">{request.error.message}</span> : null}
                {address ? (
                  <span class="activity-meta">
                    at <Hex value={address} href={explorer ? `${explorer}/address/${address}` : undefined} />
                  </span>
                ) : hash ? (
                  <span class="activity-meta">
                    tx <Hex value={hash} lead={8} tail={6} href={request.result?.explorerUrl} />
                  </span>
                ) : null}
              </span>
              <span class="activity-state">{waitingText(request) ?? STATE_TEXT[request.state] ?? request.state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function waitingText(request: RequestView): string | undefined {
  if (request.state !== "queued") return undefined;
  if (request.waitingFor === "previous_confirmation") return "After previous";
  if (request.waitingFor === "wallet") return "Waiting for wallet";
  if (request.waitingFor === "review") return "Preparing";
  return undefined;
}
