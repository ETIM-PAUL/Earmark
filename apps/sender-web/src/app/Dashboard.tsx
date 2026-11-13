import { api } from "./api.js";
import { loadChat } from "./chat.js";
import { Shell, type View } from "./Shell.js";
import type { AppConfig, FamilyState, Invite } from "./types.js";
import { usePoll } from "./usePoll.js";
import { Assistant, ChatPanel } from "./views/Assistant.js";
import { Family } from "./views/Family.js";
import { Home } from "./views/Home.js";
import { Inbox } from "./views/Inbox.js";
import { Receipts } from "./views/Receipts.js";
import { Rules } from "./views/RulesView.js";
import { TopUp } from "./views/TopUp.js";

export { TeamCard } from "./views/Family.js";
export { ApprovalItem } from "./views/Inbox.js";

/** The signed-in app: the family's state, polled, shown in the view the person chose. */
export function Dashboard({
  familyId,
  config,
  firstInvite,
  name,
  view,
  setView,
  onSignOut,
}: {
  familyId: string;
  config: AppConfig;
  firstInvite: Invite | null;
  name: string;
  view: View;
  setView: (v: View) => void;
  onSignOut: () => void;
}) {
  const {
    value: state,
    error,
    refresh,
  } = usePoll(() => api<FamilyState>(`/api/families/${familyId}/state`), 3_000);
  const chat = usePoll(() => loadChat(familyId), 2_500);

  if (!state) {
    return (
      <div className="splash" role="status">
        {error ? error.message : "Loading your family…"}
      </div>
    );
  }
  const lines = chat.value;
  const chatLive = lines !== null && lines !== undefined;
  const badge = state.approvals.length + state.proposals.length;

  return (
    <Shell
      view={view}
      setView={setView}
      badge={badge}
      name={name}
      frozen={state.overview.frozen}
      onSignOut={onSignOut}
      aside={
        chatLive && view !== "assistant" ? (
          <ChatPanel familyId={familyId} lines={lines} refresh={chat.refresh} compact />
        ) : undefined
      }
    >
      {view === "home" && (
        <Home familyId={familyId} state={state} config={config} onChange={refresh} go={setView} />
      )}
      {view === "inbox" && (
        <Inbox
          familyId={familyId}
          cards={state.approvals}
          proposals={state.proposals}
          onChange={refresh}
        />
      )}
      {view === "rules" && (
        <Rules
          familyId={familyId}
          overview={state.overview}
          team={state.team}
          config={config}
          onChange={refresh}
        />
      )}
      {view === "receipts" && <Receipts orders={state.orders} config={config} />}
      {view === "assistant" && (
        <Assistant familyId={familyId} invite={firstInvite} lines={lines} refresh={chat.refresh} />
      )}
      {view === "family" && (
        <Family
          familyId={familyId}
          overview={state.overview}
          team={state.team}
          onChange={refresh}
        />
      )}
      {view === "topup" && <TopUp config={config} overview={state.overview} />}
    </Shell>
  );
}
