// Opening Intelligence — monthly recognition-accuracy report (Netlify Scheduled Function).
// Runs on the 1st of each month, summarizes the last 30 days of scans, emails the provider.
// Zero dependencies: talks to Supabase REST with the service-role key and to Resend over fetch.
//
// Required Netlify environment variables:
//   SUPABASE_URL            e.g. https://ytqiulxtiharrplqnuir.supabase.co
//   SUPABASE_SERVICE_ROLE   the service_role (secret) key — server-side only, never in the app
//   RESEND_API_KEY          from resend.com
//   REPORT_TO_EMAIL         where the report is sent (e.g. stephan.o@elitesalesconsultants.com)
//   REPORT_FROM_EMAIL       a verified Resend sender (e.g. reports@elitesalesconsultants.com)

export const config = { schedule: "0 13 1 * *" }; // 1st of the month, 13:00 UTC

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const pct = (n, d) => (d ? Math.round((n / d) * 100) + "%" : "—");

async function sbSelect(path) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  const r = await fetch(url + "/rest/v1/" + path, {
    headers: { apikey: key, Authorization: "Bearer " + key, "content-type": "application/json" },
  });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + (await r.text()));
  return r.json();
}

async function sendEmail(subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.REPORT_FROM_EMAIL,
      to: (process.env.REPORT_TO_EMAIL || "").split(",").map((s) => s.trim()).filter(Boolean),
      subject,
      html,
    }),
  });
  if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()));
  return r.json();
}

export default async () => {
  try {
    for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE", "RESEND_API_KEY", "REPORT_TO_EMAIL", "REPORT_FROM_EMAIL"]) {
      if (!process.env[k]) return new Response("Missing env " + k, { status: 500 });
    }
    // window: the previous 30 days
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const rows = await sbSelect(
      "scans?select=confidence,needs_review,true_model,correct,component_class,predicted_model,created_at&created_at=gte." +
        encodeURIComponent(since) + "&order=created_at.desc&limit=5000"
    );

    const total = rows.length;
    const labeled = rows.filter((s) => s.true_model);
    const correct = labeled.filter((s) => s.correct === true).length;
    const review = rows.filter((s) => s.needs_review).length;
    const avgConf = total ? rows.reduce((a, s) => a + (Number(s.confidence) || 0), 0) / total : 0;

    // per-class breakdown
    const byClass = {};
    rows.forEach((s) => {
      const c = s.component_class || "(unclassified)";
      const b = (byClass[c] = byClass[c] || { n: 0, lab: 0, ok: 0, rev: 0, conf: 0 });
      b.n++; b.conf += Number(s.confidence) || 0;
      if (s.needs_review) b.rev++;
      if (s.true_model) { b.lab++; if (s.correct === true) b.ok++; }
    });
    const classRows = Object.keys(byClass).sort((a, b) => byClass[b].n - byClass[a].n).map((c) => {
      const b = byClass[c];
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(c.replace(/_/g, " "))}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${b.n}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${b.lab ? pct(b.ok, b.lab) + " (" + b.ok + "/" + b.lab + ")" : "—"}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${pct(b.rev, b.n)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${Math.round((b.conf / b.n) * 100)}%</td></tr>`;
    }).join("");

    const period = new Date(since).toLocaleDateString() + " – " + new Date().toLocaleDateString();
    const acc = pct(correct, labeled.length);
    const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#1a1f26">
      <h2 style="margin:0 0 2px">Opening Intelligence — Recognition Accuracy</h2>
      <div style="color:#6b7480;font-size:13px;margin-bottom:16px">Monthly report · ${esc(period)}</div>
      <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
        <tr>
          <td style="padding:12px;background:#f5f7fa;border-radius:8px;width:25%;text-align:center"><div style="font-size:22px;font-weight:800">${total}</div><div style="font-size:12px;color:#6b7480">scans</div></td>
          <td style="width:8px"></td>
          <td style="padding:12px;background:#f5f7fa;border-radius:8px;width:25%;text-align:center"><div style="font-size:22px;font-weight:800">${acc}</div><div style="font-size:12px;color:#6b7480">accuracy (${correct}/${labeled.length})</div></td>
          <td style="width:8px"></td>
          <td style="padding:12px;background:#f5f7fa;border-radius:8px;width:25%;text-align:center"><div style="font-size:22px;font-weight:800">${pct(review, total)}</div><div style="font-size:12px;color:#6b7480">flagged for review</div></td>
          <td style="width:8px"></td>
          <td style="padding:12px;background:#f5f7fa;border-radius:8px;width:25%;text-align:center"><div style="font-size:22px;font-weight:800">${Math.round(avgConf * 100)}%</div><div style="font-size:12px;color:#6b7480">avg confidence</div></td>
        </tr>
      </table>
      <h3 style="margin:0 0 6px;font-size:15px">By component type</h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
        <tr style="text-align:left;color:#6b7480;font-size:11px;text-transform:uppercase;letter-spacing:.03em">
          <th style="padding:6px 10px">Type</th><th style="padding:6px 10px;text-align:right">Scans</th>
          <th style="padding:6px 10px;text-align:right">Accuracy</th><th style="padding:6px 10px;text-align:right">Review</th>
          <th style="padding:6px 10px;text-align:right">Avg conf.</th></tr>
        ${classRows || '<tr><td colspan="5" style="padding:10px;color:#6b7480">No scans in this window.</td></tr>'}
      </table>
      <p style="color:#6b7480;font-size:12px;margin-top:18px">Accuracy is measured on scans where a technician confirmed the true model. "Flagged for review" are low-confidence identifications the app asked a human to verify. Generated automatically by Opening Intelligence.</p>
    </div>`;

    await sendEmail("Opening Intelligence — accuracy report (" + period + ")", html);
    return new Response("sent: " + total + " scans, accuracy " + acc, { status: 200 });
  } catch (e) {
    return new Response("error: " + String(e), { status: 500 });
  }
};
