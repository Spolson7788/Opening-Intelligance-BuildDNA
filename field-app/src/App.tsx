import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { auth, loading } = useAuth();
  if (loading) return null;
  if (!auth) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  useEffect(() => {
    const cleanup = initSync();
    return cleanup;
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/scan" element={<RequireAuth><ScanPage /></RequireAuth>} />
      <Route path="/my-work-orders" element={<RequireAuth><MyWorkOrdersPage /></RequireAuth>} />
      <Route path="/opening/by-qr/:qrToken" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/by-code/:openingCode" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/:id" element={<RequireAuth><OpeningDetailPage /></RequireAuth>} />
      <Route path="/opening/:id/log-service" element={<RequireAuth><LogServiceEventPage /></RequireAuth>} />
      <Route path="/opening/:id/log-inspection" element={<RequireAuth><LogInspectionEventPage /></RequireAuth>} />
      <Route path="/opening/:id/add-hardware" element={<RequireAuth><LogHardwarePage /></RequireAuth>} />
      <Route path="/opening/:id/edit-hardware/:hardwareId" element={<RequireAuth><EditHardwarePage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/scan" replace />} />
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
