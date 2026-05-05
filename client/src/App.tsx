import { useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { LoginPage } from "./pages/LoginPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { SalesAnalysisPage } from "./pages/SalesAnalysisPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { ReactNode } from "react";

// Set VITE_SKIP_AUTH=1 in client/.env.local to browse the UI without a backend.
const SKIP_AUTH = import.meta.env.VITE_SKIP_AUTH === "1";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (SKIP_AUTH) return <>{children}</>;
  if (loading) return <div style={{ padding: 32, color: "var(--text-dim)" }}>Loading…</div>;
  if (!user) return <Navigate to="/login" state={{ from: loc }} replace />;
  return <>{children}</>;
}

export function App() {
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
  }, []);

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<LoginPage />} />
        <Route path="/" element={<RequireAuth><DiscoverPage /></RequireAuth>} />
        <Route path="/sales-analysis" element={<RequireAuth><SalesAnalysisPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
