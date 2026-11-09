// Keep field-app/src/guide/howToUse.tsx and dashboard/src/guide/howToUse.tsx identical.
import { useEffect, type CSSProperties } from "react";

export const GUIDE_VERSION = "2026-11-08";
export const GUIDE_DATE = "8 November 2026";

export type GuideAudience = "field" | "facility";

export type GuideSection = { id: string; title: string; paragraphs: string[] };

export const FIELD_SECTIONS: GuideSection[] = [
  {
    id: "field-start",
    title: "Start here",
    paragraphs: [
      "Open How to Use from the sign-in screen or from Scan before you fill in a long form. Leaving a form you have not saved can drop what you typed. Printing stays on this page.",
      "A normal first visit: sign in, choose the facility, scan the door label or type the opening code, then record hardware, an inspection, or a purchasing send from that door.",
    ],
  },
  {
    id: "field-signin",
    title: "Sign in and access",
    paragraphs: [
      "Use the email and password your company gave you. Forgot password sends a reset link only when you have a connection. Some staff accounts also ask for a 6-digit code from email. Wait about a minute before asking for another code. The code expires in 10 minutes.",
      "This site is private. If the phone says access needs renewal, use Renew private site access and sign in again. That is separate from your Opening Intelligence password.",
      "The field app and the facility dashboard are different sign-in screens. There is no switch that jumps you from one to the other while keeping the same page.",
    ],
  },
  {
    id: "field-doors",
    title: "Facilities and doors",
    paragraphs: [
      "After sign-in, confirm the state, county, and facility before Scan. Continue confirms the location, including a last-used facility. A door link opens that door after sign-in and does not ask again. Looking up an opening needs a connection. A QR label does not by itself let you in.",
      "Scan the door label, or type the opening code from the tag. From the opening you can add hardware, edit hardware, log a service event, or log an inspection, when your role allows it.",
      "Viewers can look. Inspectors record inspections, photos, and service requests, and they can send to purchasing. They do not add or edit hardware. Technicians also add and edit hardware. Facility managers and admins do the office setup on the dashboard. The door page may show a health score out of 100. That number is a summary. It is not a test you run.",
    ],
  },
  {
    id: "field-photos",
    title: "Photos",
    paragraphs: [
      "Take a clear photo of the part you are recording. For a fire door failure, each failed item needs a note and a photo. The phone prepares the photo before it is saved. If it cannot, retake the photo.",
      "A photo that is too large to sync stays on the phone under Synchronization review. You can make a smaller copy or remove it from this phone. Removing it does not change the server.",
    ],
  },
  {
    id: "field-identify",
    title: "Identify hardware",
    paragraphs: [
      "Identify hardware appears on an opening only when your company has turned that tool on. Technicians, facility managers, and admins can use it. Inspectors and viewers do not save hardware with it. It is a helper, not a guarantee.",
      "Add 3 to 9 photographs, then tap Done. You get a short list with a confidence note. Read the stamp and the photos yourself. Edit the type, manufacturer, model, and finish, uncheck anything you do not want, then tap Save hardware. If nothing was identified, nothing is saved.",
    ],
  },
  {
    id: "field-sync",
    title: "Saving and sync",
    paragraphs: [
      "Save stores the work on this phone immediately, even with no signal. The badge shows when a change is still waiting to sync. Sync sends it when you are online.",
      "Synchronization review lists anything that did not sync. Retry asks the server again. Discard this saved change removes that item from this phone only, after you confirm. It does not delete a record that already reached the server. A permanent failure will not succeed just by waiting.",
    ],
  },
  {
    id: "field-inspection",
    title: "Fire door inspection",
    paragraphs: [
      "Log Inspection, choose Fire Door (NFPA 80), and answer every item. That name is the inspection type in the app. Sign with your finger, and enter your name, qualification, and license number. A signature is required. Other inspection types ask for a result and a signature, and they do not use this item list.",
      "N/A is offered only on items that can be not applicable, such as glazing when the door has none. N/A does not mean Pass. Marking N/A does not clear an older failure. An inspection that is all N/A is not a pass.",
      "A later inspection clears an older failure only when you mark that same item Pass. Fail still needs a note and a photo. This guide does not replace fire door inspector training or the standard itself.",
    ],
  },
  {
    id: "field-email",
    title: "Email the inspection report",
    paragraphs: [
      "After a fire door inspection is saved, email is offered only once the record has synced. You need a connection. The app says when it is still syncing.",
      "The message starts with the facility contact, when one is on file, and the email of the person who signed. You can edit the list. The facility person opens the dashboard link, signs in, and can download the PDF or save it to facility records. Email from the field does not itself file the PDF on the facility record.",
    ],
  },
  {
    id: "field-purchasing",
    title: "Send to purchasing",
    paragraphs: [
      "On the hardware page, Send to purchasing shows the branch and the address before you send. If the branch has no address of its own, the company address is used and the screen says so.",
      "If more than one branch covers the job, choose the branch. If no branch covers the job, sending stays off. Your own home branch is not used when it is not the branch for this job.",
      "Attach a PDF from Files or Downloads, or take a photo of the sheet. Sending needs a connection. A file that is empty, too large, or not a PDF or photo is refused with a reason.",
    ],
  },
];

