/**
 * content.js — Injected into https://www.linkedin.com/my-items/saved-posts
 *
 * Extraction logic runs in two phases:
 *
 * Phase 1 — Find the anchor
 *   Scroll down from the top of the feed until the anchor post (last extracted)
 *   appears in the DOM. Collect every post above it — these are newly saved posts
 *   added since the last run.
 *
 * Phase 2 — Fill the batch below the anchor
 *   After the anchor, continue scrolling to load posts below it (older, unextracted).
 *   Collect enough to bring the total up to batchSize.
 *
 * Combined result: [new posts above anchor] + [next unextracted posts below anchor]
 * This list is always in LinkedIn's display order (newest saved = first).
 *
 * Message protocol (background → content):
 *   { action: 'ping' }
 *     → { ok: true, loggedIn: bool }
 *
 *   { action: 'extract', anchorUrl, anchorAuthor, extractedUrls, batchSize }
 *     → { ok: true,  posts: [...], anchorMatchType: 'url'|'author'|'none' }
 *     → { ok: false, error: string }
 *
 *   { action: 'progress_query' }
 *     → { ok: true, phase, scrollCount, postsAboveAnchor, postsBelowAnchor, anchorFound }
 */


// ─── LOGIN CHECK ──────────────────────────────────────────────────────────────

function isLoggedIn() {
  const url = window.location.href;

  // Definitive "not logged in" — redirected to auth pages
  if (url.includes('/login') || url.includes('/authwall') || url.includes('/checkpoint')) {
    return false;
  }

  // If we're on the saved-posts page and NOT on an auth page, LinkedIn has
  // already confirmed the session server-side by serving the page.
  // Check several nav selectors that appear at different render stages.
  const loggedInSelectors = [
    '.global-nav__me',
    '[class*="global-nav__me"]',
    '[data-test-id="nav-settings__open-rec-dropdown"]',
    'nav[aria-label]',                          // top nav — renders early
    '.authentication-outlet',                   // authenticated route wrapper
    '[class*="scaffold-layout__main"]',         // main content — only present when logged in
    '[class*="ember-application"]',             // legacy Ember shell
  ];

  return loggedInSelectors.some(sel => !!document.querySelector(sel));
}


// ─── EXPAND "SEE MORE" ────────────────────────────────────────────────────────

function expandSeeMore() {
  let clicked = 0;
  const seen  = new WeakSet();

  const selectors = [
    'button[aria-label*="see more"]',
    'button[aria-label*="See more"]',
    'button.inline-show-more-text__button',
    '[class*="inline-show-more-text"] button',
    'span.lt-line-clamp__more',
    '[class*="lt-line-clamp__more"]',
    'button[class*="see-more"]',
    'a[class*="see-more"]',
  ];

  selectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      if (!seen.has(el)) {
        seen.add(el);
        try { el.click(); clicked++; } catch (e) { /* ignore */ }
      }
    });
  });

  document.querySelectorAll('span, button, a').forEach(el => {
    if (seen.has(el)) return;
    const txt = (el.innerText || '').trim().toLowerCase();
    if (txt === 'see more' || txt === '…see more' || txt === '...see more') {
      seen.add(el);
      try { el.click(); clicked++; } catch (e) { /* ignore */ }
    }
  });

  return clicked;
}


// ─── CARD EXTRACTION ─────────────────────────────────────────────────────────

