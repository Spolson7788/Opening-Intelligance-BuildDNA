# OS3 branch defaults and hosted acceptance checkpoint — 2026-09-26

Status: engineering deployed to protected nonproduction; full acceptance and recording release remain HELD.

## Source and deployment

- Branch-default application commit: 1704061949c02d4a9e0005595d9df4f1e7029d5a; tree e1dc3a315bbc0b95f61e8e41b87c9ce5725414c5.
- Live application verification: immutable Netlify deploy 6ab80e64d904e20008f8bf1a.
- Subsequent migration/evidence build commit: f99fd884746a39e63fb7f8d2385be1774c5ad717; tree 7a47fbf494e64e4e4f7819aac3070495e43173bd.
- Evidence build: 6ab8114a2ecf42000807cd55, ready, deploy-preview, published_at null.
- Both builds report the same API package digest: 8d95b3f7827e2a788191f2e8e8c2f583e811939fab08e719681bd8262263489e.
- Both report photo-deletion-retry digest: 3a91232e0f5f7d5c98fa9b02c9d0a875db29e8463ebaf1e7bc975f8734e2eb01.
- PR9 remains unmerged. Production unchanged.

## Implemented

Company administrators can create/update/deactivate branches and assign current company users through /field/branches. Server checks the administrator's current role and company, and rejects foreign users/branches. Defaults come from an active branch; existing personal preferences are fallback only. Geographic filters never grant facility access. The setup page clears prior account data and ignores obsolete asynchronous responses when the principal changes.

Migrations 20260926182106_company_branch_defaults.sql and 20260926183557_api_branch_provider_privileges.sql applied to staging project ioqfdcehnhnqpnqawwvo. The first live attempt exposed omitted grants for the restricted oi_pr2_api database role, including the earlier provider/purchasing tables. The second migration fixes the omission using the existing trusted-server RLS model. Public/client grants remain revoked on all four tables. Security advisor now reports no findings.

The build writes deployment-evidence.json with SHA-256 and byte counts from its actual generated output, before Netlify HTML injection. This is not a substitute for verifying fetched/loaded artifact bytes.

## Verified live

Account stephan.o@elitesalesconsultants.com, active admin, organization OI Staging Test. No role was changed. Personal home_state/home_territory remain null.

Created synthetic branch 271307ad-388f-4830-bb7a-7a614d00fbbb, name SYNTHETIC QA — California branch, defaults CA / QA West. Assigned only the existing staging recording account. This is an actual branch assignment, not a manually filled personal preference.

- Branch and assignment saves completed through hosted UI.
- Facility selector initially loads CA / QA West; one California facility.
- FL / QA West gives zero results; FL / QA East gives one Florida facility.
- Reload restores CA / QA West.
- Dashboard shares the authenticated session and also starts with CA / QA West.
- SYNTHETIC-QA-20260926-PAIR loads one frame, two leaves and separate closers, plus the saved synthetic service event.
- Active closer model saved through Field App as QA-ACTIVE-CLOSER-DEMO-UPDATED, then displayed on Dashboard after explicit Refresh saved records.
- Restored QA-ACTIVE-CLOSER-SYNC-VERIFIED through Field App; Dashboard refresh showed restoration in 1,445 ms measured in one browser action sequence. This is one observation, not an SLA or automatic synchronization claim.
- Purchasing review refuses this unassessed opening, excludes both nonreplacement components and states nothing is sent or ordered.

## Local verification

- Five API/PGlite tests across branch defaults, restricted API role, territory search, provider assignment and purchasing passed. Include positive/negative tenant checks, role change, branch deactivation, identity/document gates and request-level refusal.
- 27 offline model/database/flush/cache tests passed. These do not constitute hosted network-interruption acceptance.
- Eight protected-staging context tests passed.
- API and Field App builds pass.
- Mobile facility selector controlled-API browser test passes. Its mocked API is explicitly not hosted proof.

## Remaining blockers — not passes

1. No approved real component photograph retrieved. Existing image is a synthetic QA placard. Two downloads of the approved integration archive and an alternate preview archive failed HTTP 502; exact-photo search found no Dropbox or default-branch GitHub copy. Do not substitute a spec sheet, generated image or QA placard. Required original: OP1_closer_whole.jpg, 23,282 bytes, approved SHA-256 23d95b0541cefaeb040fedc028eb2227d72b0038904fe8ec1d8526d5d4c00efb.
2. Retrieval of the protected deployment-evidence.json in the cloud browser was rejected by browser security policy. No workaround attempted. Manifest contents/deployed frontend hashes are not independently verified here.
3. Hosted two-company technician sessions, revocation/private-photo denial, account switching and interrupted upload/response-loss recovery remain unexecuted. Only the administrator session is authenticated in the current immutable app. Available browser controls do not expose network interruption. Local tests remain supporting evidence only.
4. Full purchasing acceptance still needs the hosted eligible, unresolved-document and mixed-request cases; only the incomplete-opening refusal was exercised live in this session.

## Next authorized work

Retrieve the exact approved photo, attach it to active closer a2700d66-f640-47a2-bfd9-298c3414680e and verify it in both clients. Obtain the actual deployment manifest and compare hosted assets. Run the outstanding acceptance matrix using a protected authenticated test runner with two synthetic company technician accounts and controllable networking. Then release one immutable recording candidate. No further production authorization is implied.

Rollback: revert the protected preview to prior application artifact; retain additive data tables. Unassign/deactivate the synthetic branch through the administrator UI if reverting defaults. No destructive rollback or production action performed.
