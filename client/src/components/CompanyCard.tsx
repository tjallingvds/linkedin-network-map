import type { Company } from "@app/shared";
import { initials, avatarGrad } from "../design/mockProspects";
import { IconLinkedIn } from "../design/icons";

interface CardProps {
  company: Company;
  index: number;
}

/** A discovered target-account. Reuses the prospect-card visual shell so a
 *  "find companies" result sits consistently next to people results, but it's
 *  display-only — no selection/board-add (companies aren't people). */
export function CompanyCard({ company: c, index }: CardProps) {
  const metaBits = [c.industry, c.hq].filter(Boolean) as string[];
  const website = c.domain
    ? (c.domain.startsWith("http") ? c.domain : `https://${c.domain}`)
    : undefined;
  return (
    <div className="prospect-card" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="pc-head">
        <div className="pc-avatar" style={{ background: avatarGrad(index) }}>
          {initials(c.name)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pc-name">{c.name}</div>
          <div className="pc-title">{metaBits.length > 0 ? metaBits.join(" · ") : "—"}</div>
        </div>
      </div>

      <div className="pc-signals">
        {c.fit && <div className="signal match">{c.fit}</div>}
        {c.signals.slice(0, 2).map((s, i) => (
          <div key={i} className="signal">{s}</div>
        ))}
      </div>

      <div className="pc-meta">
        <span>{c.employees ? c.employees : "—"}</span>
        <div className="pc-quick">
          {c.linkedin && (
            <a
              className="pc-quick-btn"
              href={c.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              title="Company LinkedIn"
            >
              <IconLinkedIn size={12} />
            </a>
          )}
          {website && (
            <a
              className="pc-quick-btn"
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              title={website}
            >
              ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function CompanyGrid({ companies }: { companies: Company[] }) {
  return (
    <div className="prospect-grid">
      {companies.map((c, i) => (
        <CompanyCard key={c.id} company={c} index={i} />
      ))}
    </div>
  );
}
