import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { LocationProvider, useLocations } from "./lib/LocationContext";
import { CreateLocationPicker } from "./components/LocationBar";
import { Sidebar } from "./components/Sidebar";

/** M3: create/import pages only open for ONE specific location (the active company). */
function RequireOneLocation({ children }: { children: React.ReactElement }) {
  const { combined, setFilter } = useLocations();
  if (!combined) return children;
  return (
    <div className="app-shell"><Sidebar /><div className="main"><div className="panel">
      <h2>Choose one location</h2>
      <p>New records are always added to one specific location. Choose where this should go.</p>
      <CreateLocationPicker onChosen={() => {}} />
      <p><button className="btn btn-secondary" onClick={() => setFilter({ kind: "company" })}>Use the current company</button></p>
    </div></div></div>
  );
}
import { LoginPage } from "./pages/LoginPage";
import { ForgotPasswordPage, ResetPasswordPage } from "./pages/PasswordResetPages";
import { DashboardPage } from "./pages/DashboardPage";
import { FacilitySchedulesPage } from "./pages/FacilitySchedulesPage";
import { ScheduleImportPage, ScheduleImportStartPage } from "./pages/ScheduleImportPage";
import { ScheduleComparisonPage } from "./pages/ScheduleComparisonPage";
import { ScheduleComparisonsPage } from "./pages/ScheduleComparisonsPage";
import { OpeningDetailPage } from "./pages/OpeningDetailPage";
import { NewPropertyPage } from "./pages/NewPropertyPage";
import { NewOpeningPage } from "./pages/NewOpeningPage";
import { ImportOpeningsPage } from "./pages/ImportOpeningsPage";
import { ImportHardwarePage } from "./pages/ImportHardwarePage";
import { PrintLabelsPage } from "./pages/PrintLabelsPage";
import { CapitalForecastPage } from "./pages/CapitalForecastPage";
import { ComplianceAlertsPage } from "./pages/ComplianceAlertsPage";
import { TeamPage } from "./pages/TeamPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { StaffToolsPage } from "./pages/StaffToolsPage";
import { WorkOrdersPage } from "./pages/WorkOrdersPage";
import { MaintenanceSchedulesPage } from "./pages/MaintenanceSchedulesPage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { PurchasingEmailPage } from "./pages/PurchasingEmailPage";
import { HowToUsePage } from "./pages/HowToUsePage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { CoveragePage } from "./pages/CoveragePage";

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { auth } = useAuth();
  const location = useLocation();
  if (!auth) return <Navigate to="/login" replace />;
  // M5: a forced password change comes first (the API enforces it too).
  if (auth.mustChangePassword && location.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
  return children;
}

function AppRoutes() {
  // M3: re-mount pages whenever the company or location scope changes so every list re-reads.
  const { scopeKey } = useLocations();
  return (
    <Routes key={scopeKey}>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/how-to-use" element={<HowToUsePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/properties/new" element={<RequireAuth><RequireOneLocation><NewPropertyPage /></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/new" element={<RequireAuth><RequireOneLocation><NewOpeningPage /></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/import" element={<RequireAuth><RequireOneLocation><ImportOpeningsPage /></RequireOneLocation></RequireAuth>} />
      <Route path="/hardware/import" element={<RequireAuth><RequireOneLocation><ImportHardwarePage /></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/print-labels" element={<RequireAuth><PrintLabelsPage /></RequireAuth>} />
      <Route path="/capital-forecast" element={<RequireAuth><CapitalForecastPage /></RequireAuth>} />
      <Route path="/compliance-alerts" element={<RequireAuth><ComplianceAlertsPage /></RequireAuth>} />
      <Route path="/staff-tools" element={<RequireAuth><StaffToolsPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/purchasing-email" element={<RequireAuth><PurchasingEmailPage /></RequireAuth>} />
      <Route path="/coverage" element={<RequireAuth><CoveragePage /></RequireAuth>} />
      <Route path="/audit-log" element={<RequireAuth><AuditLogPage /></RequireAuth>} />
      <Route path="/work-orders" element={<RequireAuth><WorkOrdersPage /></RequireAuth>} />
      <Route path="/facility-schedules" element={<RequireAuth><FacilitySchedulesPage /></RequireAuth>} />
      <Route path="/schedule-imports/new" element={<RequireAuth><RequireOneLocation><ScheduleImportStartPage /></RequireOneLocation></RequireAuth>} />
      <Route path="/schedule-imports/:id" element={<RequireAuth><ScheduleImportPage /></RequireAuth>} />
      <Route path="/schedule-comparisons" element={<RequireAuth><ScheduleComparisonsPage /></RequireAuth>} />
<Route path="/schedule-imports/:id/comparison" element={<RequireAuth><ScheduleComparisonPage /></RequireAuth>} />
      <Route path="/schedule-imports/:id/comparison/:snapshotId" element={<RequireAuth><ScheduleComparisonPage /></RequireAuth>} />
      <Route path="/maintenance-schedules" element={<RequireAuth><MaintenanceSchedulesPage /></RequireAuth>} />
      <Route path="/opening/:id" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <LocationProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <AppRoutes />
        </BrowserRouter>
      </LocationProvider>
    </AuthProvider>
  );
}
