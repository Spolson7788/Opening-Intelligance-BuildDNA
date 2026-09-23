# Preview service-role verification — 2026-09-23

Migration `restrict_service_writes_to_tech_admin` applied only to isolated Supabase preview `lujfnhvkmllnpxkihhno`.

The recovered policies allowed every facility member, including viewers, to write service records. Thirteen INSERT/UPDATE policies across seven service tables now require `can_write` (admin or tech). Member read policies are unchanged.

Executed `tests/service_write_roles.sql` successfully on the preview. Rollback-only authenticated-role assertions verified:
- tech insertion on all seven tables and updates on the six tables exposing UPDATE;
- viewer reads on all seven tables, insertion rejection on all seven, and no visible UPDATE targets on all six;
- nonmember reads return no records on all seven.

The transient test fixture was rolled back. This is database role simulation, not browser authentication or connected ORG-B record/photo acceptance.

Two normally provisioned preview Auth users were subsequently confirmed present with confirmed email addresses. No credentials were read or changed. Account provisioning is no longer missing; connected browser sign-in, deployment, dataset and required end-to-end evidence remain outstanding.

Production, frozen PR2 and R8 were not changed. Recording readiness remains HOLD.
