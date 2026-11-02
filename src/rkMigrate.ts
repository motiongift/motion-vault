// Legacy phone-access copies (follow-up to V12 F-28; 2026-10-28). Owner: "we must never lose users' money, strictly. If
// something changed and old versions remain, find out how many such accounts exist and show each of them a prompt to sign /
// migrate. Only that way."
//
// What changed: since V12 F-28 (389fe5b, 2026-10-24) a phone-access recovery copy (profile.rk) is sealed with the main
// wallet's own signature inside (body {v:2, s, ms, mv}). A copy written by an engine before that (19–24 Oct) has body {v:1, s}
// and no main signature. A phone that restores through such a copy marks its seed 'rk1' (unverified): its new wallets are
// standalone keys that the account backup does NOT receive (webEngine mainProfile). Nothing re-sealed the old copies.
//
// The migration, explicit and visible, never silent, never deleting:
//   desktop (main attached, seed verified) — the page shows "Update your phone access — sign once to keep every wallet backed
//     up"; the vault's own dialog (UPDATE_DIALOG) re-seals the copy as v2 bound to the main's signature. Cancel = nothing.
//   phone ('rk1') — a v2 copy on the server, opened with the account's recovery wallet, whose main signature is the main's AND
//     derives exactly the seed this phone already holds, proves that seed: the phone marks it 'main' (adoptCheck) and its
//     next publish seals every wallet it holds (a union with the server copy: nothing is dropped).
//
// Pure: no DOM, no storage, no network. webEngine.ts wires it; test/legacy-rk.mjs runs it with real signatures.
import { MAIN_MSG, seedOfSignature, unb64, type MainMsgVersion, type OpenedRecovery } from './vaultRecovery.ts';

// ── which body a recovery copy carries, read from its OUTER envelope only (no key needed; the server can count the same) ──
// AES-GCM adds 16 bytes to the plaintext. A legacy body JSON.stringify({ v: 1, s }) is exactly 80 bytes (the seed is always
// 0x + 64 lower-case hex): 96 bytes of ciphertext, 128 base64 characters. A v2 body ({ v: 2, s, ms, mv }, ms = 0x + 130 hex)
// is 227 bytes: 243 / 324. Nothing else was ever written. 0 = not a recovery copy we know.
export const RK_LEGACY_CT_BYTES = 96;
export const RK_V2_CT_BYTES = 243;
export function recoveryBodyVersion(rk: unknown): 0 | 1 | 2 {
  if (!rk || typeof rk !== 'object') return 0;
  const r = rk as { v?: unknown; addr?: unknown; iv?: unknown; ct?: unknown };
  if (r.v !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(String(r.addr || '')) || !/^[A-Za-z0-9+/=]{16}$/.test(String(r.iv || '')) || !/^[A-Za-z0-9+/=]{20,400}$/.test(String(r.ct || ''))) return 0;
  let n = 0; try { n = unb64(String(r.ct)).length; } catch { return 0; }
  return n === RK_LEGACY_CT_BYTES ? 1 : n === RK_V2_CT_BYTES ? 2 : 0;
}

