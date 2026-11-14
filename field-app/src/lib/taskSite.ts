import { fetchInspectionVisit, fetchOpenInspectionVisit } from "./api";
import { putOfflineSetting, loadAuth } from "./db";
import { selectedFacilityKey } from "./facilitySync";
import { writeLocationConfirmation } from "./locationChoice";
import { ensureOpenVisit, reconcileOpenVisit } from "./inspectionVisit";

/** Pick this site and keep at most one open visit for this person here. */
export async function selectTaskSite(propertyId: string) {
  const auth = await loadAuth();
  if (!auth) throw new Error("Sign in again before choosing a site.");
  await putOfflineSetting({ key: selectedFacilityKey(auth), value: propertyId, updatedAt: new Date().toISOString() });
  writeLocationConfirmation(sessionStorage, auth, propertyId);
  await reconcileOpenVisit((id) => fetchInspectionVisit(id), fetchOpenInspectionVisit);
  await ensureOpenVisit(fetchOpenInspectionVisit);
}
