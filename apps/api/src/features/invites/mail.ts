import { env } from "../../core/env.js";
import { findChainSettings } from "../../core/db.js";
import { sendMail } from "../../core/mailer.js";
import type { MemberInviteDocument } from "./invites.js";

export async function sendInviteMail(
  invite: MemberInviteDocument,
  token: string,
): Promise<void> {
  const settings = await findChainSettings();
  const chainName = settings?.chainName || "OpenGym";
  const link = `${env.publicWebUrl}/invite#token=${token}`;
  const expiry = invite.expiresAt.toLocaleString("tr-TR", {
    timeZone: env.reportsTimeZone,
  });
  await sendMail({
    to: invite.email,
    subject: `${chainName} üyelik davetiniz`,
    text: `Merhaba ${invite.firstName},\n\n${chainName} sizi OpenGym'e davet ediyor. Hesabınızı oluşturmak için aşağıdaki bağlantıyı açın, yasal belgeleri okuyup her iki onayı verin ve şifrenizi belirleyin.\n\n${link}\n\nBu tek kullanımlık bağlantı ${expiry} tarihine kadar geçerlidir. Kabul etmezseniz davetteki bilgileriniz süre dolduğunda otomatik silinir.\n\nHesabınız hazır olduğunda OpenGym mobil uygulamasından giriş yapabilirsiniz.`,
  });
}
