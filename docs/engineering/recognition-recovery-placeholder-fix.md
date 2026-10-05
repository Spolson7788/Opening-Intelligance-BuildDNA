# Empty recognition result after timeout — review handoff

Reviewed baseline: 481f3ed106486a07f22ba86ee2739e1d48fb5930.

## Observed failure

The user's screenshot displays Recognition evidence as `{}`, no candidate, and no reference evidence. The latest staging run, 8a38e44a-a987-45ce-945b-d81868e32d6f, started 2026-10-05 14:06:26 UTC and completed with status reference_evidence, a single-reader LCN 4040XP candidate, four citations, and analysis_elapsed_ms 30743. The screenshot contains no run ID, so correlation uses timing and the selected Installed 3.png photograph rather than a browser network trace.

## Cause and correction

The recovery endpoint returned a persisted running row as HTTP 200, including its initial empty suggestion. The browser validator accepted any object, including `{}`, with any string status. This permits timeout recovery to display an unfinished placeholder as a completed result even though the server subsequently saves useful evidence.

- A running row now returns HTTP 202 awaiting_saved_result, without run_id or suggestion, so the existing bounded polling loop continues.
- A failed row returns HTTP 502 recognition_provider_failed.
- An empty or malformed terminal suggestion returns HTTP 502 recognition_result_missing.
- The browser independently rejects empty suggestions and running/failed/awaiting statuses.
- Actor, organization, opening and request scoping remain unchanged. Recovery does not invoke AI again.

## Validation

153/153 recognition release tests across 11 files passed. Added a running-placeholder followed by completed-candidate regression and failed/empty terminal rejection. Client checks now cover empty objects and noncompleted statuses. API TypeScript and Field App production builds passed; git diff --check passed. No paid provider requests or hosted data mutations were made.

## Limits

This fixes result recovery, not OCR accuracy. The saved 4040XP candidate remains single-reader evidence, not independently confirmed identity. The screenshot cannot prove the precise network sequence; the race is directly reproduced by the endpoint regression. P1–P3/N1–N7 were independently reviewed at the baseline. This narrow follow-up needs independent review; no production deployment or full-suite claim.
