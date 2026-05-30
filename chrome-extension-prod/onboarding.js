/**
 * onboarding.js — Logic for the first-install setup page.
 * NO inline scripts or onclick= attributes — MV3 CSP requires external JS only.
 */

let selectedHours     = 12;
let selectedBatchSize = 25;
let selectedProvider  = 'anthropic';
let skipApiKey        = false;

const SECONDS_PER_POST = 3;

// ── Wire up buttons once DOM is ready ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('opt12').addEventListener('click',  () => selectSchedule(12));
  document.getElementById('opt24').addEventListener('click',  () => selectSchedule(24));
  document.getElementById('opt15m').addEventListener('click', () => selectSchedule(0.25));

  document.getElementById('batch10').addEventListener('click',  () => selectBatch(10));
  document.getElementById('batch25').addEventListener('click',  () => selectBatch(25));
  document.getElementById('batch50').addEventListener('click',  () => selectBatch(50));
  document.getElementById('batch100').addEventListener('click', () => selectBatch(100));

  // Live hint update as user types the folder name
  document.getElementById('folderInput').addEventListener('input', updateFolderHint);

  // Step 5: AI provider selection
  document.getElementById('ob-anthropic').addEventListener('click', () => selectProvider('anthropic'));
  document.getElementById('ob-openai').addEventListener('click',    () => selectProvider('openai'));

  // Skip key link — clears input and marks as skipped
  document.getElementById('ob-skip-key').addEventListener('click', () => {
    document.getElementById('ob-api-key').value = '';
    skipApiKey = true;
    document.getElementById('ob-skip-key').textContent = '✓ Skipped — you can add a key later via the ⋯ menu.';
  });

  // Un-skip if user starts typing again
  document.getElementById('ob-api-key').addEventListener('input', () => {
    skipApiKey = false;
    document.getElementById('ob-skip-key').textContent = 'Skip for now — I\'ll add a key later';
  });

  document.getElementById('startBtn').addEventListener('click', finish);
});

// ── Schedule ──────────────────────────────────────────────────────────────────

function selectSchedule(h) {
  selectedHours = h;
  document.getElementById('opt12').classList.toggle('selected',  h === 12);
  document.getElementById('opt24').classList.toggle('selected',  h === 24);
  document.getElementById('opt15m').classList.toggle('selected', h === 0.25);
  const hint = document.getElementById('testModeHint');
  hint.textContent = h === 0.25 ? '⚗ Test mode — fires every 15 minutes. Switch to 12h or 24h for normal use.' : '';
}

// ── Batch size ────────────────────────────────────────────────────────────────

function selectBatch(size) {
  selectedBatchSize = size;
  ['batch10', 'batch25', 'batch50', 'batch100'].forEach(id => {
    document.getElementById(id).classList.toggle(
      'selected', parseInt(id.replace('batch', '')) === size
    );
  });
  const secs  = size * SECONDS_PER_POST;
  const mins  = Math.round(secs / 60);
  const label = mins < 1 ? `~${secs}s` : `~${mins} min`;
  document.getElementById('batchTimeEst').textContent = `Estimated run time: ${label}`;
}

// ── Folder hint ───────────────────────────────────────────────────────────────

function updateFolderHint() {
  const val  = document.getElementById('folderInput').value.trim();
  const hint = document.getElementById('folderHint');
  if (val) {
    hint.innerHTML = `Files will save to <strong>Downloads/${sanitize(val)}/</strong>`;
  } else {
    hint.innerHTML = 'Leave blank to save to <strong>Downloads</strong> directly.';
  }
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '').trim();
}

// ── AI provider ───────────────────────────────────────────────────────────────

function selectProvider(provider) {
  selectedProvider = provider;
  document.getElementById('ob-anthropic').classList.toggle('selected', provider === 'anthropic');
  document.getElementById('ob-openai').classList.toggle('selected',    provider === 'openai');
  document.getElementById('ob-cost-anthropic').style.display = provider === 'anthropic' ? '' : 'none';
  document.getElementById('ob-cost-openai').style.display    = provider === 'openai'    ? '' : 'none';
}

// ── Finish ────────────────────────────────────────────────────────────────────

async function finish() {
  const btn = document.getElementById('startBtn');
  btn.disabled    = true;
  btn.textContent = 'Setting up…';

  const folderName = sanitize(document.getElementById('folderInput').value.trim());
  const apiKeyRaw  = document.getElementById('ob-api-key').value.trim();
  const apiKey     = (!skipApiKey && apiKeyRaw) ? apiKeyRaw : null;

  await sendMsg({ action: 'set_output_path',  path:    folderName || null });
  await sendMsg({ action: 'set_schedule',      hours:   selectedHours });
  await sendMsg({ action: 'set_batch_size',    size:    selectedBatchSize });
  await sendMsg({ action: 'set_ai_provider',   provider: selectedProvider });

  if (apiKey) {
    await sendMsg({ action: 'set_ai_api_key',  apiKey });
    await sendMsg({ action: 'set_ai_titles',   enabled: true });
  }

  sendMsg({ action: 'run_now' });   // fire first run, don't await

  btn.textContent = 'Done! Extracting in background…';
  setTimeout(() => window.close(), 1500);
}

// ── Messaging helper ──────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        console.warn('sendMsg error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}
