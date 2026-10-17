import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  LayoutGrid,
  List as ListIcon,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  Table2,
  UserRound,
  X,
} from "lucide-react";
import type {
  CreateSubscriptionRequest,
  SetSubscriptionGymsRequest,
  SubscriptionStatus,
  UserDirectoryPage,
  UserDirectoryRow,
  MfaMethod,
  PublicUser,
  Subscription,
  SubscriptionMonths,
} from "@opengym/shared";
import { ApiError, api, authApi, isAbortError } from "../lib/api";
import { useProfile } from "../lib/profile";
import { PageHeader } from "../components/PageHeader";
import { Avatar } from "../components/Avatar";
import { useGymId, useGyms } from "../lib/gyms";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";

const subscriptionMonthOptions: readonly SubscriptionMonths[] = [1, 3, 6, 12];

function roleKey(
  role: PublicUser["role"],
): "Owner" | "Administrator" | "Staff" | "Member" {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Administrator";
  if (role === "staff") return "Staff";
  return "Member";
}

const monthsKeys = {
  1: "1 month",
  3: "3 months",
  6: "6 months",
  12: "12 months",
} as const satisfies Record<SubscriptionMonths, WebTranslationKey>;

function monthsKey(months: SubscriptionMonths): WebTranslationKey {
  return monthsKeys[months];
}

function subscriptionStatus(subscription: Subscription): {
  label: WebTranslationKey;
  className: string;
} {
  const now = Date.now();
  if (new Date(subscription.startsAt).getTime() > now) {
    return { label: "Scheduled", className: "warn" };
  }
  if (new Date(subscription.endsAt).getTime() >= now) {
    return { label: "Active", className: "ok" };
  }
  return { label: "Expired", className: "member" };
}

