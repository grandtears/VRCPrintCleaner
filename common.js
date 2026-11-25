// 共通の設定・ストレージ・削除対象選定ロジック
// background.js（定期実行）/ popup.js（アイコン横の小窓）/ manager.js（一覧・設定ページ）から import される。
// ここに置いているのは「どの画面からも同じ判断をしたいもの」だけ。API通信そのものは background.js 側。

// ドキュメント上のAPIは api.vrchat.cloud。サイト本体の vrchat.com でも同じパスが通ることがある。
// 呼び出し順の切替は background.js。ここは画像URLの置換にだけ使う。
export const API_BASE = 'https://api.vrchat.cloud/api/1';

// 初回インストール時の設定。ユーザーが画面で変えるまではこの値を使う。
export const DEFAULT_SETTINGS = {
  enabled: false,          // 初回は無効。確認してから有効化してもらう（誤削除防止）
  triggerCount: 64,        // この枚数に達したら削除を始める（VRC+ の上限が 64）
  targetCount: 63,         // 削除後、この枚数まで減らす（trigger より必ず小さくする）
  intervalMinutes: 1,      // 何分おきに枚数を見に行くか
  maxPerRun: 5,            // 1回の実行で消す最大枚数。バグや設定ミスで一気に消さないための上限
  keepOthersPrints: false, // true のとき、他人が撮って自分のコレクションに入ったプリントは消さない
  backupBeforeDelete: true,// true のとき、削除の前に画像をダウンロードフォルダへ保存する
  dryRun: false            // true のとき、実際には削除せず「消す予定」をログに書くだけ
};

// --- 設定（chrome.storage.sync） ---
// sync は同じ Google アカウントの Chrome 同士で共有される。
// 容量は小さいので、設定と保護IDだけを置く。ログや最終状態は local 側。

// 保存済み設定を読み、未保存のキーは初期値で埋めてから正規化する。
export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings || {}) });
}

// 一部のキーだけ上書きして保存する。画面のチェックボックス1つ分の変更に使う。
export async function saveSettings(partial) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await chrome.storage.sync.set({ settings: next });
  return next;
}

// 画面から来た値を、APIや削除処理が安心して使える範囲に直す。
// 文字列の "64" や空欄、範囲外の数値が混ざってもここで整数に落とす。
export function normalizeSettings(s) {
  // 数値として解釈できないときは初期値。解釈できたら min〜max に収める。
  const int = (v, min, max, def) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const out = { ...s };
  out.triggerCount = int(s.triggerCount, 1, 64, DEFAULT_SETTINGS.triggerCount);
  out.targetCount = int(s.targetCount, 0, 63, DEFAULT_SETTINGS.targetCount);
  // 「削除後の枚数」が開始枚数以上だと、1枚も減らせず無限に条件を満たし続ける。
  // 必ず開始枚数より1枚少なくする。
  if (out.targetCount >= out.triggerCount) out.targetCount = out.triggerCount - 1;
  out.intervalMinutes = int(s.intervalMinutes, 1, 60, DEFAULT_SETTINGS.intervalMinutes);
  out.maxPerRun = int(s.maxPerRun, 1, 64, DEFAULT_SETTINGS.maxPerRun);
  // チェックボックス由来の値を必ず true / false にする（"false" 文字列などを防ぐ）
  for (const k of ['enabled', 'keepOthersPrints', 'backupBeforeDelete', 'dryRun']) out[k] = !!s[k];
  return out;
}

// --- 保護（★）リスト（chrome.storage.sync、プリントIDの配列） ---
// 「消したくないプリント」の ID だけを覚える。画像本体は保存しない。

// 保護中のプリントIDを Set で返す。検索を O(1) にするため配列のまま扱わない。
export async function getProtectedIds() {
  const { protectedIds } = await chrome.storage.sync.get('protectedIds');
  return new Set(Array.isArray(protectedIds) ? protectedIds : []);
}

// 1枚の保護を付ける / 外す。画面の ★ ボタンから呼ばれる。
export async function setProtected(printId, isProtected) {
  const set = await getProtectedIds();
  if (isProtected) set.add(printId); else set.delete(printId);
  await chrome.storage.sync.set({ protectedIds: [...set] });
  return set;
}

// もう存在しないプリントの保護IDを捨てる。
// sync ストレージは容量が小さいので、削除済み・期限切れのIDを残し続けない。
export async function pruneProtectedIds(existingIds) {
  const set = await getProtectedIds();
  const exist = new Set(existingIds);
  const next = [...set].filter((id) => exist.has(id));
  // 変化がなければ書き込まない（不要な storage イベントと同期を避ける）
  if (next.length !== set.size) await chrome.storage.sync.set({ protectedIds: next });
}

