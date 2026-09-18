// Opening Intelligence — overdue fire-door inspection notifier (Netlify Scheduled Function).
// Runs monthly. Finds fire-rated openings with no NFPA 80 inspection in the last 12 months
// (or never inspected) and emails the provider a digest grouped by facility.
// Zero dependencies: Supabase REST (service-role key) + Resend over fetch.
//
// Required Netlify environment variables (same set as monthly-accuracy):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE, RESEND_API_KEY, REPORT_TO_EMAIL, REPORT_FROM_EMAIL

export const config = { schedule: "0 13 1 * *" }; // 1st of the month, 13:00 UTC

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

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
    // all fire-rated openings, with facility name embedded
    const fire = await sbSelect(
      "openings?fire_rated=eq.true&select=facility_id,opening_no,area,facilities(name)&limit=10000"
    );
    // last inspection date per opening (view created in inspections_setup.sql)
    const insp = await sbSelect("opening_last_inspection?select=facility_id,opening_no,last_inspected_at&limit=10000");
    const lastMap = {};
    insp.forEach((r) => { lastMap[r.facility_id + "|" + r.opening_no] = r.last_inspected_at; });

    // dedupe openings (an opening has one row per part) and evaluate overdue
    const seen = {};
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const overdue = [];
    fire.forEach((o) => {
      const k = o.facility_id + "|" + o.opening_no;
      if (seen[k]) return; seen[k] = 1;
      const last = lastMap[k];
      let state = null;
      if (!last) state = "never";
      else if (new Date(last + "T00:00:00") < cutoff) state = "overdue";
      if (state) overdue.push({
        facility: (o.facilities && o.facilities.name) || "Unassigned",
        opening: o.opening_no, area: o.area || "", last, state,
      });
    });

    if (!overdue.length) return new Response("no overdue fire-door inspections", { status: 200 });

    // group by facility
    const byFac = {};
    overdue.forEach((o) => { (byFac[o.facility] = byFac[o.facility] || []).push(o); });
    const sections = Object.keys(byFac).sort().map((f) => {
      const rows = byFac[f].sort((a, b) => (a.opening > b.opening ? 1 : -1)).map((o) => `
        <tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(o.opening)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(o.area)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee">${o.state === "never" ? '<span style="color:#8f2020;font-weight:700">Never inspected</span>' : '<span style="color:#8a4b06;font-weight:700">Last ' + new Date(o.last + "T00:00:00").toLocaleDateString() + "</span>"}</td></tr>`).join("");
      return `<h3 style="margin:16px 0 4px;font-size:15px">${esc(f)} <span style="color:#8f2020">(${byFac[f].length})</span></h3>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <tr style="text-align:left;color:#6b7480;font-size:11px;text-transform:uppercase;letter-spacing:.03em">
            <th style="padding:6px 10px">Opening</th><th style="padding:6px 10px">Area</th><th style="padding:6px 10px">Status</th></tr>
          ${rows}</table>`;
    }).join("");

    const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#1a1f26">
      <h2 style="margin:0 0 2px">Fire-Door Inspections Due</h2>
      <div style="color:#6b7480;font-size:13px;margin-bottom:12px">NFPA 80 requires annual inspection of fire-rated openings. As of ${new Date().toLocaleDateString()}, <b style="color:#8f2020">${overdue.length}</b> opening${overdue.length === 1 ? "" : "s"} across ${Object.keys(byFac).length} facilit${Object.keys(byFac).length === 1 ? "y" : "ies"} ${overdue.length === 1 ? "is" : "are"} due.</div>
      ${sections}
      <p style="color:#6b7480;font-size:12px;margin-top:18px">Schedule these inspections in the field app (Fire door inspection · NFPA 80). Generated automatically by Opening Intelligence.</p>
    </div>`;

    await sendEmail("Fire-door inspections due — " + overdue.length + " opening" + (overdue.length === 1 ? "" : "s"), html);
    return new Response("sent: " + overdue.length + " overdue openings", { status: 200 });
  } catch (e) {
    return new Response("error: " + String(e), { status: 500 });
  }
};
