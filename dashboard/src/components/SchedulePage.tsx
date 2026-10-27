import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Sidebar } from "./Sidebar";

// Item 1: schedule pages use the same shell, header and panels as the rest of the dashboard.
export function SchedulePage({ title, subtitle, back, children }: { title: string; subtitle?: ReactNode; back?: { to: string; label: string }; children: ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main schedule-page">
        <div className="page-header">
          <div>
            {back && <p className="schedule-back"><Link to={back.to}>{back.label}</Link></p>}
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
