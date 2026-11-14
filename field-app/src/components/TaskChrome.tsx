import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { onSyncStateChange, refreshPendingCount } from "../lib/sync";
import { AccountMenu } from "./AccountMenu";

export function TaskChrome({ title, hint, backTo, children }: { title: string; hint: string; backTo?: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    document.body.classList.add("c04-on");
    return () => document.body.classList.remove("c04-on");
  }, []);
  useEffect(() => {
    void refreshPendingCount();
    return onSyncStateChange((state) => setWaiting((state.pending || 0) + (state.failed || 0) + (state.conflicts || 0)));
  }, [auth?.userId, auth?.organizationId]);
  return (
    <div className="app-shell c04">
      <div className="screen">
        <div className="c04-taskbar">
          {backTo ? <button type="button" className="btn c04-back" onClick={() => navigate(backTo)}>Back</button> : <span />}
          <Link className={waiting > 0 ? "c04-syncdot c04-syncdot-wait" : "c04-syncdot"} to="/sync-issues">{waiting > 0 ? `${waiting} waiting` : "Saved"}</Link>
          <button type="button" className="c04-account-mark" aria-label="Account" onClick={() => setOpen(true)}>A</button>
        </div>
        <h1>{title}</h1>
        {hint ? <p className="c04-note">{hint}</p> : null}
        {children}
        <p><Link className="c04-link" to="/scan">Current screens</Link></p>
        {open && <AccountMenu onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}
