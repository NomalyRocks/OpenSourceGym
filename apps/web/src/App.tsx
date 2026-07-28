import {
  BrowserRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
} from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authClient, useSessionUser } from "./lib/auth";
import { ProfileProvider, useProfile } from "./lib/profile";
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
import { Kvkk } from "./pages/Kvkk";
import { LanguageSwitcher } from "./i18n/LanguageSwitcher";
import { dateLocale } from "./i18n/format";

function roleLabel(
  role: string | undefined,
  t: (key: "Yönetici" | "Personel" | "Üye") => string,
) {
  if (role === "admin") return t("Yönetici");
  if (role === "staff") return t("Personel");
  return t("Üye");
}

function Shell({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { refetch } = useSessionUser();
  const { profile } = useProfile();
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
          <nav className="nav">
            <NavLink to="/overview">{t("Genel Bakış")}</NavLink>
            <NavLink to="/members">{t("Üyeler")}</NavLink>
            <NavLink to="/entries">{t("Geçişler")}</NavLink>
            <NavLink to="/renewals">{t("Yenilemeler")}</NavLink>
            <NavLink to="/reports">{t("Raporlar")}</NavLink>
            <NavLink to="/security">{t("Güvenlik")}</NavLink>
            {profile?.role === "admin" && (
              <NavLink to="/devices">{t("Cihazlar")}</NavLink>
            )}
            {profile?.role === "admin" && (
              <NavLink to="/settings">{t("Ayarlar")}</NavLink>
            )}
            {profile?.role === "admin" && (
              <NavLink to="/audit">{t("İşlem kaydı")}</NavLink>
            )}
            {profile?.role === "admin" && (
              <NavLink to="/kvkk">{t("Veri Koruma")}</NavLink>
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
            {t("Çıkış")}
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function Gate() {
  const { t } = useTranslation();
  const { user, isPending, refetch } = useSessionUser();
  const { profile, loading, refresh } = useProfile();

  if (isPending || (user && loading)) {
    return <div className="auth-wrap">{t("Yükleniyor…")}</div>;
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
          <h1>{t("Yetkisiz")}</h1>
          <p className="sub">
            {t("Bu panel salon personeli içindir. Mobil uygulamayı kullanın.")}
          </p>
          <button onClick={() => authClient.signOut().then(() => refetch())}>
            {t("Çıkış")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/overview" element={<Overview />} />
          <Route path="/members" element={<Members />} />
          <Route path="/entries" element={<Entries />} />
          <Route path="/renewals" element={<Renewals />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/security" element={<Security />} />
          {profile.role === "admin" && (
            <Route path="/devices" element={<Devices />} />
          )}
          {profile.role === "admin" && (
            <Route path="/settings" element={<Settings />} />
          )}
          {profile.role === "admin" && (
            <Route path="/audit" element={<Audit />} />
          )}
          {profile.role === "admin" && (
            <Route path="/kvkk" element={<Kvkk />} />
          )}
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </Shell>
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
