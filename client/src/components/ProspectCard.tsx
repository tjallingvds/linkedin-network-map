import { type Prospect, initials, avatarGrad } from "../design/mockProspects";
import { IconCheck } from "../design/icons";

interface Props {
  prospect: Prospect;
  index: number;
  selected: boolean;
  onToggle: (id: string) => void;
  onOpen: (p: Prospect) => void;
}

export function ProspectCard({ prospect: p, index, selected, onToggle, onOpen }: Props) {
  return (
    <div
      className={`prospect-card ${selected ? "selected" : ""}`}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={() => onOpen(p)}
    >
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
        <div style={{ minWidth: 0 }}>
          <div className="pc-name">{p.name}</div>
          <div className="pc-title">{p.title} · {p.company}</div>
        </div>
      </div>

      <div className="pc-signals">
        {p.signals.slice(0, 2).map((s, i) => (
          <span key={i} className={`signal ${s.kind}`}>{s.text}</span>
        ))}
      </div>

      <div className="pc-meta">
        <span>{p.loc}</span>
        <span className="dot-sep">·</span>
        <span>{p.headcount}</span>
        <div className="pc-confidence">
          <div className="pc-conf-bar">
            <i style={{ width: `${p.matchPct}%` }} />
          </div>
          <span>{p.matchPct}%</span>
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