// ── the phone's adoption of a v2 copy: every check, in order; any failure leaves the phone exactly as it was ──
// opened: openRecovery(profile.rk, main, recoverySig) (the recovery wallet's own signature, checked by the caller);
// localSeed / localMv: what this phone holds for the main (seedSrc 'rk1'); fp: profile.fp.
export type AdoptWhy = 'not-v2' | 'signer' | 'seed' | 'local-seed' | 'fp' | 'text';
export async function adoptCheck(src: { opened: OpenedRecovery | null; main: string; localSeed: string; localMv: MainMsgVersion; fp: string; fingerprint: (seed: string) => Promise<string>; recover: (message: string, signature: string) => Promise<string> }): Promise<{ ok: true; ms: string; mv: MainMsgVersion } | { ok: false; why: AdoptWhy }> {
  const o = src.opened;
  if (!o || !o.ms || !/^0x[0-9a-fA-F]{130}$/.test(o.ms)) return { ok: false, why: 'not-v2' };
  const mv: MainMsgVersion = o.mv === 2 ? 2 : 1;
  // the text this phone's seed was attached with: another text derives other wallets (and the server refuses a switch)
  if (mv !== src.localMv) return { ok: false, why: 'text' };
  const main = String(src.main).toLowerCase();
  const signer = String(await src.recover(MAIN_MSG(main, mv), o.ms).catch(() => '')).toLowerCase();
  if (signer !== main) return { ok: false, why: 'signer' };
  const fromMs = await seedOfSignature(o.ms);
  if (fromMs !== o.seed) return { ok: false, why: 'seed' };
  // the decisive one: the main's own signature derives EXACTLY the seed this phone already uses. A different seed here would
  // mean the phone's seed was never the account's (planted through the unbound copy): nothing is adopted, nothing is sealed.
  if (fromMs !== src.localSeed) return { ok: false, why: 'local-seed' };
  if (!src.fp || (await src.fingerprint(fromMs)) !== src.fp) return { ok: false, why: 'fp' };
  return { ok: true, ms: o.ms, mv };
}

// ── the wallets of an 'rk1' phone that the account backup does not hold: union rule, never shrinking ──
// wallets: backupWalletsOf(main) (every keyed wallet the backup would carry); covered: meta.rk1[main].addrs (restored from the
// account); returns the ones that exist only on this phone.
export const localOnly = <T extends { address: string }>(wallets: T[], covered: string[]): T[] => {
  const c = new Set(covered.map((a) => String(a).toLowerCase()));
  return wallets.filter((w) => !c.has(String(w.address).toLowerCase()));
};

// ── the dialogs' words in the app's six languages ──
export const RK_LANGS = ['en', 'ru', 'zh', 'id', 'es', 'fr'] as const;
export type RkLang = typeof RK_LANGS[number];
// 'ru', 'ru-RU', 'zh-CN', 'id', 'in' (old Indonesian), 'ms' → one of the six; anything else English
export const rkLangOf = (v: unknown): RkLang => {
  const s = String(v || '').toLowerCase().trim();
  if ((RK_LANGS as readonly string[]).includes(s)) return s as RkLang;
  const p = s.split(/[-_]/)[0];
  if (p === 'in' || p === 'ms') return 'id';
  if (p === 'uk' || p === 'be') return 'ru';
  return (RK_LANGS as readonly string[]).includes(p) ? p as RkLang : 'en';
};