function extractCards() {
  // Get all <li> elements in the scroll container, filter to only post cards
  // (excludes filter-pill <li> elements like the "All" button)
  const scaffoldLis = Array.from(document.querySelectorAll(
    '.scaffold-finite-scroll__content li'
  ));
  let cards = scaffoldLis.filter(li =>
    li.querySelector(
      '.entity-result__content-actor, ' +
      '[class*="actor__name"], ' +
      'a[href*="/feed/update/urn:li:activity:"], ' +
      '[class*="content-summary"]'
    )
  );

  // Fallbacks for other LinkedIn layouts
  if (cards.length === 0) {
    for (const sel of ['.entity-result', '[data-urn*="activity"]', '.occludable-update', '.feed-shared-update-v2']) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) { cards = found; break; }
    }
  }

  const tsPattern = /^(\d+)\s*(s|m|h|d|w|mo|yr)$/i;

  return cards.map(card => {
    // ── Author ──
    const authorEl = card.querySelector(
      '.entity-result__content-actor, ' +
      '.update-components-actor__name span[aria-hidden="true"], ' +
      '.feed-shared-actor__name span[aria-hidden="true"], ' +
      '[class*="actor__name"] span[aria-hidden="true"], ' +
      '[class*="actor__name"]'
    );
    const author = authorEl
      ? (authorEl.innerText || authorEl.textContent || '').trim().split('\n')[0]
      : '';

    // ── Title / Headline ──
    // LinkedIn layout: .entity-result__content-actor = author name,
    //                  .entity-result__primary-subtitle = professional headline.
    // IMPORTANT: do NOT search inside the author element or it returns the author name again.
    const HEADLINE_BLACKLIST = /^(status is (online|offline|away|busy)|1st|2nd|3rd|follow|connect|message|pending|connection|open to work|hiring|premium|linkedin member)$/i;
    const isValidHeadline = (txt) => {
      if (!txt || txt === author || txt.length < 4 || txt.length > 300) return false;
      // Check BOTH the full text and the first line — multi-line strings can hide blacklisted
      // values on line 1 that pass the anchored regex on the full string (e.g. "Status is offline\n…")
      const firstLine = txt.trim().split('\n')[0].trim();
      return !HEADLINE_BLACKLIST.test(txt.trim()) && !HEADLINE_BLACKLIST.test(firstLine);
    };

    let title = '';
    const titleSelectors = [
      '.entity-result__primary-subtitle',
      '[class*="primary-subtitle"]',
      '[class*="actor__subtitle"]',
      '[class*="actor__description"]',
      '.update-components-actor__description',
      '.feed-shared-actor__description',
      '[class*="sub-description"]',
    ];
    for (const sel of titleSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const isInsideAuthor = authorEl && authorEl.contains(el);
        const txt = (el.innerText || el.textContent || '').trim().split('\n')[0];
        if (!isInsideAuthor && isValidHeadline(txt)) { title = txt; break; }
      }
    }
    // Fallback: scan siblings of the author element
    if (!title && authorEl) {
      const parent = authorEl.parentElement;
      if (parent) {
        const localTs = /^\d+\s*(s|m|h|d|w|mo|yr)$/i;
        for (const child of parent.children) {
          if (child === authorEl || authorEl.contains(child)) continue;
          const txt = (child.innerText || child.textContent || '').trim().split('\n')[0];
          if (!localTs.test(txt) && isValidHeadline(txt)) { title = txt; break; }
        }
      }
    }
    // Last resort: span scan outside author element
    if (!title) {
      const localTs = /^\d+\s*(s|m|h|d|w|mo|yr)$/i;
      for (const el of card.querySelectorAll('span, div')) {
        if (authorEl && authorEl.contains(el)) continue;
        if (el.children.length > 2) continue;
        const txt = (el.innerText || el.textContent || '').trim();
        if (localTs.test(txt) || !isValidHeadline(txt)) continue;
        if (txt.includes(' ') || txt.includes('|') || txt.includes('@')) {
          title = txt.split('\n')[0]; break;
        }
      }
    }

    // ── Post Content ──
    const contentSelectors = [
      '[class*="content-summary"]',
      '[class*="content-inner-container"]',
      '.update-components-text',
      '[class*="update-components-text"]',
      '[class*="commentary"]',
      '.feed-shared-update-v2__description',
      '.feed-shared-text-view',
    ];
    let content = '';
    for (const sel of contentSelectors) {
      const el = card.querySelector(sel);
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text.length > content.length) content = text;
      }
    }

    // ── Relative Timestamp ──
    // Timestamps appear as "3w", "2d", "1mo" — possibly with trailing "•" punctuation.
    const tsExtract = (raw) => {
      const clean = (raw || '').trim().replace(/[\s•·]+$/, '').trim();
      return tsPattern.test(clean) ? clean : null;
    };
    let relativeTime = '';
    const tsSelectors = [
      'time', '[class*="timedelta"]', '[class*="time-ago"]',
      '[class*="posted-time"]', '[class*="sub-description"] span',
      '[class*="actor__meta"] span', '[class*="secondary-subtitle"] span',
      '[aria-label*="ago"]',
    ];
    for (const sel of tsSelectors) {
      for (const el of card.querySelectorAll(sel)) {
        const dt  = el.getAttribute('datetime') || el.getAttribute('aria-label') || '';
        const txt = (el.innerText || el.textContent || '').trim();
        const found = tsExtract(txt) || tsExtract(dt);
        if (found) { relativeTime = found; break; }
      }
      if (relativeTime) break;
    }
    // Broad scan
    if (!relativeTime) {
      for (const el of card.querySelectorAll('span, div, li')) {
        if (el.children.length > 2) continue;
        const found = tsExtract((el.innerText || el.textContent || '').trim());
        if (found) { relativeTime = found; break; }
      }
    }
    // Tokenise full card text as last resort
    if (!relativeTime) {
      for (const token of (card.innerText || '').split(/[\s\n•·]+/)) {
        if (tsPattern.test(token.trim())) { relativeTime = token.trim(); break; }
      }
    }

    // ── Post URL ──
    let url = '';
    const urlEl = card.querySelector('a[href*="/feed/update/urn:li:activity:"]');
    if (urlEl) {
      url = urlEl.href.split('?')[0];
    }
    if (!url) {
      const urnEl = card.closest('[data-urn*="activity"]') || card.querySelector('[data-urn*="activity"]');
      if (urnEl) {
        const m = urnEl.getAttribute('data-urn').match(/urn:li:activity:(\d+)/);
        if (m) url = 'https://www.linkedin.com/feed/update/urn:li:activity:' + m[1];
      }
    }

    return { author, title, content, relativeTime, url };
  }).filter(p => p.author || p.url);
}


