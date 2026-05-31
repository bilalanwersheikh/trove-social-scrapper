/**
 * background.js — Service Worker
 *
 * Responsibilities:
 *  1. Listen for chrome.alarms to trigger scheduled extraction
 *  2. Open the LinkedIn saved posts tab, inject content script, run extraction
 *  3. Persist state to chrome.storage after every internal batch
 *  4. Download session + master CSVs to the user's chosen output path
 *  5. Send notifications (success, failure, login required)
 *  6. Handle messages from the popup (run now, set schedule, set output path, set batch size)
 *  7. Broadcast live progress updates to the popup progress overlay
 */

import { loadState, saveState, prependPostsToStore, getMasterPosts } from './state.js';
import { parseLinkedInTimestamp, postsToCSV, todayYYMMDD, downloadCSV } from './utils.js';

const ALARM_NAME         = 'linkedin-extract';
const LINKEDIN_SAVED_URL = 'https://www.linkedin.com/my-items/saved-posts';
const INTERNAL_BATCH     = 10;   // how many posts to write to storage at a time (fault tolerance)

// Stop flag — set by 'stop_extraction' message, checked by content script via 'check_stop' message
let _stopRequested = false;


// ─── ALARM SETUP ─────────────────────────────────────────────────────────────

async function setAlarm(hours) {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes:  hours * 60,
    periodInMinutes: hours * 60
  });
}

async function clearAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    _stopRequested = false;
    await runExtractionFlow('scheduled');
  }
});


// ─── NOTIFICATION HELPERS ─────────────────────────────────────────────────────

function notify(title, message, isError = false) {
  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message
  });
}


// ─── MAIN EXTRACTION FLOW ─────────────────────────────────────────────────────

