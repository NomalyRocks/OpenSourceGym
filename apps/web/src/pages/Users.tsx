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
  PublicUser,
  SubscriptionStatus,
  UserDirectoryPage,
  UserDirectoryRow,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Avatar } from "../components/Avatar";
import { MemberDrawer } from "../components/MemberDrawer";
import { StatusBadge, statusMeta } from "../components/StatusBadge";
import { useGyms } from "../lib/gyms";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { roleKey } from "../lib/roleKey";
import type { WebTranslationKey } from "../i18n/resources";

type View = "table" | "board" | "list";
type SortKey = "name" | "createdAt";

const ROLES: PublicUser["role"][] = ["owner", "admin", "staff", "member"];
const STATUSES: SubscriptionStatus[] = ["active", "expired", "none"];
const PAGE_SIZE_TABLE = 25;
const PAGE_SIZE_CARDS = 100;

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);

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
                  className={selectedId === u.id ? "selected" : ""}
                  onClick={() => setSelectedId(u.id)}
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
                    onClick={() => setSelectedId(u.id)}
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
              onClick={() => setSelectedId(u.id)}
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

      {selectedId && (
        <MemberDrawer
          userId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
