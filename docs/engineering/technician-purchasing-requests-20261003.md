# Technician requests for purchasing department review

A field technician sends a product request to the service provider's purchasing
department. The purchasing department performs the second verification and
authorizes purchases. Platform administrators do not approve individual requests.

The opening page now prepares an email after the technician supplies the
purchasing address and acknowledges reviewing the selection. Request readiness
retains completed-opening, reviewed-component, verified-condition and established
identity checks. It does not require individual owner-admin document approval.
Existing owner approval and purchasing eligibility endpoints retain their
previous meaning; request preparation uses its separate review mode.

Request snapshots and acknowledgments are stored transactionally in the existing
audit log. Request IDs are idempotent and scoped to the organization and actor.
Access to the opening is rechecked on preparation, history and send confirmation.
Changed product selections require a new draft. Anonymous users, viewers,
inspectors, other organizations and revoked providers cannot submit.

The email draft contains product selections and available approved manufacturer
source links. Photos remain private; the technician attaches relevant photos in
their email client. Opening a mailto draft is not evidence of sending. The app
records submitted status only after explicit technician confirmation, labeled
as technician-reported delivery. No automatic email transport, purchase
authorization, ordering or purchasing-department approval is implied.

Validation covers missing acknowledgment, technician submission without owner
approval, idempotency, changed identity, other-tenant access, send confirmation,
and existing purchasing and provider boundaries. No database schema or public
data grants are added.
