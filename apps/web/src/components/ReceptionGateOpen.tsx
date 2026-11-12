import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type {
  DeviceDirection,
  GateDeviceSummary,
  GateScanResponse,
  PublicUser,
} from "@opengym/shared";
import { api, isAbortError } from "../lib/api";
import { errorMessage } from "../i18n/errors";
import { Avatar } from "./Avatar";
import { ConfirmModal } from "./Modal";

/** The selected gym comes from the page URL; chain-wide drawers have no gate action. */
export function ReceptionGateOpen({
  member,
  onOpened,
}: {
  member: PublicUser;
  onOpened: () => void;
}) {
  const { gymId } = useParams();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!gymId) return null;
  return (
    <>
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        {t("Open turnstile")}
      </button>
      {open && (
        <GateOpenModal
          key={`${gymId}:${member.id}`}
          gymId={gymId}
          member={member}
          onClose={() => setOpen(false)}
          onOpened={() => {
            setOpen(false);
            onOpened();
          }}
        />
      )}
    </>
  );
}

function GateOpenModal({
  gymId,
  member,
  onClose,
  onOpened,
}: {
  gymId: string;
  member: PublicUser;
  onClose: () => void;
  onOpened: () => void;
}) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<GateDeviceSummary[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [direction, setDirection] = useState<DeviceDirection>("in");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/admin/gyms/${encodeURIComponent(gymId)}`;
  useEffect(() => {
    const controller = new AbortController();
    api<GateDeviceSummary[]>(`${base}/gate-devices`, {
      signal: controller.signal,
    })
      .then((items) => {
        setDevices(items);
        const first = items.find((device) => device.online);
        setDeviceId(first?.id ?? "");
        setDirection(first?.direction === "out" ? "out" : "in");
        setLoading(false);
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        setError(errorMessage(err, t, "Could not load data."));
        setLoading(false);
      });
    return () => controller.abort();
  }, [base, t]);
  const device = devices.find((item) => item.id === deviceId);
  return (
    <ConfirmModal
      title={t("Open turnstile")}
      confirmLabel={t("Confirm")}
      errorFallback="Could not open turnstile."
      disabled={
        loading ||
        !device?.online ||
        reason.trim().length < 3 ||
        reason.trim().length > 200
      }
      onClose={onClose}
      onConfirm={async () => {
        await api<GateScanResponse>(`${base}/gate-open`, {
          method: "POST",
          body: {
            userId: member.id,
            deviceId,
            direction,
            reason: reason.trim(),
          },
        });
        onOpened();
      }}
    >
      <div className="member-identity" style={{ marginBottom: 16 }}>
        <Avatar member={member} large />
        <strong>{member.name}</strong>
      </div>
      {error && <div className="msg error">{error}</div>}
      {loading ? (
        <p className="hint">{t("Loading…")}</p>
      ) : (
        !devices.some((item) => item.online) && (
          <p className="hint">{t("No online turnstiles at this gym.")}</p>
        )
      )}
      <div className="field">
        <label htmlFor="reception-device">{t("Device")}</label>
        <select
          id="reception-device"
          value={deviceId}
          onChange={(e) => {
            setDeviceId(e.target.value);
            const selected = devices.find((item) => item.id === e.target.value);
            setDirection(selected?.direction === "out" ? "out" : "in");
          }}
        >
          <option value="" disabled>
            {t("Select a turnstile")}
          </option>
          {devices.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.online}>
              {item.name}
              {!item.online ? ` (${t("Offline")})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label
          htmlFor={
            device?.direction === "both" ? "reception-direction" : undefined
          }
        >
          {t("Direction")}
        </label>
        {device?.direction === "both" ? (
          <select
            id="reception-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as DeviceDirection)}
          >
            <option value="in">{t("Entry")}</option>
            <option value="out">{t("Exit")}</option>
          </select>
        ) : (
          <p>{t(direction === "out" ? "Exit" : "Entry")}</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="reception-reason">
          {t("Reason (3–200 characters)")}
        </label>
        <textarea
          id="reception-reason"
          required
          minLength={3}
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </ConfirmModal>
  );
}
