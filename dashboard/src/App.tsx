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
import { CompanyCustomerPage } from "./pages/CompanyCustomerPage";
import { CompanySitePage } from "./pages/CompanySitePage";
import { CompanyOpeningPage } from "./pages/CompanyOpeningPage";
import { FacilitySchedulesPage } from "./pages/FacilitySchedulesPage";
import { ScheduleImportPage, ScheduleImportStartPage } from "./pages/ScheduleImportPage";
import { ScheduleComparisonPage } from "./pages/ScheduleComparisonPage";
import { ScheduleComparisonsPage } from "./pages/ScheduleComparisonsPage";
import { OpeningDetailPage } from "./pages/OpeningDetailPage";
import { InspectionVisitPage } from "./pages/InspectionVisitPage";
import { InspectionVisitsPage } from "./pages/InspectionVisitsPage";
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
import "./company.css";

function RequireOffice({ children }: { children: React.ReactElement }) {
  const { auth } = useAuth();
  if (auth?.role === "admin" || auth?.role === "facilities_manager") return children;
  return (
    <main className="c04-refuse">
      <h1>This dashboard is for company administrators and managers</h1>
      <p>Technicians and inspectors use the field app.</p>
      <p><a href="/field/scan">Open the field app</a></p>
    </main>
  );
}

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
      <Route path="/" element={<RequireAuth><RequireOffice><DashboardPage /></RequireOffice></RequireAuth>} />
      <Route path="/customers/:customerId" element={<RequireAuth><RequireOffice><CompanyCustomerPage /></RequireOffice></RequireAuth>} />
      <Route path="/sites/:propertyId" element={<RequireAuth><RequireOffice><CompanySitePage /></RequireOffice></RequireAuth>} />
      <Route path="/company/opening/:id" element={<RequireAuth><RequireOffice><CompanyOpeningPage /></RequireOffice></RequireAuth>} />
      <Route path="/properties/new" element={<RequireAuth><RequireOneLocation><RequireOffice><NewPropertyPage /></RequireOffice></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/new" element={<RequireAuth><RequireOneLocation><RequireOffice><NewOpeningPage /></RequireOffice></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/import" element={<RequireAuth><RequireOneLocation><RequireOffice><ImportOpeningsPage /></RequireOffice></RequireOneLocation></RequireAuth>} />
      <Route path="/hardware/import" element={<RequireAuth><RequireOneLocation><RequireOffice><ImportHardwarePage /></RequireOffice></RequireOneLocation></RequireAuth>} />
      <Route path="/openings/print-labels" element={<RequireAuth><RequireOffice><PrintLabelsPage /></RequireOffice></RequireAuth>} />
      <Route path="/capital-forecast" element={<RequireAuth><RequireOffice><CapitalForecastPage /></RequireOffice></RequireAuth>} />
      <Route path="/compliance-alerts" element={<RequireAuth><RequireOffice><ComplianceAlertsPage /></RequireOffice></RequireAuth>} />
      <Route path="/staff-tools" element={<RequireAuth><RequireOffice><StaffToolsPage /></RequireOffice></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><RequireOffice><TeamPage /></RequireOffice></RequireAuth>} />
      <Route path="/purchasing-email" element={<RequireAuth><RequireOffice><PurchasingEmailPage /></RequireOffice></RequireAuth>} />
      <Route path="/coverage" element={<RequireAuth><RequireOffice><CoveragePage /></RequireOffice></RequireAuth>} />
      <Route path="/audit-log" element={<RequireAuth><RequireOffice><AuditLogPage /></RequireOffice></RequireAuth>} />
      <Route path="/work-orders" element={<RequireAuth><RequireOffice><WorkOrdersPage /></RequireOffice></RequireAuth>} />
      <Route path="/facility-schedules" element={<RequireAuth><RequireOffice><FacilitySchedulesPage /></RequireOffice></RequireAuth>} />
      <Route path="/schedule-imports/new" element={<RequireAuth><RequireOneLocation><RequireOffice><ScheduleImportStartPage /></RequireOffice></RequireOneLocation></RequireAuth>} />
      <Route path="/schedule-imports/:id" element={<RequireAuth><RequireOffice><ScheduleImportPage /></RequireOffice></RequireAuth>} />
      <Route path="/schedule-comparisons" element={<RequireAuth><RequireOffice><ScheduleComparisonsPage /></RequireOffice></RequireAuth>} />
      <Route path="/schedule-imports/:id/comparison" element={<RequireAuth><RequireOffice><ScheduleComparisonPage /></RequireOffice></RequireAuth>} />
      <Route path="/schedule-imports/:id/comparison/:snapshotId" element={<RequireAuth><RequireOffice><ScheduleComparisonPage /></RequireOffice></RequireAuth>} />
      <Route path="/maintenance-schedules" element={<RequireAuth><RequireOffice><MaintenanceSchedulesPage /></RequireOffice></RequireAuth>} />
      <Route path="/opening/:id" element={<RequireAuth><RequireOffice><OpeningDetailPage /></RequireOffice></RequireAuth>} />
      <Route path="/inspection-visits" element={<RequireAuth><RequireOffice><InspectionVisitsPage /></RequireOffice></RequireAuth>} />
      <Route path="/inspection-visits/:id" element={<RequireAuth><RequireOffice><InspectionVisitPage /></RequireOffice></RequireAuth>} />
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
