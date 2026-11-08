import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PackageListResponse,
  CreatePackageRequest,
  Package,
  PackageDuration,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { formatMoney, MAX_PRICE_MINOR } from "../lib/money";
import { dateLocale } from "../i18n/format";
import { errorMessage } from "../i18n/errors";
import { PageHeader } from "../components/PageHeader";
import { Modal, ConfirmModal } from "../components/Modal";
import { MoneyInput } from "../components/MoneyInput";

function PackageEditor({
  item,
  currency,
  onClose,
  onSaved,
}: {
  item: Package | null;
  currency: string;
  onClose: () => void;
  onSaved: (item: Package) => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState<PackageDuration["unit"]>(
    item?.duration.unit ?? "month",
  );
  const [duration, setDuration] = useState(item?.duration.value ?? 1);
  const [price, setPrice] = useState<number | null>(item?.priceMinor ?? null);
  const [unpriced, setUnpriced] = useState(item?.priceMinor == null);
  const [confirm, setConfirm] = useState(false);
  const priceLabel = (value: number | null) =>
    value === null
      ? t("Price not set")
      : formatMoney(value, currency, dateLocale(i18n.resolvedLanguage));
  const body: CreatePackageRequest = {
    name: name.trim(),
    duration: { unit, value: duration },
    priceMinor: unpriced ? null : price,
  };
  const valid =
    !!name.trim() &&
    Number.isInteger(duration) &&
    duration >= 1 &&
    duration <= (unit === "month" ? 24 : 366) &&
    (unpriced || (price !== null && price <= MAX_PRICE_MINOR));
  if (confirm)
    return (
      <ConfirmModal
        title={t("Confirm package changes")}
        confirmLabel={t("Save")}
        errorFallback="Could not save changes."
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          const saved = await api<Package>(
            item ? `/api/admin/packages/${item.id}` : "/api/admin/packages",
            { method: item ? "PATCH" : "POST", body },
          );
          onSaved(saved);
        }}
      >
        <dl className="modal-summary">
          <dt>{t("Name")}</dt>
          <dd>{body.name}</dd>
          <dt>{t("Duration")}</dt>
          <dd>
            {unit === "month"
              ? t("{{count}} months", { count: duration })
              : t("{{count}} days", { count: duration })}
          </dd>
          <dt>{t("Price")}</dt>
          <dd>
            {item ? `${priceLabel(item.priceMinor)} → ` : ""}
            {priceLabel(body.priceMinor)}
          </dd>
        </dl>
        <p className="hint">
          {t("Past sales keep their original price and duration.")}
        </p>
      </ConfirmModal>
    );
  return (
    <Modal
      title={item ? t("Edit package") : t("Create package")}
      busy={false}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setConfirm(true);
        }}
      >
        <div className="field">
          <label htmlFor="package-name">{t("Name")}</label>
          <input
            id="package-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="package-unit">{t("Duration unit")}</label>
            <select
              id="package-unit"
              value={unit}
              onChange={(e) => {
                setUnit(e.target.value as PackageDuration["unit"]);
                setDuration(1);
              }}
            >
              <option value="month">{t("Months")}</option>
              <option value="day">{t("Days")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="package-duration">{t("Duration")}</label>
            <input
              id="package-duration"
              type="number"
              min={1}
              max={unit === "month" ? 24 : 366}
              step={1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              required
            />
          </div>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={unpriced}
            onChange={(e) => setUnpriced(e.target.checked)}
          />
          {t("Price not set")}
        </label>
        {!unpriced && (
          <div className="field">
            <label htmlFor="package-price">
              {t("Price")} ({currency})
            </label>
            <MoneyInput id="package-price" value={price} onChange={setPrice} />
          </div>
        )}
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

export function Packages() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<Package[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ item: Package | null } | null>(null);
  const [toggle, setToggle] = useState<Package | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<PackageListResponse>("/api/admin/packages?all=true", {
      signal: controller.signal,
    })
      .then((catalog) => {
        setItems(catalog.packages);
        setCurrency(catalog.currency);
      })
      .catch((err) => {
        if (!isAbortError(err))
          setError(errorMessage(err, t, "Could not load data."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [t]);
  const saved = (item: Package) => {
    setItems((prev) =>
      prev.some((p) => p.id === item.id)
        ? prev.map((p) => (p.id === item.id ? item : p))
        : [...prev, item],
    );
    setEditor(null);
    setToggle(null);
  };
  return (
    <div className="stagger">
      <PageHeader
        title={t("Packages")}
        subtitle={t(
          "Manage the chain catalog. Inactive packages remain in past sales.",
        )}
      />
      {error && <div className="msg error">{error}</div>}
      <div className="panel">
        <div className="row">
          <button
            disabled={!currency}
            onClick={() => setEditor({ item: null })}
          >
            {t("Create package")}
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Name")}</th>
                <th>{t("Duration")}</th>
                <th>{t("Price")}</th>
                <th>{t("Status")}</th>
                <th>{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    {p.duration.unit === "month"
                      ? t("{{count}} months", { count: p.duration.value })
                      : t("{{count}} days", { count: p.duration.value })}
                  </td>
                  <td>
                    {p.priceMinor === null ? (
                      <span className="badge warn">{t("Price not set")}</span>
                    ) : (
                      currency &&
                      formatMoney(
                        p.priceMinor,
                        currency,
                        dateLocale(i18n.resolvedLanguage),
                      )
                    )}
                  </td>
                  <td>
                    <span className={`badge ${p.active ? "ok" : "member"}`}>
                      {p.active ? t("Active") : t("Inactive")}
                    </span>
                  </td>
                  <td>
                    <div className="row">
                      <button
                        className="ghost"
                        disabled={!currency}
                        onClick={() => setEditor({ item: p })}
                      >
                        {t("Edit package")}
                      </button>
                      <button className="ghost" onClick={() => setToggle(p)}>
                        {p.active ? t("Deactivate") : t("Activate")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={5}>
                    {loading ? t("Loading…") : t("No packages.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {editor && currency && (
        <PackageEditor
          item={editor.item}
          currency={currency}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {toggle && (
        <ConfirmModal
          title={
            toggle.active ? t("Deactivate package") : t("Activate package")
          }
          confirmLabel={t("Confirm")}
          errorFallback="Could not save changes."
          onClose={() => setToggle(null)}
          onConfirm={async () =>
            saved(
              await api<Package>(`/api/admin/packages/${toggle.id}`, {
                method: "PATCH",
                body: { active: !toggle.active },
              }),
            )
          }
        >
          <p>{toggle.name}</p>
          <p className="hint">
            {t("Past sales keep their original price and duration.")}
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}
