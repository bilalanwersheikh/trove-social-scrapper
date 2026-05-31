/**
 * popup.js — Controls the extension popup UI.
 * NO inline scripts or onclick= attributes — MV3 CSP requires external JS only.
 */

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Header menu
  document.getElementById('menuBtn').addEventListener('click', toggleDropdown);
  document.getElementById('menuApiKey').addEventListener('click', () => { closeDropdown(); showApiDialog(); });
  document.getElementById('menuReset').addEventListener('click', () => { closeDropdown(); showResetDialog(); });
  document.getElementById('menuEmail').addEventListener('click', () => {
    closeDropdown();
    chrome.tabs.create({ url: 'mailto:support@usetrove.app' });
  });
  document.getElementById('menuDiscord').addEventListener('click', () => {
    closeDropdown();
    chrome.tabs.create({ url: 'https://discord.gg/4jU4Myfvs' });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#menuBtn') && !e.target.closest('#dropdown')) closeDropdown();
  });

  // Schedule
  document.getElementById('btn12h').addEventListener('click', () => setSchedule(12));
  document.getElementById('btn24h').addEventListener('click', () => setSchedule(24));
  document.getElementById('btn15m').addEventListener('click', () => setSchedule(0.25));
  document.getElementById('pauseBtn').addEventListener('click', togglePause);

  // Batch size
  document.getElementById('batchBtn10').addEventListener('click',  () => setBatchSize(10));
  document.getElementById('batchBtn25').addEventListener('click',  () => setBatchSize(25));
  document.getElementById('batchBtn50').addEventListener('click',  () => setBatchSize(50));
  document.getElementById('batchBtn100').addEventListener('click', () => setBatchSize(100));

  // AI toggle + provider
  document.getElementById('aiToggle').addEventListener('click', toggleAiTitles);
  document.getElementById('providerAnthropic').addEventListener('click', () => setProvider('anthropic'));
  document.getElementById('providerOpenAI').addEventListener('click',    () => setProvider('openai'));

  // Folder
  document.getElementById('folderSaveBtn').addEventListener('click', saveFolder);
  document.getElementById('folderInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveFolder(); });
  document.getElementById('folderInput').addEventListener('input', onFolderInputChange);

  // Actions
  document.getElementById('runBtn').addEventListener('click',      runNow);
  document.getElementById('stopBtn').addEventListener('click',     stopExtraction);
  document.getElementById('downloadBtn').addEventListener('click', downloadMaster);
  document.getElementById('liLink').addEventListener('click',      openLinkedIn);

  // Tab switching
  document.getElementById('tabDashboard').addEventListener('click', () => switchTab('dashboard'));
  document.getElementById('tabRunLog').addEventListener('click',    () => switchTab('runLog'));

  // Reset dialog
  document.getElementById('resetCancel').addEventListener('click',  hideResetDialog);
  document.getElementById('resetConfirm').addEventListener('click', confirmReset);
  document.getElementById('resetDialog').addEventListener('click', e => {
    if (e.target === document.getElementById('resetDialog')) hideResetDialog();
  });

  // API key dialog
  document.getElementById('tabAnthropic').addEventListener('click', () => switchApiTab('anthropic'));
  document.getElementById('tabOpenAI').addEventListener('click',    () => switchApiTab('openai'));
  document.getElementById('apiSaveBtn').addEventListener('click',   saveApiKey);
  document.getElementById('apiRemoveBtn').addEventListener('click', removeApiKey);
  document.getElementById('apiCancel').addEventListener('click',    hideApiDialog);
  document.getElementById('apiDialog').addEventListener('click', e => {
    if (e.target === document.getElementById('apiDialog')) hideApiDialog();
  });

  await refreshUI();
});

// Listen for status + progress updates broadcast from background
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'status_update')   handleStatusUpdate(message);
  if (message.action === 'progress_update') handleProgressUpdate(message);
});


// ── Active progress polling ───────────────────────────────────────────────────
let _pollInterval = null;

function startProgressPolling() {
  if (_pollInterval) return;
  _pollInterval = setInterval(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/my-items/saved-posts*' });
    if (tabs.length > 0) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'progress_query' }, resp => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok) handleProgressUpdate(resp);
      });
    }
  }, 800);
}

function stopProgressPolling() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }
}


// ── State rendering ───────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById('panelDashboard').style.display = tab === 'dashboard' ? '' : 'none';
  document.getElementById('panelRunLog').style.display    = tab === 'runLog'    ? '' : 'none';
  document.getElementById('tabDashboard').classList.toggle('active', tab === 'dashboard');
  document.getElementById('tabRunLog').classList.toggle('active',    tab === 'runLog');
}

