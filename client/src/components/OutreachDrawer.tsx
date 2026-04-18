import { useState } from "react";
import type { OutreachDraft, Prospect } from "@app/shared";
import { initials, avatarGrad } from "../design/mockProspects";
import { IconClose, IconMail, IconLinkedIn, IconSend } from "../design/icons";

interface Props {
  recipients: Prospect[];
  drafts?: OutreachDraft[];
  onClose: () => void;
  onSent: () => void;
}

export function OutreachDrawer({ recipients, drafts, onClose, onSent }: Props) {
  const [tab, setTab] = useState<"email" | "linkedin">("email");
  const [selectedId, setSelectedId] = useState<string>(recipients[0]?.id ?? "");

  const currentDraft =
    drafts?.find((d) => d.recipientId === selectedId) ?? drafts?.[0];
  const currentRecipient =
    recipients.find((r) => r.id === selectedId) ?? recipients[0];

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer outreach-drawer">
        <div className="drawer-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Draft outreach</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
              {drafts ? `${drafts.length} AI-written draft${drafts.length === 1 ? "" : "s"}` : `To ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose}><IconClose size={16} /></button>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === "email" ? "active" : ""}`} onClick={() => setTab("email")}>
            <IconMail size={13} />Email
          </button>
          <button className={`tab ${tab === "linkedin" ? "active" : ""}`} onClick={() => setTab("linkedin")}>
            <IconLinkedIn size={13} />LinkedIn DM
          </button>
        </div>

        <div className="drawer-body">
          <div className="recipient-strip">
            {recipients.map((r, i) => (
              <button
                key={r.id}
                className="rec-chip"
                onClick={() => setSelectedId(r.id)}
                style={{
                  borderColor: r.id === selectedId ? "var(--accent)" : "var(--hairline)",
                  background: r.id === selectedId ? "var(--accent-soft)" : "var(--panel)",
                }}
              >
                <div className="pc-avatar" style={{ background: avatarGrad(i) }}>
                  {initials(r.name)}
                </div>
                <span>{r.name}</span>
              </button>
            ))}
          </div>

          {currentDraft ? (
            <div className="draft-box">
              {tab === "email" ? (
                <>
                  <div className="from-row">
                    <span>From</span><b>you@nontrivial.com</b>
                    <span style={{ marginLeft: 8 }}>To</span>
                    <b>{currentDraft.recipientName}</b>
                  </div>
                  <div className="subj">{currentDraft.email.subject}</div>
                  <div className="draft-body">{currentDraft.email.body}</div>
                </>
              ) : (
                <div className="draft-body">{currentDraft.linkedin}</div>
              )}
            </div>
          ) : (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-mute)", fontSize: 13 }}>
              {currentRecipient
                ? `No draft yet for ${currentRecipient.name}. Use the composer Draft mode.`
                : "No recipients."}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="pill-btn" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="pill-btn primary" onClick={onSent}>
            <IconSend size={12} />Queue for send
          </button>
        </div>
      </div>
    </>
  );
}
