// Service Worker：定期チェックと自動削除
// 拡張の本体。ポップアップや一覧画面は「表示と設定」だけで、削除の実行はすべてここ。
// 認証情報は一切保存しない。vrchat.com にログイン済みのブラウザCookieをそのまま使う。
import {
  getSettings, getProtectedIds, pruneProtectedIds,
  getState, setState, addLog, setPrintCache, selectDeletions, imageUrlCandidates, isTrustedAssetUrl, printTime,
  getBackupDir
} from './common.js';

const ALARM = 'print-check';
const DELETE_INTERVAL_MS = 1500;   // 削除リクエスト間の待ち時間（API負荷対策）
// 公式ドキュメントのホストが先。サイト側プロキシでも同じパスが生きている場合は次で試す。
const API_HOSTS = ['https://api.vrchat.cloud/api/1', 'https://vrchat.com/api/1'];
let hostOrder = [...API_HOSTS];

// HTTPステータスを残したエラー。401（未ログイン）と 429（レート制限）を画面文言で分けたい。
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------- API 呼び出し ----------------
// 削除の正はドキュメントどおり DELETE https://api.vrchat.cloud/api/1/prints/{printId}。
// Service Worker から fetch すると Origin が chrome-extension:// になり、VRChat が拒否する。
// そのため vrchat.com のページ本体（MAIN world）から呼び、Origin を https://vrchat.com にする。

async function fetchDirect(url, method) {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include', // ログインCookieを付ける
      headers: { Accept: 'application/json' },
      cache: 'no-store'       // 枚数は毎回最新が欲しいのでキャッシュしない
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    // ネットワーク断や CORS などで fetch 自体が落ちたとき。status 0 は「応答が無い」。
    return { ok: false, status: 0, text: String(e) };
  }
}

// 空の 200 は削除成功。HTML が 200 で返った場合はプロキシの取り違えなので失敗扱いにする。
function isApiSuccess(result) {
  if (!result?.ok) return false;
  if (!result.text) return true;
  try { JSON.parse(result.text); return true; } catch { return false; }
}

// VRChat が拡張の Origin を拒否した応答。ステータスに関係なく別経路を試す。
function isOriginRejected(result) {
  return typeof result?.text === 'string' && result.text.includes('Origin') && result.text.includes('not acceptable');
}

// 認証・経路・メソッド違いだけ次のホストを試す。429 や 400 は同じ失敗を繰り返さない。
function shouldTryNext(result) {
  if (!result || isOriginRejected(result)) return true;
  return result.status === 0 || result.status === 401 || result.status === 403 || result.status === 404 || result.status === 405;
}

function preferHost(base) {
  hostOrder = [base, ...hostOrder.filter((h) => h !== base)];
}

async function apiFetch(path, method = 'GET') {
  let last = { ok: false, status: 0, text: 'APIに接続できません' };
  for (const base of hostOrder) {
    const url = base + path;
    // ページ本体を先に試す。拡張の Origin は API に拒否される。
    const viaTab = await fetchViaTab(url, method);
    if (isApiSuccess(viaTab)) {
      preferHost(base);
      return parse(viaTab, 'tab');
    }
    if (viaTab) last = viaTab;
    if (viaTab && !shouldTryNext(viaTab)) return parse(viaTab, 'tab');
    const direct = await fetchDirect(url, method);
    if (isApiSuccess(direct)) {
      preferHost(base);
      return parse(direct, 'sw');
    }
    last = direct;
    if (!shouldTryNext(direct)) return parse(direct, 'sw');
  }
  return parse(last, 'sw');
}

function waitForTab(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') finish();
    }).catch(finish);
    setTimeout(finish, 20000);
  });
}

// 開いている vrchat.com を使う。無ければ背面タブを1つ開いて再利用する。
async function ensureVrchatTab() {
  const tabs = await chrome.tabs.query({ url: 'https://vrchat.com/*' });
  if (tabs.length) {
    const tab = tabs.find((t) => t.status === 'complete') || tabs[0];
    if (tab.status !== 'complete') await waitForTab(tab.id);
    return tab.id;
  }
  const created = await chrome.tabs.create({ url: 'https://vrchat.com/home', active: false });
  await waitForTab(created.id);
  return created.id;
}

// ページの MAIN world で fetch する。isolated world だと Origin が拡張のままになる。
async function runInPage(func, args) {
  try {
    const tabId = await ensureVrchatTab();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args,
      func
    });
    return result?.result || null;
  } catch {
    return null;
  }
}

