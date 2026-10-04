# Recognition preview configuration

Photograph recognition requires an explicit server-side release switch and an existing Anthropic provider key. Manufacturer reference comparison has a separate switch.

Set these nonsecret switches in Netlify's environment variable settings with the Functions scope. Values are case-sensitive strings.

| Variable | Deploy Previews | Production and other contexts |
| --- | --- | --- |
| `OI_RECOGNITION_ENABLED` | `true` | `false` |
| `OI_REFERENCE_COMPARISON_ENABLED` | `true` | `false` or unset |

Preserve the existing server-only `ANTHROPIC_API_KEY`; never copy it to browser code, documentation, or chat. A configured key's presence does not verify that the provider accepts it.

Create a new preview deployment after saving environment changes. Existing deployments retain the environment captured when deployed. Do not deploy the production branch to refresh a pull-request preview.

The authenticated `/api/recognition/availability` endpoint reports only configuration presence and release-switch status. It does not call the provider or return credentials. The Field App checks it before accepting an analysis request. Runtime provider and evidence-recording failures have separate safe error messages.

A successful preview deployment is not proof of a successful recognition run. Verify an authorized photograph request, persisted evidence, and any returned reference citations separately. Suggestions require technician review and do not authorize purchases.

## Provider failure checks

When `recognition_provider_authentication_failed` is returned, verify the server credential in the provider account. App sign-in credentials and reference documents do not resolve provider authentication. If no project-level `ANTHROPIC_API_KEY` variable is listed, add a secret variable with the Functions scope and the intended preview context. Enter the full provider key directly in Netlify; never use a shortened key displayed in an account listing.

After a credential update, create a new preview deployment before retesting. A provider authentication failure, billing block, request rejection, timeout, or unavailable model has a distinct safe error category. Do not forward raw provider messages, tokens, or response bodies to the client.
