import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type {
  CancelSubscriptionResponse,
  SetSubscriptionGymsRequest,
  PublicUser,
  Subscription,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { NewPeriodModal } from "./NewPeriodModal";
import {
  DueDateModal,
  PeriodBilling,
  RecordPaymentModal,
} from "./PeriodBilling";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";
import { useProfile } from "../lib/profile";
import { formatMoney } from "../lib/money";
import { Modal, useDateFormatter } from "./Modal";
import { useGyms } from "../lib/gyms";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import type { WebTranslationKey } from "../i18n/resources";

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

/** True when both lists hold the same gym ids, ignoring order and duplicates. */
function sameGymSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** What "apply to later periods" does to one later period. */
type LaterChange =
  | { target: Subscription; kind: "unchanged" | "empty" }
  | { target: Subscription; kind: "update"; next: string[] };

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

  // Later periods receive only this diff, never a copy of this period's list:
  // the PUT replaces the whole list, so copying would drop gyms that exist only
  // on a later period. A period left with no gyms is skipped, not sent.
  const laterChanges: LaterChange[] = later.map((target): LaterChange => {
    const kept = target.gymIds.filter((id) => !removed.includes(id));
    const next = [...kept, ...added.filter((id) => !kept.includes(id))];
    if (sameGymSet(next, target.gymIds)) return { target, kind: "unchanged" };
    if (next.length === 0) return { target, kind: "empty" };
    return { target, kind: "update", next };
  });

  async function put(target: Subscription, gymIds: string[]) {
    const body: SetSubscriptionGymsRequest = { gymIds };
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
          await put(subscription, selected);
          updated += 1;
        } catch (err) {
          setError(errorMessage(err, t, "Could not update the gyms."));
          return;
        }
      }
      if (applyLater) {
        const failed: string[] = [];
        for (const change of laterChanges) {
          if (change.kind !== "update") continue;
          try {
            await put(change.target, change.next);
            updated += 1;
          } catch (err) {
            failed.push(
              `${period(change.target)}: ${errorMessage(err, t, "Could not update the gyms.")}`,
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
      {applyLater && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>
            {t("Later scheduled periods:")}
          </p>
          <ul className="modal-list" style={{ marginBottom: 14 }}>
            {laterChanges.map((change) => (
              <li key={change.target.id}>
                {change.kind === "update"
                  ? t("{{period}} → {{gyms}}", {
                      period: period(change.target),
                      gyms: gymList(change.next),
                    })
                  : change.kind === "empty"
                    ? t(
                        "{{period}}: would be left with no gyms; left unchanged",
                        { period: period(change.target) },
                      )
                    : t("{{period}}: unchanged", {
                        period: period(change.target),
                      })}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row">
        {!finished && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !changed}
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

type EditStep = "gyms" | "cancel";

/** Opens the existing edit or cancellation confirmation directly for one period. */
function PeriodActionModal({
  subs,
  step,
  subscriptionId,
  onClose,
  onChanged,
  onGymsDone,
  onCancelled,
}: {
  subs: Subscription[];
  step: EditStep;
  subscriptionId: string;
  onClose: () => void;
  onChanged: () => void;
  onGymsDone: (updatedPeriods: number) => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const ongoing = ongoingPeriods(subs);
  const selected = ongoing.find((s) => s.id === subscriptionId);
  if (!selected) return null;
  const later = ongoing.filter(
    (s) =>
      s.id !== selected.id &&
      new Date(s.startsAt).getTime() > new Date(selected.startsAt).getTime(),
  );
  return (
    <Modal
      title={step === "gyms" ? t("Edit gyms") : t("Cancel period")}
      busy={busy}
      onClose={onClose}
    >
      {step === "gyms" ? (
        <EditGymsForm
          subscription={selected}
          later={later}
          onBack={onClose}
          onClose={onClose}
          onChanged={onChanged}
          onDone={onGymsDone}
          onBusy={setBusy}
        />
      ) : (
        <CancelPeriodForm
          subscription={selected}
          later={later}
          onBack={onClose}
          onCancelled={onCancelled}
          onBusy={setBusy}
        />
      )}
    </Modal>
  );
}

type PeriodModal =
  | { kind: "new" }
  | { kind: "edit"; step: EditStep; subscriptionId: string }
  | { kind: "record" | "due"; subscriptionId: string };

function PeriodCard({
  subscription,
  past,
  primaryPayment,
  onEdit,
  onBilling,
  onChanged,
}: {
  subscription: Subscription;
  past: boolean;
  primaryPayment: boolean;
  onEdit: (step: EditStep, subscription: Subscription) => void;
  onBilling: (kind: "record" | "due", subscription: Subscription) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { profile } = useProfile();
  const { gyms } = useGyms();
  const formatDate = useDateFormatter();
  const [expanded, setExpanded] = useState(
    (subscription.balanceMinor ?? 0) > 0,
  );
  const bodyId = useId();
  const started = new Date(subscription.startsAt).getTime() <= Date.now();
  const balance = subscription.balanceMinor ?? 0;
  const sale = subscription.sale;
  const name = sale?.packageName ?? t("Subscription period");
  const dates = `${formatDate(subscription.startsAt)} – ${formatDate(subscription.endsAt)}`;
  const gymsLabel = gymNames(subscription.gymIds, gyms);
  const money = (amount: number) =>
    sale
      ? formatMoney(amount, sale.currency, dateLocale(i18n.resolvedLanguage))
      : "";
  const items: OverflowMenuItem[] = [
    ...(!past
      ? [
          {
            label: t("Change gyms"),
            onSelect: () => onEdit("gyms", subscription),
          },
        ]
      : []),
    ...(sale &&
    balance > 0 &&
    (profile?.role === "owner" || profile?.role === "admin")
      ? [
          {
            label: t("Edit next payment date"),
            onSelect: () => onBilling("due", subscription),
          },
        ]
      : []),
    {
      label: t("Cancel period"),
      destructive: true,
      disabled: started,
      reason: started
        ? t(
            "This subscription period has already started and cannot be cancelled.",
          )
        : undefined,
      onSelect: () => onEdit("cancel", subscription),
    },
  ];
  const pastSummary = [
    dates,
    name,
    ...(sale
      ? [
          money(sale.priceMinor),
          balance > 0
            ? t("Balance due {{amount}}", { amount: money(balance) })
            : t("Paid in full"),
        ]
      : []),
  ].join(" · ");

  return (
    <article className={`period-card${past ? " past-period" : ""}`}>
      {past && (
        <button
          type="button"
          className="ghost past-period-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span title={pastSummary}>{pastSummary}</span>
        </button>
      )}
      <div id={bodyId} className="period-card-body" hidden={past && !expanded}>
        {(!past || expanded) && (
          <>
            <div className="period-card-head">
              <div className="period-card-identity">
                <strong>{name}</strong>
                <span className="hint period-gyms" title={gymsLabel}>
                  {gymsLabel}
                </span>
              </div>
              <OverflowMenu
                label={t("Actions for {{period}}", { period: dates })}
                items={items}
              />
            </div>
            {!past && <p className="hint period-dates">{dates}</p>}
            {subscription.note?.trim() && (
              <p className="hint period-note">{subscription.note}</p>
            )}
            {sale && (
              <>
                <PeriodBilling
                  subscription={subscription}
                  onChanged={onChanged}
                />
                {balance > 0 && !primaryPayment && (
                  <button
                    type="button"
                    className="ghost period-record"
                    onClick={() => onBilling("record", subscription)}
                  >
                    {t("Record payment")}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </article>
  );
}

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
  const now = Date.now();
  const current = ongoing.filter((s) => new Date(s.startsAt).getTime() <= now);
  const upcoming = ongoing.filter((s) => new Date(s.startsAt).getTime() > now);
  const past = (subs ?? [])
    .filter((s) => new Date(s.endsAt).getTime() <= now)
    .sort(
      (a, b) => new Date(b.endsAt).getTime() - new Date(a.endsAt).getTime(),
    );
  const summary = current[0] ?? upcoming[0];
  const paymentPeriod = [...current, ...past, ...upcoming].find(
    (s) => s.sale && (s.balanceMinor ?? 0) > 0,
  );
  const paymentSale = paymentPeriod?.sale;
  const paymentOverdue =
    paymentSale?.nextPaymentDue &&
    new Date(paymentSale.nextPaymentDue).getTime() < now;
  const billingSubscription =
    modal && "subscriptionId" in modal
      ? subs?.find((s) => s.id === modal.subscriptionId)
      : undefined;
  const groups: {
    label: WebTranslationKey;
    periods: Subscription[];
    past: boolean;
  }[] = [
    { label: "Current period", periods: current, past: false },
    { label: "Upcoming", periods: upcoming, past: false },
    { label: "Past", periods: past, past: true },
  ];
  function openBilling(kind: "record" | "due", subscription: Subscription) {
    setMsg(null);
    setModal({ kind, subscriptionId: subscription.id });
  }

  function openEdit(step: EditStep, subscription: Subscription) {
    setMsg(null);
    setModal({ kind: "edit", step, subscriptionId: subscription.id });
  }

  return (
    <section className="subscription-panel" aria-label={t("Subscription")}>
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
      {loadError && <div className="msg error">{loadError}</div>}
      <div className="subscription-overview">
        {summary && (
          <p className="subscription-summary">
            <strong>
              {summary.sale?.packageName ?? t("Subscription period")}
            </strong>
            <span>
              {formatDate(summary.startsAt)} → {formatDate(summary.endsAt)}
            </span>
            {current.includes(summary) && (
              <span className="hint">
                {t("{{count}} days left", {
                  count: Math.max(
                    0,
                    Math.ceil(
                      (new Date(summary.endsAt).getTime() - now) / 86_400_000,
                    ),
                  ),
                })}
              </span>
            )}
          </p>
        )}
        {paymentPeriod && paymentSale && (
          <div className="subscription-balance">
            <strong>
              {t("Balance due {{amount}}", {
                amount: formatMoney(
                  paymentPeriod.balanceMinor ?? 0,
                  paymentSale.currency,
                  dateLocale(i18n.resolvedLanguage),
                ),
              })}
            </strong>
            {paymentOverdue && (
              <span className="badge warn">{t("Overdue")}</span>
            )}
            {paymentPeriod !== summary && (
              <span className="hint">
                {t("Payment for {{period}}", {
                  period: `${formatDate(paymentPeriod.startsAt)} – ${formatDate(paymentPeriod.endsAt)}`,
                })}
              </span>
            )}
          </div>
        )}
        <div className="row subscription-primary-actions">
          {paymentPeriod && (
            <button
              type="button"
              onClick={() => openBilling("record", paymentPeriod)}
            >
              {t("Record payment")}
            </button>
          )}
          <button
            type="button"
            className={paymentPeriod ? "ghost" : undefined}
            disabled={loading || subs === null}
            onClick={() => {
              setMsg(null);
              setModal({ kind: "new" });
            }}
          >
            <Plus size={14} aria-hidden="true" /> {t("New period")}
          </button>
        </div>
      </div>
      {loading && <p className="hint">{t("Loading…")}</p>}
      {!loading && subs?.length === 0 && (
        <p className="hint">{t("No subscription records.")}</p>
      )}
      {groups
        .filter((group) => group.periods.length > 0)
        .map((group) => (
          <section
            key={group.label}
            className="period-group"
            aria-label={t(group.label)}
          >
            <h2>{t(group.label)}</h2>
            {group.periods.map((subscription) => (
              <PeriodCard
                key={subscription.id}
                subscription={subscription}
                past={group.past}
                primaryPayment={subscription.id === paymentPeriod?.id}
                onEdit={openEdit}
                onBilling={openBilling}
                onChanged={() => void reloadList()}
              />
            ))}
          </section>
        ))}
      {modal?.kind === "new" && (
        <NewPeriodModal
          member={member}
          subs={subs ?? []}
          onClose={() => {
            closeModal();
            void reloadList();
          }}
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
        <PeriodActionModal
          subs={subs ?? []}
          step={modal.step}
          subscriptionId={modal.subscriptionId}
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
      {modal?.kind === "record" && billingSubscription?.sale && (
        <RecordPaymentModal
          subscription={billingSubscription}
          onClose={() => {
            closeModal();
            void reloadList();
          }}
          onSaved={() => {
            closeModal();
            void reloadList();
          }}
        />
      )}
      {modal?.kind === "due" && billingSubscription?.sale && (
        <DueDateModal
          subscription={billingSubscription}
          onClose={() => {
            closeModal();
            void reloadList();
          }}
          onSaved={() => {
            closeModal();
            void reloadList();
          }}
        />
      )}
    </section>
  );
}
