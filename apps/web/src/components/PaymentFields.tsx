import { useTranslation } from "react-i18next";
import type { PaymentMethod } from "@opengym/shared";
import type { WebTranslationKey } from "../i18n/resources";
import { MoneyInput } from "./MoneyInput";

export const paymentMethodKeys = {
  cash: "Cash",
  card: "Card",
  transfer: "Transfer",
  other: "Other",
} as const satisfies Record<PaymentMethod, WebTranslationKey>;

export function PaymentFields({
  amount,
  onAmount,
  method,
  onMethod,
  gymId,
  onGym,
  gyms,
  note,
  onNote,
}: {
  amount: number | null;
  onAmount: (value: number | null) => void;
  method: PaymentMethod;
  onMethod: (value: PaymentMethod) => void;
  gymId: string;
  onGym: (value: string) => void;
  gyms: { id: string; name: string }[];
  note: string;
  onNote: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="field">
        <label htmlFor="payment-amount">{t("Payment amount")}</label>
        <MoneyInput id="payment-amount" value={amount} onChange={onAmount} />
      </div>
      <div className="field">
        <label htmlFor="payment-method">{t("Payment method")}</label>
        <select
          id="payment-method"
          value={method}
          onChange={(e) => onMethod(e.target.value as PaymentMethod)}
        >
          {Object.entries(paymentMethodKeys).map(([value, key]) => (
            <option key={value} value={value}>
              {t(key)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="payment-gym">{t("Payment gym")}</label>
        <select
          id="payment-gym"
          value={gymId}
          onChange={(e) => onGym(e.target.value)}
          required
        >
          <option value="" disabled>
            {t("Select a gym")}
          </option>
          {gyms.map((gym) => (
            <option key={gym.id} value={gym.id}>
              {gym.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="payment-note">{t("Payment note (optional)")}</label>
        <input
          id="payment-note"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          maxLength={200}
        />
      </div>
    </>
  );
}