async function fetchViaTab(url, method) {
  return runInPage(async (u, m) => {
    try {
      const r = await fetch(u, { method: m, credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }, [url, method]);
}

// 応答テキストを JSON にして、失敗なら ApiError を投げる。
// transport は 'sw' か 'tab'。どの経路で通ったかを状態に残すためだけに受け取る。
function parse(r, transport) {
  let data = null;
  try { data = r.text ? JSON.parse(r.text) : null; } catch { data = r.text; }
  if (!r.ok) {
    const msg = data?.error?.message || (typeof data === 'string' ? data : '') || `HTTP ${r.status}`;
    throw new ApiError(r.status, msg);
  }
  return { data, transport };
}

// 今ログインしている自分。2FA の途中で止まっている応答は未ログインと同じ扱いにする。
async function getMe() {
  const { data, transport } = await apiFetch('/auth/user');
  if (!data?.id || data.requiresTwoFactorAuth) throw new ApiError(401, '2段階認証が未完了です');
  return { userId: data.id, transport };
}

// VRChatの一覧APIは n を省略すると10件だけ返す。上限は1リクエスト100件。
// 64枚持っていても、パラメータなしだと先頭の10枚しか見えず、削除判定が枚数不足のままになる。
const PRINT_PAGE_SIZE = 100;
const PRINT_MAX_COUNT = 1000; // 応答が繰り返しても打ち切る

// 自分のプリント一覧。offset を進め、短いページが来るまで結合する。
// 配列以外が返ったら API の形が変わったとみなして止める（誤削除防止）。
async function getPrints(userId) {
  const all = [];
  const seen = new Set();
  for (let offset = 0; offset < PRINT_MAX_COUNT;) {
    const { data } = await apiFetch(
      `/prints/user/${encodeURIComponent(userId)}?n=${PRINT_PAGE_SIZE}&offset=${offset}`
    );
    if (!Array.isArray(data)) throw new ApiError(500, 'プリント一覧の形式が想定外です（APIが変わった可能性）');
    for (const p of data) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      all.push(p);
    }
    if (data.length === 0) break;
    offset += data.length;
    // 100件未満は最後のページ。ただし n が無視されて既定の10件だけ返る場合は、次の offset をまだ見る。
    if (data.length < PRINT_PAGE_SIZE && data.length !== 10) break;
  }
  return all;
}

// DELETE /prints/{printId}。成功時の本文は空。
async function deletePrint(printId) {
  await apiFetch(`/prints/${encodeURIComponent(printId)}`, 'DELETE');
}

// ---------------- バックアップ（削除前に画像を保存） ----------------
// ファイル名に使えない文字（Windows の \/:*?"<>| や制御文字）を '_' にする。
// 長すぎるワールド名は 60 文字で切る。空になったら 'unknown'。
function sanitize(s) {
  return String(s || 'unknown').replace(/[\\/:*?"<>|~\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';
}

// 例: VRChatPrints/2026-11-17_175901_ワールド名_printId.png
// 日時を先頭にして、エクスプローラで時系列に並ぶようにする。
function backupFilename(p) {
  const d = new Date(printTime(p) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `VRChatPrints/${stamp}_${sanitize(p.worldName)}_${sanitize(p.id)}.png`;
}

function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 8) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  return png || jpg || webp;
}

const IMAGE_URLS = [
  'https://vrchat.com/*',
  'https://*.vrchat.cloud/*',
  'https://assets.vrchat.com/*'
];

// files.vrchat.cloud は Access-Control-Allow-Origin を返さない。
// 拡張機能自身のリクエストにだけ、そのヘッダを足して画像の中身を読めるようにする。
// 他のサイトの通信には付けない。
let imageCorsReady = null;
function ensureImageCors() {
  if (!imageCorsReady) imageCorsReady = installImageCors();
  return imageCorsReady;
}

async function installImageCors() {
  const origin = `chrome-extension://${chrome.runtime.id}`;
  const filters = ['||vrchat.cloud/', '||vrchat.com/'];
  const addRules = filters.map((urlFilter, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'access-control-allow-origin', operation: 'set', value: origin },
        { header: 'access-control-allow-credentials', operation: 'set', value: 'true' }
      ]
    },
    condition: {
      urlFilter,
      resourceTypes: ['xmlhttprequest'],
      initiatorDomains: [chrome.runtime.id]
    }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: addRules.map((rule) => rule.id),
    addRules
  });
}

