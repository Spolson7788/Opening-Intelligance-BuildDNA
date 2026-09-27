# Isolated release acceptance checkpoint

Observed 2026-09-27, approximately 19:53–19:58 UTC.

Candidate: ef4e0862a835d271e48da85353f72e4f7fd38b92.
Netlify deployment: 6ab96d5680c17b0008818945.
Backend: fdudsigbxumcpbxxxerb.
Origin: https://oi-connected-release-candidate.netlify.app (private).

## Verified against hosted application

- Administrator enrollment succeeded for Stephan Olson. Active organization-scoped admin in Opening Intelligence, organization type customer. This is not a global internal administrator.
- Created SYNTHETIC-QA-RELEASE-CA — not a real facility through Dashboard New Property. State CA, synthetic street address.
- Created SYNTHETIC-QA Building A through the hosted form.
- Created opening SYNTHETIC-QA-RELEASE-PAIR through the hosted form. ID 33da870a-76ed-4a28-a625-7b3beb1a858a, building 5a3ec1d7-f28b-4c7d-9204-d0b4c5f791cf.
- Returning to portfolio loaded one opening with the exact code and synthetic location. Independent read-only database query confirmed the same opening identity.
- The opening is currently a shell. Paired structure, hardware, photographs, service history and completion have NOT been verified or populated by this checkpoint.

## Sign-in blocker

Field App maintains separate authentication state from Dashboard and presented Field Sign-In. A secure browser credential request was submitted by the user. Hosted login returned invalid credentials. Server log for support reference f1400a69-e311-4767-98f7-86a349473346 reported password_mismatch. No password was inspected, stored in this report, reset, or transferred between browser sessions. Dashboard authentication remains intact.

## Outstanding

Field save to Dashboard refresh, real private-photo lifecycle, provider/territory isolation, California defaults, offline/retry acceptance, purchasing guards and final rollback/release reconciliation remain unverified on this backend. Earlier staging evidence is not substituted for these checks. No public cutover performed.
