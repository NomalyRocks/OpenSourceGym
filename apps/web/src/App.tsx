import {
  BrowserRouter,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authClient, useSessionUser } from "./lib/auth";
import { ProfileProvider, useProfile } from "./lib/profile";
import { GymsProvider, useGyms } from "./lib/gyms";
import { Login } from "./pages/Login";
import { ChangePassword } from "./pages/ChangePassword";
import { Overview } from "./pages/Overview";
import { Members } from "./pages/Members";
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
import { dateLocale } from "./i18n/format";

const LAST_GYM_KEY = "opengym:lastGymId";

function roleLabel(
  role: string | undefined,
  t: (key: "Owner" | "Administrator" | "Staff" | "Member") => string,
) {
  if (role === "owner") return t("Owner");
  if (role === "admin") return t("Administrator");
  if (role === "staff") return t("Staff");
  return t("Member");
}

/** Picks the gym to open when the URL names none (or an unknown one). */
function useDefaultGymId(): string | null {
  const { gyms } = useGyms();
  const last = localStorage.getItem(LAST_GYM_KEY);
  const remembered = gyms.find((g) => g.id === last);
  return (remembered ?? gyms.find((g) => g.active) ?? gyms[0])?.id ?? null;
}

function GymSwitcher() {
  const { t } = useTranslation();
  const { gyms } = useGyms();
  const { profile } = useProfile();
  const navigate = useNavigate();
  const location = useLocation();
  const match = useMatch("/gyms/:gymId/*");
  const gymId = match?.params.gymId;
  const isOwner = profile?.role === "owner";
  const ALL = "__all__";

  if (gyms.length === 0 && !isOwner) return null;

  function change(value: string) {
    if (value === ALL) {
      navigate("/chain");
      return;
    }
    localStorage.setItem(LAST_GYM_KEY, value);
    // Keep the current section (e.g. /entries) when switching gyms.
    const section = match?.params["*"] || "overview";
    navigate(`/gyms/${value}/${section}${location.search}`);
  }

  return (
    <select
      className="gym-switcher"
      aria-label={t("Gym")}
      value={gymId ?? (isOwner ? ALL : "")}
      onChange={(e) => change(e.target.value)}
    >
      {isOwner && <option value={ALL}>{t("All gyms")}</option>}
      {!gymId && !isOwner && <option value="" disabled />}
      {gyms.map((g) => (
        <option key={g.id} value={g.id}>
          {g.active ? g.name : `${g.name} (${t("Inactive")})`}
        </option>
      ))}
    </select>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { refetch } = useSessionUser();
  const { profile } = useProfile();
  const gymMatch = useMatch("/gyms/:gymId/*");
  const defaultGymId = useDefaultGymId();
  const gymBase = gymMatch
    ? `/gyms/${gymMatch.params.gymId}`
    : defaultGymId
      ? `/gyms/${defaultGymId}`
      : null;
  const isOwner = profile?.role === "owner";
  const canAdmin = isOwner || profile?.role === "admin";
  const locale = dateLocale(i18n.resolvedLanguage);
  const todayLabel = new Date()
    .toLocaleDateString(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    })
    .toLocaleUpperCase(locale);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            Open<em>Gym</em>
          </div>
          <GymSwitcher />
          <nav className="nav">
            {isOwner && <NavLink to="/chain">{t("All gyms")}</NavLink>}
            {gymBase && (
              <>
                <NavLink to={`${gymBase}/overview`}>{t("Overview")}</NavLink>
                <NavLink to={`${gymBase}/members`}>{t("Members")}</NavLink>
                <NavLink to={`${gymBase}/entries`}>{t("Entries")}</NavLink>
                <NavLink to={`${gymBase}/renewals`}>{t("Renewals")}</NavLink>
                <NavLink to={`${gymBase}/reports`}>{t("Reports")}</NavLink>
                {canAdmin && (
                  <NavLink to={`${gymBase}/devices`}>{t("Devices")}</NavLink>
                )}
                {canAdmin && (
                  <NavLink to={`${gymBase}/settings`}>{t("Settings")}</NavLink>
                )}
              </>
            )}
            <NavLink to="/security">{t("Security")}</NavLink>
            {isOwner && <NavLink to="/chain/gyms">{t("Gyms")}</NavLink>}
            {isOwner && (
              <NavLink to="/chain/staff">{t("Staff assignment")}</NavLink>
            )}
            {canAdmin && (
              <NavLink to="/chain/settings">{t("Chain settings")}</NavLink>
            )}
            {canAdmin && <NavLink to="/audit">{t("Audit log")}</NavLink>}
            {isOwner && (
              <NavLink to="/data-requests">{t("Data protection")}</NavLink>
            )}
          </nav>
        </div>
        <div className="topbar-right">
          <span className="topbar-date">{todayLabel}</span>
          <span className="topbar-who">
            {roleLabel(profile?.role, t)} · {profile?.email}
          </span>
          <LanguageSwitcher compact />
          <button
            className="ghost"
            onClick={() => authClient.signOut().then(() => refetch())}
          >
            {t("Sign out")}
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

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
              <Route path="members" element={<Members />} />
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