async function refreshUI() {
  const resp = await sendMessage({ action: 'get_state' });
  if (!resp || !resp.ok) return;
  renderState(resp.state);
  renderRunLog(resp.state.runs);

  // Resume polling if extraction is mid-run
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/my-items/saved-posts*' });
  if (tabs.length > 0) {
    chrome.tabs.sendMessage(tabs[0].id, { action: 'progress_query' }, prog => {
      if (chrome.runtime.lastError) return;
      if (prog?.ok && prog.active) {
        document.getElementById('runBtn').disabled = true;
        document.getElementById('statusDot').className = 'status-dot running';
        document.getElementById('statusText').textContent = prog.message || 'Extracting…';
        showProgressOverlay();
        handleProgressUpdate(prog);
        startProgressPolling();
      }
    });
  }
}

function renderState(state) {
  document.getElementById('statTotal').textContent = state.total_extracted ?? 0;
  document.getElementById('statRuns').textContent  =
    (state.runs ?? []).filter(r => r.status === 'success').length;

  if (state.last_run_at) {
    const d = new Date(state.last_run_at);
    document.getElementById('statLast').textContent    = relativeTime(d);
    document.getElementById('lastRunInfo').textContent = 'Last run: ' + d.toLocaleString();
  }

  // Schedule
  document.getElementById('btn12h').classList.toggle('active', state.schedule_hours === 12   && state.schedule_active);
  document.getElementById('btn24h').classList.toggle('active', state.schedule_hours === 24   && state.schedule_active);
  document.getElementById('btn15m').classList.toggle('active', state.schedule_hours === 0.25 && state.schedule_active);
  const pauseBtn = document.getElementById('pauseBtn');
  if (!state.schedule_active) {
    pauseBtn.textContent = '▶ Resume schedule';
    pauseBtn.classList.add('paused');
  } else {
    pauseBtn.textContent = '⏸ Pause schedule';
    pauseBtn.classList.remove('paused');
  }

  // Batch size
  const batchSize = Number(state.batch_size) || 25;
  document.getElementById('batchBtn10').classList.toggle('active',  batchSize === 10);
  document.getElementById('batchBtn25').classList.toggle('active',  batchSize === 25);
  document.getElementById('batchBtn50').classList.toggle('active',  batchSize === 50);
  document.getElementById('batchBtn100').classList.toggle('active', batchSize === 100);

  // AI titles toggle
  const aiOn = !!state.ai_titles_enabled;
  const toggle = document.getElementById('aiToggle');
  toggle.classList.toggle('on', aiOn);
  document.getElementById('aiProviderRow').style.display = aiOn ? 'flex' : 'none';

  // Provider selection
  const provider = state.ai_provider || 'anthropic';
  document.getElementById('providerAnthropic').classList.toggle('active', provider === 'anthropic');
  document.getElementById('providerOpenAI').classList.toggle('active',    provider === 'openai');

  // API key hint
  renderApiKeyHint(state);

  // Folder
  const savedPath = state.output_path || '';
  const input = document.getElementById('folderInput');
  input.value = savedPath;
  input.classList.toggle('has-value', !!savedPath);
  updateFolderHint(savedPath);

  hideError();
}

function renderApiKeyHint(state) {
  const hint    = document.getElementById('aiKeyHint');
  const aiOn    = !!state.ai_titles_enabled;
  const hasKey  = !!(state.ai_api_key);
  if (!aiOn && !hasKey) {
    hint.innerHTML = '<a id="aiAddKeyLink" href="#">Add key</a>';
    const link = document.getElementById('aiAddKeyLink');
    if (link) link.addEventListener('click', e => { e.preventDefault(); showApiDialog(); });
  } else if (hasKey) {
    const provider = state.ai_provider || 'anthropic';
    const label    = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    hint.textContent = `${label} ✓`;
    hint.style.color = '#15803d';
  } else {
    hint.innerHTML = '<a id="aiAddKeyLink" href="#">Add key</a>';
    const link = document.getElementById('aiAddKeyLink');
    if (link) link.addEventListener('click', e => { e.preventDefault(); showApiDialog(); });
  }
}


// ── Folder input ──────────────────────────────────────────────────────────────

function onFolderInputChange() {
  const val = document.getElementById('folderInput').value.trim();
  document.getElementById('folderInput').classList.toggle('has-value', !!val);
  const hint = document.getElementById('folderHint');
  hint.textContent = val
    ? 'Will save to: Downloads/' + sanitizeFolderName(val) + '/'
    : 'Leave blank to save directly to Downloads.';
  hint.className = 'path-hint';
}

