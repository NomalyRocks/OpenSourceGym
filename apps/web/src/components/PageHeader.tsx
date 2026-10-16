import type { ReactNode } from "react";

/** Shared page heading: title, optional count pill, subtitle and an actions slot. */
export function PageHeader({
  title,
  count,
  subtitle,
  actions,
}: {
  title: string;
  count?: number;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {count !== undefined && <span className="count-pill">{count}</span>}
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {subtitle && <p className="page-sub">{subtitle}</p>}
    </div>
  );
}