// --- 状態・ログ（chrome.storage.local） ---
// local はこのブラウザだけ。枚数・エラー・ログは端末ごとに違ってよいので sync にしない。

// 直近の実行結果。画面の「何枚 / 最終チェック / エラー」表示の元になる。
export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || { lastRunAt: null, lastCount: null, lastError: null, userId: null };
}

// 状態の一部だけ上書きする。渡していないキーは前の値を残す。
export async function setState(partial) {
  const state = { ...(await getState()), ...partial };
  await chrome.storage.local.set({ state });
  return state;
}

export async function getLogs() {
  const { logs } = await chrome.storage.local.get('logs');
  return Array.isArray(logs) ? logs : [];
}

// 新しいログを先頭に足し、100件を超えた古い分は捨てる。
// level は 'info' | 'warn' | 'error'。一覧画面の色分けに使う。
export async function addLog(level, message) {
  const logs = await getLogs();
  logs.unshift({ at: new Date().toISOString(), level, message });
  await chrome.storage.local.set({ logs: logs.slice(0, 100) });
}

// 一覧画面が開いたままでも、定期チェックの結果でカードを描き直すための控え。
// 画面が使う項目だけ残す。APIの余分なフィールドでストレージを膨らませない。
function slimPrint(p) {
  const image = p?.files?.image;
  return {
    id: p.id,
    worldName: p.worldName || '',
    authorId: p.authorId || '',
    authorName: p.authorName || '',
    note: p.note || '',
    createdAt: p.createdAt || p.timestamp || '',
    files: image ? { image } : {}
  };
}

export async function setPrintCache(userId, prints) {
  await chrome.storage.local.set({
    printCache: {
      at: new Date().toISOString(),
      userId,
      prints: (prints || []).filter((p) => p?.id).map(slimPrint)
    }
  });
}

// --- プリントのユーティリティ ---

// プリントの作成時刻をミリ秒で返す。APIのフィールド名が変わっても createdAt / timestamp の両方を見る。
// 日付として読めないものは 0（最古扱い）にして、並び順が壊れないようにする。
export function printTime(p) {
  const t = Date.parse(p.createdAt || p.timestamp || '');
  return Number.isFinite(t) ? t : 0;
}

// 削除は「古いものから」。元の配列は壊さない（画面は新しい順で表示したいため）。
export function sortOldestFirst(prints) {
  return [...prints].sort((a, b) => printTime(a) - printTime(b));
}

// この1枚を自動削除してよいか。
// 保護中、または「他人のプリントは残す」設定で作者が自分でないものは対象外。
export function isDeletable(p, settings, protectedSet, userId) {
  if (protectedSet.has(p.id)) return false;
  // authorId が無い古いデータは判定できないので、設定ONでも削除対象に残す
  if (settings.keepOthersPrints && userId && p.authorId && p.authorId !== userId) return false;
  return true;
}

// 消してよいプリントを古い順に並べた配列。実際に何枚消すかは selectDeletions が決める。
export function deletionOrder(prints, settings, protectedSet, userId) {
  return sortOldestFirst(prints).filter((p) => isDeletable(p, settings, protectedSet, userId));
}

// 今回の実行で実際に手を付けるプリントを選ぶ。
// 枚数が開始枚数未満なら何もしない。超えていても 1回の上限（maxPerRun）まで。
export function selectDeletions(prints, settings, protectedSet, userId) {
  if (prints.length < settings.triggerCount) return [];
  // 例: 64枚持っていて目標が 63 なら、1枚だけ減らせばよい
  const need = prints.length - settings.targetCount;
  if (need <= 0) return [];
  return deletionOrder(prints, settings, protectedSet, userId).slice(0, Math.min(need, settings.maxPerRun));
}

// VRChat の画像配信先だけを許可する。それ以外へ Cookie 付きで取りに行かない。
export function isTrustedAssetUrl(url) {
  try {
    const host = new URL(url).hostname;
    return url.startsWith('https://') && (
      host === 'vrchat.com' || host.endsWith('.vrchat.com') ||
      host === 'vrchat.cloud' || host.endsWith('.vrchat.cloud') ||
      host === 'assets.vrchat.com'
    );
  } catch {
    return false;
  }
}

// サムネイルやバックアップに使う画像URL。
export function imageUrl(p) {
  const url = p?.files?.image || '';
  return isTrustedAssetUrl(url) ? url : '';
}

