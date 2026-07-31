import { View, type ViewStyle } from "react-native";

/**
 * Görünüm tabanlı glif seti.
 *
 * Bu çalışma alanında `react-native-svg` yok; eklemek native dev-client
 * rebuild'i gerektirir. Bunun yerine her ikon 24 birimlik bir ızgarada düz
 * `View`'lardan kuruluyor: aynı 1.8 birim çizgi kalınlığı, aynı köşe yumuşaklığı,
 * aynı optik ağırlık. Tek bir ailenin parçası gibi okunmaları için kurallar
 * ikonlar arasında sabit tutulur.
 */

export interface IconProps {
  size?: number;
  color: string;
}

const STROKE = 1.8;

/** 24'lük ızgarada mutlak konumlu dikdörtgen/çizgi. */
function rect(
  u: number,
  x: number,
  y: number,
  w: number,
  h: number,
  extra?: ViewStyle,
): ViewStyle {
  return {
    position: "absolute",
    left: x * u,
    top: y * u,
    width: w * u,
    height: h * u,
    ...extra,
  };
}

/** İçi boş (çizgi) kutu. */
function outlineRect(
  u: number,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r = 2,
): ViewStyle {
  return rect(u, x, y, w, h, {
    borderWidth: STROKE * u,
    borderColor: color,
    borderRadius: r * u,
  });
}

/** Dolu çizgi (yatay ya da dikey). */
function line(
  u: number,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra?: ViewStyle,
): ViewStyle {
  return rect(u, x, y, w, h, {
    backgroundColor: color,
    borderRadius: 1 * u,
    ...extra,
  });
}

function Frame({
  size,
  children,
}: {
  size: number;
  children: React.ReactNode;
}) {
  return <View style={{ width: size, height: size }}>{children}</View>;
}

/** Turnike QR'ı: üç bulucu kare + modül kümesi. */
export function QrGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  const finder: ViewStyle = {
    width: 7 * u,
    height: 7 * u,
    borderRadius: 1.6 * u,
    borderWidth: STROKE * u,
    borderColor: color,
    position: "absolute",
  };
  return (
    <Frame size={size}>
      <View style={[finder, { left: 3 * u, top: 3 * u }]} />
      <View style={[finder, { left: 14 * u, top: 3 * u }]} />
      <View style={[finder, { left: 3 * u, top: 14 * u }]} />
      <View style={outlineRect(u, color, 14, 14, 3.6, 3.6, 1)} />
      <View style={line(u, color, 19.8, 14, 1.6, 6.6)} />
      <View style={line(u, color, 14, 19.8, 6.6, 1.6)} />
    </Frame>
  );
}

/** Ev: çatı üçgeni yerine kesilmiş kutu + saçak çizgisi. */
export function HomeGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={outlineRect(u, color, 4, 9, 16, 12, 2.5)} />
      <View
        style={rect(u, 7.6, 2.6, 9, 9, {
          borderTopWidth: STROKE * u,
          borderLeftWidth: STROKE * u,
          borderColor: color,
          borderTopLeftRadius: 2.5 * u,
          transform: [{ rotate: "45deg" }],
        })}
      />
      <View style={line(u, color, 10, 15, 4, 6, { borderRadius: 0.8 * u })} />
    </Frame>
  );
}

/** Takvim: başlık ayraçlı kart + iki askı. */
export function CalendarGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={outlineRect(u, color, 3, 5, 18, 16, 2.5)} />
      <View style={line(u, color, 3, 10, 18, STROKE, { borderRadius: 0 })} />
      <View style={line(u, color, 7.5, 2.5, STROKE, 4.5)} />
      <View style={line(u, color, 15, 2.5, STROKE, 4.5)} />
      <View
        style={rect(u, 7, 13.5, 3, 3, {
          backgroundColor: color,
          borderRadius: 1 * u,
        })}
      />
    </Frame>
  );
}