// Edits which gyms a current or future period covers; the dates stay as they
// are. Gyms outside the caller's scope are not listed and therefore kept.
function SubscriptionGymsEditor({
  subscription,
  onSaved,
  onCancel,
}: {
  subscription: Subscription;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { gyms } = useGyms();
  const [selected, setSelected] = useState<string[]>(subscription.gymIds);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Active gyms, plus any inactive gym already on the period so it can be removed
  const options = gyms.filter(
    (g) => g.active || subscription.gymIds.includes(g.id),
  );
  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  async function save() {
    setError(null);
    if (selected.length === 0) {
      setError(t("Select at least one gym."));
      return;
    }
    setSaving(true);
    try {
      const body: SetSubscriptionGymsRequest = { gymIds: selected };
      await api(`/api/admin/subscriptions/${subscription.id}/gyms`, {
        method: "PUT",
        body,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, t, "Could not update the gyms."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {error && <div className="msg error">{error}</div>}
      <div className="row">
        {options.map((g) => (
          <label key={g.id} className="check">
            <input
              type="checkbox"
              checked={selected.includes(g.id)}
              onChange={() => toggle(g.id)}
            />{" "}
            {g.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={save} disabled={saving}>
          {t("Save")}
        </button>
        <button className="ghost" onClick={onCancel} disabled={saving}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}

function SubscriptionPanel({
  member,
  onGranted,
}: {
  member: PublicUser;
  onGranted?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [months, setMonths] = useState<SubscriptionMonths>(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { gyms } = useGyms();
  const selectedGymId = useGymId();
  const activeGyms = gyms.filter((g) => g.active);
  // Defaults to the gym currently selected in the panel.
  const [gymIds, setGymIds] = useState<string[]>([selectedGymId]);
  const toggleGym = (id: string) =>
    setGymIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  function load(signal?: AbortSignal) {
    return api<Subscription[]>(`/api/admin/users/${member.id}/subscriptions`, {
      signal,
    });
  }

  // Load here instead of during the render phase: requesting during render caused
  // duplicate requests in StrictMode and setState calls after unmount.
  useEffect(() => {
    const controller = new AbortController();
    setSubs(null);
    setLoading(true);
    setLoadError(null);

    load(controller.signal)
      .then(setSubs)
      .catch((err) => {
        if (isAbortError(err)) return;
        setLoadError(errorMessage(err, t, "Could not load data."));
      })
      .finally(() => setLoading(false));

    // Cancel the in-flight request when the member changes or the component
    // unmounts, so a late response cannot overwrite the new member's list.
    return () => controller.abort();
  }, [member.id]);

  async function grant() {
    setMsg(null);
    if (gymIds.length === 0) {
      setMsg({ kind: "error", text: t("Select at least one gym.") });
      return;
    }
    try {
      const request: CreateSubscriptionRequest = {
        userId: member.id,
        months,
        gymIds,
        note: t("{{months}}-month plan", { months }),
      };
      await api("/api/admin/subscriptions", {
        method: "POST",
        body: request,
      });
      setMsg({ kind: "success", text: t("Subscription granted.") });
      setSubs(await load());
      onGranted?.();
    } catch (err) {
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not grant the subscription."),
      });
    }
  }

  return (
    <div className="panel">
      <div className="member-detail-heading">
        <Avatar member={member} large />
        <h2>
          {t("Subscription — {{name}}", {
            name: `${member.firstName} ${member.lastName}`,
          })}
        </h2>
      </div>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {loadError && <div className="msg error">{loadError}</div>}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="field">
          <label htmlFor="months">{t("Plan")}</label>
          <select
            id="months"
            value={months}
            onChange={(e) =>
              setMonths(Number(e.target.value) as SubscriptionMonths)
            }
          >
            {subscriptionMonthOptions.map((option) => (
              <option key={option} value={option}>
                {t(monthsKey(option))}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t("Gyms")}</label>
          <div className="row">
            {activeGyms.map((g) => (
              <label key={g.id} className="check">
                <input
                  type="checkbox"
                  checked={gymIds.includes(g.id)}
                  onChange={() => toggleGym(g.id)}
                />{" "}
                {g.name}
              </label>
            ))}
          </div>
        </div>
        <button onClick={grant}>{t("Grant subscription")}</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("Start")}</th>
            <th>{t("End")}</th>
            <th>{t("Note")}</th>
            <th>{t("Gyms")}</th>
            <th>{t("Status")}</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={5}>{t("Loading…")}</td>
            </tr>
          )}
          {!loading &&
            (subs ?? []).map((subscription) => {
              const status = subscriptionStatus(subscription);
              return (
                <tr key={subscription.id}>
                  <td>
                    {new Date(subscription.startsAt).toLocaleDateString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>
                    {new Date(subscription.endsAt).toLocaleDateString(
                      dateLocale(i18n.resolvedLanguage),
                    )}
                  </td>
                  <td>{subscription.note ?? "—"}</td>
                  <td>
                    {editingId === subscription.id ? (
                      <SubscriptionGymsEditor
                        subscription={subscription}
                        onCancel={() => setEditingId(null)}
                        onSaved={() => {
                          setEditingId(null);
                          setMsg({
                            kind: "success",
                            text: t("Subscription gyms updated."),
                          });
                          void load().then(setSubs);
                          onGranted?.();
                        }}
                      />
                    ) : (
                      <>
                        {subscription.gymIds
                          .map(
                            (id) => gyms.find((g) => g.id === id)?.name ?? id,
                          )
                          .join(", ")}
                        {new Date(subscription.endsAt).getTime() >
                          Date.now() && (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => setEditingId(subscription.id)}
                            >
                              {t("Edit gyms")}
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${status.className}`}>
                      {t(status.label)}
                    </span>
                  </td>
                </tr>
              );
            })}
          {!loading && subs?.length === 0 && (
            <tr>
              <td colSpan={5}>{t("No subscription records.")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

interface MfaPrompt {
  target: PublicUser;
  role: string;
}

interface MfaPrompt {
  target: PublicUser;
  role: string;
}

type View = "table" | "board" | "list";
type SortKey = "name" | "createdAt";

const ROLES: PublicUser["role"][] = ["owner", "admin", "staff", "member"];
const STATUSES: SubscriptionStatus[] = ["active", "expired", "none"];
const PAGE_SIZE_TABLE = 25;
const PAGE_SIZE_CARDS = 100;

const statusMeta: Record<
  SubscriptionStatus,
  { cls: string; label: WebTranslationKey }
> = {
  active: { cls: "ok", label: "Active" },
  expired: { cls: "danger", label: "Expired" },
  none: { cls: "none", label: "None" },
};

function StatusBadge({ status }: { status: SubscriptionStatus }) {
  const { t } = useTranslation();
  const meta = statusMeta[status];
  return <span className={`badge dot ${meta.cls}`}>{t(meta.label)}</span>;
}

/** Pill-shaped filter button with a popover of options. */
function FilterChip({
  icon,
  label,
  summary,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  /** Short text of the active selection; empty when the filter is not set. */
  summary: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="chip-menu"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`chip${summary ? " set" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon}
        {label}
        {summary && `: ${summary}`}
        <ChevronDown size={14} />
      </button>
      {open && <div className="popover">{children}</div>}
    </div>
  );
}

export function Users() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.resolvedLanguage);
  const { profile: user } = useProfile();
  const { gyms } = useGyms();
  const gymName = (id: string) => gyms.find((g) => g.id === id)?.name ?? id;

  const [view, setView] = useState<View>("table");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string[]>([]);
  const [twoFactor, setTwoFactor] = useState<"" | "on" | "off">("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [gymFilter, setGymFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("createdAt");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<UserDirectoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<UserDirectoryRow | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

  const [mfaPrompt, setMfaPrompt] = useState<MfaPrompt | null>(null);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaInfo, setMfaInfo] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);

  const pageSize = view === "table" ? PAGE_SIZE_TABLE : PAGE_SIZE_CARDS;

  // Debounce typing so the directory is not requested on every keystroke.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onSearchInput(value: string) {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      // The API rejects a single character; treat it as blank.
      const trimmed = value.trim();
      setQ(trimmed.length >= 2 ? trimmed : "");
      setPage(1);
    }, 300);
  }
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      sort,
      dir,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (q) params.set("q", q);
    if (roleFilter.length) params.set("role", roleFilter.join(","));
    if (twoFactor) params.set("twoFactor", twoFactor);
    if (statusFilter.length) params.set("status", statusFilter.join(","));
    if (gymFilter) params.set("gymId", gymFilter);
    setLoading(true);
    api<UserDirectoryPage>(`/api/admin/users/directory?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((result) => {
        setData(result);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setMsg({
          kind: "error",
          text: errorMessage(err, t, "Could not load data."),
        });
      })
      .finally(() => {
        // A canceled request must not clear the replacement request's loading state.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    q,
    roleFilter,
    twoFactor,
    statusFilter,
    gymFilter,
    sort,
    dir,
    page,
    pageSize,
    reloadTick,
    t,
  ]);

  function toggleIn(
    list: string[],
    set: (next: string[]) => void,
    value: string,
  ) {
    set(
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
    setPage(1);
  }

  function changeSort(key: SortKey) {
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "name" ? "asc" : "desc");
    }
    setPage(1);
  }

  function changeView(next: View) {
    setView(next);
    setPage(1);
  }

  const sortIcon = (key: SortKey) =>
    sort !== key ? (
      <ChevronsUpDown size={13} />
    ) : dir === "asc" ? (
      <ChevronUp size={13} />
    ) : (
      <ChevronDown size={13} />
    );

  async function applyRole(
    target: PublicUser,
    role: string,
    mfa?: { mfaCode: string; mfaMethod: MfaMethod },
  ) {
    await api(`/api/admin/users/${target.id}/role`, {
      method: "POST",
      body: { role, ...mfa },
    });
    setMsg({
      kind: "success",
      text: t("{{email}} was updated to {{role}}.", {
        email: target.email,
        role: t(roleKey(role as PublicUser["role"])),
      }),
    });
    setSelected((prev) =>
      prev?.id === target.id
        ? { ...prev, role: role as PublicUser["role"] }
        : prev,
    );
    reload();
  }

  async function setRole(target: PublicUser, role: string) {
    setMsg(null);
    try {
      await applyRole(target, role);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_REQUIRED") {
        setMfaPrompt({ target, role });
        setMfaMethod("totp");
        setMfaCode("");
        setMfaError(null);
        setMfaInfo(null);
        return;
      }
      setMsg({
        kind: "error",
        text: errorMessage(err, t, "Could not assign the role."),
      });
    }
  }

  async function chooseMfaMethod(method: MfaMethod) {
    setMfaMethod(method);
    setMfaCode("");
    setMfaError(null);
    setMfaInfo(null);
    if (method === "otp") {
      try {
        await authApi("/two-factor/send-otp", {});
        setMfaInfo(t("A code was sent to your email."));
      } catch (err) {
        setMfaError(errorMessage(err, t, "The code could not be sent."));
      }
    }
  }

  async function confirmMfa() {
    if (!mfaPrompt) return;
    setMfaBusy(true);
    setMfaError(null);
    try {
      await applyRole(mfaPrompt.target, mfaPrompt.role, {
        mfaCode,
        mfaMethod,
      });
      setMfaPrompt(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "MFA_INVALID") {
        setMfaError(t("The code is invalid."));
      } else {
        setMfaError(errorMessage(err, t, "Verification failed."));
      }
    } finally {
      setMfaBusy(false);
    }
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const fullName = (u: UserDirectoryRow) => `${u.firstName} ${u.lastName}`;
  const joined = (u: UserDirectoryRow) =>
    new Date(u.createdAt).toLocaleDateString(locale, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  const userGyms = (u: UserDirectoryRow) => {
    if (u.role === "owner") return t("All gyms");
    const ids = u.role === "member" ? u.subscriptionGymIds : u.gymIds;
    return ids.length > 0 ? ids.map(gymName).join(", ") : "—";
  };

  function toggleAll() {
    setChecked(
      items.every((u) => checked.has(u.id))
        ? new Set()
        : new Set(items.map((u) => u.id)),
    );
  }

  const tabs: { id: View; label: WebTranslationKey; icon: React.ReactNode }[] =
    [
      { id: "table", label: "Table", icon: <Table2 size={15} /> },
      { id: "board", label: "Board", icon: <LayoutGrid size={15} /> },
      { id: "list", label: "List", icon: <ListIcon size={15} /> },
    ];

  const roleSummary = roleFilter.map((r) =>
    t(roleKey(r as PublicUser["role"])),
  );
  return (
    <div className="stagger">
      <PageHeader
        title={t("Users")}
        count={total}
        subtitle={t("Search members, manage roles and grant subscriptions.")}
      />

      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      <div className="view-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={view === tab.id ? "active" : ""}
            onClick={() => changeView(tab.id)}
          >
            {tab.icon}
            {t(tab.label)}
          </button>
        ))}
        <div className="search-box">
          <Search size={14} />
          <input
            value={searchText}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder={t("Search members…")}
            aria-label={t("Search")}
          />
        </div>
      </div>

      <div className="chips">
        <FilterChip
          icon={<UserRound size={14} />}
          label={t("Role")}
          summary={roleSummary.join(", ")}
        >
          {ROLES.map((r) => (
            <button
              type="button"
              key={r}
              onClick={() => toggleIn(roleFilter, setRoleFilter, r)}
            >
              <input
                type="checkbox"
                readOnly
                checked={roleFilter.includes(r)}
              />
              {t(roleKey(r))}
            </button>
          ))}
        </FilterChip>
        <FilterChip
          icon={<ShieldCheck size={14} />}
          label={t("2FA")}
          summary={
            twoFactor === "on"
              ? t("Enabled")
              : twoFactor === "off"
                ? t("Disabled")
                : ""
          }
        >
          {(
            [
              ["", t("Any")],
              ["on", t("Enabled")],
              ["off", t("Disabled")],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={twoFactor === value ? "selected" : ""}
              onClick={() => {
                setTwoFactor(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </FilterChip>
        <FilterChip
          icon={<Activity size={14} />}
          label={t("Status")}
          summary={statusFilter
            .map((s) => t(statusMeta[s as SubscriptionStatus].label))
            .join(", ")}
        >
          {STATUSES.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => toggleIn(statusFilter, setStatusFilter, s)}
            >
              <input
                type="checkbox"
                readOnly
                checked={statusFilter.includes(s)}
              />
              {t(statusMeta[s].label)}
            </button>
          ))}
        </FilterChip>
        {gymFilter && (
          <button
            type="button"
            className="chip set"
            onClick={() => {
              setGymFilter("");
              setPage(1);
            }}
          >
            <Building2 size={14} />
            {t("Gym")}: {gymName(gymFilter)}
            <X size={14} />
          </button>
        )}
        {!gymFilter && gyms.length > 0 && (
          <FilterChip
            icon={<Plus size={14} />}
            label={t("Add filter")}
            summary=""
          >
            <div className="popover-label">{t("Gym")}</div>
            {gyms.map((g) => (
              <button
                type="button"
                key={g.id}
                onClick={() => {
                  setGymFilter(g.id);
                  setPage(1);
                }}
              >
                <Building2 size={14} />
                {g.name}
              </button>
            ))}
          </FilterChip>
        )}
      </div>

      {view === "table" && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label={t("Select all")}
                    checked={
                      items.length > 0 && items.every((u) => checked.has(u.id))
                    }
                    onChange={toggleAll}
                  />
                </th>
                <th>
                  <button
                    type="button"
                    className="th-sort"
                    onClick={() => changeSort("name")}
                  >
                    {t("Full name")} {sortIcon("name")}
                  </button>
                </th>
                <th>
                  <span className="th-icon">
                    <Mail size={13} /> {t("Email")}
                  </span>
                </th>
                <th>
                  <span className="th-icon">
                    <UserRound size={13} /> {t("Role")}
                  </span>
                </th>
                <th>
                  <span className="th-icon">
                    <Activity size={13} /> {t("Status")}
                  </span>
                </th>
                <th>
                  <button
                    type="button"
                    className="th-sort"
                    onClick={() => changeSort("createdAt")}
                  >
                    <CalendarDays size={13} /> {t("Joined")}{" "}
                    {sortIcon("createdAt")}
                  </button>
                </th>
                <th>
                  <span className="th-icon">
                    <Building2 size={13} /> {t("Gyms")}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr
                  key={u.id}
                  className={selected?.id === u.id ? "selected" : ""}
                  onClick={() => setSelected(u)}
                >
                  <td
                    className="col-check"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={fullName(u)}
                      checked={checked.has(u.id)}
                      onChange={() => {
                        const next = new Set(checked);
                        if (!next.delete(u.id)) next.add(u.id);
                        setChecked(next);
                      }}
                    />
                  </td>
                  <td>
                    <div className="member-identity">
                      <Avatar member={u} />
                      <span>{fullName(u)}</span>
                    </div>
                  </td>
                  <td>
                    <span className="email-link">{u.email}</span>
                  </td>
                  <td>
                    <span className={`badge ${u.role}`}>
                      {t(roleKey(u.role))}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={u.subscriptionStatus} />
                  </td>
                  <td className="muted">{joined(u)}</td>
                  <td className="muted">{userGyms(u)}</td>
                </tr>
              ))}
              {loading && items.length === 0 && (
                <tr>
                  <td colSpan={7}>{t("Loading…")}</td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={7}>{t("No matching member found.")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {view === "board" && (
        <div className="board">
          {STATUSES.map((status) => {
            const column = items.filter((u) => u.subscriptionStatus === status);
            return (
              <div className="board-col" key={status}>
                <div className="board-col-head">
                  <StatusBadge status={status} />
                  <span className="count-pill">{column.length}</span>
                </div>
                {column.map((u) => (
                  <div
                    className="board-card"
                    key={u.id}
                    onClick={() => setSelected(u)}
                  >
                    <Avatar member={u} />
                    <div className="who">
                      <div>{fullName(u)}</div>
                      <div className="hint">{u.email}</div>
                    </div>
                  </div>
                ))}
                {column.length === 0 && (
                  <p className="hint" style={{ padding: 6 }}>
                    {loading ? t("Loading…") : t("No matching member found.")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === "list" && (
        <div className="compact-list">
          {items.map((u) => (
            <div
              className="compact-row"
              key={u.id}
              onClick={() => setSelected(u)}
            >
              <Avatar member={u} />
              <span className="grow">{fullName(u)}</span>
              <span className="grow muted">{u.email}</span>
              <span className={`badge ${u.role}`}>{t(roleKey(u.role))}</span>
              <StatusBadge status={u.subscriptionStatus} />
            </div>
          ))}
          {items.length === 0 && (
            <p className="hint" style={{ padding: 14 }}>
              {loading ? t("Loading…") : t("No matching member found.")}
            </p>
          )}
        </div>
      )}

      <div className="pager">
        <span>
          {checked.size > 0
            ? t("{{count}} selected", { count: checked.size })
            : t("Showing {{from}}–{{to}} of {{total}}", {
                from: firstShown,
                to: lastShown,
                total,
              })}
        </span>
        <div className="row">
          <button
            type="button"
            className="ghost"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            {t("Previous")}
          </button>
          <span>
            {t("Page {{page}} of {{count}}", { page, count: pageCount })}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
          >
            {t("Next")}
          </button>
        </div>
      </div>

      {selected && (
        <div className="drawer-overlay" onMouseDown={() => setSelected(null)}>
          <aside
            className="drawer"
            role="dialog"
            aria-label={fullName(selected)}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div className="member-identity">
                <Avatar member={selected} large />
                <div>
                  <div>{fullName(selected)}</div>
                  <div className="hint">{selected.email}</div>
                </div>
              </div>
              <button
                type="button"
                className="ghost"
                aria-label={t("Close")}
                onClick={() => setSelected(null)}
              >
                <X size={16} />
              </button>
            </div>
            {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
            <div className="panel">
              <div className="row">
                <span className={`badge ${selected.role}`}>
                  {t(roleKey(selected.role))}
                </span>
                <StatusBadge status={selected.subscriptionStatus} />
                {user?.role === "owner" && selected.id !== user.id && (
                  <select
                    aria-label={t("Role")}
                    value={selected.role}
                    onChange={(e) => void setRole(selected, e.target.value)}
                  >
                    <option value="member">{t("Member")}</option>
                    <option value="staff">{t("Staff")}</option>
                    <option value="admin">{t("Administrator")}</option>
                    <option value="owner">{t("Owner")}</option>
                  </select>
                )}
              </div>
            </div>
            <SubscriptionPanel
              key={selected.id}
              member={selected}
              onGranted={reload}
            />
          </aside>
        </div>
      )}
      {mfaPrompt && (
        <div className="modal-overlay">
          <div className="panel">
            <h2>{t("MFA verification required")}</h2>
            <p className="hint" style={{ marginBottom: 16 }}>
              {t("Enter a verification code to change {{email}} to {{role}}.", {
                email: mfaPrompt.target.email,
                role: t(roleKey(mfaPrompt.role as PublicUser["role"])),
              })}
            </p>
            {mfaError && <div className="msg error">{mfaError}</div>}
            {mfaInfo && <div className="msg success">{mfaInfo}</div>}
            <div className="row" style={{ marginBottom: 16 }}>
              <button
                type="button"
                className={mfaMethod === "totp" ? "" : "ghost"}
                onClick={() => void chooseMfaMethod("totp")}
              >
                {t("Authenticator")}
              </button>
              <button
                type="button"
                className={mfaMethod === "otp" ? "" : "ghost"}
                onClick={() => void chooseMfaMethod("otp")}
              >
                {t("Email code")}
              </button>
            </div>
            <div className="field">
              <label htmlFor="mfaCode">{t("Verification code")}</label>
              <input
                id="mfaCode"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </div>
            <div className="row">
              <button
                type="button"
                onClick={() => void confirmMfa()}
                disabled={mfaBusy || !mfaCode}
              >
                {mfaBusy ? t("Verifying…") : t("Approve")}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setMfaPrompt(null)}
                disabled={mfaBusy}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
