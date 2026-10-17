import { useEffect, useState } from "react";
import { NavLink, useLocation, useMatch, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Check,
  ChevronDown,
  Cpu,
  LayoutDashboard,
  Layers,
  LogOut,
  RefreshCw,
  ScrollText,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Shield,
  ShieldAlert,
  UserCog,
  Users as UsersIcon,
  Activity,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import type { DeletionRequest, Page } from "@opengym/shared";
import { api } from "../lib/api";
import { authClient, useSessionUser } from "../lib/auth";
import { useProfile } from "../lib/profile";
import { LAST_GYM_KEY, useDefaultGymId, useGyms } from "../lib/gyms";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import type { WebTranslationKey } from "../i18n/resources";
import { CommandPalette, type PaletteItem } from "./CommandPalette";

interface NavItem {
  to: string;
  label: WebTranslationKey;
  icon: LucideIcon;
  count?: number | string;
}

const ALL_GYMS = "__all__";

function roleLabel(
  role: string | undefined,
): "Owner" | "Administrator" | "Staff" | "Member" {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Administrator";
  if (role === "staff") return "Staff";
  return "Member";
}

/** Page title (translation key) for the last URL segment. */
const sectionLabels: Record<string, WebTranslationKey> = {
  overview: "Overview",
  users: "Users",
  entries: "Entries",
  renewals: "Renewals",
  reports: "Reports",
  devices: "Devices",
  settings: "Settings",
  chain: "All gyms",
  gyms: "Gyms",
  staff: "Staff assignment",
  audit: "Audit log",
  "data-requests": "Data protection",
  security: "Security",
};

/** Pending deletion requests, shown as a count next to the nav entry (owner only). */
function usePendingDeletions(enabled: boolean): number | string | undefined {
  const [count, setCount] = useState<number | string | undefined>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () =>
      api<Page<DeletionRequest>>(
        "/api/admin/deletion-requests?status=pending",
        {
          signal: controller.signal,
        },
      )
        .then((page) => {
          const n = page.items.length;
          setCount(n === 0 ? undefined : page.nextCursor ? `${n}+` : n);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled]);
  return count;
}

function WorkspaceSwitcher({
  currentGymId,
  isOwner,
}: {
  currentGymId: string | undefined;
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  const { gyms } = useGyms();
  const navigate = useNavigate();
  const match = useMatch("/gyms/:gymId/*");
  const [open, setOpen] = useState(false);
  const current = gyms.find((g) => g.id === currentGymId);
  const label = current?.name ?? (isOwner ? t("All gyms") : t("Gym"));

  function pick(value: string) {
    setOpen(false);
    if (value === ALL_GYMS) {
      navigate("/chain");
      return;
    }
    localStorage.setItem(LAST_GYM_KEY, value);
    // Keep the current section (e.g. /entries) when switching gyms.
    navigate(`/gyms/${value}/${match?.params["*"] || "overview"}`);
  }

  if (gyms.length === 0 && !isOwner) return null;
  return (
    <div className="menu-wrap">
      <button
        type="button"
        className="workspace"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) {
            setOpen(false);
          }
        }}
      >
        <span className="workspace-mark">
          {current ? <Building2 size={14} /> : <Layers size={14} />}
        </span>
        <span className="workspace-name">{label}</span>
        <ChevronDown size={14} className="icon" />
      </button>
      {open && (
        <div
          className="popover"
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
        >
          {isOwner && (
            <button
              type="button"
              className={!current ? "selected" : ""}
              onClick={() => pick(ALL_GYMS)}
            >
              <Layers size={14} /> {t("All gyms")}
              {!current && <Check size={14} className="check-slot" />}
            </button>
          )}
          <div className="popover-label">{t("Gyms")}</div>
          {gyms.map((g) => (
            <button
              type="button"
              key={g.id}
              className={g.id === currentGymId ? "selected" : ""}
              onClick={() => pick(g.id)}
            >
              <Building2 size={14} />
              {g.active ? g.name : `${g.name} (${t("Inactive")})`}
              {g.id === currentGymId && (
                <Check size={14} className="check-slot" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { refetch } = useSessionUser();
  const { profile } = useProfile();
  const { gyms } = useGyms();
  const navigate = useNavigate();
  const location = useLocation();
  const gymMatch = useMatch("/gyms/:gymId/*");
  const defaultGymId = useDefaultGymId();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const isOwner = profile?.role === "owner";
  const canAdmin = isOwner || profile?.role === "admin";
  const currentGymId = gymMatch?.params.gymId;
  const gymBase = currentGymId
    ? `/gyms/${currentGymId}`
    : defaultGymId
      ? `/gyms/${defaultGymId}`
      : null;
  const pendingDeletions = usePendingDeletions(isOwner);

  const general: NavItem[] = gymBase
    ? [
        { to: `${gymBase}/overview`, label: "Overview", icon: LayoutDashboard },
        { to: `${gymBase}/users`, label: "Users", icon: UsersIcon },
        { to: `${gymBase}/entries`, label: "Entries", icon: Activity },
        { to: `${gymBase}/renewals`, label: "Renewals", icon: RefreshCw },
        { to: `${gymBase}/reports`, label: "Reports", icon: BarChart3 },
        ...(canAdmin
          ? [
              { to: `${gymBase}/devices`, label: "Devices", icon: Cpu },
              {
                to: `${gymBase}/settings`,
                label: "Settings",
                icon: SettingsIcon,
              },
            ]
          : []),
      ].map((i) => i as NavItem)
    : [];
  const chain: NavItem[] = [
    ...(isOwner
      ? [
          { to: "/chain", label: "All gyms", icon: Layers },
          { to: "/chain/gyms", label: "Gyms", icon: Building2 },
          { to: "/chain/staff", label: "Staff assignment", icon: UserCog },
        ]
      : []),
    ...(canAdmin
      ? [{ to: "/audit", label: "Audit log", icon: ScrollText }]
      : []),
    ...(isOwner
      ? [
          {
            to: "/data-requests",
            label: "Data protection",
            icon: ShieldAlert,
            count: pendingDeletions,
          },
        ]
      : []),
    ...(canAdmin
      ? [
          {
            to: "/chain/settings",
            label: "Chain settings",
            icon: SlidersHorizontal,
          },
        ]
      : []),
  ].map((i) => i as NavItem);
  const account: NavItem[] = [
    { to: "/security", label: "Security", icon: Shield },
  ];

  // Quick actions: ⌘K / Ctrl+K anywhere, "/" when no field has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const paletteItems: PaletteItem[] = [
    ...[...general, ...chain, ...account].map((i) => ({
      id: i.to,
      label: t(i.label),
      icon: i.icon,
      run: () => navigate(i.to),
    })),
    ...gyms.map((g) => ({
      id: `gym-${g.id}`,
      label: t("Switch to {{name}}", { name: g.name }),
      icon: Building2,
      run: () => {
        localStorage.setItem(LAST_GYM_KEY, g.id);
        navigate(`/gyms/${g.id}/overview`);
      },
    })),
  ];

  const lastSegment = gymMatch
    ? (gymMatch.params["*"] ?? "").split("/")[0]
    : (location.pathname.split("/").filter(Boolean).slice(-1)[0] ?? "");
  const sectionKey = sectionLabels[lastSegment || "overview"];
  const crumbRoot = gymMatch
    ? (gyms.find((g) => g.id === currentGymId)?.name ?? t("Gym"))
    : t("Chain");

  const renderGroup = (label: WebTranslationKey | null, items: NavItem[]) =>
    items.length > 0 && (
      <div className="nav-group">
        {label && <div className="nav-group-label">{t(label)}</div>}
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end>
            <item.icon size={16} className="icon" />
            {t(item.label)}
            {item.count !== undefined && (
              <span className="nav-count">{item.count}</span>
            )}
          </NavLink>
        ))}
      </div>
    );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          Open<em>Gym</em>
        </div>
        <WorkspaceSwitcher currentGymId={currentGymId} isOwner={isOwner} />
        <div className="quick-row">
          <button
            type="button"
            className="quick-btn"
            onClick={() => setPaletteOpen(true)}
          >
            {t("Quick actions")}
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="quick-btn icon-only"
            aria-label={t("Search")}
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={14} />
          </button>
        </div>
        <nav className="nav">
          {renderGroup("General", general)}
          {renderGroup("Chain", chain)}
          {renderGroup("Account", account)}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-foot">
          <div className="sidebar-who">
            <strong>{profile?.email}</strong>
            <span>{t(roleLabel(profile?.role))}</span>
          </div>
          <LanguageSwitcher compact />
          <button
            className="ghost"
            onClick={() => authClient.signOut().then(() => refetch())}
          >
            <LogOut size={14} /> {t("Sign out")}
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="crumbbar">
          <span>{crumbRoot}</span>
          <span className="sep">/</span>
          <span className="current">{sectionKey ? t(sectionKey) : ""}</span>
        </div>
        <main className="content">{children}</main>
      </div>
      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