/** Araç kutusu: farklı hesaplayıcıları temsil eden 2×2 modül ızgarası. */
export function ToolsGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={outlineRect(u, color, 3, 3, 7.2, 7.2, 2)} />
      <View style={outlineRect(u, color, 13.8, 3, 7.2, 7.2, 2)} />
      <View style={outlineRect(u, color, 3, 13.8, 7.2, 7.2, 2)} />
      <View
        style={rect(u, 13.8, 13.8, 7.2, 7.2, {
          borderRadius: 2 * u,
          backgroundColor: color,
        })}
      />
    </Frame>
  );
}

/** Hesap makinesi: kalori aracının katalog glifi. */
export function CalculatorGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={outlineRect(u, color, 4, 2.5, 16, 19, 3)} />
      <View style={outlineRect(u, color, 7, 5.5, 10, 4.5, 1.2)} />
      {[7, 11.2, 15.4].map((x) =>
        [13.2, 17.2].map((y) => (
          <View
            key={`${x}-${y}`}
            style={line(u, color, x, y, 2.2, 2.2, {
              borderRadius: 0.8 * u,
            })}
          />
        )),
      )}
    </Frame>
  );
}

/** Baş ve omuz silüeti. */
export function PersonGlyph({ size = 22, color }: IconProps) {
  const u = size / 24;
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          top: 3.5 * u,
          width: 8.5 * u,
          height: 8.5 * u,
          borderRadius: 4.25 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 14 * u,
          width: 16.5 * u,
          height: 8.5 * u,
          borderTopLeftRadius: 8.5 * u,
          borderTopRightRadius: 8.5 * u,
          borderWidth: STROKE * u,
          borderBottomWidth: 0,
          borderColor: color,
        }}
      />
    </View>
  );
}

/** Zil. */
export function BellGlyph({ size = 20, color }: IconProps) {
  const u = size / 24;
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          top: 3 * u,
          width: 14 * u,
          height: 11.5 * u,
          borderTopLeftRadius: 7 * u,
          borderTopRightRadius: 7 * u,
          borderWidth: STROKE * u,
          borderBottomWidth: 0,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 14.5 * u,
          width: 18 * u,
          height: STROKE * u,
          borderRadius: u,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 17.5 * u,
          width: 6 * u,
          height: 3.2 * u,
          borderBottomLeftRadius: 3 * u,
          borderBottomRightRadius: 3 * u,
          borderWidth: STROKE * u,
          borderTopWidth: 0,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 1.2 * u,
          width: 2.4 * u,
          height: 2.4 * u,
          borderRadius: 1.2 * u,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** Dişli: gövde halkası + altı diş. */
export function GearGlyph({ size = 20, color }: IconProps) {
  const u = size / 24;
  const teeth = [0, 60, 120];
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {teeth.map((angle) => (
        <View
          key={angle}
          style={{
            position: "absolute",
            width: 3.4 * u,
            height: 21 * u,
            borderRadius: 1.6 * u,
            backgroundColor: color,
            transform: [{ rotate: `${angle}deg` }],
          }}
        />
      ))}
      <View
        style={{
          position: "absolute",
          width: 13 * u,
          height: 13 * u,
          borderRadius: 6.5 * u,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 6.6 * u,
          height: 6.6 * u,
          borderRadius: 3.3 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
    </View>
  );
}

function Chevron({
  size,
  color,
  rotate,
}: IconProps & { size: number; rotate: string }) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 8 * u,
          height: 8 * u,
          borderTopWidth: 2 * u,
          borderRightWidth: 2 * u,
          borderTopRightRadius: 1.4 * u,
          borderColor: color,
          transform: [{ rotate }, { translateX: -1 * u }, { translateY: u }],
        }}
      />
    </View>
  );
}

export function ChevronRightGlyph({ size = 18, color }: IconProps) {
  return <Chevron size={size} color={color} rotate="45deg" />;
}

export function ChevronLeftGlyph({ size = 18, color }: IconProps) {
  return <Chevron size={size} color={color} rotate="-135deg" />;
}

export function CheckGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 6.5 * u,
          height: 12 * u,
          borderRightWidth: 2.2 * u,
          borderBottomWidth: 2.2 * u,
          borderColor: color,
          borderBottomRightRadius: 1.2 * u,
          transform: [{ rotate: "42deg" }, { translateY: -1.4 * u }],
        }}
      />
    </View>
  );
}