export const FACILITY_SECTIONS: GuideSection[] = [
  {
    id: "facility-start",
    title: "Start here",
    paragraphs: [
      "The dashboard is the office view. Sign in, open a facility, then open a door. How to Use is in the sidebar and on the sign-in screen.",
      "Printing uses the browser. On a computer, choose Print this guide, then Save as PDF. This site does not download a separate PDF file for the guide.",
    ],
  },
  {
    id: "facility-signin",
    title: "Sign in and roles",
    paragraphs: [
      "Use Forgot password when you cannot sign in. A reset email needs a connection. Some accounts also ask for an emailed code.",
      "Viewers can look and not change records. Inspectors and technicians do the field work. Facility managers and admins set purchasing email, coverage, and schedules. Team setup stays with admins. You only see facilities your company is allowed to see.",
    ],
  },
  {
    id: "facility-records",
    title: "Doors and records",
    paragraphs: [
      "All openings is the list of doors. Open one to see hardware, photos, service history, and inspection history. Photos taken in the field appear after they sync. An inspection failure photo is labeled as such.",
      "A health score, when one is shown, is a number on the opening and in the openings list. It is a summary. It is not a test, and it is not a certification.",
    ],
  },
  {
    id: "facility-reports",
    title: "Inspection reports",
    paragraphs: [
      "A fire door inspection card shows the date, result, inspector, and signature. Download PDF saves the report. Save to facility records stores that PDF on the door so it can be opened again. Saving twice does not create a second copy.",
      "Those buttons are for facility managers and admins on a completed fire door inspection. The email from the field is a separate step and needs the recipient to sign in.",
    ],
  },
  {
    id: "facility-purchasing",
    title: "Purchasing email",
    paragraphs: [
      "Purchasing email is in the sidebar for facility managers and admins. Set the company address, and a branch address when that branch has its own purchasing staff.",
      "A job is sent to the branch whose area covers the facility. If that branch has no address, the company address is used. If several branches cover the job, the technician must choose. If none do, the send is blocked. Leave a branch blank to keep using the company address.",
    ],
  },
  {
    id: "facility-coverage",
    title: "State, county, and providers",
    paragraphs: [
      "State and county is in the sidebar for facility managers and admins. Either of those roles can set a facility's state and county. An administrator adds the states or counties a branch covers, and sets a technician's own area. Leave the county unset on a branch to cover a whole state.",
      "Assign provider is for an administrator. It is refused when that company does not cover the facility's state and county. A technician area changes where that technician works. It does not choose the purchasing address.",
    ],
  },
  {
    id: "facility-field",
    title: "What the field visit does",
    paragraphs: [
      "Technicians can save on the phone with no signal. Those entries stay on the phone until sync. The dashboard shows them after they arrive.",
      "Emailing a report and sending to purchasing both need a connection. They are not stored to send later.",
    ],
  },
];

