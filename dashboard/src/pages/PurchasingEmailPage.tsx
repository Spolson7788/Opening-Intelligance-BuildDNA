import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Sidebar } from "../components/Sidebar";
import { fetchPurchasingEmail, savePurchasingEmail, fetchBranches, saveBranch } from "../lib/api";

type Branch = { id: string; name: string; default_state: string; default_territory: string | null; is_active: boolean; purchasing_email: string | null };

export function PurchasingEmailPage() {
  const [companyEmail, setCompanyEmail] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchPurchasingEmail().then((row) => setCompanyEmail(row.purchasing_email || "")).catch(() => setMessage("Could not load the purchasing email."));
    fetchBranches().then((payload) => setBranches(payload.branches || [])).catch(() => setBranches([]));
  }, []);

  async function saveCompany(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    try {
      const saved = await savePurchasingEmail(companyEmail.trim() || null);
      setCompanyEmail(saved.purchasing_email || "");
      setMessage("Company purchasing email saved.");
    } catch {
      setMessage("Could not save that email.");
    }
  }

  async function saveBranchEmail(branch: Branch, email: string) {
    setMessage(null);
    try {
      await saveBranch(branch.id, {
        name: branch.name,
        default_state: branch.default_state,
        default_territory: branch.default_territory,
        is_active: branch.is_active,
        purchasing_email: email.trim() || null,
      });
      setMessage(`Saved the purchasing email for ${branch.name}.`);
    } catch {
      setMessage("Could not save the branch email.");
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <div className="panel">
          <h2>Purchasing email</h2>
          <p>Cut sheets are sent to this address. A branch address, when set, is used instead of the company address.</p>
          <form onSubmit={saveCompany}>
            <label htmlFor="company-purchasing-email">Company purchasing email</label>
            <input id="company-purchasing-email" type="email" value={companyEmail} onChange={(e) => setCompanyEmail(e.target.value)} placeholder="purchasing@example.com" />
            <button className="btn btn-primary" type="submit">Save company email</button>
          </form>
          {branches.map((branch) => (
            <form key={branch.id} onSubmit={(e) => { e.preventDefault(); const input = (e.currentTarget.elements.namedItem("email") as HTMLInputElement); void saveBranchEmail(branch, input.value); }} style={{ marginTop: 16 }}>
              <label htmlFor={`branch-${branch.id}`}>{branch.name} override</label>
              <input id={`branch-${branch.id}`} name="email" type="email" defaultValue={branch.purchasing_email || ""} placeholder="Leave blank to use the company email" />
              <button className="btn btn-secondary" type="submit">Save branch email</button>
            </form>
          ))}
          {message && <p>{message}</p>}
        </div>
      </div>
    </div>
  );
}