export function CloseGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  const bar: ViewStyle = {
    position: "absolute",
    width: 17 * u,
    height: 2 * u,
    borderRadius: u,
    backgroundColor: color,
  };
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

/** Güneş: açık tema. */
export function SunGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {[0, 45, 90, 135].map((angle) => (
        <View
          key={angle}
          style={{
            position: "absolute",
            width: 21 * u,
            height: 2 * u,
            borderRadius: u,
            backgroundColor: color,
            transform: [{ rotate: `${angle}deg` }],
          }}
        />
      ))}
      <View
        style={{
          position: "absolute",
          width: 13 * u,
          height: 13 * u,
          borderRadius: 6.5 * u,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 9.5 * u,
          height: 9.5 * u,
          borderRadius: 4.75 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
    </View>
  );
}

/**
 * Ay: dolu daireden ikinci bir daireyle "ısırık" alınır. `overflow: hidden`
 * yerine zemin rengiyle maskelemek gerekmesin diye halka olarak çizilir.
 */
export function MoonGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: 17 * u,
          height: 17 * u,
          borderRadius: 8.5 * u,
          borderWidth: 4.6 * u,
          borderColor: color,
          borderRightColor: "transparent",
          borderTopColor: "transparent",
          transform: [{ rotate: "-28deg" }],
        }}
      />
    </View>
  );
}

/** Telefon gövdesi: "cihazı takip et" seçeneği. */
export function DeviceGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={outlineRect(u, color, 6, 2.5, 12, 19, 3)} />
      <View style={line(u, color, 10.5, 17.5, 3, 1.6, { borderRadius: u })} />
    </Frame>
  );
}

/** Küre: dil seçimi. */
export function GlobeGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          width: 19 * u,
          height: 19 * u,
          borderRadius: 9.5 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 8.6 * u,
          height: 19 * u,
          borderRadius: 4.3 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 19 * u,
          height: STROKE * u,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** Saat. */
export function ClockGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          width: 19 * u,
          height: 19 * u,
          borderRadius: 9.5 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: STROKE * u,
          height: 6 * u,
          borderRadius: u,
          backgroundColor: color,
          top: 5.5 * u,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 4.6 * u,
          height: STROKE * u,
          borderRadius: u,
          backgroundColor: color,
          left: 12 * u,
          top: 11.1 * u,
        }}
      />
    </View>
  );
}

/** Kalkan: güvenlik ve KVKK satırları. */
export function ShieldGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          top: 2.5 * u,
          width: 16 * u,
          height: 13 * u,
          borderWidth: STROKE * u,
          borderBottomWidth: 0,
          borderColor: color,
          borderTopLeftRadius: 3 * u,
          borderTopRightRadius: 3 * u,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 11 * u,
          width: 11 * u,
          height: 11 * u,
          borderRightWidth: STROKE * u,
          borderBottomWidth: STROKE * u,
          borderColor: color,
          borderBottomRightRadius: 3 * u,
          transform: [{ rotate: "45deg" }],
        }}
      />
    </View>
  );
}

/** Zarf: e-posta OTP rozetleri. */
export function EnvelopeGlyph({ size = 24, color }: IconProps) {
  const u = size / 24;
  const height = 18 * u;
  return (
    <View style={{ width: size, height, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          width: size,
          height,
          borderRadius: 3.5 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 3 * u,
          left: 2.4 * u,
          width: 11.6 * u,
          height: STROKE * u,
          backgroundColor: color,
          borderRadius: u,
          transform: [{ rotate: "27deg" }],
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 3 * u,
          right: 2.4 * u,
          width: 11.6 * u,
          height: STROKE * u,
          backgroundColor: color,
          borderRadius: u,
          transform: [{ rotate: "-27deg" }],
        }}
      />
    </View>
  );
}

/** Asma kilit: şifre akışları. */
export function LockGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View style={{ width: size, height: size, alignItems: "center" }}>
      <View
        style={{
          position: "absolute",
          top: 2.5 * u,
          width: 11 * u,
          height: 9 * u,
          borderTopLeftRadius: 5.5 * u,
          borderTopRightRadius: 5.5 * u,
          borderWidth: STROKE * u,
          borderBottomWidth: 0,
          borderColor: color,
        }}
      />
      <View style={outlineRect(u, color, 3.5, 10, 17, 11.5, 3)} />
    </View>
  );
}

