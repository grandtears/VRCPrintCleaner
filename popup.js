// ツールバーアイコンを押したときに出る小さい窓。
// 枚数の確認、自動削除のオン/オフ、「今すぐチェック」、一覧ページを開く、だけを行う。
import { getSettings, saveSettings, getState, formatDate, getBackupAccess } from './common.js';

// getElementById の短い別名。このファイル内の要素参照はすべてこれ。
const $ = (id) => document.getElementById(id);
let latestSettings = null;

// 保存済みの設定と直近の実行状態を読んで、ポップアップ全体を描き直す。
async function render() {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  latestSettings = settings;
  $('enabled').checked = settings.enabled;
  // ドライラン中だけ「（ドライラン）」を出す。hidden 属性で表示を切り替える。
  $('dryRunTag').hidden = !settings.dryRun;
  $('limit').textContent = settings.triggerCount;
  $('count').textContent = state.lastCount ?? '-';
  // バーの幅は「現在枚数 / 削除開始枚数」。100% を超えて描かない。
  const pct = state.lastCount != null ? Math.min(100, (state.lastCount / settings.triggerCount) * 100) : 0;
  $('bar').style.width = `${pct}%`;
  $('bar').style.background = pct >= 100 ? 'var(--danger)' : 'var(--accent)';
  $('status').textContent = `最終チェック: ${formatDate(state.lastRunAt)}`;
  if (state.lastError) {
    $('error').hidden = false;
    $('error').innerHTML = '';
    $('error').append(state.lastError + ' ');
    // 未ログイン時に、その場から vrchat.com のログインへ飛べるようにする
    const a = document.createElement('a');
    a.href = 'https://vrchat.com/home/login';
    a.target = '_blank';
    a.textContent = 'vrchat.com を開く';
    $('error').append(a);
  } else {
    $('error').hidden = true;
  }
}

$('enabled').addEventListener('change', async (e) => {
  if (e.target.checked) {
    // 初めて自動削除を入れるときは、確認ダイアログのある一覧画面へ送る。
    // acknowledged は、一覧画面で確認に「OK」したあとに local へ保存される。
    const { acknowledged } = await chrome.storage.local.get('acknowledged');
    if (!acknowledged) {
      e.target.checked = false;
      chrome.runtime.openOptionsPage();
      return;
    }
  }
  await saveSettings({ enabled: e.target.checked });
  render();
});

// background.js に「今すぐ1回やれ」と頼む。結果の枚数でステータス文言を差し替える。
$('runNow').addEventListener('click', async () => {
  $('runNow').disabled = true;
  $('runNow').textContent = 'チェック中…';
  const settings = latestSettings;
  if (settings?.enabled && settings.backupBeforeDelete && !settings.dryRun) {
    // ポップアップでは「次回以降も許可」のダイアログが出ない。切れていたら一覧タブへ送る。
    const access = await getBackupAccess();
    if (access.state !== 'granted') {
      $('runNow').disabled = false;
      $('runNow').textContent = '今すぐチェック';
      chrome.runtime.openOptionsPage();
      return;
    }
  }
  const res = await chrome.runtime.sendMessage({ type: 'runNow' });
  $('runNow').disabled = false;
  $('runNow').textContent = '今すぐチェック';
  await render();
  if (res?.ok && res.result) {
    const r = res.result;
    if (r.deleted.length) $('status').textContent = `${r.deleted.length} 枚削除しました`;
    else if (r.wouldDelete.length) $('status').textContent = `[ドライラン] ${r.wouldDelete.length} 枚が削除対象です`;
    else if (!r.error && !r.enabled) $('status').textContent = '自動削除がOFFのため枚数の確認のみ行いました';
  }
});

// options_page（manager.html）を開く。Chrome が拡張の設定ページとして扱う。
$('openManager').addEventListener('click', () => chrome.runtime.openOptionsPage());

// バックグラウンドが枚数やエラーを書き換えたら、開いているポップアップも追従する。
chrome.storage.onChanged.addListener(render);
render();
