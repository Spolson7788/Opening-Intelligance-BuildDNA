# Manufacturer reference evidence candidate

Recognition retrieves reviewed, citable manufacturer pages and retains validated citations in a recognition run. The Field App and Facility Dashboard expose the saved evidence. Draft, duplicate, superseded and quarantined pages do not supply identification citations. Human identity review and purchasing approval remain separate.

Local verification: 67 targeted SQL/API regression tests, 8 manifest tests, API and Field App builds, Dashboard generation, and importer asset preflight passed. These use recorded provider fixtures; they are not live field or recognition-accuracy evidence.

The audited source CSV is kept byte-for-byte through Git checkouts. Document import does not approve documents. Reference comparison requires its own explicit enable switch. Configuration, approval and connected acceptance remain separate deployment work.

Internal environment, project and account details are retained in the private review package and are intentionally omitted from this public summary.

The public branch contains code and synthetic SQL fixtures. The audited catalog, original documents and derived page text remain private inputs. Set OI_REFERENCE_TEST_MANIFEST_DIR and OI_REFERENCE_MANIFEST_DIR to a private manifest folder when reproducing corpus tests. Native CI fixture passes do not constitute manufacturer-document approval or live field acceptance. Import and approval capabilities are separate; the importer cannot set approval fields or delete reference documents.