export function guideSections(audience: GuideAudience): GuideSection[] {
  return audience === "field" ? FIELD_SECTIONS : FACILITY_SECTIONS;
}

const printCss = `
  .how-to-use { max-width: 40rem; }
  .how-to-use a { color: inherit; }
  .how-to-use details { border-top: 1px solid #d5dee8; padding: 8px 0; }
  .how-to-use summary { font-weight: 700; cursor: pointer; min-height: 44px; display: flex; align-items: center; }
  .how-to-use .toc { padding-left: 1.1rem; }
  @media print {
    .no-print, aside[aria-label="Current account"] { display: none !important; }
    .how-to-use, .how-to-use details, .how-to-use details > *, .how-to-use details::details-content { display: block !important; content-visibility: visible !important; }
    .how-to-use summary { list-style: none; }
    .how-to-use details { break-inside: avoid; page-break-inside: avoid; }
    .how-to-use h2 { break-before: page; page-break-before: always; }
    .how-to-use h2.guide-first { break-before: auto; page-break-before: auto; }
    body { background: #fff; color: #000; }
  }
`;

export function HowToUse({
  audience,
  onAudience,
  onBack,
}: {
  audience: GuideAudience;
  onAudience: (audience: GuideAudience) => void;
  onBack?: () => void;
}) {
  useEffect(() => {
    const nodes = () => [...document.querySelectorAll(".how-to-use details")] as HTMLDetailsElement[];
    function openAll() {
      nodes().forEach((details) => {
        details.dataset.printWasOpen = details.open ? "1" : "0";
        details.open = true;
      });
    }
    function restore() {
      nodes().forEach((details) => {
        if (details.dataset.printWasOpen === "0") details.open = false;
      });
    }
    window.addEventListener("beforeprint", openAll);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", openAll);
      window.removeEventListener("afterprint", restore);
    };
  }, [audience]);
  const sections = guideSections(audience);
  const title = audience === "field" ? "Technicians and inspectors" : "Facility staff";
  const backStyle: CSSProperties = { width: "auto", minHeight: 44, marginBottom: 12 };
  return (
    <article className="how-to-use screen">
      <style>{printCss}</style>
      <p className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {onBack && <button type="button" className="btn btn-secondary" style={backStyle} onClick={onBack}>Back</button>}
        <button type="button" className="btn btn-secondary" style={backStyle} onClick={() => window.print()}>Print this guide</button>
      </p>
      <h1>How to use</h1>
      <p>Guide version {GUIDE_VERSION}, {GUIDE_DATE}. {title}.</p>
      <p className="no-print">On a computer, Print this guide, then choose Save as PDF. On iPhone Safari, use the Share button, then Print. Save a PDF from the print preview if your phone offers it. This app does not create the guide PDF itself. Open this page before you fill in a form you have not saved.</p>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <button type="button" className="btn btn-secondary" style={backStyle} aria-pressed={audience === "field"} onClick={() => onAudience("field")}>Technicians and inspectors</button>
        <button type="button" className="btn btn-secondary" style={backStyle} aria-pressed={audience === "facility"} onClick={() => onAudience("facility")}>Facility staff</button>
      </div>
      <nav aria-label="Guide contents">
        <h2 className="guide-first" style={{ fontSize: 18 }}>Contents</h2>
        <ol className="toc">
          {sections.map((section) => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}
        </ol>
      </nav>
      {sections.map((section) => (
        <details key={section.id} id={section.id}>
          <summary>{section.title}</summary>
          {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </details>
      ))}
    </article>
  );
}
