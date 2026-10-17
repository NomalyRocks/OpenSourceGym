import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useMatch,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authClient, useSessionUser } from "./lib/auth";
import { ProfileProvider, useProfile } from "./lib/profile";
import {
  GymsProvider,
  LAST_GYM_KEY,
  useDefaultGymId,
  useGyms,
} from "./lib/gyms";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";
import { ChangePassword } from "./pages/ChangePassword";
import { Overview } from "./pages/Overview";
import { Users } from "./pages/Users";
import { Settings } from "./pages/Settings";
import { Audit } from "./pages/Audit";
import { Devices } from "./pages/Devices";
import { Entries } from "./pages/Entries";
import { Renewals } from "./pages/Renewals";
import { Reports } from "./pages/Reports";
import { Security } from "./pages/Security";
import { DataRequests } from "./pages/DataRequests";
import { Gyms } from "./pages/Gyms";
import { StaffGyms } from "./pages/StaffGyms";
import { ChainSummary } from "./pages/ChainSummary";
import { ChainSettings } from "./pages/ChainSettings";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";

/** Validates `:gymId` against the caller's gyms and remounts pages on a gym switch. */
function GymScope() {
  const { t } = useTranslation();
  const { gyms, loading } = useGyms();
  const { gymId } = useMatch("/gyms/:gymId/*")?.params ?? {};
  const fallback = useDefaultGymId();
  if (loading) return <div className="auth-wrap">{t("Loading…")}</div>;
  if (!gyms.some((g) => g.id === gymId)) {
    return (
      <Navigate to={fallback ? `/gyms/${fallback}/overview` : "/"} replace />
    );
  }
  // Server enforces scope; this keeps the last choice for the next visit.
  localStorage.setItem(LAST_GYM_KEY, gymId!);
  return <Outlet key={gymId} />;
}

function HomeRedirect() {
  const { t } = useTranslation();
  const { loading } = useGyms();
  const { profile } = useProfile();
  const gymId = useDefaultGymId();
  if (loading) return <div className="auth-wrap">{t("Loading…")}</div>;
  if (gymId) return <Navigate to={`/gyms/${gymId}/overview`} replace />;
  if (profile?.role === "owner") return <Navigate to="/chain/gyms" replace />;
  return (
    <div className="panel">
      <h2>{t("No gym assigned")}</h2>
      <p className="hint">{t("Ask the chain owner to assign you to a gym.")}</p>
    </div>
  );
}

function Gate() {
  const { t } = useTranslation();
  const { user, isPending, refetch } = useSessionUser();
  const { profile, loading, refresh } = useProfile();

  if (isPending || (user && loading)) {
    return <div className="auth-wrap">{t("Loading…")}</div>;
  }
  if (!user || !profile) {
    return <Login />;
  }
  if (profile.mustChangePassword) {
    return <ChangePassword onDone={() => refresh()} />;
  }
  if (profile.role === "member") {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <LanguageSwitcher />
          <h1>{t("Unauthorized")}</h1>
          <p className="sub">
            {t("This panel is for gym staff. Please use the mobile app.")}
          </p>
          <button onClick={() => authClient.signOut().then(() => refetch())}>
            {t("Sign out")}
          </button>
        </div>
      </div>
    );
  }

  const isOwner = profile.role === "owner";
  const canAdmin = isOwner || profile.role === "admin";

  return (
    <BrowserRouter>
      <GymsProvider>
        <Shell>
          <Routes>
            <Route path="/gyms/:gymId" element={<GymScope />}>
              <Route path="overview" element={<Overview />} />
              <Route path="users" element={<Users />} />
              <Route
                path="members"
                element={<Navigate to="../users" replace />}
              />
              <Route path="entries" element={<Entries />} />
              <Route path="renewals" element={<Renewals />} />
              <Route path="reports" element={<Reports />} />
              {canAdmin && <Route path="devices" element={<Devices />} />}
              {canAdmin && <Route path="settings" element={<Settings />} />}
              <Route path="*" element={<Navigate to="overview" replace />} />
              <Route index element={<Navigate to="overview" replace />} />
            </Route>
            <Route path="/security" element={<Security />} />
            {isOwner && <Route path="/chain" element={<ChainSummary />} />}
            {isOwner && <Route path="/chain/gyms" element={<Gyms />} />}
            {isOwner && <Route path="/chain/staff" element={<StaffGyms />} />}
            {canAdmin && (
              <Route path="/chain/settings" element={<ChainSettings />} />
            )}
            {canAdmin && <Route path="/audit" element={<Audit />} />}
            {isOwner && (
              <Route path="/data-requests" element={<DataRequests />} />
            )}
            <Route path="*" element={<HomeRedirect />} />
          </Routes>
        </Shell>
      </GymsProvider>
    </BrowserRouter>
  );
}

export function App() {
  const { user } = useSessionUser();
  return (
    <ProfileProvider enabled={!!user}>
      <Gate />
    </ProfileProvider>
  );
}
