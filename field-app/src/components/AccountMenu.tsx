import { Link } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { CompanySwitcher } from "./CompanySwitcher";
import { fieldBuildLabel } from "../lib/buildStamp";

export function AccountMenu({ onClose }: { onClose: () => void }) {
  const { auth, logout } = useAuth();
  return (
    <div className="c04-account-menu" role="dialog" aria-label="Account">
      <p>Signed in as {auth?.email || "this account"}</p>
      <CompanySwitcher />
      <Link to="/sync-issues" onClick={onClose}>Synchronization review</Link>
      <Link to="/change-password" onClick={onClose}>Change password</Link>
      <Link to="/how-to-use" onClick={onClose}>How to use</Link>
      <button type="button" onClick={() => { onClose(); void logout(); }}>Sign out</button>
      <p>{fieldBuildLabel()}</p>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  );
}
