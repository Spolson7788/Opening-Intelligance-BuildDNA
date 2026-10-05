# Bounded staging stability trial

The original recognition preview had audit accounting but no enforceable dollar
limit. The stability trial adds a durable reservation before each provider send.
It is enabled only by Functions-scoped preview configuration and trusted Netlify
`context.deploy.context`; the build-only `CONTEXT` variable cannot authorize it.
The existing API wrapper also verifies the designated staging database.

Each trial binds one existing organization, actor, opening and original image
SHA-256. It admits at most ten distinct request IDs. PostgreSQL locks the trial
row while registering runs, reserving charges and settling them. The cap is at
most 2,000,000 integer micro-dollars ($2), including outstanding reservations.
Requests are restricted to the existing direct Sonnet 4.5 model, standard API
configuration and a 2,500-token maximum output. Input reservations use the full
200,000-token context ceiling at $3 per million input tokens and $15 per million
output tokens. No optimistic token estimate is used.

Explicit validated response usage releases unused reservation amounts. Unknown
usage, interrupted sends and detected abandoned reservations retain their full
ceiling and pause the trial. A later response cannot refund an unknown send.
Insufficient headroom stops the test, even if fewer than ten runs completed.
The migration enables RLS and restricts access to the existing server API role;
it creates no active trial. Production configuration and deployment are unchanged.

Validation: 24 budget tests with real PGlite SQL and mocked provider fetches,
including reservation-before-send, duplicate requests, scope and run limits,
competing reservations, explicit settlement and interrupted responses. PGlite
serializes its one session; this is not a native multi-connection PostgreSQL
concurrency test. The 167 existing recognition release tests and API TypeScript
build also passed. These checks incur no provider charges.

Before live runs: verify the approved replacement preview commit, packaged API,
Functions-scoped trial flags, staging trial row and original image digest. Obtain
normal Netlify and Field App access; retain protection. Record each new run and
attempt against the trial, checking budget state between sequential runs. Never
automatically retry an unknown send. Close the trial after completion and report
completed-run count, stable/variable outcomes and recorded or unknown costs.
