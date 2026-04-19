import { type Prospect, initials, avatarGrad } from "../design/mockProspects";
import { IconCheck, IconLinkedIn, IconMail } from "../design/icons";

interface Props {
  prospect: Prospect;
  index: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (p: Prospect) => void;
}

export function ProspectCard({ prospect: p, index, selected, onToggle, onOpen }: Props) {
  const matchTier = p.matchPct >= 85 ? "high" : p.matchPct >= 70 ? "mid" : "low";
  const metaBits = [p.loc, p.headcount].filter(Boolean) as string[];
  return (
    <div
      className={`prospect-card ${selected ? "selected" : ""}`}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={() => onOpen(p)}
    >
      {typeof p.matchPct === "number" && p.matchPct > 0 && (
        <div className={`pc-match-badge ${matchTier}`} title={`${p.matchPct}% match`}>
          {p.matchPct}%
        </div>
      )}

      <div className="pc-head">
        <button
          className="pc-check"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(p.id);
          }}
          aria-label={selected ? "Deselect" : "Select"}
        >
          {selected && <IconCheck size={12} />}
        </button>
        <div className="pc-avatar" style={{ background: avatarGrad(index) }}>
          {initials(p.name)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pc-name">{p.name}</div>
          <div className="pc-title">{[p.title, p.company].filter(Boolean).join(" · ")}</div>
        </div>
      </div>

      {p.signals.length > 0 && (
        <div className="pc-signals">
          {p.signals.slice(0, 2).map((s, i) => (
            <div key={i} className={`signal ${s.kind}`}>{s.text}</div>
          ))}
        </div>
      )}

      <div className="pc-meta">
        <span>{metaBits.length > 0 ? metaBits.join(" · ") : "—"}</span>
        <div className="pc-quick" onClick={(e) => e.stopPropagation()}>
          {p.linkedin && (
            <a
              className="pc-quick-btn"
              href={p.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              title="Open LinkedIn profile"
            >
              <IconLinkedIn size={12} />
            </a>
          )}
          {p.email && (
            <a className="pc-quick-btn" href={`mailto:${p.email}`} title={`Email ${p.email}`}>
              <IconMail size={12} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

interface GridProps {
  prospects: Prospect[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (p: Prospect) => void;
}

export function ProspectGrid({ prospects, selected, onToggle, onOpen }: GridProps) {
  return (
    <div className="prospect-grid">
      {prospects.map((p, i) => (
        <ProspectCard
          key={p.id}
          prospect={p}
          index={i}
          selected={selected.has(p.id)}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
