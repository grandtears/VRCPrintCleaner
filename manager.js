// 一覧・設定ページ（拡張の options_page）。
// プリントのサムネイル、★保護、削除順の予告、設定フォーム、ログをここにまとめる。
// API へのアクセスはせず、background.js へメッセージを送って結果をもらう。
import {
  getSettings, saveSettings, getProtectedIds, setProtected, getLogs,
  deletionOrder, imageUrl, printTime, formatDate
} from './common.js';

const $ = (id) => document.getElementById(id);
// 直近に取得したプリント一覧と、自分のユーザーID。再描画のたびに API を叩き直さない。
let prints = [];
let userId = null;

// ---------- 設定フォーム ----------
// data-key 属性を持つ input に、保存済み設定の同じ名前の値を入れる。
async function loadSettingsForm() {
  const s = await getSettings();
  document.querySelectorAll('[data-key]').forEach((el) => {
    const v = s[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
  $('limit').textContent = s.triggerCount;
}

// フォームのどれかが変わったら、その1キーだけ保存して画面を正規化後の値で描き直す。
document.querySelectorAll('[data-key]').forEach((el) => {
  el.addEventListener('change', async () => {
    const key = el.dataset.key;
    if (key === 'enabled' && el.checked) {
      const s = await getSettings();
      // 初回有効化の確認。キャンセルしたらチェックを戻して保存しない。
      const ok = confirm(
        `自動削除を有効にします。\n\n` +
        `プリントが ${s.triggerCount} 枚に達すると、★のないものを古い順に削除して ${s.targetCount} 枚まで減らします。\n` +
        `削除したプリントはVRChat上では元に戻せません。\n\n` +
        `残したいプリントに★が付いているか確認しましたか？`
      );
      if (!ok) { el.checked = false; return; }
      // ここを通過したら、以後ポップアップから直接オンにできるようにする
      await chrome.storage.local.set({ acknowledged: true });
    }
    await saveSettings({ [key]: el.type === 'checkbox' ? el.checked : el.value });
    await loadSettingsForm(); // 範囲外の数値などを正規化した結果を入力欄へ戻す
    renderGrid();             // 「次に削除」の赤枠は設定に依存するので、カードも描き直す
  });
});

// ---------- プリント一覧 ----------
// background に一覧取得を頼む。失敗時はグリッドを空にして、ログインへのリンクを出す。
async function loadPrints() {
  $('listError').hidden = true;
  $('grid').innerHTML = '<div class="muted">読み込み中…</div>';
  const res = await chrome.runtime.sendMessage({ type: 'getPrints' });
  if (!res?.ok) {
    $('grid').innerHTML = '';
    $('listError').hidden = false;
    $('listError').innerHTML = '';
    $('listError').append(res?.error || '読み込みに失敗しました', ' ');
    const a = document.createElement('a');
    a.href = 'https://vrchat.com/home/login';
    a.target = '_blank';
    a.textContent = 'vrchat.com を開く';
    $('listError').append(a);
    return;
  }
  ({ prints, userId } = res.result);
  renderGrid();
}

// 取得済みの prints からカードを組み立てる。設定や保護が変わったときもここだけ呼べばよい。
async function renderGrid() {
  const [settings, protectedSet] = await Promise.all([getSettings(), getProtectedIds()]);
  $('count').textContent = prints.length;
  $('protCount').textContent = prints.filter((p) => protectedSet.has(p.id)).length;

  // 削除順（古い順・消してよいものだけ）と、その中で「次の実行で手を付ける枚」を計算する。
  const order = deletionOrder(prints, settings, protectedSet, userId);
  const rank = new Map(order.map((p, i) => [p.id, i + 1]));
  // まだ上限未満でも、「上限に達した瞬間に最初に消える枚」を赤枠で予告する。
  // 1回で減らせる枚数は maxPerRun と（開始枚数 − 目標枚数）の小さい方。
  const perTrigger = Math.min(settings.maxPerRun, Math.max(0, settings.triggerCount - settings.targetCount));
  const nextCount = prints.length >= settings.triggerCount
    ? Math.min(settings.maxPerRun, prints.length - settings.targetCount)
    : perTrigger;
  const nextIds = new Set(order.slice(0, nextCount).map((p) => p.id));

  const grid = $('grid');
  grid.innerHTML = '';
  if (!prints.length) {
    grid.innerHTML = '<div class="muted">プリントがありません</div>';
    return;
  }

  // 画面は新しい順。削除そのものは古い順なので、順位バッジの数字と見た目の並びは一致しない。
  const sorted = [...prints].sort((a, b) => printTime(b) - printTime(a));
  for (const p of sorted) {
    const isProt = protectedSet.has(p.id);
    // protected = 金枠（★）。next = 赤枠（次に消える）。
    // 保護中は削除順から外れるので、同じカードに両方のクラスは付かない。
    const card = document.createElement('div');
    card.className = 'card' + (isProt ? ' protected' : '') + (nextIds.has(p.id) ? ' next' : '');

    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.alt = '';
    img.src = imageUrl(p);
    // vrchat.com に寄せた URL で失敗したら、API が返した元の URL を1回だけ試す
    img.addEventListener('error', () => {
      const orig = p?.files?.image;
      if (orig && img.src !== orig) img.src = orig;
    }, { once: true });
    img.addEventListener('click', () => window.open(img.src, '_blank'));
    img.style.cursor = 'zoom-in';
    card.append(img);

    const star = document.createElement('button');
    star.className = 'star';
    star.title = isProt ? '保護を解除' : '保護する（自動削除しない）';
    star.textContent = isProt ? '★' : '☆';
    star.addEventListener('click', async () => {
      await setProtected(p.id, !isProt);
      renderGrid();
    });
    card.append(star);

    // 左上のラベル。保護中 / 次に削除 #n / 削除順 #n / 対象外（他人のプリント除外など）
    const badge = document.createElement('span');
    badge.className = 'order';
    if (isProt) badge.textContent = '保護中';
    else if (rank.has(p.id)) badge.textContent = nextIds.has(p.id) ? `次に削除 #${rank.get(p.id)}` : `削除順 #${rank.get(p.id)}`;
    else badge.textContent = '対象外';
    card.append(badge);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const world = document.createElement('div');
    world.className = 'world';
    world.textContent = p.worldName || '不明なワールド';
    world.title = p.worldName || '';
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = `${formatDate(printTime(p))} · ${p.authorId === userId ? '自分' : (p.authorName || '他のユーザー')}`;
    meta.append(world, sub);
    if (p.note) {
      const note = document.createElement('div');
      note.textContent = p.note;
      meta.append(note);
    }
    card.append(meta);
    grid.append(card);
  }
}

// ---------- ログ ----------
// 直近100件を新しい順に出す。error は赤、warn は橙（styles.css のクラス）。
async function renderLogs() {
  const logs = await getLogs();
  const el = $('logs');
  el.innerHTML = '';
  if (!logs.length) { el.innerHTML = '<div class="muted">まだログはありません</div>'; return; }
  for (const l of logs) {
    const d = document.createElement('div');
    d.className = l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : '';
    d.textContent = `${formatDate(l.at)}  ${l.message}`;
    el.append(d);
  }
}

// ---------- ボタン ----------
$('reload').addEventListener('click', loadPrints);
$('runNow').addEventListener('click', async () => {
  $('runNow').disabled = true;
  $('runNow').textContent = 'チェック中…';
  // 削除が走ったあとの枚数に合わせるため、チェック完了後に一覧を取り直す
  await chrome.runtime.sendMessage({ type: 'runNow' });
  $('runNow').disabled = false;
  $('runNow').textContent = '今すぐチェック';
  await loadPrints();
});

// 別画面（ポップアップ）で保護やログが変わっても、開いたままのこのページを更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.logs) renderLogs();
  if (area === 'sync' && changes.protectedIds) renderGrid();
});

loadSettingsForm();
renderLogs();
loadPrints();
