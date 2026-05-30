/**
 * state.js — Shared state management via chrome.storage.local
 *
 * All reads/writes go through here so the service worker and popup
 * always see the same schema. Storage survives Chrome restarts and
 * service-worker termination between alarm fires.
 */

export const DEFAULT_STATE = {
  // Extraction continuity
  extracted_urls:  [],          // append-only list of all post URLs ever extracted
  last_anchor: {
    post_url:      null,        // primary resume anchor (URL of last extracted post in the batch)
    author_name:   null,        // fallback anchor (author name)
    position_hint: 0            // approximate total posts extracted so far
  },
  total_extracted: 0,
  last_run_at:     null,        // ISO timestamp
  runs:            [],          // log of all runs

  // User preferences
  schedule_hours:  24,          // 12 or 24
  batch_size:      25,          // posts to extract per run: 10 | 25 | 50 | 100
  output_path:     null,        // null = Downloads folder
  schedule_active: false,       // whether the alarm is currently set

  // AI title generation (Phase 3)
  ai_titles_enabled: false,     // whether to run Phase 3 after extraction
  ai_provider:       'anthropic', // 'anthropic' | 'openai'
  ai_api_key:        null       // stored in chrome.storage.local (never transmitted to any intermediary)
};

export async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get('extraction_state', result => {
      if (result.extraction_state) {
        // Merge with defaults so new keys are always present after schema updates
        resolve({ ...DEFAULT_STATE, ...result.extraction_state });
      } else {
        resolve({ ...DEFAULT_STATE });
      }
    });
  });
}

export async function saveState(state) {
  return new Promise(resolve => {
    chrome.storage.local.set({ extraction_state: state }, resolve);
  });
}

export async function updateState(partial) {
  const current = await loadState();
  const updated  = { ...current, ...partial };
  await saveState(updated);
  return updated;
}

/**
 * Prepend new posts to the master CSV store (newest posts first).
 *
 * LinkedIn's display order is newest-saved at the top. To mirror this in the CSV,
 * new session posts are inserted BEFORE existing posts, not appended after them.
 *
 * Within a single session's posts, the order from content.js is already correct:
 * [above-anchor posts newest-first] + [below-anchor posts in order].
 * We prepend the whole batch together.
 */
export async function prependPostsToStore(posts) {
  return new Promise(resolve => {
    chrome.storage.local.get('master_posts', result => {
      const existing = result.master_posts || [];
      const updated  = [...posts, ...existing];   // ← prepend, not append
      chrome.storage.local.set({ master_posts: updated }, resolve);
    });
  });
}

/** @deprecated Use prependPostsToStore instead */
export async function appendPostsToStore(posts) {
  return prependPostsToStore(posts);
}

export async function getMasterPosts() {
  return new Promise(resolve => {
    chrome.storage.local.get('master_posts', result => {
      resolve(result.master_posts || []);
    });
  });
}
