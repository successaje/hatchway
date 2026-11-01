import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Notice } from "../../../hatchway/src/core/protocol.ts";

export function shortHex(value: string, lead = 6, tail = 4): string {
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Ticks once a second; `offset` corrects for the difference between server and page clocks. */
export function useNow(offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() + offset), 1000);
    setNow(Date.now() + offset);
    return () => window.clearInterval(timer);
  }, [offset]);
  return now;
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8" class="mark-bg" />
      <rect x="9" y="8" width="14" height="16" rx="3" class="mark-door" />
      <circle cx="19" cy="16" r="1.8" class="mark-handle" />
    </svg>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      class={`copy ${copied ? "is-copied" : ""}`}
      aria-label={copied ? "Copied" : `${label}: ${value}`}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** Address or hash that shows a short form and reveals the full value on demand. */
export function Hex({ value, lead = 6, tail = 4, href }: { value: string; lead?: number; tail?: number; href?: string | undefined }) {
  const [full, setFull] = useState(false);
  const text = full ? value : shortHex(value, lead, tail);
  return (
    <span class="hex">
      <button type="button" class="hex-toggle mono" onClick={() => setFull(!full)} aria-label={full ? "Show short form" : `Show full value ${value}`} title={value}>
        {text}
      </button>
      <CopyButton value={value} />
      {href ? (
        <a class="ext" href={href} target="_blank" rel="noreferrer noopener" aria-label="Open in block explorer" title="Open in block explorer">
          <ExternalIcon />
        </a>
      ) : null}
    </span>
  );
}

export function Notices({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;
  const order = { danger: 0, warning: 1, info: 2 } as const;
  const sorted = [...notices].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <ul class="notices">
      {sorted.map((notice, i) => (
        <li key={i} class={`notice notice-${notice.level}`}>
          <span class="notice-icon" aria-hidden="true">
            {notice.level === "info" ? <InfoIcon /> : <AlertIcon />}
          </span>
          <span>
            <span class="sr-only">{notice.level === "info" ? "Note: " : notice.level === "warning" ? "Warning: " : "Danger: "}</span>
            {notice.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Pill({ tone, children }: { tone: "neutral" | "good" | "warn" | "bad" | "live"; children: ComponentChildren }) {
  return <span class={`pill pill-${tone}`}>{children}</span>;
}

export function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}

const svgProps = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" } as const;

export const CopyIcon = () => (
  <svg {...svgProps}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);
export const CheckIcon = () => (
  <svg {...svgProps}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);
export const CrossIcon = () => (
  <svg {...svgProps}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const ExternalIcon = () => (
  <svg {...svgProps}>
    <path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
  </svg>
);
export const InfoIcon = () => (
  <svg {...svgProps}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v3.6M8 5.2v.1" />
  </svg>
);
export const AlertIcon = () => (
  <svg {...svgProps}>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 6.8v3M8 11.8v.1" />
  </svg>
);
export const LockIcon = () => (
  <svg {...svgProps}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
export const WalletIcon = () => (
  <svg {...svgProps} width={18} height={18}>
    <rect x="2" y="4" width="12" height="9" rx="2" />
    <path d="M2 6.5h12M10.5 9.5h1" />
  </svg>
);