// 同じ画像を、api.vrchat.cloud と vrchat.com の両方で試すための候補。
export function imageUrlCandidates(p) {
  const url = imageUrl(p);
  if (!url) return [];
  const swapped = url.includes('://api.vrchat.cloud/')
    ? url.replace('://api.vrchat.cloud/', '://vrchat.com/')
    : url.replace('://vrchat.com/', '://api.vrchat.cloud/');
  return swapped === url ? [url] : [url, swapped];
}

// --- 保存先フォルダ（IndexedDB に FileSystemDirectoryHandle を置く） ---
// chrome.downloads は「ダウンロード前に保存場所を確認する」がオンだと、saveAs:false でも
// ファイルごとにダイアログを出す。許可済みフォルダへ直接書くと、その設定に影響されない。
const DIR_DB = 'print-cleaner';
const DIR_STORE = 'fs';
let cachedBackupDir = null;

function openDirDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DIR_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DIR_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getBackupDir() {
  const db = await openDirDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DIR_STORE, 'readonly');
    const req = tx.objectStore(DIR_STORE).get('dir');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBackupDir(handle) {
  cachedBackupDir = handle;
  const db = await openDirDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DIR_STORE, 'readwrite');
    tx.objectStore(DIR_STORE).put(handle, 'dir');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return handle;
}

// Chrome は、この拡張のページ（一覧・ポップアップ）が全部閉じるとフォルダ許可を破棄する。
// ハンドル自体は IndexedDB に残る。次に一覧タブで requestPermission すると
// 「今回のみ / 次回以降も許可」が出る。次回以降も許可を選ぶと、タブを閉じても
// Chrome を終了しても再許可は不要になる。今回のみだと、次に閉じたときまた切れる。
// ポップアップにはこのダイアログを出す枠が無いので、許可の取り直しは一覧タブで行う。
const WRITE_ACCESS = { mode: 'readwrite' };

export async function getBackupAccess() {
  const handle = cachedBackupDir || await getBackupDir();
  if (!handle) return { state: 'missing', handle: null, name: '' };
  let state = 'prompt';
  try {
    const perm = await handle.queryPermission(WRITE_ACCESS);
    state = perm === 'granted' ? 'granted' : perm === 'denied' ? 'denied' : 'prompt';
  } catch {
    state = 'prompt';
  }
  if (state === 'granted') cachedBackupDir = handle;
  return { state, handle, name: handle.name || '' };
}

// クリック中に呼ぶ。保存済みのフォルダに対して許可だけ取り直す。フォルダ選択は出さない。
export async function restoreBackupAccess() {
  const { state, handle } = await getBackupAccess();
  if (!handle) {
    const err = new Error('保存先フォルダがまだ選ばれていません');
    err.code = 'missing';
    throw err;
  }
  if (state === 'granted') return handle;
  const perm = await handle.requestPermission(WRITE_ACCESS);
  if (perm !== 'granted') {
    const err = new Error('保存先フォルダが許可されませんでした。ダイアログでは「次回以降も許可」を選んでください');
    err.code = 'denied';
    throw err;
  }
  cachedBackupDir = handle;
  return handle;
}

// 許可済みならダイアログなし。未選択、または force のときだけフォルダ選択を出す（クリック中に呼ぶ）。
// ハンドルが残っていて許可だけ切れているときは、フォルダを選び直さず requestPermission に進む。
export async function ensureBackupDir(force = false) {
  if (!force) {
    const { state, handle } = await getBackupAccess();
    if (handle && state === 'granted') return handle;
    if (handle) return restoreBackupAccess();
  }
  if (typeof showDirectoryPicker !== 'function') {
    throw new Error('保存先フォルダが未許可です。一覧・設定を開いて許可してください。');
  }
  const dir = await showDirectoryPicker({
    id: 'VRChatPrints',
    mode: 'readwrite',
    startIn: 'downloads'
  });
  const saved = await saveBackupDir(dir);
  const { backupPersistHint } = await chrome.storage.local.get('backupPersistHint');
  if (!backupPersistHint) {
    await chrome.storage.local.set({ backupPersistHint: true });
    alert(
      'フォルダを記憶しました。\n\n' +
      'Chrome またはこのタブを閉じると、アクセス許可は一度切れます。\n' +
      'そのあと一覧・設定で「保存先へのアクセスを再開」を押し、\n' +
      'ダイアログが出たら「次回以降も許可」を選んでください。\n' +
      '以後は、タブを閉じても Chrome を終了しても再許可は不要です。\n\n' +
      '「今回のみ」を選ぶと、次に閉じたときまた聞かれます。'
    );
  }
  return saved;
}

// ISO文字列やミリ秒を「2026/11/17 17:59」の形にする。値が無ければ '-'。
export function formatDate(t) {
  if (!t) return '-';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