async function saveFolder() {
  const raw  = document.getElementById('folderInput').value.trim();
  const name = sanitizeFolderName(raw);
  document.getElementById('folderInput').value = name;
  await sendMessage({ action: 'set_output_path', path: name || null });
  updateFolderHint(name);
  const btn = document.getElementById('folderSaveBtn');
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = 'Save'; }, 1200);
}

function sanitizeFolderName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '').trim();
}

function updateFolderHint(path) {
  const hint = document.getElementById('folderHint');
  if (path) {
    hint.textContent = '✓ Saving to: Downloads/' + path + '/';
    hint.className   = 'path-hint confirmed';
  } else {
    hint.textContent = 'Leave blank to save directly to Downloads.';
    hint.className   = 'path-hint';
  }
}


// ── Status update (from background.js) ───────────────────────────────────────

function handleStatusUpdate(update) {
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  if (update.running) {
    dot.className    = 'status-dot running';
    text.textContent = update.message || 'Extracting posts…';
    document.getElementById('runBtn').disabled = true;
    showProgressOverlay();
    startProgressPolling();
    hideError();
    return;
  }

  stopProgressPolling();
  document.getElementById('runBtn').disabled = false;
  hideProgressOverlay();

  if (update.stopped) {
    dot.className    = 'status-dot idle';
    text.textContent = 'Stopped by user';
    refreshUI();
    return;
  }

  if (update.error === 'NOT_LOGGED_IN') {
    dot.className    = 'status-dot error';
    text.textContent = 'Sign in required';
    showError('Sign in required',
      'You are not signed in to LinkedIn. Please open LinkedIn, sign in, and try again.');
    return;
  }

  if (update.error) {
    dot.className    = 'status-dot error';
    text.textContent = 'Error — see details';
    showError('Extraction failed', update.error);
    return;
  }

  dot.className = 'status-dot success';
  const n = update.lastRun?.new_posts ?? 0;
  text.textContent = n > 0
    ? `✓ Extracted ${n} new post${n !== 1 ? 's' : ''}`
    : '✓ Already up to date';

  hideError();
  refreshUI();
}


// ── Progress overlay (from content.js via background) ────────────────────────

function handleProgressUpdate(update) {
  showProgressOverlay();

  const pill1 = document.getElementById('pill1');
  const pill2 = document.getElementById('pill2');
  const pill3 = document.getElementById('pill3');

  // Phase 1 / Phase 2 updates come from content.js with update.phase
  if (update.phase === 'phase1') {
    pill1.className = 'phase-pill active';
    pill2.className = 'phase-pill';
    pill3.className = 'phase-pill';
  } else if (update.phase === 'phase2') {
    pill1.className = 'phase-pill done';
    pill2.className = 'phase-pill active';
    pill3.className = 'phase-pill';
  } else if (update.phase === 'done') {
    pill1.className = 'phase-pill done';
    pill2.className = 'phase-pill done';
    // pill3 stays as-is (may not have run if AI disabled)
  }

  // Phase 3 updates come from background.js with update.phase3
  if (update.phase3 === 'active') {
    pill1.className = 'phase-pill done';
    pill2.className = 'phase-pill done';
    pill3.className = 'phase-pill active';

    // Show AI title progress in the progress bar
    if (update.phase3Total > 0) {
      const pct = Math.min(100, Math.round((update.phase3Done ?? 0) / update.phase3Total * 100));
      document.getElementById('progressBar').style.width = pct + '%';
    }
  } else if (update.phase3 === 'done') {
    pill3.className = 'phase-pill done';
    document.getElementById('progressBar').style.width = '100%';
  } else if (update.phase3 === 'error') {
    pill3.className = 'phase-pill error';
  }

  // Extraction-phase post counts (from content.js)
  if (update.phase === 'phase1' || update.phase === 'phase2' || update.phase === 'done') {
    const above = update.postsAboveAnchor ?? 0;
    const below = update.postsBelowAnchor ?? 0;
    const total = update.batchSize        ?? 0;
    document.getElementById('progAbove').textContent = above;
    document.getElementById('progBelow').textContent = below;
    document.getElementById('progBatch').textContent = total || '—';

    if (!update.phase3) {  // don't overwrite AI progress bar
      const pct = total > 0 ? Math.min(100, Math.round((above + below) / total * 100)) : 0;
      document.getElementById('progressBar').style.width = pct + '%';
    }
  }

  if (update.message) {
    document.getElementById('progressMsg').textContent = update.message;
  }
}

function showProgressOverlay() {
  document.getElementById('progressOverlay').classList.add('show');
}