async function runExtractionFlow(trigger = 'manual') {
  const state = await loadState();

  const runEntry = {
    timestamp:            new Date().toISOString(),
    trigger,
    anchor_used:          state.last_anchor.post_url,
    batch_size:           state.batch_size,
    new_above_anchor:     0,    // newly saved posts found above anchor
    new_below_anchor:     0,    // continuation posts from below anchor
    new_posts:            0,    // total new this run
    duplicates_skipped:   0,
    anchor_match_type:    null,
    status:               'failed',
    error:                null
  };

  broadcastStatus({ running: true, message: 'Opening LinkedIn…' });

  // ── 1. Find or open the LinkedIn saved posts tab ──
  let tabId;
  try {
    tabId = await getOrOpenLinkedInTab();
  } catch (err) {
    return await failRun(state, runEntry, err.message);
  }

  // ── 2. Wait for page to settle, then check login state ──
  await sleep(3000);
  broadcastStatus({ running: true, message: 'Checking login…' });

  let loginOk;
  try {
    const pingResp = await sendToTab(tabId, { action: 'ping' });
    loginOk = pingResp?.loggedIn;
  } catch {
    await sleep(3000);
    try {
      const pingResp = await sendToTab(tabId, { action: 'ping' });
      loginOk = pingResp?.loggedIn;
    } catch {
      loginOk = false;
    }
  }

  // ── 3. LOGIN FAILURE ──
  if (!loginOk) {
    runEntry.error  = 'NOT_LOGGED_IN';
    runEntry.status = 'failed';
    state.runs.push(runEntry);
    state.last_run_at = runEntry.timestamp;
    await saveState(state);
    notify('LinkedIn Extractor — Sign In Required',
      'Please open LinkedIn, sign in, and run the extractor again.', true);
    broadcastStatus({ running: false, error: 'NOT_LOGGED_IN', lastRun: runEntry });
    return;
  }

  broadcastStatus({ running: true, message: 'Extracting posts…' });

  // ── 4. Run two-phase extraction via content script ──
  let extractResult;
  try {
    extractResult = await sendToTab(tabId, {
      action:        'extract',
      anchorUrl:     state.last_anchor.post_url,
      anchorAuthor:  state.last_anchor.author_name,
      extractedUrls: state.extracted_urls,
      batchSize:     state.batch_size || 25,
    });

    if (!extractResult?.ok) {
      throw new Error(extractResult?.error || 'Extraction failed — unknown error');
    }
  } catch (err) {
    return await failRun(state, runEntry, err.message);
  }

  // Handle user-initiated stop
  if (extractResult.stopped) {
    runEntry.status    = 'stopped';
    runEntry.new_posts = 0;
    state.runs.push(runEntry);
    state.last_run_at = runEntry.timestamp;
    await saveState(state);
    broadcastStatus({ running: false, stopped: true, lastRun: runEntry });
    return;
  }

  const newPosts         = extractResult.posts        || [];
  const anchorMatchType  = extractResult.anchorMatchType || 'none';
  runEntry.anchor_match_type = anchorMatchType;

  console.log(`[Extractor] Extraction complete. Posts returned: ${newPosts.length}, anchor match: ${anchorMatchType}`);

  if (newPosts.length === 0) {
    runEntry.status    = 'success';
    runEntry.new_posts = 0;
    state.runs.push(runEntry);
    state.last_run_at = runEntry.timestamp;
    await saveState(state);
    notify('LinkedIn Extractor', 'All caught up — no new posts to extract.');
    broadcastStatus({ running: false, lastRun: runEntry });
    return;
  }

  // ── 5. Process and store posts in internal batches ──
  const now         = new Date();
  const sessionRows = [];
  let   newCount    = 0;
  let   dupCount    = 0;
  const seenUrls    = new Set(state.extracted_urls);
  let   lastAnchor  = { ...state.last_anchor };

  for (let i = 0; i < newPosts.length; i += INTERNAL_BATCH) {
    const batch     = newPosts.slice(i, i + INTERNAL_BATCH);
    const batchRows = [];

    for (const post of batch) {
      if (post.url && seenUrls.has(post.url)) {
        dupCount++;
        continue;
      }

      const row = {
        "Author's Name": post.author  || '',
        "Title":         post.title   || '',
        "Post Content":  post.content || '',
        "Post Date":     parseLinkedInTimestamp(post.relativeTime, now),
        "Post URL":      post.url     || 'N/A',
        "Extracted At":  now.toISOString()
      };

      batchRows.push(row);
      if (post.url) seenUrls.add(post.url);

      // Advance anchor to track last successfully processed post
      if (post.url) {
        lastAnchor = {
          post_url:      post.url,
          author_name:   post.author,
          position_hint: state.total_extracted + newCount + 1
        };
      }
    }

    if (batchRows.length > 0) {
      sessionRows.push(...batchRows);
      newCount += batchRows.length;

      // Persist after every internal batch — a mid-run failure loses at most INTERNAL_BATCH posts
      await prependPostsToStore(batchRows);
      state.extracted_urls   = [...seenUrls];
      state.total_extracted += batchRows.length;
      state.last_anchor      = lastAnchor;
      await saveState(state);

      broadcastStatus({
        running: true,
        message: `Saved ${newCount}/${newPosts.length} posts…`
      });
    }
  }

  // ── 6. Phase 3: AI Title Generation (optional) ──
  let finalSessionRows = sessionRows;
  if (sessionRows.length > 0 && state.ai_titles_enabled && state.ai_api_key) {
    broadcastStatus({ running: true, phase3: 'active', message: 'Generating AI titles…', phase3Total: sessionRows.length, phase3Done: 0 });
    try {
      finalSessionRows = await generateAiTitles(sessionRows, state.ai_api_key, state.ai_provider, (done, total) => {
        broadcastStatus({ running: true, phase3: 'active', message: `AI titles: ${done}/${total}…`, phase3Done: done, phase3Total: total });
      });
      broadcastStatus({ running: true, phase3: 'done', message: 'AI titles complete.' });
    } catch (err) {
      console.error('[Extractor] Phase 3 AI titles failed:', err.message);
      broadcastStatus({ running: true, phase3: 'error', message: `AI titles failed: ${err.message}` });
      // Non-fatal — continue with untitled rows
    }
  }

  // ── 7. Download CSVs ──
  if (finalSessionRows.length > 0) {
    const outputPath      = state.output_path || null;
    const sessionFilename = `${todayYYMMDD()}_linkedin_saved_posts.csv`;

    // Session CSV: just this run (with AI titles if Phase 3 ran)
    downloadCSV(postsToCSV(finalSessionRows), sessionFilename, outputPath);

    // Master CSV: rebuild from stored posts, replacing session rows with AI-titled versions
    const allPosts = await getMasterPosts();
    // If Phase 3 ran, patch the master store with AI-titled versions before downloading
    if (state.ai_titles_enabled && state.ai_api_key) {
      const titledByUrl = new Map(finalSessionRows.map(r => [r['Post URL'], r['Title']]));
      const patched = allPosts.map(p => {
        const t = titledByUrl.get(p['Post URL']);
        return t ? { ...p, Title: t } : p;
      });
      downloadCSV(postsToCSV(patched), 'master_linkedin_saved_posts.csv', outputPath);
    } else {
      downloadCSV(postsToCSV(allPosts), 'master_linkedin_saved_posts.csv', outputPath);
    }
  }

  // ── 8. Finalise ──
  runEntry.status             = 'success';
  runEntry.new_posts          = newCount;
  runEntry.duplicates_skipped = dupCount;
  state.runs.push(runEntry);
  state.last_run_at = runEntry.timestamp;
  await saveState(state);

  const msg = `Extracted ${newCount} new post${newCount !== 1 ? 's' : ''}. Total: ${state.total_extracted}.`;
  notify('LinkedIn Extractor — Done', msg);
  broadcastStatus({ running: false, lastRun: runEntry, totalExtracted: state.total_extracted });
}


// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function failRun(state, runEntry, errorMsg) {
  runEntry.error  = errorMsg;
  runEntry.status = 'failed';
  state.runs.push(runEntry);
  state.last_run_at = runEntry.timestamp;
  await saveState(state);
  notify('LinkedIn Extractor — Error', errorMsg, true);
  broadcastStatus({ running: false, error: errorMsg, lastRun: runEntry });
}

async function getOrOpenLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/my-items/saved-posts*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    return tabs[0].id;
  }

  const liTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (liTabs.length > 0) {
    await chrome.tabs.update(liTabs[0].id, { url: LINKEDIN_SAVED_URL, active: true });
    await waitForTabLoad(liTabs[0].id);
    return liTabs[0].id;
  }

  const newTab = await chrome.tabs.create({ url: LINKEDIN_SAVED_URL, active: true });
  await waitForTabLoad(newTab.id);
  return newTab.id;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timed out after 30s'));
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


// ─── AI TITLE GENERATION (Phase 3) ───────────────────────────────────────────

/**
 * Calls the selected AI API to generate a concise title for each post.
 * Processes posts one-at-a-time (sequential) to respect rate limits and
 * keep usage transparent to the user.
 *
 * @param {Array}    rows       - Array of CSV row objects (already deduped)
 * @param {string}   apiKey     - User's API key
 * @param {string}   provider   - 'anthropic' | 'openai'
 * @param {Function} onProgress - Called with (doneCount, totalCount) after each post
 * @returns {Array} Updated rows with Title field populated
 */
async function generateAiTitles(rows, apiKey, provider, onProgress) {
  const TITLE_PROMPT = 'Generate a concise, descriptive title (maximum 8 words) for the following LinkedIn post. Reply with the title only — no quotes, no punctuation at the end.\n\nPost:\n';

  const titled = [];

  for (let i = 0; i < rows.length; i++) {
    const row     = rows[i];
    const content = (row['Post Content'] || '').slice(0, 1500);  // cap context to avoid token spikes

    let title = '';
    try {
      if (provider === 'anthropic') {
        title = await callAnthropic(apiKey, TITLE_PROMPT + content);
      } else {
        title = await callOpenAI(apiKey, TITLE_PROMPT + content);
      }
    } catch (err) {
      console.warn(`[Extractor] AI title failed for post ${i + 1}:`, err.message);
      title = '';   // leave blank rather than aborting the whole batch
    }

    titled.push({ ...row, Title: title.trim() });
    if (onProgress) onProgress(i + 1, rows.length);
  }

  return titled;
}