async function fetchBytes(url) {
  await ensureImageCors();
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// 画像URLは api.vrchat.cloud から CloudFront などへ転送される。
// ページ内 fetch は転送先の中身を CORS で読めないので、転送先URLだけここで拾う。
function watchRedirects(startUrl) {
  const fileId = startUrl.match(/file_[0-9a-f-]+/i)?.[0] || '';
  let latest = null;
  const listener = (details) => {
    const chain = `${details.url}\n${latest || ''}`;
    if (details.url === startUrl || details.url === latest || (fileId && chain.includes(fileId))) {
      latest = details.redirectUrl;
    }
  };
  chrome.webRequest.onBeforeRedirect.addListener(listener, { urls: IMAGE_URLS });
  return () => {
    chrome.webRequest.onBeforeRedirect.removeListener(listener);
    return latest;
  };
}

// タブ内 fetch の戻り値は JSON 化されるため、画像は base64 で持ち帰る。
async function fetchBytesViaTab(url) {
  const payload = await runInPage(async (u) => {
    try {
      const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) return { ok: false, status: r.status };
      const bytes = new Uint8Array(await r.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x1000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x1000));
      }
      return { ok: true, b64: btoa(binary) };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }, [url]);
  if (!payload?.ok || !payload.b64) return null;
  const bin = atob(payload.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchImageBytes(p) {
  await ensureImageCors();
  const urls = imageUrlCandidates(p);
  if (!urls.length) throw new Error('画像URLが見つかりません');
  for (const url of urls) {
    const stopWatch = watchRedirects(url);
    const viaTab = await fetchBytesViaTab(url);
    const redirected = stopWatch();
    if (looksLikeImage(viaTab)) return viaTab;
    // 転送先は署名付きURLなので、拡張から直接読める。
    for (const target of [redirected, url]) {
      if (!isTrustedAssetUrl(target)) continue;
      const direct = await fetchBytes(target);
      if (looksLikeImage(direct)) return direct;
    }
  }
  throw new Error('画像を取得できませんでした');
}

// 許可済みフォルダの VRChatPrints/ に直接書く。保存ダイアログは出さない。
// 書けなかった場合は例外にして、呼び出し側が削除を止める。
async function backupPrint(p) {
  const bytes = await fetchImageBytes(p);
  const dir = await getBackupDir();
  if (!dir) throw new Error('保存先フォルダが未許可のため削除を中止しました。一覧・設定を開いて保存先を許可してください');
  // サービスワーカーから requestPermission は出せない（ユーザー操作と一覧タブが要る）。
  // ここは許可の有無だけ見て、切れていれば削除せず一覧での再開を案内する。
  const perm = await dir.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('保存先フォルダの許可が切れています。一覧・設定で「保存先へのアクセスを再開」を押し、「次回以降も許可」を選んでください');
  const folder = await dir.getDirectoryHandle('VRChatPrints', { create: true });
  const name = backupFilename(p).split('/').pop();
  const file = await folder.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  await stream.write(bytes);
  await stream.close();
}

// ---------------- バッジ ----------------
// ツールバーアイコンの数字。色の意味は README と同じ。
// 灰 = 自動削除OFF、赤 = 上限以上、青 = 余裕あり、橙の「!」= 直近の実行がエラー。
async function updateBadge(count, settings, error) {
  if (error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    return;
  }
  await chrome.action.setBadgeText({ text: count == null ? '' : String(count) });
  const full = count != null && count >= settings.triggerCount;
  await chrome.action.setBadgeBackgroundColor({ color: !settings.enabled ? '#6b7280' : full ? '#dc2626' : '#2563eb' });
}

// ---------------- メイン処理 ----------------
// アラームと「今すぐチェック」が同時に来ても、実行は1本にまとめる。
// running が Promise のあいだは、後から来た呼び出しも同じ Promise を待つ。
let running = null;

function run(reason) {
  if (!running) running = doRun(reason).finally(() => { running = null; });
  return running;
}

// reason は 'alarm'（定期）か 'manual'（ボタン）。ログには出さず、戻り値の summary にだけ載せる。
async function doRun(reason) {
  const settings = await getSettings();
  const summary = { reason, count: null, deleted: [], wouldDelete: [], error: null, enabled: settings.enabled, dryRun: settings.dryRun };
  try {
    const { userId, transport } = await getMe();
    const prints = await getPrints(userId);
    summary.count = prints.length;
    // もう持っていないプリントの ★ を保護リストから外す
    await pruneProtectedIds(prints.map((p) => p.id));

    // 自動削除OFFでも、上の枚数取得とバッジ更新は行う。消す処理だけをここで止める。
    if (settings.enabled) {
      const protectedSet = await getProtectedIds();
      const targets = selectDeletions(prints, settings, protectedSet, userId);

      // 上限なのに消せるものが1枚もない（全部★、または他人のプリント除外で残っていない）
      if (prints.length >= settings.triggerCount && targets.length === 0) {
        await addLog('warn', `上限 ${settings.triggerCount} 枚に達していますが、削除できるプリントがありません（すべて保護中など）`);
      }

      for (const p of targets) {
        const label = `${p.worldName || '不明なワールド'} / ${p.id}`;
        if (settings.dryRun) {
          summary.wouldDelete.push(p.id);
          await addLog('info', `[ドライラン] 削除対象: ${label}`);
          continue;
        }
        // 保存できなかったプリントは消さない。以降の枚数も、原因が直るまでこの回は止める。
        if (settings.backupBeforeDelete) {
          try {
            await backupPrint(p);
          } catch (e) {
            await addLog('error', `バックアップに失敗したため削除を中止: ${label} — ${e.message}`);
            break;
          }
        }
        await deletePrint(p.id);
        summary.deleted.push(p.id);
        await addLog('info', `削除: ${label}`);
        // 連続DELETEでレート制限に当たらないよう、次の1枚まで待つ
        await new Promise((r) => setTimeout(r, DELETE_INTERVAL_MS));
      }
      // 削除後の枚数。一覧を取り直さず、消した件数だけ引く（ドライランでは deleted が空なので減らない）。
      summary.count = prints.length - summary.deleted.length;
    }

    // 開いている一覧は、この控えが変わったときに再描画する。チェック間隔がそのまま更新間隔になる。
    const removed = new Set(summary.deleted);
    await setPrintCache(userId, prints.filter((p) => !removed.has(p.id)));
    await setState({ lastRunAt: new Date().toISOString(), lastCount: summary.count, lastError: null, userId, transport });
    await updateBadge(summary.count, settings, null);
  } catch (e) {
    const msg = e instanceof ApiError && e.status === 401
      ? 'vrchat.com にログインしていません（またはセッション切れ）。ブラウザで vrchat.com にログインしてください。'
      : e instanceof ApiError && e.status === 429
        ? 'APIのレート制限中です。しばらく待ってから再試行します。'
        : `エラー: ${e.message}`;
    summary.error = msg;
    const prev = await getState();
    // 1分ごとのアラームで同じ未ログインエラーを延々とログに積まない
    if (prev.lastError !== msg) await addLog('error', msg);
    await setState({ lastRunAt: new Date().toISOString(), lastError: msg });
    await updateBadge(null, settings, msg);
  }
  return summary;
}

// ---------------- スケジュール ----------------
// 既存アラームを消してから作り直す。間隔を変えたときに古い周期が残らないようにする。
// delayInMinutes: 0.1 で、登録の約6秒後に初回を走らせる（起動直後の取りこぼしを減らす）。
async function schedule() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: settings.intervalMinutes });
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) run('alarm');
});

// 設定が変わったらバッジを描き直し、間隔が変わったときだけアラームを組み直す。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (before.intervalMinutes !== after.intervalMinutes) schedule();
    getState().then((s) => getSettings().then((st) => updateBadge(s.lastCount, st, s.lastError)));
  }
});

// ---------------- 画面からのメッセージ ----------------
// popup.js / manager.js は API を直接叩かず、ここへメッセージを送る。
// リスナーは true を返して、非同期の sendResponse を後から使えるようにする。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'runNow') return run('manual');
    if (msg?.type === 'getPrints') {
      // 一覧画面用。削除はせず、枚数とバッジだけ更新してプリント配列を返す。
      const { userId } = await getMe();
      const prints = await getPrints(userId);
      const settings = await getSettings();
      await setPrintCache(userId, prints);
      await setState({ lastCount: prints.length, lastError: null, userId });
      await updateBadge(prints.length, settings, null);
      return { userId, prints };
    }
    throw new Error('unknown message');
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e instanceof ApiError && e.status === 401
      ? 'vrchat.com にログインしていません。ログインしてから再読み込みしてください。'
      : e.message })
  );
  return true; // 非同期レスポンス
});