// ─── SCROLL HELPERS ───────────────────────────────────────────────────────────

function scrollDown(distance = 700) {
  window.scrollBy(0, distance);
}

function clickShowMore() {
  const btn = document.querySelector(
    'button.scaffold-finite-scroll__load-button, button[aria-label*="Load more"]'
  );
  if (btn) { btn.click(); return true; }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Returns true if the user clicked Stop in the popup. */
function checkStop() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'check_stop' }, resp => {
      if (chrome.runtime.lastError) { resolve(false); return; }
      resolve(resp?.stop === true);
    });
  });
}


// ─── LIVE PROGRESS STATE (queryable by popup) ─────────────────────────────────

let _progress = {
  active:           false,
  phase:            'idle',      // 'phase1' | 'phase2' | 'done' | 'idle'
  scrollCount:      0,
  postsAboveAnchor: 0,           // new posts found above anchor
  postsBelowAnchor: 0,           // unextracted posts collected below anchor
  batchSize:        0,
  anchorFound:      false,
  anchorMatchType:  null,        // 'url' | 'author' | null
  message:          'Idle',
};

function updateProgress(patch) {
  Object.assign(_progress, patch);
  // Send to background.js which relays to the popup (background is always alive,
  // popup may not be open — direct runtime.sendMessage from content → popup doesn't work)
  chrome.runtime.sendMessage({ action: 'relay_progress', ..._progress }).catch(() => {});
}


// ─── MAIN EXTRACTION ORCHESTRATOR ────────────────────────────────────────────

/**
 * Two-phase extraction.
 *
 * Phase 1: Scroll from top → find anchor URL in DOM.
 *   - Collect all posts above anchor = newly saved posts.
 *   - If no anchor (first run): stop when batchSize posts are loaded.
 *
 * Phase 2: Continue scrolling below the anchor.
 *   - Collect (batchSize - postsAboveAnchor) more posts from below anchor.
 *   - Skip any URL already in extractedUrls.
 *
 * Result order: [above-anchor posts, newest first] + [below-anchor posts, oldest-saved first]
 * This preserves LinkedIn's display order throughout.
 */