function hideProgressOverlay() {
  ['pill1','pill2','pill3'].forEach(id => document.getElementById(id).className = 'phase-pill');
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progAbove').textContent  = '—';
  document.getElementById('progBelow').textContent  = '—';
  document.getElementById('progBatch').textContent  = '—';
  document.getElementById('progressMsg').textContent = '';
  document.getElementById('progressOverlay').classList.remove('show');
}


// ── Actions ───────────────────────────────────────────────────────────────────

async function runNow() {
  document.getElementById('runBtn').disabled = true;
  document.getElementById('statusDot').className = 'status-dot running';
  document.getElementById('statusText').textContent = 'Starting…';
  showProgressOverlay();
  document.getElementById('progressMsg').textContent = 'Opening LinkedIn…';
  hideError();
  startProgressPolling();
  await sendMessage({ action: 'run_now' });
}

async function stopExtraction() {
  const btn = document.getElementById('stopBtn');
  btn.textContent = 'Stopping…';
  btn.disabled    = true;
  await sendMessage({ action: 'stop_extraction' });
  setTimeout(() => { btn.textContent = '✕ Stop'; btn.disabled = false; }, 2000);
}

async function setSchedule(hours) {
  await sendMessage({ action: 'set_schedule', hours });
  await refreshUI();
}

async function togglePause() {
  const resp = await sendMessage({ action: 'get_state' });
  if (!resp || !resp.ok) return;
  if (resp.state.schedule_active) {
    await sendMessage({ action: 'pause_schedule' });
  } else {
    await sendMessage({ action: 'set_schedule', hours: resp.state.schedule_hours || 24 });
  }
  await refreshUI();
}

async function setBatchSize(size) {
  await sendMessage({ action: 'set_batch_size', size: Number(size) });
  await refreshUI();
}

async function toggleAiTitles() {
  const resp = await sendMessage({ action: 'get_state' });
  if (!resp || !resp.ok) return;
  const state   = resp.state;
  const turning = !state.ai_titles_enabled;

  // If turning on and no key saved, prompt for key first
  if (turning && !state.ai_api_key) {
    showApiDialog();
    return;
  }

  await sendMessage({ action: 'set_ai_titles', enabled: turning });
  await refreshUI();
}

async function setProvider(provider) {
  await sendMessage({ action: 'set_ai_provider', provider });
  await refreshUI();
}

async function downloadMaster() {
  const resp = await sendMessage({ action: 'download_master' });
  if (!resp || !resp.ok) {
    showError('Download failed', (resp && resp.error) || 'No posts extracted yet.');
  }
}

function openLinkedIn() {
  chrome.tabs.create({ url: 'https://www.linkedin.com/my-items/saved-posts' });
}


// ── Three-dot dropdown ────────────────────────────────────────────────────────

function toggleDropdown() {
  document.getElementById('dropdown').classList.toggle('open');
}
function closeDropdown() {
  document.getElementById('dropdown').classList.remove('open');
}


// ── Reset dialog ──────────────────────────────────────────────────────────────

function showResetDialog() {
  document.getElementById('resetDialog').classList.add('show');
}
function hideResetDialog() {
  document.getElementById('resetDialog').classList.remove('show');
}
async function confirmReset() {
  hideResetDialog();
  const resp = await sendMessage({ action: 'reset_session' });
  if (resp && resp.ok) {
    document.getElementById('statusDot').className  = 'status-dot idle';
    document.getElementById('statusText').textContent = 'Session cleared — ready for fresh start';
    await refreshUI();
  } else {
    showError('Reset failed', 'Could not clear session. Try again.');
  }
}


// ── API key dialog ────────────────────────────────────────────────────────────

let _activeApiTab = 'anthropic';

function showApiDialog() {
  document.getElementById('apiDialog').classList.add('show');
  // Pre-fill if a key is already saved
  sendMessage({ action: 'get_state' }).then(resp => {
    if (!resp || !resp.ok) return;
    const state    = resp.state;
    const provider = state.ai_provider || 'anthropic';
    switchApiTab(provider);
    const maskedKey = state.ai_api_key ? '••••••••' + state.ai_api_key.slice(-4) : '';
    document.getElementById('apiKeyInput').placeholder = maskedKey || 'Paste your API key here…';
    document.getElementById('apiRemoveBtn').classList.toggle('show', !!state.ai_api_key);
  });
}

function hideApiDialog() {
  document.getElementById('apiDialog').classList.remove('show');
  document.getElementById('apiKeyInput').value = '';
}

