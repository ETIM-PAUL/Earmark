// Small line icons, drawn for the app's navigation. Decorative: the label
// next to each one says what it is.

const PATHS = {
  home: "M3 11 12 3l9 8v10h-6v-6H9v6H3z",
  inbox: "M3 13 6 5h12l3 8v6H3zM3 13h5l1.5 3h5L16 13h5",
  rules: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",
  receipts: "M5 3h14v7a2 2 0 0 0 0 4v7H5v-7a2 2 0 0 0 0-4zM8.5 8.5h7M8.5 16h5",
  assistant: "M4 5h16v11H10l-6 4zM8 10h8",
  family:
    "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a2.5 2.5 0 1 0 0-5M17 14c2.6.3 4.5 2.4 4.5 5",
  topup: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  check: "m5 12.5 4.5 4.5L19 7.5",
  plus: "M12 5v14M5 12h14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The wordmark: a rounded slip with its corner folded down. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--primary)" />
      <path d="M8 6h5.5l3.5 3.5V18H8z" fill="var(--on-primary)" />
      <path d="M13.5 6v3.5H17z" fill="var(--tertiary-container)" />
    </svg>
  );
}