// The desktop's re-seal (mainRecoveryUpdate): what it does in one sentence, what cancel means.
export const UPDATE_DIALOG: Record<RkLang, { title: string; ok: string; cancel: string; sub: string; why: string; note: string; wallet: string }> = {
  en: { title: 'Update your phone access', ok: 'Update', cancel: 'Not now', sub: 'Sign once to keep every wallet backed up.', why: 'Your phone access copy is sealed again, now bound to your main wallet. Wallets made on a phone that signed in with it join your encrypted backup.', note: 'Cancel keeps everything as it is.', wallet: 'Recovery wallet' },
  ru: { title: 'Обновите доступ с телефона', ok: 'Обновить', cancel: 'Не сейчас', sub: 'Подпишите один раз, чтобы все кошельки были в резервной копии.', why: 'Копия для доступа с телефона запечатывается заново и теперь привязана к вашему основному кошельку. Кошельки, созданные на телефоне, который вошёл через неё, попадут в вашу зашифрованную копию.', note: 'Отмена оставляет всё как есть.', wallet: 'Кошелёк восстановления' },
  zh: { title: '更新手机访问', ok: '更新', cancel: '暂不', sub: '签名一次，让每个钱包都有备份。', why: '手机访问副本会重新封存，并绑定到你的主钱包。通过它登录的手机上创建的钱包会加入你的加密备份。', note: '取消则一切保持不变。', wallet: '恢复钱包' },
  id: { title: 'Perbarui akses ponsel', ok: 'Perbarui', cancel: 'Nanti', sub: 'Tanda tangani sekali agar setiap dompet tercadangkan.', why: 'Salinan akses ponsel Anda disegel ulang, kini terikat ke dompet utama Anda. Dompet yang dibuat di ponsel yang masuk dengannya ikut masuk ke cadangan terenkripsi Anda.', note: 'Batal membiarkan semuanya seperti sekarang.', wallet: 'Dompet pemulihan' },
  es: { title: 'Actualiza el acceso desde el móvil', ok: 'Actualizar', cancel: 'Ahora no', sub: 'Firma una vez para que todas tus wallets queden en tu copia.', why: 'La copia de acceso desde el móvil se vuelve a sellar, ahora vinculada a tu wallet principal. Las wallets creadas en un móvil que inició sesión con ella entran en tu copia cifrada.', note: 'Cancelar lo deja todo como está.', wallet: 'Wallet de recuperación' },
  fr: { title: 'Mettez à jour l’accès mobile', ok: 'Mettre à jour', cancel: 'Plus tard', sub: 'Signez une fois pour que chaque wallet soit sauvegardé.', why: 'La copie d’accès mobile est scellée à nouveau, désormais liée à votre wallet principal. Les wallets créés sur un téléphone connecté avec elle rejoignent votre sauvegarde chiffrée.', note: 'Annuler laisse tout tel quel.', wallet: 'Wallet de récupération' },
};

// "Remove wallet": the truth about the account backup (the live server's union keeps a removed wallet's sealed entry, so a
// wallet the backup holds stays restorable; one it does NOT hold — no account, or made on an 'rk1' phone — is gone for good).
export const REMOVE_DIALOG: Record<RkLang, { title: (name: string) => string; ok: string; cancel: string; kept: string; keptNote: string; lost: string; lostNote: string }> = {
  en: { title: (n) => `Remove ${n}?`, ok: 'Remove wallet', cancel: 'Keep it', kept: 'Removed from this device. It stays in your encrypted backup and can be restored.', keptNote: 'Restore it any time from Wallets.', lost: 'Its key is erased from this device. This wallet is not in your encrypted backup.', lostNote: 'Export it or download a backup file first if it holds funds. This can\'t be undone.' },
  ru: { title: (n) => `Удалить ${n}?`, ok: 'Удалить кошелёк', cancel: 'Оставить', kept: 'Удаляется с этого устройства. Он остаётся в вашей зашифрованной копии, и его можно восстановить.', keptNote: 'Восстановить можно в любой момент в разделе «Кошельки».', lost: 'Ключ стирается с этого устройства. Этого кошелька нет в вашей зашифрованной копии.', lostNote: 'Если на нём есть средства, сначала экспортируйте ключ или скачайте файл копии. Это нельзя отменить.' },
  zh: { title: (n) => `移除 ${n}？`, ok: '移除钱包', cancel: '保留', kept: '将从此设备移除。它仍在你的加密备份中，可以恢复。', keptNote: '随时可在「钱包」中恢复。', lost: '其密钥将从此设备抹去。此钱包不在你的加密备份中。', lostNote: '若其中有资金，请先导出或下载备份文件。此操作无法撤销。' },
  id: { title: (n) => `Hapus ${n}?`, ok: 'Hapus dompet', cancel: 'Simpan', kept: 'Dihapus dari perangkat ini. Dompet tetap ada di cadangan terenkripsi Anda dan bisa dipulihkan.', keptNote: 'Pulihkan kapan saja dari Dompet.', lost: 'Kuncinya dihapus dari perangkat ini. Dompet ini tidak ada di cadangan terenkripsi Anda.', lostNote: 'Ekspor atau unduh file cadangan dulu jika ada dananya. Ini tidak bisa dibatalkan.' },
  es: { title: (n) => `¿Eliminar ${n}?`, ok: 'Eliminar wallet', cancel: 'Conservarla', kept: 'Se elimina de este dispositivo. Sigue en tu copia cifrada y se puede restaurar.', keptNote: 'Restáurala cuando quieras desde Wallets.', lost: 'Su clave se borra de este dispositivo. Esta wallet no está en tu copia cifrada.', lostNote: 'Si tiene fondos, expórtala o descarga un archivo de copia antes. No se puede deshacer.' },
  fr: { title: (n) => `Supprimer ${n} ?`, ok: 'Supprimer le wallet', cancel: 'Le garder', kept: 'Supprimé de cet appareil. Il reste dans votre sauvegarde chiffrée et peut être restauré.', keptNote: 'Restaurez-le quand vous voulez depuis Wallets.', lost: 'Sa clé est effacée de cet appareil. Ce wallet n’est pas dans votre sauvegarde chiffrée.', lostNote: 'Exportez-le ou téléchargez un fichier de sauvegarde d’abord s’il contient des fonds. C’est irréversible.' },
};

