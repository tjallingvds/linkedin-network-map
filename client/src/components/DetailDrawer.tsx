import { type Prospect, initials, avatarGrad } from "../design/mockProspects";
import { IconClose, IconMail, IconPhone, IconLinkedIn, IconBolt, IconSend } from "../design/icons";

interface Props {
  prospect: Prospect;
  index: number;
  onClose: () => void;
  onDraft: (ids: string[]) => void;
}

export function DetailDrawer({ prospect: p, index, onClose, onDraft }: Props) {
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="profile-hero">
            <div className="profile-avatar" style={{ background: avatarGrad(index) }}>
              {initials(p.name)}
            </div>
            <div>
              <div className="profile-name">{p.name}</div>
              <div className="profile-title">{p.title} · {p.company}</div>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose size={16} />
          </button>
        </div>

        <div className="drawer-body">
          <div className="field-grid">
            <div className="field">
              <div className="field-label">Email</div>
              <div className="field-value">
                <IconMail size={12} style={{ color: "var(--text-mute)" }} />
                {p.email}
                <span className="verified">{p.emailConf}%</span>
              </div>
            </div>
            <div className="field">
              <div className="field-label">Phone</div>
              <div className="field-value">
                <IconPhone size={12} style={{ color: "var(--text-mute)" }} />
                {p.phone ?? "—"}
              </div>
            </div>
            <div className="field">
              <div className="field-label">LinkedIn</div>
              <div className="field-value">
                <IconLinkedIn size={12} style={{ color: "var(--text-mute)" }} />
                {p.linkedin}
              </div>
            </div>
            <div className="field">
              <div className="field-label">Location</div>
              <div className="field-value">{p.loc}</div>
            </div>
            <div className="field">
              <div className="field-label">Headcount</div>
              <div className="field-value">{p.headcount}</div>
            </div>
            <div className="field">
              <div className="field-label">Funding</div>
              <div className="field-value">{p.funding}</div>
            </div>
          </div>

          <div>
            <div className="section-title">Signals</div>
            <div className="signal-list">
              {p.signals.map((s, i) => (
                <div key={i} className="signal-item">
                  <div className="si-icon"><IconBolt size={12} /></div>
                  <div>
                    <div className="si-text">{s.text}</div>
                    {s.when && <div className="si-when">{s.when}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="section-title">Past experience</div>
            {p.past.map((e, i) => (
              <div key={i} className="exp-row">
                <div className="exp-logo">{e.co.slice(0, 2).toUpperCase()}</div>
                <div className="exp-meta">
                  <div className="exp-role">{e.role}</div>
                  <div className="exp-co">{e.co}</div>
                </div>
                <div className="exp-when">{e.when}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="drawer-foot">
          <button className="pill-btn">Save</button>
          <div style={{ flex: 1 }} />
          <button className="pill-btn primary" onClick={() => onDraft([p.id])}>
            <IconSend size={12} />Draft outreach
          </button>
        </div>
      </div>
    </>
  );
}
