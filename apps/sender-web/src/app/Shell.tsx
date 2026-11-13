import type { ReactNode } from "react";
import { Icon, type IconName, Mark } from "../ui/Icon.js";

export type View = "home" | "inbox" | "rules" | "receipts" | "assistant" | "family" | "topup";

export const VIEWS: View[] = ["home", "inbox", "rules", "receipts", "assistant", "family", "topup"];

const NAV: { id: View; label: string; icon: IconName; onPhone: boolean }[] = [
  { id: "home", label: "Home", icon: "home", onPhone: true },
  { id: "inbox", label: "Inbox", icon: "inbox", onPhone: true },
  { id: "rules", label: "Rules", icon: "rules", onPhone: true },
  { id: "receipts", label: "Receipts", icon: "receipts", onPhone: true },
  { id: "assistant", label: "Assistant", icon: "assistant", onPhone: true },
  { id: "family", label: "Family", icon: "family", onPhone: false },
  { id: "topup", label: "Top up", icon: "topup", onPhone: false },
];

/**
 * The app's frame: a rail on a computer, a top bar and thumb-height tabs on
 * a phone. `aside` is a third column (the live assistant chat) that only
 * appears when there's room for it.
 */
export function Shell({
  view,
  setView,
  badge,
  name,
  frozen,
  onSignOut,
  aside,
  children,
}: {
  view: View;
  setView: (v: View) => void;
  badge: number;
  name: string;
  frozen: boolean;
  onSignOut: () => void;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const item = (n: (typeof NAV)[number]) => (
    <button
      key={n.id}
      type="button"
      className={`nav-item ${view === n.id ? "on" : ""}`}
      aria-current={view === n.id ? "page" : undefined}
      onClick={() => setView(n.id)}
    >
      <span className="indicator">
        <Icon name={n.icon} />
        {n.id === "inbox" && badge > 0 && (
          <span className="badge" role="status" aria-label={`${badge} waiting`}>
            {badge}
          </span>
        )}
      </span>
      <span className="label">{n.label}</span>
    </button>
  );
  return (
    <div className={`shell ${aside ? "has-aside" : ""}`}>
      <aside className="rail">
        <a className="wordmark" href="/" aria-label="Earmark home">
          <Mark /> Earmark
        </a>
        <nav aria-label="Sections" className="rail-nav">
          {NAV.map(item)}
        </nav>
        <div className="rail-user">
          <span className="who">{name}</span>
          <button type="button" className="link" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="stage">
        <header className="topbar">
          <a className="wordmark" href="/" aria-label="Earmark home">
            <Mark /> Earmark
          </a>
          <div className="topbar-right">
            <button type="button" className="link" onClick={() => setView("family")}>
              Family
            </button>
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </header>
        {frozen && (
          <p role="status" className="freeze-banner">
            The account is frozen. Nothing can be paid until you unfreeze it.
          </p>
        )}
        <main className="page">{children}</main>
      </div>

      {aside && <aside className="side">{aside}</aside>}

      <nav className="tabs" aria-label="Sections">
        {NAV.filter((n) => n.onPhone).map(item)}
      </nav>
    </div>
  );
}
