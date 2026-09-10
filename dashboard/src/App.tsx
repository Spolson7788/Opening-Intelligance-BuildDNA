import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { DashboardPage } from "./pages/DashboardPage";
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
import { WorkOrdersPage } from "./pages/WorkOrdersPage";
import { MaintenanceSchedulesPage } from "./pages/MaintenanceSchedulesPage";

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { auth } = useAuth();
  if (!auth) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/properties/new" element={<RequireAuth><NewPropertyPage /></RequireAuth>} />
      <Route path="/openings/new" element={<RequireAuth><NewOpeningPage /></RequireAuth>} />
      <Route path="/openings/import" element={<RequireAuth><ImportOpeningsPage /></RequireAuth>} />
      <Route path="/hardware/import" element={<RequireAuth><ImportHardwarePage /></RequireAuth>} />
      <Route path="/openings/print-labels" element={<RequireAuth><PrintLabelsPage /></RequireAuth>} />
      <Route path="/capital-forecast" element={<RequireAuth><CapitalForecastPage /></RequireAuth>} />
      <Route path="/compliance-alerts" element={<RequireAuth><ComplianceAlertsPage /></RequireAuth>} />
      <Route path="/team" element={<RequireAuth><TeamPage /></RequireAuth>} />
      <Route path="/audit-log" element={<RequireAuth><AuditLogPage /></RequireAuth>} />
      <Route path="/work-orders" element={<RequireAuth><WorkOrdersPage /></RequireAuth>} />
      <Route path="/maintenance-schedules" element={<RequireAuth><MaintenanceSchedulesPage /></RequireAuth>} />
      <Route path="/opening/:id" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
