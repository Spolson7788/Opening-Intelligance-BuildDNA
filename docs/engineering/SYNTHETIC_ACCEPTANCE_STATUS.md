# Synthetic hosted acceptance setup — 26 September 2026

Status: **NOT READY FOR PRODUCTION; hosted acceptance incomplete.**

## Completed in staging

Applied `synthetic-acceptance-fixtures.sql` once to Supabase project `ioqfdcehnhnqpnqawwvo`, then queried all four opening/component records back. The associated JSON contains the exact IDs. The transaction creates a separate labelled synthetic portfolio, facility, building, four single-leaf openings, frames, leaves and closers. It grants only that new facility to the existing staging Alpha company. Existing recording facilities, records, accounts, roles and credentials were unchanged.

The cases cover an intended eligible replacement, unresolved identity/document, incomplete opening and all-serviceable opening. **The intended eligible case has no document approval yet and must still refuse purchasing.** No invented approval URL or hash was inserted. A controlled synthetic document and its verified hash are still needed before testing the positive case.

The new facility is `1df79d1f-d01d-441a-835c-86680f8e9da7`. The test opening code is `SYNTHETIC-ACCEPTANCE-20260926-ELIGIBLE` and its component is `9de994e0-7147-4fa7-9b41-b48df8b74f56`. No photo has been uploaded to this disposable opening yet. The approved recording photograph remains associated with the original paired recording opening.

## Deployment metadata

Netlify's deployment reader confirmed:

- Deploy: `6ab820150d641600080e815f`
- Commit: `2dfc79d862fd90faf12d7866c480d8e4e58d1e23`
- Context: `deploy-preview`
- State: `ready`
- Published: null (not production)

This is deployment metadata, not a verification of frontend artifact bytes or a hosted acceptance pass.

## Actual blocker

On the new preview, the Field App displayed its email/password sign-in form. The secure credential handoff returned `submission_failed`. The required follow-up accessibility check was rejected by automatic browser security review as an unapproved retry. No further attempt, alternate browser, token extraction or authentication bypass was made. Sign-in success is unknown; no technician acceptance claim can be made.

The older preview also displayed `Not Found` for the new opening despite the database read-back confirming it exists. Its session was not reauthenticated during this attempt; this is not evidence of a missing database record or a proven authorization defect.

## Remaining execution

1. Restore an authorized technician browser session through supported sign-in; verify both staging technician roles and company inventories.
2. Upload the approved image through the authenticated app to the disposable component, then pin its real private-photo ID.
3. Add a genuine controlled synthetic purchasing document and verified hash to the synthetic approval only; exercise eligible, unresolved, incomplete, mixed and serviceable cases.
4. Execute the prepared bounded runner with real IDs, including offline queue/retry, lost confirmation, revocation and account switching. Report failures rather than substituting local results.
5. Complete separately listed service-worker restart, in-flight account-switch and partial upload tests, and obtain deployment artifact hash evidence through an authorized route.

Do not run the seed SQL again: it is a one-time transaction and intentionally has no overwrite/upsert behavior. Do not use these software test approvals or conditions as product/manufacturer claims or video evidence.

## Follow-up after manual sign-in

Manual sign-in succeeded on deploy `6ab820150d641600080e815f`. Company branch controls identified Stephan Olson (`stephan.o@elitesalesconsultants.com`) as **admin**, with the synthetic California branch selected. This was not a technician session and does not satisfy technician isolation acceptance.

Observed through the hosted UI:
- Field App opened with CA / QA West defaults; changing territory to QA Acceptance exposed the separate disposable facility.
- The intended eligible opening loaded successfully.
- Uploaded `OP1_closer_whole.jpg` using that closer's file input. UI returned Synced and the thumbnail loaded at 503 pixels natural width. Database read-back confirms photo `ad653bf1-66a9-4a6f-9e2c-3db8e9a92a11` belongs to component `9de994e0-7147-4fa7-9b41-b48df8b74f56` on the disposable opening.
- Dashboard reused the same authenticated session, restored CA / QA West defaults and displayed the disposable facility after selecting QA Acceptance.
- Hosted purchasing review of all four openings reported requirements unresolved, named the incomplete opening, unresolved identity and missing approvals, and excluded the serviceable closer. It displayed “Review only — nothing is sent or ordered.” This proves the mixed rejection case only; positive eligibility remains untested.

Two presentation corrections arose from this check: saved frames with null material were labelled “not saved”, and component photographs were labelled “Opening photo”. The patch checks frame existence separately and derives photograph labels/captions from stored component/leaf identity, including tracker ID for identical hardware. Three pure tests passed for paired hardware distinction, unavailable targets and queued association. Field App production build passed. These changes are not yet included in the preview used for the above observations.

The earlier browser blocker is superseded for the administrator session only. Test technician A/B sign-in and offline recovery execution remain outstanding.
