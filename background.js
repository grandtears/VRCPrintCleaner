// Service Worker：定期チェックと自動削除
// 拡張の本体。ポップアップや一覧画面は「表示と設定」だけで、削除の実行はすべてここ。
// 認証情報は一切保存しない。vrchat.com にログイン済みのブラウザCookieをそのまま使う。
import {
  API_BASE, getSettings, getProtectedIds, pruneProtectedIds,
  getState, setState, addLog, selectDeletions, imageUrl, printTime
} from './common.js';

const ALARM = 'print-check';
const DELETE_INTERVAL_MS = 1500;   // 削除リクエスト間の待ち時間（API負荷対策）
const DOWNLOAD_TIMEOUT_MS = 60000; // 画像保存がこの時間を超えたら失敗扱いにして、削除しない

// HTTPステータスを残したエラー。401（未ログイン）と 429（レート制限）を画面文言で分けたい。
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------- API 呼び出し ----------------
// 1) Service Worker から直接 fetch（Cookie付き）
// 2) 401 / 通信失敗なら、開いている vrchat.com タブの中から fetch（同一オリジンなので確実にCookieが付く）
// Chrome の Service Worker は、サイトの Cookie が付かないことがある。そのときの逃げ道が 2)。

async function apiFetch(path, method = 'GET') {
  const url = API_BASE + path;
  let direct = null;
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include', // ログインCookieを付ける
      headers: { Accept: 'application/json' },
      cache: 'no-store'       // 枚数は毎回最新が欲しいのでキャッシュしない
    });
    direct = { ok: res.ok, status: res.status, text: await res.text() };
    // 401 以外（成功も、404 や 429 も）はここで確定。401 だけタブ経由でもう一度試す。
    if (direct.status !== 401) return parse(direct, 'sw');
  } catch (e) {
    // ネットワーク断や CORS などで fetch 自体が落ちたとき。status 0 は「応答が無い」。
    direct = { ok: false, status: 0, text: String(e) };
  }

  const viaTab = await fetchViaTab(url, method);
  if (viaTab) return parse(viaTab, 'tab');
  // タブが無い、またはタブ内実行も失敗したときは、最初の結果をそのままエラーにする
  return parse(direct, 'sw');
}

// 開いている vrchat.com タブのページ内で fetch する。
// ページと API が同じオリジンなので、拡張の Service Worker より確実に Cookie が付く。
async function fetchViaTab(url, method) {
  const tabs = await chrome.tabs.query({ url: 'https://vrchat.com/*' });
  if (!tabs.length) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      args: [url, method],
      // この関数は拡張の外、タブのページ側で実行される。ここから外側の変数は見えない。
      func: async (u, m) => {
        try {
          const r = await fetch(u, { method: m, credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
          return { ok: r.ok, status: r.status, text: await r.text() };
        } catch (e) {
          return { ok: false, status: 0, text: String(e) };
        }
      }
    });
    return result?.result || null;
  } catch {
    // タブが閉じた直後や、chrome:// など注入できないページだったとき
    return null;
  }
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

// 画像のダウンロード完了を待ってから戻る。失敗・タイムアウトは例外にして、呼び出し側が削除を止める。
async function backupPrint(p) {
  const url = imageUrl(p);
  if (!url) throw new Error('画像URLが見つかりません');
  const downloadId = await chrome.downloads.download({
    url, filename: backupFilename(p), conflictAction: 'uniquify', saveAs: false
    // uniquify: 同名ファイルがあれば (1) などを付けて上書きしない
    // saveAs: false なので「名前を付けて保存」ダイアログは出さない
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('ダウンロードがタイムアウトしました')); }, DOWNLOAD_TIMEOUT_MS);
    // chrome.downloads.download は開始しただけで完了ではない。onChanged で完了を待つ。
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') { cleanup(); resolve(); }
      if (delta.state.current === 'interrupted') { cleanup(); reject(new Error(`ダウンロード失敗 (${delta.error?.current || 'interrupted'})`)); }
    };
    const cleanup = () => { clearTimeout(timer); chrome.downloads.onChanged.removeListener(listener); };
    chrome.downloads.onChanged.addListener(listener);
    // リスナー登録より前に完了していた場合の取りこぼし対策。search で現在状態を一度見る。
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') { cleanup(); resolve(); }
      if (item?.state === 'interrupted') { cleanup(); reject(new Error(`ダウンロード失敗 (${item.error || 'interrupted'})`)); }
    });
  });
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