async function callAnthropic(apiKey, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages:   [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Anthropic API ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data?.content?.[0]?.text || '';
}

async function callOpenAI(apiKey, prompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: 32,
      messages:   [{ role: 'user', content: prompt }]
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`OpenAI API ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}


// ─── POPUP MESSAGING ─────────────────────────────────────────────────────────

function broadcastStatus(data) {
  chrome.runtime.sendMessage({ action: 'status_update', ...data }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Relay progress updates from content.js → popup
  // (Content scripts can't message the popup directly — they go via background)
  if (message.action === 'relay_progress') {
    // Strip 'relay_progress' action, forward as 'progress_update' for the popup
    const { action: _a, ...rest } = message;
    chrome.runtime.sendMessage({ action: 'progress_update', ...rest }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // Content script polls this to know if the user clicked Stop
  if (message.action === 'check_stop') {
    sendResponse({ stop: _stopRequested });
    return false;
  }

  if (message.action === 'stop_extraction') {
    _stopRequested = true;
    broadcastStatus({ running: false, stopped: true, message: 'Stopping…' });
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'run_now') {
    _stopRequested = false;  // clear any previous stop on new run
    runExtractionFlow('manual').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'set_schedule') {
    loadState().then(async state => {
      state.schedule_hours  = message.hours;
      state.schedule_active = true;
      await saveState(state);
      await setAlarm(message.hours);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'pause_schedule') {
    loadState().then(async state => {
      state.schedule_active = false;
      await saveState(state);
      await clearAlarm();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'set_output_path') {
    loadState().then(async state => {
      state.output_path = message.path || null;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'set_batch_size') {
    loadState().then(async state => {
      state.batch_size = message.size;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'get_state') {
    loadState().then(state => sendResponse({ ok: true, state }));
    return true;
  }

  if (message.action === 'reset_session') {
    // Clears extraction state (progress, anchor, run history, stored posts).
    // User preferences (schedule, batch size, output path) are kept.
    // Downloaded CSV files on disk are NOT touched.
    loadState().then(async state => {
      try {
        const fresh = {
          extracted_urls:  [],
          last_anchor:     { post_url: null, author_name: null, position_hint: 0 },
          total_extracted: 0,
          last_run_at:     null,
          runs:            [],
          // Keep user preferences intact
          schedule_hours:    state.schedule_hours,
          batch_size:        state.batch_size,
          output_path:       state.output_path,
          schedule_active:   state.schedule_active,
          ai_titles_enabled: state.ai_titles_enabled,
          ai_provider:       state.ai_provider,
          ai_api_key:        state.ai_api_key,
        };
        await saveState(fresh);
        // Clear stored master posts — they'll be rebuilt from future runs
        await new Promise((resolve, reject) => {
          chrome.storage.local.remove('master_posts', () => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve();
          });
        });
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[Extractor] reset_session error:', err);
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  if (message.action === 'set_ai_titles') {
    loadState().then(async state => {
      state.ai_titles_enabled = !!message.enabled;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'set_ai_provider') {
    loadState().then(async state => {
      state.ai_provider = message.provider;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'set_ai_api_key') {
    loadState().then(async state => {
      state.ai_api_key = message.apiKey || null;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'remove_ai_api_key') {
    loadState().then(async state => {
      state.ai_api_key        = null;
      state.ai_titles_enabled = false;
      await saveState(state);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === 'download_master') {
    getMasterPosts().then(async posts => {
      if (posts.length === 0) {
        sendResponse({ ok: false, error: 'No posts extracted yet.' });
        return;
      }
      const state = await loadState();
      downloadCSV(postsToCSV(posts), 'master_linkedin_saved_posts.csv', state.output_path);
      sendResponse({ ok: true });
    });
    return true;
  }
});


// ─── INSTALL / STARTUP ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'onboarding.html' });
  }
});
