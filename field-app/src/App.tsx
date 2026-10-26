import {AccountRecoveryPage} from "./pages/AccountRecoveryPage";
import {AccountIdentity} from "./components/AccountIdentity";
import {BranchesPage} from "./pages/BranchesPage";
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { initSync } from "./lib/sync";
import { LoginPage } from "./pages/LoginPage";
import { ScanPage } from "./pages/ScanPage";
import { OpeningDetailPage } from "./pages/OpeningDetailPage";
import { LogServiceEventPage } from "./pages/LogServiceEventPage";
import { LogInspectionEventPage } from "./pages/LogInspectionEventPage";
import { LogHardwarePage } from "./pages/LogHardwarePage";
import { EditHardwarePage } from "./pages/EditHardwarePage";
import { MyWorkOrdersPage } from "./pages/MyWorkOrdersPage";
import { OpeningStructurePage } from "./pages/OpeningStructurePage";
import { SetupOpeningPage } from "./pages/SetupOpeningPage";
import { QrLabelPage } from "./pages/QrLabelPage";
import { ServiceRequestPage } from './pages/ServiceRequestPage';
import { InstallationLifecyclePage } from './pages/InstallationLifecyclePage';
import { LifecycleOperationsPage } from './pages/LifecycleOperationsPage';
import { SyncIssuesPage } from "./pages/SyncIssuesPage";
const PhotoIsolationPage=__PHOTO_ISOLATION_ENABLED__?lazy(()=>import('./pages/PhotoIsolationPage')):null;

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { auth, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!auth) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

function AppRoutes() {
  const location=useLocation();
  const diagnostic=location.pathname==='/diagnostics/photo-isolation'||(location.pathname==='/login'&&location.state?.from==='/diagnostics/photo-isolation');
  useEffect(() => {
    if(diagnostic)return;
    const cleanup = initSync();
    return cleanup;
  }, [diagnostic]);

  return (
    <Routes>
      {PhotoIsolationPage&&<Route path="/diagnostics/photo-isolation" element={<RequireAuth><Suspense fallback={<p>Loading check.</p>}><PhotoIsolationPage/></Suspense></RequireAuth>}/>}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/account-recovery" element={<AccountRecoveryPage />} />
      <Route path="/branches" element={<RequireAuth><BranchesPage /></RequireAuth>} />
      <Route path="/setup-opening" element={<RequireAuth><SetupOpeningPage /></RequireAuth>} />
      <Route path="/opening/:id/label" element={<RequireAuth><QrLabelPage /></RequireAuth>} />
      <Route path="/opening/:id/request-service" element={<RequireAuth><ServiceRequestPage /></RequireAuth>} />
      <Route path="/opening/:id/lifecycle" element={<RequireAuth><InstallationLifecyclePage /></RequireAuth>} />
      <Route path="/opening/:id/lifecycle-records" element={<RequireAuth><LifecycleOperationsPage /></RequireAuth>} />
      <Route path="/scan" element={<RequireAuth><ScanPage /></RequireAuth>} />
      <Route path="/my-work-orders" element={<RequireAuth><MyWorkOrdersPage /></RequireAuth>} />
      <Route path="/sync-issues" element={<RequireAuth><SyncIssuesPage /></RequireAuth>} />
      <Route path="/opening/by-qr/:qrToken" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/by-code/:openingCode" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/:id" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/:id/log-service" element={<RequireAuth><LogServiceEventPage /></RequireAuth>} />
      <Route path="/opening/:id/log-inspection" element={<RequireAuth><LogInspectionEventPage /></RequireAuth>} />
      <Route path="/opening/:id/add-hardware" element={<RequireAuth><LogHardwarePage /></RequireAuth>} />
      <Route path="/opening/:id/structure" element={<RequireAuth><OpeningStructurePage /></RequireAuth>} />
      <Route path="/opening/:id/edit-hardware/:hardwareId" element={<RequireAuth><EditHardwarePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/scan" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AccountIdentity />
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