function switchApiTab(provider) {
  _activeApiTab = provider;
  document.getElementById('tabAnthropic').classList.toggle('active', provider === 'anthropic');
  document.getElementById('tabOpenAI').classList.toggle('active',    provider === 'openai');
  document.getElementById('apiNoteAnthropic').style.display = provider === 'anthropic' ? 'block' : 'none';
  document.getElementById('apiNoteOpenAI').style.display    = provider === 'openai'    ? 'block' : 'none';
}

async function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) return;
  const btn = document.getElementById('apiSaveBtn');
  btn.textContent = 'Saving…';
  btn.disabled    = true;

  await sendMessage({ action: 'set_ai_api_key',  key });
  await sendMessage({ action: 'set_ai_provider', provider: _activeApiTab });
  await sendMessage({ action: 'set_ai_titles',   enabled: true });

  btn.textContent = '✓ Saved';
  setTimeout(() => { btn.textContent = 'Save key'; btn.disabled = false; }, 1200);
  document.getElementById('apiRemoveBtn').classList.add('show');
  document.getElementById('apiKeyInput').value = '';
  await refreshUI();
}

async function removeApiKey() {
  await sendMessage({ action: 'set_ai_api_key',  key: null });
  await sendMessage({ action: 'set_ai_titles',   enabled: false });
  document.getElementById('apiRemoveBtn').classList.remove('show');
  document.getElementById('apiKeyInput').placeholder = 'Paste your API key here…';
  hideApiDialog();
  await refreshUI();
}


// ── Run Log ───────────────────────────────────────────────────────────────────

function relativeTimeIso(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderRunLog(runs) {
  const list = document.getElementById('runLogList');
  if (!list) return;
  list.innerHTML = '';

  if (!runs || runs.length === 0) {
    list.innerHTML = '<div class="run-log-empty">No exports yet. Run your first export from the Dashboard.</div>';
    return;
  }

  const recent = [...runs].reverse().slice(0, 20);
  recent.forEach(run => {
    const item = document.createElement('div');
    item.className = 'run-log-item';

    // Dot
    const dot = document.createElement('div');
    dot.className = 'run-log-dot ' + (
      run.status === 'completed' || run.status === 'success' ? 'success' :
      run.status === 'failed'                                ? 'failed'  : 'partial'
    );

    // Body
    const body = document.createElement('div');
    body.className = 'run-log-body';

    const line1 = document.createElement('div');
    line1.className = 'run-log-line1';
    const isSuccess = run.status === 'completed' || run.status === 'success';
    const isNotLoggedIn = run.error === 'NOT_LOGGED_IN';
    if (isSuccess) {
      const n = run.new_posts ?? 0;
      line1.textContent = n > 0 ? `✓ ${n} post${n !== 1 ? 's' : ''} exported` : '✓ 0 posts — already up to date';
    } else if (isNotLoggedIn) {
      line1.textContent = '✕ Not signed in to LinkedIn';
    } else {
      line1.textContent = '✕ Export failed';
    }

    const line2 = document.createElement('div');
    line2.className = 'run-log-line2';
    const ts      = run.timestamp ? relativeTimeIso(run.timestamp) : '';
    const trigger = run.trigger   ? run.trigger                    : '';
    let line2Text = [ts, trigger].filter(Boolean).join(' · ');
    if (run.status === 'failed' && !isNotLoggedIn && run.error) {
      const truncated = run.error.length > 60 ? run.error.slice(0, 60) + '…' : run.error;
      line2Text += (line2Text ? ' — ' : '') + truncated;
    }
    line2.textContent = line2Text;

    body.appendChild(line1);
    body.appendChild(line2);

    item.appendChild(dot);
    item.appendChild(body);

    // Retry button for non-auth failures
    if (run.status === 'failed' && !isNotLoggedIn) {
      const retryBtn = document.createElement('button');
      retryBtn.className   = 'run-log-retry';
      retryBtn.textContent = '↻ Retry';
      retryBtn.addEventListener('click', async () => {
        await sendMessage({ action: 'run_now' });
        switchTab('dashboard');
      });
      item.appendChild(retryBtn);
    }

    list.appendChild(item);
  });
}


// ── UI helpers ────────────────────────────────────────────────────────────────

function showError(title, body) {
  document.getElementById('errorTitle').textContent = title;
  document.getElementById('errorBody').textContent  = body;
  document.getElementById('errorBanner').classList.add('show');
}
function hideError() {
  document.getElementById('errorBanner').classList.remove('show');
}

function relativeTime(date) {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 2)  return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return diffH + 'h ago';
  return Math.floor(diffH / 24) + 'd ago';
}


// ── Messaging helper ──────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        console.warn('sendMessage error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}
