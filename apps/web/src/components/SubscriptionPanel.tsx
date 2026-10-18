import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus } from "lucide-react";
import type {
  CancelSubscriptionResponse,
  CreateSubscriptionRequest,
  SetSubscriptionGymsRequest,
  PublicUser,
  Subscription,
  SubscriptionMonths,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { Avatar } from "./Avatar";
import { Modal, useDateFormatter } from "./Modal";
import { useGymId, useGyms } from "../lib/gyms";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";

const subscriptionMonthOptions: readonly SubscriptionMonths[] = [1, 3, 6, 12];

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

// Mirrors the server's addUtcCalendarMonthsClamped so the preview matches what
// POST /api/admin/subscriptions will create (UTC months, day clamped).
function addUtcMonthsClamped(date: Date, months: number): Date {
  const targetMonthIndex = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCFullYear(
    targetYear,
    targetMonth,
    Math.min(date.getUTCDate(), lastDay),
  );
  return result;
}

/** Active or scheduled periods (not yet ended), earliest first. */
function ongoingPeriods(subs: Subscription[]): Subscription[] {
  const now = Date.now();
  return subs
    .filter((s) => new Date(s.endsAt).getTime() > now)
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
}

function gymNames(ids: string[], gyms: { id: string; name: string }[]) {
  return ids.map((id) => gyms.find((g) => g.id === id)?.name ?? id).join(", ");
}

// Creates a NEW sequential period after the member's latest one. Two steps
// (form, then confirm) so an accidental click cannot sell an extra period.
function NewPeriodModal({
  member,
  subs,
  onClose,
  onSwitchToEdit,
  onGranted,
}: {
  member: PublicUser;
  subs: Subscription[];
  onClose: () => void;
  /** Opens the edit-gyms modal for the current period. */
  onSwitchToEdit: (subscription: Subscription) => void;
  onGranted: (startsAt: string, endsAt: string) => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const { gyms } = useGyms();
  const selectedGymId = useGymId();
  const activeGyms = gyms.filter((g) => g.active);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [months, setMonths] = useState<SubscriptionMonths>(1);
  // Defaults to the gym currently selected in the panel.
  const [gymIds, setGymIds] = useState<string[]>(
    activeGyms.some((g) => g.id === selectedGymId) ? [selectedGymId] : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: state updates are async, so a fast double click could
  // otherwise fire two POSTs before `submitting` disables the button.
  const submittingRef = useRef(false);

  const ongoing = ongoingPeriods(subs);
  const current = ongoing[0] ?? null;
  const latestEnd = subs.reduce(
    (max, s) => Math.max(max, new Date(s.endsAt).getTime()),
    Number.NEGATIVE_INFINITY,
  );
  const startsAt = new Date(Math.max(Date.now(), latestEnd));
  const endsAt = addUtcMonthsClamped(startsAt, months);

  const toggleGym = (id: string) =>
    setGymIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  function next() {
    setError(null);
    if (gymIds.length === 0) {
      setError(t("Select at least one gym."));
      return;
    }
    setStep("confirm");
  }

  async function confirm() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const request: CreateSubscriptionRequest = {
        userId: member.id,
        months,
        gymIds,
        note: t("{{months}}-month plan", { months }),
      };
      const created = await api<{ startsAt: string; endsAt: string }>(
        "/api/admin/subscriptions",
        { method: "POST", body: request },
      );
      onGranted(created.startsAt, created.endsAt);
    } catch (err) {
      setError(errorMessage(err, t, "Could not grant the subscription."));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const warning = ongoing.length > 0 && (
    <div className="msg warn">
      <strong>
        {t(
          "This adds a NEW {{months}}-month period after {{date}}, and the member will be charged for an extra period.",
          { months, date: formatDate(new Date(latestEnd)) },
        )}
      </strong>{" "}
      {t(
        "To give access to another gym on an existing period, change that period's gyms instead.",
      )}
      {step === "form" && current && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="ghost"
            onClick={() => onSwitchToEdit(current)}
          >
            {t("Edit gyms of the current period")}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <Modal
      title={t("New subscription period")}
      busy={submitting}
      onClose={onClose}
    >
      {error && <div className="msg error">{error}</div>}
      {warning}
      {step === "form" ? (
        <>
          <div className="field">
            <label htmlFor="new-period-months">{t("Plan")}</label>
            <select
              id="new-period-months"
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
          <p className="modal-preview">
            {t("Starts {{start}} – Ends {{end}}", {
              start: formatDate(startsAt),
              end: formatDate(endsAt),
            })}
          </p>
          <div className="row">
            <button type="button" onClick={next}>
              {t("Continue")}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              {t("Cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className="modal-summary">
            <dt>{t("Member")}</dt>
            <dd>{`${member.firstName} ${member.lastName}`}</dd>
            <dt>{t("Plan")}</dt>
            <dd>{t(monthsKey(months))}</dd>
            <dt>{t("Gyms")}</dt>
            <dd>{gymNames(gymIds, gyms)}</dd>
            <dt>{t("Start")}</dt>
            <dd>{formatDate(startsAt)}</dd>
            <dt>{t("End")}</dt>
            <dd>{formatDate(endsAt)}</dd>
          </dl>
          <div className="row">
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={submitting}
            >
              {submitting
                ? t("Processing…")
                : t("Confirm — grant {{plan}}", { plan: t(monthsKey(months)) })}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setError(null);
                setStep("form");
              }}
              disabled={submitting}
            >
              {t("Back")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function EditGymsForm({
  subscription,
  later,
  onBack,
  onClose,
  onChanged,
  onDone,
  onBusy,
}: {
  subscription: Subscription;
  /** Later active/scheduled periods that "apply to later periods" would touch. */
  later: Subscription[];
  onBack: () => void;
  onClose: () => void;
  /** Called whenever the server data may have changed (list reload). */
  onChanged: () => void;
  onDone: (updatedPeriods: number) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const { gyms } = useGyms();
  const [selected, setSelected] = useState<string[]>(subscription.gymIds);
  const [applyLater, setApplyLater] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    onBusy(saving);
    return () => onBusy(false);
  }, [saving, onBusy]);
  // Active gyms, plus any inactive gym already on the period so it can be removed
  const options = gyms.filter(
    (g) => g.active || subscription.gymIds.includes(g.id),
  );
  const added = selected.filter((id) => !subscription.gymIds.includes(id));
  const removed = subscription.gymIds.filter((id) => !selected.includes(id));
  const changed = added.length > 0 || removed.length > 0;
  const toggle = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  const period = (s: Subscription) =>
    `${formatDate(s.startsAt)} – ${formatDate(s.endsAt)}`;

  async function put(target: Subscription) {
    const body: SetSubscriptionGymsRequest = { gymIds: selected };
    await api(`/api/admin/subscriptions/${target.id}/gyms`, {
      method: "PUT",
      body,
    });
  }

  async function save() {
    if (savingRef.current) return;
    setError(null);
    if (selected.length === 0) {
      setError(t("Select at least one gym."));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    let updated = 0;
    try {
      // This period first; if it fails the later ones are left untouched.
      if (changed) {
        try {
          await put(subscription);
          updated += 1;
        } catch (err) {
          setError(errorMessage(err, t, "Could not update the gyms."));
          return;
        }
      }
      if (applyLater) {
        const failed: string[] = [];
        for (const target of later) {
          try {
            await put(target);
            updated += 1;
          } catch (err) {
            failed.push(
              `${period(target)}: ${errorMessage(err, t, "Could not update the gyms.")}`,
            );
          }
        }
        if (failed.length > 0) {
          setFailures(failed);
          setFinished(true);
          return;
        }
      }
      onDone(updated);
    } finally {
      // Partial or total, the list must show what the server really has.
      if (updated > 0) onChanged();
      savingRef.current = false;
      setSaving(false);
    }
  }

  const gymList = (ids: string[]) =>
    ids.length > 0 ? gymNames(ids, gyms) : "—";

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      {failures.length > 0 && (
        <div className="msg error">
          <strong>{t("Some periods could not be updated:")}</strong>
          <ul className="modal-list">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="hint" style={{ marginBottom: 12 }}>
        {t("Period: {{start}} – {{end}}", {
          start: formatDate(subscription.startsAt),
          end: formatDate(subscription.endsAt),
        })}
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        {options.map((g) => (
          <label key={g.id} className="check">
            <input
              type="checkbox"
              checked={selected.includes(g.id)}
              onChange={() => toggle(g.id)}
              disabled={saving || finished}
            />{" "}
            {g.name}
          </label>
        ))}
      </div>
      <dl className="modal-summary">
        <dt>{t("Gyms added")}</dt>
        <dd>{gymList(added)}</dd>
        <dt>{t("Gyms removed")}</dt>
        <dd>{gymList(removed)}</dd>
      </dl>
      {later.length > 0 && (
        <label className="check" style={{ marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={applyLater}
            onChange={(e) => setApplyLater(e.target.checked)}
            disabled={saving || finished}
          />{" "}
          {t("Also apply to later scheduled periods ({{count}})", {
            count: later.length,
          })}
        </label>
      )}
      <div className="row">
        {!finished && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || (!changed && !applyLater)}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        )}
        <button
          type="button"
          className="ghost"
          onClick={onBack}
          disabled={saving}
        >
          {t("Back")}
        </button>
        {finished && (
          <button
            type="button"
            className="ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("Close")}
          </button>
        )}
      </div>
    </>
  );
}

// Cancels a scheduled period. The server moves every later period earlier by
// the cancelled period's duration; the preview below mirrors that shift.
function CancelPeriodForm({
  subscription,
  later,
  onBack,
  onCancelled,
  onBusy,
}: {
  subscription: Subscription;
  /** Periods that start after the cancelled one; they move earlier. */
  later: Subscription[];
  onBack: () => void;
  onCancelled: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const { gyms } = useGyms();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    onBusy(submitting);
    return () => onBusy(false);
  }, [submitting, onBusy]);
  const shiftMs =
    new Date(subscription.endsAt).getTime() -
    new Date(subscription.startsAt).getTime();
  const shifted = (value: string) =>
    new Date(new Date(value).getTime() - shiftMs);

  async function confirm() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await api<CancelSubscriptionResponse>(
        `/api/admin/subscriptions/${subscription.id}`,
        { method: "DELETE" },
      );
      onCancelled();
    } catch (err) {
      setError(errorMessage(err, t, "Could not cancel the period."));
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      {error && <div className="msg error">{error}</div>}
      <dl className="modal-summary">
        <dt>{t("Start")}</dt>
        <dd>{formatDate(subscription.startsAt)}</dd>
        <dt>{t("End")}</dt>
        <dd>{formatDate(subscription.endsAt)}</dd>
        <dt>{t("Gyms")}</dt>
        <dd>{gymNames(subscription.gymIds, gyms)}</dd>
      </dl>
      {later.length > 0 && (
        <div className="msg warn">
          {t(
            "The later scheduled periods ({{count}}) will move earlier by the same length:",
            { count: later.length },
          )}
          <ul className="modal-list">
            {later.map((s) => (
              <li key={s.id}>
                {`${formatDate(s.startsAt)} – ${formatDate(s.endsAt)} → ${formatDate(shifted(s.startsAt))} – ${formatDate(shifted(s.endsAt))}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="danger"
          onClick={() => void confirm()}
          disabled={submitting}
        >
          {submitting ? t("Processing…") : t("Cancel this period")}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={onBack}
          disabled={submitting}
        >
          {t("Back")}
        </button>
      </div>
    </>
  );
}

type EditStep = "pick" | "gyms" | "cancel";

// One modal with internal steps: pick a period, then change its gyms or cancel
// it. Started (active) periods cannot be cancelled.
function EditSubscriptionsModal({
  subs,
  initialStep,
  initialId,
  onClose,
  onChanged,
  onGymsDone,
  onCancelled,
}: {
  subs: Subscription[];
  initialStep: EditStep;
  initialId: string;
  onClose: () => void;
  onChanged: () => void;
  onGymsDone: (updatedPeriods: number) => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const { gyms } = useGyms();
  const [step, setStep] = useState<EditStep>(initialStep);
  const [selectedId, setSelectedId] = useState(initialId);
  const [busy, setBusy] = useState(false);

  const ongoing = ongoingPeriods(subs);
  const selected = ongoing.find((s) => s.id === selectedId) ?? ongoing[0];
  const started = selected
    ? new Date(selected.startsAt).getTime() <= Date.now()
    : false;
  const startOf = (s: Subscription) => new Date(s.startsAt).getTime();
  const laterThan = (base: Subscription) =>
    ongoing.filter((s) => s.id !== base.id && startOf(s) > startOf(base));
  const backToPick = () => setStep("pick");

  const title =
    step === "gyms"
      ? t("Edit gyms")
      : step === "cancel"
        ? t("Cancel period")
        : t("Edit subscriptions");

  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      {!selected ? (
        <>
          <p className="hint" style={{ marginBottom: 12 }}>
            {t("There is no active or scheduled period to edit.")}
          </p>
          <div className="row">
            <button type="button" className="ghost" onClick={onClose}>
              {t("Close")}
            </button>
          </div>
        </>
      ) : step === "gyms" ? (
        <EditGymsForm
          key={selected.id}
          subscription={selected}
          later={laterThan(selected)}
          onBack={backToPick}
          onClose={onClose}
          onChanged={onChanged}
          onDone={onGymsDone}
          onBusy={setBusy}
        />
      ) : step === "cancel" ? (
        <CancelPeriodForm
          key={selected.id}
          subscription={selected}
          later={laterThan(selected)}
          onBack={backToPick}
          onCancelled={onCancelled}
          onBusy={setBusy}
        />
      ) : (
        <>
          <div className="period-options" role="radiogroup">
            {ongoing.map((s) => {
              const status = subscriptionStatus(s);
              return (
                <label
                  key={s.id}
                  className={`period-option${s.id === selected.id ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="edit-period"
                    checked={s.id === selected.id}
                    onChange={() => setSelectedId(s.id)}
                  />
                  <span className="grow">
                    <strong>{`${formatDate(s.startsAt)} – ${formatDate(s.endsAt)}`}</strong>
                    <span className="hint">{gymNames(s.gymIds, gyms)}</span>
                  </span>
                  <span className={`badge ${status.className}`}>
                    {t(status.label)}
                  </span>
                </label>
              );
            })}
          </div>
          {started && (
            <p className="hint" style={{ marginBottom: 12 }}>
              {t(
                "This subscription period has already started and cannot be cancelled.",
              )}
            </p>
          )}
          <div className="row">
            <button type="button" onClick={() => setStep("gyms")}>
              {t("Change gyms")}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={started}
              onClick={() => setStep("cancel")}
            >
              {t("Cancel period")}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              {t("Close")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

type PeriodModal =
  { kind: "new" } | { kind: "edit"; step: EditStep; subscriptionId: string };

export function SubscriptionPanel({
  member,
  onGranted,
  reloadKey = 0,
}: {
  member: PublicUser;
  /** Called after any change to the member's periods (the parent refreshes). */
  onGranted?: () => void;
  /** Bump to make the panel reload its list (e.g. after a freeze changed dates). */
  reloadKey?: number;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = useDateFormatter();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const [modal, setModal] = useState<PeriodModal | null>(null);
  const { gyms } = useGyms();

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
  }, [member.id, reloadKey]);

  async function reloadList() {
    try {
      setSubs(await load());
    } catch (err) {
      setLoadError(errorMessage(err, t, "Could not load data."));
    }
    onGranted?.();
  }

  const closeModal = useCallback(() => setModal(null), []);

  const ongoing = ongoingPeriods(subs ?? []);

  function openEdit(step: EditStep, subscription: Subscription) {
    setMsg(null);
    setModal({ kind: "edit", step, subscriptionId: subscription.id });
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
        <button
          type="button"
          disabled={loading || subs === null}
          onClick={() => {
            setMsg(null);
            setModal({ kind: "new" });
          }}
        >
          <Plus size={14} /> {t("New subscription period")}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={loading || ongoing.length === 0}
          title={
            ongoing.length === 0
              ? t("There is no active or scheduled period to edit.")
              : undefined
          }
          onClick={() => ongoing[0] && openEdit("pick", ongoing[0])}
        >
          <Pencil size={14} /> {t("Edit subscriptions")}
        </button>
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
                  <td>{gymNames(subscription.gymIds, gyms)}</td>
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
      {modal?.kind === "new" && (
        <NewPeriodModal
          member={member}
          subs={subs ?? []}
          onClose={closeModal}
          onSwitchToEdit={(subscription) => openEdit("gyms", subscription)}
          onGranted={(startsAt, endsAt) => {
            setModal(null);
            setMsg({
              kind: "success",
              text: t("Subscription granted: {{start}} – {{end}}.", {
                start: formatDate(startsAt),
                end: formatDate(endsAt),
              }),
            });
            void reloadList();
          }}
        />
      )}
      {modal?.kind === "edit" && (
        <EditSubscriptionsModal
          subs={subs ?? []}
          initialStep={modal.step}
          initialId={modal.subscriptionId}
          onClose={closeModal}
          onChanged={() => void reloadList()}
          onGymsDone={(updated) => {
            setModal(null);
            setMsg({
              kind: "success",
              text:
                updated > 1
                  ? t("Subscription gyms updated on {{count}} periods.", {
                      count: updated,
                    })
                  : t("Subscription gyms updated."),
            });
          }}
          onCancelled={() => {
            setModal(null);
            setMsg({
              kind: "success",
              text: t("Subscription period cancelled."),
            });
            void reloadList();
          }}
        />
      )}
    </div>
  );
}
