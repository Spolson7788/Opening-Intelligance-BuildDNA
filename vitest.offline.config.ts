import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      JWT_SECRET: "offline-hosting-smoke-test-only",
      CORS_ORIGINS: "",
    },
    include: ["tests/accountRecovery.test.ts","tests/loginForm.test.ts","tests/loginDiagnostics.test.ts","tests/mediaAssociationLabel.test.ts","tests/authAvailability.test.ts","tests/openingLoadFailure.test.ts","tests/openingCacheAccess.test.ts","tests/openingQr.test.ts", "tests/openingCompletionRequirements.test.ts", "tests/offlineSyncModel.test.ts", "tests/offlineDb.test.ts", "tests/offlineDependencies.test.ts", "tests/offlineFlushRecovery.test.ts", "tests/syncIssuesModel.test.ts", "tests/photoSizeRecovery.test.ts", "tests/principalChangeRecovery.test.ts", "tests/serviceHistoryModel.test.ts", "tests/storageVerification.test.ts", "tests/netlifyHosting.test.ts", "tests/photoDeletionDeployment.test.ts", "tests/facilitySchedules.test.ts", "tests/inspectorPermissions.test.ts", "tests/scheduleParsing.test.ts", "tests/scheduleImports.test.ts", "tests/scheduleImportsConfirmLock.test.ts", "tests/scheduleImportsConfirmBatch.test.ts", "tests/dashboardUiRound.test.ts", "tests/dashboardSessionExpiry.test.ts", "tests/scheduleKindCorrection.test.ts", "tests/scheduleKindCorrectionUi.test.ts", "tests/scheduleComparison.test.ts", "tests/scheduleComparisonUi.test.ts", "tests/scheduleComparisonFieldSync.test.ts", "tests/fieldFacilityDownload.test.ts", "tests/memberOnboarding.test.ts", "tests/memberOnboardingUi.test.ts", "tests/fieldLoginSiteAccess.test.ts", "tests/legacyRegisterRetired.test.ts", "tests/dashboardSiteAccess.test.ts", "tests/providerHistorySharing.test.ts", "tests/providerSharingHealth.test.ts", "tests/facilityAreaAndPublicQr.test.ts", "tests/c2Lockdown.test.ts", "tests/c3Migrations.test.ts", "tests/c3RevokePublicAccess.test.ts", "tests/multiOrgHierarchy.test.ts", "tests/multiCompanyM1.test.ts"],
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
