import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CreateSubscriptionRequest,
  CurrencyCode,
  Package,
  PackageListResponse,
  PaymentMethod,
  PublicUser,
  RecordPaymentRequest,
  Subscription,
} from "@opengym/shared";
import { api, ApiError, isAbortError } from "../lib/api";
import { useProfile } from "../lib/profile";
import { useGymId, useGyms } from "../lib/gyms";
import { addUtcMonthsClamped } from "../lib/subscriptionDates";
import { formatCatalogMoney, MAX_PRICE_MINOR } from "../lib/money";
import { dayEndIso } from "../lib/dateRange";
import { uuid } from "../lib/uuid";
import {
  defaultPaymentGym,
  isDefinitiveSaleRejection,
} from "../lib/subscriptionSale";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { Modal, useDateFormatter } from "./Modal";
import { MoneyInput } from "./MoneyInput";
import { PaymentFields, paymentMethodKeys } from "./PaymentFields";

type CreatedPeriod = { id: string; startsAt: string; endsAt: string };

export function NewPeriodModal({
  member,
  subs,
  onClose,
  onSwitchToEdit,
  onGranted,
}: {
  member: PublicUser;
  subs: Subscription[];
  onClose: () => void;
  onSwitchToEdit: (subscription: Subscription) => void;
  onGranted: (startsAt: string, endsAt: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const formatDate = useDateFormatter();
  const { profile } = useProfile();
  const canOverride = profile?.role === "owner" || profile?.role === "admin";
  const { gyms } = useGyms();
  const selectedGymId = useGymId();
  const activeGyms = gyms.filter((g) => g.active);
  const [gymIds, setGymIds] = useState<string[]>(
    activeGyms.some((g) => g.id === selectedGymId) ? [selectedGymId] : [],
  );
  const [packages, setPackages] = useState<Package[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [currency, setCurrency] = useState<CurrencyCode | null>(null);
  const [selection, setSelection] = useState("");
  const [customDays, setCustomDays] = useState(30);
  const [label, setLabel] = useState("");
  const [override, setOverride] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [due, setDue] = useState("");
  const dueIso = dayEndIso(due);
  const [note, setNote] = useState("");
  const [takePayment, setTakePayment] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paymentGym, setPaymentGym] = useState(
    defaultPaymentGym(
      activeGyms.filter((g) => gymIds.includes(g.id)),
      selectedGymId,
    ),
  );
  const [paymentNote, setPaymentNote] = useState("");
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const [saleRequestId] = useState(uuid);
  const [paymentRequestId] = useState(uuid);
  const [attempted, setAttempted] = useState(false);
  const created = useRef<CreatedPeriod | null>(null);
  const [saleCreated, setSaleCreated] = useState(false);
  // Freeze both payloads after the first attempt, including when a response is lost.
  const payload = useRef<{
    sale: CreateSubscriptionRequest;
    payment: RecordPaymentRequest | null;
  } | null>(null);
  const [previewNow] = useState(() => Date.now());
  useEffect(() => {
    const controller = new AbortController();
    api<PackageListResponse>("/api/admin/packages", {
      signal: controller.signal,
    })
      .then(({ packages: items, currency }) => {
        setPackages(items.filter((p) => p.active));
        setCurrency(currency);
        setLoaded(true);
        setSelection(
          items.find((p) => p.active && (canOverride || p.priceMinor !== null))
            ?.id ?? (canOverride ? "custom" : ""),
        );
      })
      .catch((err) => {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      });
    return () => controller.abort();
  }, [canOverride, t]);
  const custom = selection === "custom";
  const chosen = packages.find((p) => p.id === selection);
  const needsPrice =
    custom || (canOverride && (override || chosen?.priceMinor === null));
  const salePrice = needsPrice ? price : (chosen?.priceMinor ?? null);
  const duration = custom
    ? { unit: "day" as const, value: customDays }
    : chosen?.duration;
  const latestEnd = subs.reduce(
    (max, s) => Math.max(max, new Date(s.endsAt).getTime()),
    previewNow,
  );
  const startsAt = new Date(latestEnd);
  const endsAt = !duration
    ? startsAt
    : duration.unit === "month"
      ? addUtcMonthsClamped(startsAt, duration.value)
      : new Date(latestEnd + duration.value * 86400000);
  const ongoing = subs
    .filter((s) => new Date(s.endsAt).getTime() > previewNow)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const paymentGyms = activeGyms.filter((g) => gymIds.includes(g.id));
  const name = custom
    ? label.trim() || t("{{count}} days", { count: customDays })
    : chosen?.name;
  const money = (value: number) =>
    formatCatalogMoney(value, currency, dateLocale(i18n.resolvedLanguage));
  const valid =
    loaded &&
    currency !== null &&
    !!duration &&
    Number.isInteger(duration.value) &&
    duration.value >= 1 &&
    duration.value <= (duration.unit === "month" ? 24 : 366) &&
    salePrice !== null &&
    salePrice <= MAX_PRICE_MINOR &&
    gymIds.length > 0 &&
    (!due || !!dayEndIso(due)) &&
    (!takePayment ||
      (amount !== null &&
        amount > 0 &&
        amount <= salePrice &&
        paymentGyms.some((g) => g.id === paymentGym)));

  async function confirm() {
    if (guard.current || !valid || salePrice === null || !currency || !duration)
      return;
    guard.current = true;
    setBusy(true);
    setError(null);
    setAttempted(true);
    if (!payload.current) {
      const base = {
        userId: member.id,
        gymIds,
        expectedCurrency: currency,
        expectedDuration: duration,
        nextPaymentDue: due ? dayEndIso(due) : null,
        note: note.trim() || undefined,
        requestId: saleRequestId,
      };
      payload.current = {
        sale: custom
          ? {
              ...base,
              custom: {
                days: customDays,
                priceMinor: salePrice,
                label:
                  label.trim() || t("{{count}} days", { count: customDays }),
              },
            }
          : {
              ...base,
              packageId: selection,
              ...(needsPrice
                ? { priceMinor: salePrice }
                : { expectedPriceMinor: salePrice }),
            },
        payment:
          takePayment && amount !== null
            ? {
                amountMinor: amount,
                method,
                gymId: paymentGym,
                note: paymentNote.trim() || undefined,
                requestId: paymentRequestId,
              }
            : null,
      };
    }
    try {
      if (!created.current) {
        created.current = await api<CreatedPeriod>("/api/admin/subscriptions", {
          method: "POST",
          body: payload.current.sale,
        });
        setSaleCreated(true);
      }
      if (payload.current.payment)
        await api(`/api/admin/subscriptions/${created.current.id}/payments`, {
          method: "POST",
          body: payload.current.payment,
        });
      onGranted(created.current.startsAt, created.current.endsAt);
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === "PACKAGE_PRICE_CHANGED"
          ? t(
              "The sale terms changed. Review the refreshed catalog and confirm the sale again.",
            )
          : errorMessage(err, t, "Could not save changes.");
      setError(message);
      if (!created.current && isDefinitiveSaleRejection(err)) {
        payload.current = null;
        setAttempted(false);
        if (err instanceof ApiError && err.code === "PACKAGE_PRICE_CHANGED") {
          setStep("form");
          setLoaded(false);
          try {
            const catalog = await api<PackageListResponse>(
              "/api/admin/packages",
            );
            const active = catalog.packages.filter((pkg) => pkg.active);
            setPackages(active);
            setCurrency(catalog.currency);
            if (!active.some((pkg) => pkg.id === selection)) setSelection("");
            setLoaded(true);
          } catch (refreshError) {
            setPackages([]);
            setError(
              `${message} ${errorMessage(refreshError, t, "Could not load data.")}`,
            );
          }
        }
      }
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={t("New subscription period")} busy={busy} onClose={onClose}>
      {error && <div className="msg error">{error}</div>}
      {saleCreated && (
        <div className="msg warn">
          {t(
            "The period was created. Retry to record the payment, or close and record it from the period.",
          )}
        </div>
      )}
      {ongoing.length > 0 && !saleCreated && (
        <div className="msg warn">
          {t("This creates an additional sold period after {{date}}.", {
            date: formatDate(startsAt),
          })}{" "}
          {t(
            "To give access to another gym on an existing period, change that period's gyms instead.",
          )}
          {step === "form" && (
            <div>
              <button
                className="ghost"
                onClick={() => onSwitchToEdit(ongoing[0]!)}
              >
                {t("Edit gyms of the current period")}
              </button>
            </div>
          )}
        </div>
      )}
      {step === "form" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) {
              setStep("confirm");
              setError(null);
            }
          }}
        >
          <div className="field">
            <label htmlFor="sale-package">{t("Package")}</label>
            <select
              id="sale-package"
              value={selection}
              onChange={(e) => {
                setSelection(e.target.value);
                setOverride(false);
                setPrice(null);
              }}
              required
            >
              <option value="" disabled>
                {t("Select a package")}
              </option>
              {packages.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  disabled={!canOverride && p.priceMinor === null}
                >
                  {p.name} ·{" "}
                  {p.priceMinor === null
                    ? t("Price not set")
                    : money(p.priceMinor)}
                </option>
              ))}
              {canOverride && (
                <option value="custom">{t("Custom day grant")}</option>
              )}
            </select>
          </div>
          {!canOverride && (
            <p className="hint">
              {t(
                "Prices are in {{currency}}. Unpriced packages require an owner or administrator.",
                { currency },
              )}
            </p>
          )}
          {custom && (
            <>
              <div className="field">
                <label htmlFor="custom-days">{t("Days")}</label>
                <input
                  id="custom-days"
                  type="number"
                  min={1}
                  max={366}
                  step={1}
                  value={customDays}
                  onChange={(e) => setCustomDays(Number(e.target.value))}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="custom-label">{t("Label (optional)")}</label>
                <input
                  id="custom-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={80}
                />
              </div>
            </>
          )}
          {chosen && (
            <p className="hint">
              {t("List price")}:{" "}
              {chosen.priceMinor === null
                ? t("Price not set")
                : money(chosen.priceMinor)}
            </p>
          )}
          {canOverride && !custom && chosen && chosen.priceMinor !== null && (
            <label className="check">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => {
                  setOverride(e.target.checked);
                  setPrice(chosen?.priceMinor ?? null);
                }}
              />
              {t("Override price")}
            </label>
          )}
          {needsPrice && (
            <div className="field">
              <label htmlFor="sale-price">
                {t("Sale price")} {currency && `(${currency})`}
              </label>
              <MoneyInput
                key={`${selection}-${override}`}
                id="sale-price"
                value={price}
                onChange={setPrice}
              />
            </div>
          )}
          <div className="field">
            <label>{t("Gyms")}</label>
            <div className="row">
              {activeGyms.map((g) => (
                <label key={g.id} className="check">
                  <input
                    type="checkbox"
                    checked={gymIds.includes(g.id)}
                    onChange={() =>
                      setGymIds((prev) =>
                        prev.includes(g.id)
                          ? prev.filter((id) => id !== g.id)
                          : [...prev, g.id],
                      )
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="sale-due">
              {t("Next payment date (optional)")}
            </label>
            <input
              id="sale-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-describedby={dueIso ? "sale-due-hint" : undefined}
            />
            {dueIso && (
              <span className="hint" id="sale-due-hint">
                {formatDate(dueIso)}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="sale-note">{t("Note")}</label>
            <input
              id="sale-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={takePayment}
              onChange={(e) => {
                setTakePayment(e.target.checked);
                setAmount(salePrice);
                setPaymentGym(defaultPaymentGym(paymentGyms, selectedGymId));
              }}
            />
            {t("Take a payment now")}
          </label>
          {takePayment && (
            <PaymentFields
              amount={amount}
              onAmount={setAmount}
              method={method}
              onMethod={setMethod}
              gymId={paymentGym}
              onGym={setPaymentGym}
              gyms={paymentGyms}
              note={paymentNote}
              onNote={setPaymentNote}
            />
          )}
          <p className="modal-preview">
            {t("Starts {{start}} – Ends {{end}}", {
              start: formatDate(startsAt),
              end: formatDate(endsAt),
            })}
          </p>
          <div className="row">
            <button disabled={!valid}>{t("Continue")}</button>
            <button type="button" className="ghost" onClick={onClose}>
              {t("Cancel")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <dl className="modal-summary">
            <dt>{t("Member")}</dt>
            <dd>
              {member.firstName} {member.lastName}
            </dd>
            <dt>{t("Package")}</dt>
            <dd>{name}</dd>
            <dt>{t("Gyms")}</dt>
            <dd>
              {activeGyms
                .filter((g) => gymIds.includes(g.id))
                .map((g) => g.name)
                .join(", ")}
            </dd>
            <dt>{t("Start")}</dt>
            <dd>{formatDate(startsAt)}</dd>
            <dt>{t("End")}</dt>
            <dd>{formatDate(endsAt)}</dd>
            <dt>{t("Sale price")}</dt>
            <dd>{salePrice !== null && money(salePrice)}</dd>
            <dt>{t("List price")}</dt>
            <dd>
              {chosen?.priceMinor != null
                ? money(chosen.priceMinor)
                : t("Price not set")}
            </dd>
            <dt>{t("Next payment date")}</dt>
            <dd>{dueIso ? formatDate(dueIso) : "—"}</dd>
            <dt>{t("Note")}</dt>
            <dd>{note || "—"}</dd>
            <dt>{t("Payment")}</dt>
            <dd>
              {takePayment && amount !== null
                ? `${money(amount)} · ${t(paymentMethodKeys[method])} · ${paymentGyms.find((g) => g.id === paymentGym)?.name}`
                : t("No payment now")}
            </dd>
            {takePayment && (
              <>
                <dt>{t("Payment note (optional)")}</dt>
                <dd>{paymentNote || "—"}</dd>
              </>
            )}
          </dl>
          <div className="row">
            <button onClick={() => void confirm()} disabled={busy}>
              {busy
                ? t("Processing…")
                : attempted
                  ? t("Retry")
                  : t("Confirm sale")}
            </button>
            <button
              className="ghost"
              disabled={busy || attempted}
              onClick={() => setStep("form")}
            >
              {t("Back")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
