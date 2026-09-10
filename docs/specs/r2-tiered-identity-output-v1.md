# R2 — TIERED IDENTITY OUTPUT SPECIFICATION v1

Status: DRAFT FOR ENGINEERING REVIEW.

Authoritative working copy supplied under task R2-SPEC-001. Full specification is being reviewed under OI-004. Do not implement numeric confidence thresholds as frozen constants until human/domain sign-off and benchmark calibration.

## Governing principle
A tier is populated only by affirmative discriminating evidence for that tier. Absence of conflicting evidence never promotes identity.

## Engineering integration gate
R2 must not ship on top of an unrepaired R1 contract. It governs match(), run(), applyVision(), sendToPurchasing(), and the vision proxy contract.

## Required identity tiers
- manufacturer
- platform/family
- model
- configuration axes
- SKU

Required explicit non-answer states include CANDIDATES, INSUFFICIENT_EVIDENCE, BLOCKED_BY_INCOMPLETE_SIBLING_SET, BLOCKED_BY_PROVISIONAL_TAXONOMY, CONFLICT, and NOT_APPLICABLE.

## QA constraints
- ESTABLISHED requires affirmative evidence.
- Lower tiers require upper tiers established, except separate component self-identity claims.
- Controlled/synthetic/reference imagery is not independent blind validation.
- All views of one physical unit are one physical_case_id and one IdentityClaim.
- Conflicting admissible evidence halts escalation.
- Purchasing requires an established model or explicit USER_ASSERTED override with actual recognition state attached.
- Metrics are per tier; no blended accuracy metric.

## Review status
Structural approach accepted for engineering review. Numeric confidence thresholds and the four domain-policy questions remain provisional pending OI-004 review and human/domain decisions.

See OI-004 for review findings, decisions, and implementation handoff. The complete source specification supplied by Claude must be preserved in the project evidence/specification archive during OI-001 synchronization.