// A transfer between own wallets whose destination exists only on this phone ('rk1', not in the account backup yet).
export const UNBACKED_SEND: Record<RkLang, { title: string; ok: string; cancel: string; sub: (name: string) => string; note: string }> = {
  en: { title: 'Not in your backup yet', ok: 'Send anyway', cancel: 'Don’t send', sub: (n) => `${n} exists only on this device: it isn't in your encrypted backup yet. If this browser's data is cleared, what you send there is lost.`, note: 'Open motion on your computer (or connect your main wallet here) and confirm once, or download a backup file first.' },
  ru: { title: 'Ещё не в резервной копии', ok: 'Всё равно отправить', cancel: 'Отмена', sub: (n) => `${n} есть только на этом устройстве: его ещё нет в вашей зашифрованной копии. Если данные этого браузера сотрутся, отправленное туда пропадёт.`, note: 'Откройте motion на компьютере (или подключите здесь основной кошелёк) и подтвердите один раз, либо сначала скачайте файл копии.' },
  zh: { title: '尚未备份', ok: '仍然发送', cancel: '取消', sub: (n) => `${n} 只存在于此设备上：它还不在你的加密备份中。若此浏览器的数据被清除，发送到那里的资产将会丢失。`, note: '请在电脑上打开 motion（或在此连接主钱包）并确认一次，或先下载备份文件。' },
  id: { title: 'Belum ada di cadangan', ok: 'Tetap kirim', cancel: 'Batal', sub: (n) => `${n} hanya ada di perangkat ini: belum ada di cadangan terenkripsi Anda. Jika data browser ini terhapus, yang Anda kirim ke sana akan hilang.`, note: 'Buka motion di komputer Anda (atau hubungkan dompet utama di sini) dan konfirmasi sekali, atau unduh file cadangan dulu.' },
  es: { title: 'Aún no está en tu copia', ok: 'Enviar igualmente', cancel: 'Cancelar', sub: (n) => `${n} solo existe en este dispositivo: aún no está en tu copia cifrada. Si se borran los datos de este navegador, lo que envíes allí se pierde.`, note: 'Abre motion en tu ordenador (o conecta aquí tu wallet principal) y confirma una vez, o descarga antes un archivo de copia.' },
  fr: { title: 'Pas encore sauvegardé', ok: 'Envoyer quand même', cancel: 'Annuler', sub: (n) => `${n} n’existe que sur cet appareil : il n’est pas encore dans votre sauvegarde chiffrée. Si les données de ce navigateur sont effacées, ce que vous y envoyez est perdu.`, note: 'Ouvrez motion sur votre ordinateur (ou connectez ici votre wallet principal) et confirmez une fois, ou téléchargez d’abord un fichier de sauvegarde.' },
};
