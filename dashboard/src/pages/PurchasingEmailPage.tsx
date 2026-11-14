import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Sidebar } from "../components/Sidebar";
import { fetchPurchasingEmail, savePurchasingEmail, fetchPurchasingBranchEmails, savePurchasingBranchEmail } from "../lib/api";

type Branch = { id: string; name: string; purchasing_email: string | null };

export function PurchasingEmailPage() {
  const [companyEmail, setCompanyEmail] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchPurchasingEmail().then((row) => setCompanyEmail(row.purchasing_email || "")).catch(() => setMessage("Could not load the purchasing email."));
    fetchPurchasingBranchEmails().then((payload) => setBranches(payload.branches || [])).catch(() => setBranches([]));
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
      const saved = await savePurchasingBranchEmail(branch.id, email.trim() || null);
      setBranches((current) => current.map((item) => item.id === branch.id ? { ...item, purchasing_email: saved.purchasing_email } : item));
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
          <p>Cut sheets go to the branch that covers the job. If that branch has no address of its own, they go to the company address. A company with no branch areas uses only the company address.</p>
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