/** Çıkış: kapı + ok. */
export function LogOutGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View
        style={rect(u, 3, 3, 10, 18, {
          borderWidth: STROKE * u,
          borderRightWidth: 0,
          borderColor: color,
          borderTopLeftRadius: 2.5 * u,
          borderBottomLeftRadius: 2.5 * u,
        })}
      />
      <View style={line(u, color, 10, 11.1, 11, STROKE)} />
      <View
        style={rect(u, 15.5, 8.4, 7, 7, {
          borderTopWidth: STROKE * u,
          borderRightWidth: STROKE * u,
          borderColor: color,
          borderTopRightRadius: 1.4 * u,
          transform: [{ rotate: "45deg" }],
        })}
      />
    </Frame>
  );
}

/** Çöp kutusu: hesap silme. */
export function TrashGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View style={line(u, color, 3, 6, 18, STROKE)} />
      <View style={outlineRect(u, color, 9, 2.6, 6, 3.4, 1.2)} />
      <View
        style={rect(u, 5, 7.8, 14, 13.6, {
          borderWidth: STROKE * u,
          borderTopWidth: 0,
          borderColor: color,
          borderBottomLeftRadius: 2.6 * u,
          borderBottomRightRadius: 2.6 * u,
        })}
      />
      <View style={line(u, color, 9.6, 11, STROKE, 7)} />
      <View style={line(u, color, 13.6, 11, STROKE, 7)} />
    </Frame>
  );
}

/** Fotoğraf makinesi: profil fotoğrafı eylemi. */
export function CameraGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View style={outlineRect(u, color, 2.5, 6, 19, 14, 3)} />
      <View style={line(u, color, 8, 3.4, 8, 3, { borderRadius: 1.2 * u })} />
      <View
        style={{
          position: "absolute",
          width: 7.4 * u,
          height: 7.4 * u,
          borderRadius: 3.7 * u,
          borderWidth: STROKE * u,
          borderColor: color,
          top: 9.2 * u,
        }}
      />
    </View>
  );
}

/** Bilgi: ipucu ve boş durum rozetleri. */
export function InfoGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          width: 19 * u,
          height: 19 * u,
          borderRadius: 9.5 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 2.2 * u,
          height: 2.2 * u,
          borderRadius: 1.1 * u,
          backgroundColor: color,
          top: 6 * u,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 2.2 * u,
          height: 7 * u,
          borderRadius: 1.1 * u,
          backgroundColor: color,
          top: 10 * u,
        }}
      />
    </View>
  );
}

/** Uyarı: halka + ünlem. `InfoGlyph`'in ters yerleşimi. */
export function AlertGlyph({ size = 18, color }: IconProps) {
  const u = size / 24;
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          position: "absolute",
          width: 19 * u,
          height: 19 * u,
          borderRadius: 9.5 * u,
          borderWidth: STROKE * u,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 2.2 * u,
          height: 7 * u,
          borderRadius: 1.1 * u,
          backgroundColor: color,
          top: 6 * u,
        }}
      />
      <View
        style={{
          position: "absolute",
          width: 2.2 * u,
          height: 2.2 * u,
          borderRadius: 1.1 * u,
          backgroundColor: color,
          top: 15.2 * u,
        }}
      />
    </View>
  );
}

/** Üç dengesiz çubuk: doluluk / etkinlik. */
export function ActivityGlyph({ size = 20, color }: IconProps) {
  const u = size / 24;
  return (
    <Frame size={size}>
      <View
        style={line(u, color, 3.4, 12, 3.2, 8, { borderRadius: 1.4 * u })}
      />
      <View
        style={line(u, color, 10.4, 5, 3.2, 15, { borderRadius: 1.4 * u })}
      />
      <View
        style={line(u, color, 17.4, 9, 3.2, 11, { borderRadius: 1.4 * u })}
      />
    </Frame>
  );
}