async function runExtraction({ anchorUrl, anchorAuthor, extractedUrls, batchSize = 25 }) {
  const alreadySeen  = new Set(extractedUrls || []);
  const hasAnchor    = !!(anchorUrl || anchorAuthor);

  // Minimum scrolls before trusting "anchor at position 0 = caught up"
  // Ensures the initial render has settled before we declare no new posts.
  const MIN_SCROLLS_BEFORE_ANCHOR_CHECK = 3;

  updateProgress({
    active: true, phase: 'phase1', scrollCount: 0,
    postsAboveAnchor: 0, postsBelowAnchor: 0,
    batchSize, anchorFound: false, anchorMatchType: null,
    message: hasAnchor ? 'Scrolling to find anchor…' : 'Loading first batch…'
  });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 1: Find the anchor
  // ──────────────────────────────────────────────────────────────────────────
  let anchorIndex      = null;   // position of anchor post in DOM list
  let anchorMatchType  = null;
  let scrollCount      = 0;
  let prevCardCount    = 0;
  const maxScrolls     = 200;

  while (scrollCount < maxScrolls) {
    expandSeeMore();
    await sleep(600);

    const allPosts = extractCards();

    // First-run: stop once we have enough posts loaded
    if (!hasAnchor) {
      if (allPosts.length >= batchSize) {
        updateProgress({ message: `Loaded ${allPosts.length} posts — ready to extract` });
        break;
      }
    } else if (scrollCount >= MIN_SCROLLS_BEFORE_ANCHOR_CHECK) {
      // Look for anchor only after enough scrolls to trust position 0
      for (let i = 0; i < allPosts.length; i++) {
        const p = allPosts[i];
        const urlMatch    = !!(anchorUrl    && p.url    && p.url    === anchorUrl);
        const authorMatch = !!(anchorAuthor && p.author && p.author.trim() === anchorAuthor.trim());
        if (urlMatch || authorMatch) {
          anchorIndex     = i;
          anchorMatchType = urlMatch ? 'url' : 'author';
          updateProgress({
            anchorFound: true, anchorMatchType,
            postsAboveAnchor: i,
            message: `Anchor found at position ${i} (matched by ${anchorMatchType}) — ${i} new post${i !== 1 ? 's' : ''} above it`
          });
          break;
        }
      }
      if (anchorIndex !== null) break;
    }

    // End-of-feed detection
    if (allPosts.length === prevCardCount && scrollCount > 5) {
      if (!clickShowMore()) {
        updateProgress({ message: `End of feed reached — ${allPosts.length} posts loaded` });
        break;
      }
      await sleep(2000);
    }
    prevCardCount = allPosts.length;

    scrollDown(650 + Math.random() * 200);
    await sleep(1400 + Math.random() * 800);
    scrollCount++;
    updateProgress({ scrollCount, message: `Phase 1: scrolled ${scrollCount}×, ${allPosts.length} posts in DOM…` });

    // Check if the user clicked Stop
    if (await checkStop()) {
      updateProgress({ active: false, phase: 'done', message: 'Stopped by user.' });
      return { posts: [], anchorMatchType: 'none', stopped: true };
    }
  }

  // Re-extract after final scroll
  expandSeeMore();
  await sleep(1000);
  const phase1Posts = extractCards();

  // Determine posts above anchor (new saves since last run)
  let aboveAnchorPosts = [];
  if (!hasAnchor) {
    // First run: take top batchSize posts
    aboveAnchorPosts = phase1Posts.slice(0, batchSize);
  } else if (anchorIndex !== null) {
    aboveAnchorPosts = phase1Posts.slice(0, anchorIndex);
  } else {
    // Anchor not found — fall back to URL dedup across everything loaded
    updateProgress({ anchorMatchType: 'none', message: 'Anchor not found — using URL dedup fallback' });
    const deduped = phase1Posts.filter(p => !p.url || !alreadySeen.has(p.url));
    const capped  = deduped.slice(0, batchSize);
    updateProgress({ active: false, phase: 'done', postsBelowAnchor: capped.length, message: `Done (fallback): ${capped.length} posts` });
    return { posts: capped, anchorMatchType: 'none' };
  }

  updateProgress({ postsAboveAnchor: aboveAnchorPosts.length, phase: 'phase2' });

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 2: Collect posts below the anchor to fill the batch
  // ──────────────────────────────────────────────────────────────────────────
  const stillNeeded = batchSize - aboveAnchorPosts.length;

  let belowAnchorPosts = [];

  if (stillNeeded > 0 && anchorIndex !== null) {
    // Posts immediately after the anchor in the already-loaded DOM
    const alreadyBelow = phase1Posts.slice(anchorIndex + 1);
    const freshBelow   = alreadyBelow.filter(p => !p.url || !alreadySeen.has(p.url));
    belowAnchorPosts   = freshBelow;

    // If we still don't have enough, keep scrolling to load more
    let phase2Scrolls    = 0;
    let prevPhase2Count  = phase1Posts.length;
    const maxPhase2      = 100;

    while (belowAnchorPosts.length < stillNeeded && phase2Scrolls < maxPhase2) {
      scrollDown(700 + Math.random() * 200);
      await sleep(1400 + Math.random() * 800);
      phase2Scrolls++;

      expandSeeMore();
      await sleep(600);

      const updatedPosts = extractCards();
      const updatedBelow = updatedPosts.slice(anchorIndex + 1);
      belowAnchorPosts   = updatedBelow.filter(p => !p.url || !alreadySeen.has(p.url));

      // End-of-feed
      if (updatedPosts.length === prevPhase2Count && phase2Scrolls > 3) {
        if (!clickShowMore()) {
          updateProgress({ message: `End of feed — ${belowAnchorPosts.length} posts below anchor` });
          break;
        }
        await sleep(2000);
      }
      prevPhase2Count = updatedPosts.length;

      updateProgress({
        postsBelowAnchor: Math.min(belowAnchorPosts.length, stillNeeded),
        message: `Phase 2: ${belowAnchorPosts.length}/${stillNeeded} posts below anchor loaded…`
      });

      // Check if the user clicked Stop
      if (await checkStop()) {
        updateProgress({ active: false, phase: 'done', message: 'Stopped by user.' });
        return { posts: [], anchorMatchType: 'none', stopped: true };
      }
    }

    // Final expansion and re-extract to get full content
    expandSeeMore();
    await sleep(1000);
    const finalPosts = extractCards();
    const finalBelow = finalPosts.slice(anchorIndex + 1);
    belowAnchorPosts = finalBelow.filter(p => !p.url || !alreadySeen.has(p.url));
  }

  // Cap below-anchor posts to what's still needed
  const belowCapped = belowAnchorPosts.slice(0, stillNeeded);

  // ──────────────────────────────────────────────────────────────────────────
  // COMBINE: new posts (above anchor) + next unextracted posts (below anchor)
  // Both segments are already in LinkedIn display order (newest saved = first).
  // ──────────────────────────────────────────────────────────────────────────
  const combinedPosts = [...aboveAnchorPosts, ...belowCapped];

  // Final dedup pass (belt + suspenders)
  const finalDeduped = combinedPosts.filter(p => !p.url || !alreadySeen.has(p.url));

  updateProgress({
    active: false, phase: 'done',
    postsAboveAnchor: aboveAnchorPosts.length,
    postsBelowAnchor: belowCapped.length,
    message: `Done: ${aboveAnchorPosts.length} new + ${belowCapped.length} continuation = ${finalDeduped.length} total`
  });

  return { posts: finalDeduped, anchorMatchType: anchorMatchType || 'none' };
}


// ─── MESSAGE LISTENER ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ ok: true, loggedIn: isLoggedIn() });
    return false;
  }

  if (message.action === 'progress_query') {
    sendResponse({ ok: true, ..._progress });
    return false;
  }

  if (message.action === 'extract') {
    runExtraction({
      anchorUrl:     message.anchorUrl,
      anchorAuthor:  message.anchorAuthor,
      extractedUrls: message.extractedUrls,
      batchSize:     message.batchSize ?? 25,
    }).then(result => {
      sendResponse({ ok: true, posts: result.posts, anchorMatchType: result.anchorMatchType });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // async
  }
});
