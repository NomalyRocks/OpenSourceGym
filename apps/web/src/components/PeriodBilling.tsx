import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Payment,
  PaymentMethod,
  PaymentResult,
  RecordPaymentRequest,
  Subscription,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useProfile } from "../lib/profile";
import { useGymId, useGyms } from "../lib/gyms";
import { uuid } from "../lib/uuid";
import { defaultPaymentGym } from "../lib/subscriptionSale";
import { dateInputValue, dayEndIso } from "../lib/dateRange";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { Modal, ConfirmModal, useDateFormatter } from "./Modal";
import { PaymentFields, paymentMethodKeys } from "./PaymentFields";

function RecordPaymentModal({
  subscription,
  onClose,
  onSaved,
}: {
  subscription: Subscription;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { gyms } = useGyms();
  const options = gyms.filter((g) => subscription.gymIds.includes(g.id));
  const selectedGymId = useGymId();
  const [amount, setAmount] = useState<number | null>(
    subscription.balanceMinor,
  );
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [gymId, setGymId] = useState(defaultPaymentGym(options, selectedGymId));
  const [note, setNote] = useState("");
  const [requestId] = useState(uuid);
  const [confirmed, setConfirmed] = useState<RecordPaymentRequest | null>(null);
  const money = (n: number) =>
    formatMoney(
      n,
      subscription.sale!.currency,
      dateLocale(i18n.resolvedLanguage),
    );
  if (confirmed)
    return (
      <ConfirmModal
        title={t("Confirm payment")}
        confirmLabel={t("Record payment")}
        errorFallback="Could not record the payment."
        onClose={onClose}
        onConfirm={async () => {
          await api<PaymentResult>(
            `/api/admin/subscriptions/${subscription.id}/payments`,
            { method: "POST", body: confirmed },
          );
          onSaved();
        }}
      >
        <dl className="modal-summary">
          <dt>{t("Package")}</dt>
          <dd>{subscription.sale!.packageName}</dd>
          <dt>{t("Payment amount")}</dt>
          <dd>{money(confirmed.amountMinor)}</dd>
          <dt>{t("Payment method")}</dt>
          <dd>{t(paymentMethodKeys[confirmed.method])}</dd>
          <dt>{t("Payment gym")}</dt>
          <dd>{options.find((g) => g.id === confirmed.gymId)?.name}</dd>
          <dt>{t("Note")}</dt>
          <dd>{confirmed.note || "—"}</dd>
        </dl>
      </ConfirmModal>
    );
  const valid =
    amount !== null &&
    amount >= 1 &&
    amount <= (subscription.balanceMinor ?? 0) &&
    options.some((g) => g.id === gymId);
  return (
    <Modal title={t("Record payment")} busy={false} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && amount !== null)
            setConfirmed({
              amountMinor: amount,
              method,
              gymId,
              note: note.trim() || undefined,
              requestId,
            });
        }}
      >
        <p className="modal-preview">
          {subscription.sale!.packageName} · {t("Balance")}:{" "}
          {money(subscription.balanceMinor ?? 0)}
        </p>
        <PaymentFields
          amount={amount}
          onAmount={setAmount}
          method={method}
          onMethod={setMethod}
          gymId={gymId}
          onGym={setGymId}
          gyms={options}
          note={note}
          onNote={setNote}
        />
        <p className="hint">
          {t(
            "Payment must be greater than zero and cannot exceed the balance.",
          )}
        </p>
        <div className="row">
          <button disabled={!valid}>{t("Continue")}</button>
          <button type="button" className="ghost" onClick={onClose}>
            {t("Cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function VoidPaymentModal({
  payment,
  onClose,
  onSaved,
}: {
  payment: Payment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  if (confirm)
    return (
      <ConfirmModal
        title={t("Confirm void")}
        confirmLabel={t("Void payment")}
        errorFallback="Could not void the payment."
        danger
        onClose={onClose}
        onConfirm={async () => {
          await api<PaymentResult>(`/api/admin/payments/${payment.id}/void`, {
            method: "POST",
            body: { reason: reason.trim() },
          });
          onSaved();
        }}
      >
        <p>
          {formatMoney(
            payment.amountMinor,
            payment.currency,
            dateLocale(i18n.resolvedLanguage),
          )}{" "}
          · {payment.packageName}
        </p>
        <p>{reason.trim()}</p>
        <p className="msg warn">
          {t("Refund the money in person. Voiding only changes the records.")}
        </p>
      </ConfirmModal>
    );
  return (
    <Modal title={t("Void payment")} busy={false} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setConfirm(true);
        }}
      >
        <div className="field">
          <label htmlFor="void-reason">
            {t("Void reason (3–200 characters)")}
          </label>
          <textarea
            id="void-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            maxLength={200}
          />
        </div>
        <div className="row">
          <button disabled={reason.trim().length < 3}>{t("Continue")}</button>
          <button className="ghost" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DueDateModal({
  subscription,
  onClose,
  onSaved,
}: {
  subscription: Subscription;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [due, setDue] = useState(
    subscription.sale?.nextPaymentDue
      ? dateInputValue(new Date(subscription.sale.nextPaymentDue))
      : "",
  );
  const [confirm, setConfirm] = useState(false);
  if (confirm)
    return (
      <ConfirmModal
        title={t("Confirm next payment date")}
        confirmLabel={t("Save")}
        errorFallback="Could not save changes."
        onClose={onClose}
        onConfirm={async () => {
          await api<Subscription>(
            `/api/admin/subscriptions/${subscription.id}/sale`,
            {
              method: "PATCH",
              body: { nextPaymentDue: due ? dayEndIso(due) : null },
            },
          );
          onSaved();
        }}
      >
        <p>
          {subscription.sale!.packageName} · {due || t("No payment date")}
        </p>
      </ConfirmModal>
    );
  return (
    <Modal title={t("Edit next payment date")} busy={false} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setConfirm(true);
        }}
      >
        <div className="field">
          <label htmlFor="edit-due">{t("Next payment date")}</label>
          <input
            id="edit-due"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
        <p className="hint">{t("Leave blank to clear the payment date.")}</p>
        <div className="row">
          <button disabled={!!due && !dayEndIso(due)}>{t("Continue")}</button>
          <button type="button" className="ghost" onClick={onClose}>
            {t("Cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PeriodBilling({
  subscription,
  onChanged,
}: {
  subscription: Subscription;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { profile } = useProfile();
  const { gyms } = useGyms();
  const canAdmin = profile?.role === "owner" || profile?.role === "admin";
  const formatDate = useDateFormatter();
  const [expanded, setExpanded] = useState(false);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"record" | "due" | Payment | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setPayments(null);
    setError(null);
    api<Payment[]>(`/api/admin/subscriptions/${subscription.id}/payments`, {
      signal: controller.signal,
    })
      .then(setPayments)
      .catch((err) => {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      });
    return () => controller.abort();
  }, [expanded, subscription.id, version, t]);
  const sale = subscription.sale;
  if (!sale) return null;
  const money = (n: number) =>
    formatMoney(n, sale.currency, dateLocale(i18n.resolvedLanguage));
  const balance = subscription.balanceMinor ?? 0;
  const overdue =
    balance > 0 &&
    !!sale.nextPaymentDue &&
    new Date(sale.nextPaymentDue).getTime() < Date.now();
  const closeAction = () => {
    setAction(null);
    setVersion((v) => v + 1);
    onChanged();
  };
  return (
    <div className="period-billing">
      <strong>{sale.packageName}</strong>
      <dl className="billing-summary">
        <dt>{t("Price")}</dt>
        <dd>{money(sale.priceMinor)}</dd>
        <dt>{t("Paid")}</dt>
        <dd>{money(subscription.paidMinor ?? 0)}</dd>
        <dt>{t("Balance")}</dt>
        <dd className={balance > 0 ? "billing-balance" : ""}>
          {money(balance)}{" "}
          {overdue && <span className="badge warn">{t("Overdue")}</span>}
        </dd>
        <dt>{t("Next payment date")}</dt>
        <dd>{sale.nextPaymentDue ? formatDate(sale.nextPaymentDue) : "—"}</dd>
      </dl>
      <div className="row">
        {balance > 0 && (
          <button className="ghost" onClick={() => setAction("record")}>
            {t("Record payment")}
          </button>
        )}
        {canAdmin && (
          <button className="ghost" onClick={() => setAction("due")}>
            {t("Edit next payment date")}
          </button>
        )}
        <button
          className="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("Hide payments") : t("Payments")}
        </button>
      </div>
      {expanded && (
        <div className="payment-history">
          {error && (
            <div className="msg error">
              {error}
              <button
                className="ghost"
                onClick={() => setVersion((v) => v + 1)}
              >
                {t("Retry")}
              </button>
            </div>
          )}
          {!payments && !error && <p className="hint">{t("Loading…")}</p>}
          {payments?.length === 0 && (
            <p className="hint">{t("No payments.")}</p>
          )}
          {payments?.map((p) => (
            <div key={p.id} className="payment-history-row">
              <div className={p.void ? "payment-voided" : ""}>
                {formatMoney(
                  p.amountMinor,
                  p.currency,
                  dateLocale(i18n.resolvedLanguage),
                )}{" "}
                · {t(paymentMethodKeys[p.method])} · {formatDate(p.paidAt)}
              </div>
              <div className="hint">
                {gyms.find((g) => g.id === p.gymId)?.name ?? p.gymId} ·{" "}
                {p.recordedByName ?? p.recordedBy}
              </div>
              {p.note && <div>{p.note}</div>}
              {p.void ? (
                <div className="hint">
                  {t("Voided")}: {p.void.reason || "—"} ·{" "}
                  {formatDate(p.void.at)}
                </div>
              ) : (
                canAdmin &&
                (profile?.role === "owner" ||
                  profile?.gymIds.includes(p.gymId)) && (
                  <button className="ghost" onClick={() => setAction(p)}>
                    {t("Void")}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {action === "record" && (
        <RecordPaymentModal
          subscription={subscription}
          onClose={closeAction}
          onSaved={closeAction}
        />
      )}
      {action === "due" && (
        <DueDateModal
          subscription={subscription}
          onClose={closeAction}
          onSaved={closeAction}
        />
      )}
      {action && typeof action === "object" && (
        <VoidPaymentModal
          payment={action}
          onClose={closeAction}
          onSaved={closeAction}
        />
      )}
    </div>
  );
}
