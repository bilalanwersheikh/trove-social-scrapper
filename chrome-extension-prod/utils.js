/**
 * utils.js — Shared utilities (timestamp parsing, CSV generation)
 * Used by both background.js and popup.js
 */

/**
 * Convert a LinkedIn relative timestamp string to an absolute YYYY-MM-DD date.
 * Examples: "2h" → today, "3d" → 3 days ago, "2w" → 2 weeks ago,
 *           "1mo" → ~30 days ago, "1yr" → ~365 days ago
 */
export function parseLinkedInTimestamp(tsStr, now = new Date()) {
  if (!tsStr) return '';
  const s = tsStr.trim().toLowerCase();

  const match = s.match(/^(\d+)\s*(s|m|h|d|w|mo|yr)$/i);
  if (!match) {
    if (s === 'now' || s === 'just now' || s === 'moments ago') {
      return formatDate(now);
    }
    return tsStr; // can't parse — keep original
  }

  const n    = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms   = {
    s:  1000,
    m:  60 * 1000,
    h:  3600 * 1000,
    d:  86400 * 1000,
    w:  7 * 86400 * 1000,
    mo: 30 * 86400 * 1000,
    yr: 365 * 86400 * 1000
  }[unit];

  return formatDate(new Date(now.getTime() - n * ms));
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert an array of post objects to a CSV string.
 */
export function postsToCSV(posts) {
  const COLUMNS = ["Author's Name", "Title", "Post Content", "Post Date", "Post URL", "Extracted At"];

  const escape = val => {
    if (val == null) return '';
    const s = String(val);
    // Wrap in quotes if contains comma, newline, or quote
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const header = COLUMNS.map(escape).join(',');
  const rows   = posts.map(p =>
    COLUMNS.map(col => escape(p[col] ?? '')).join(',')
  );
  return [header, ...rows].join('\n');
}

/**
 * Format a date as YYMMDD for filenames.
 */
export function todayYYMMDD() {
  const now = new Date();
  const y   = String(now.getFullYear()).slice(-2);
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Trigger a CSV download via chrome.downloads API.
 * filename: just the filename (e.g. "260529_linkedin_saved_posts.csv")
 * outputPath: user-defined sub-folder name or null (→ Downloads root)
 *
 * IMPORTANT: MV3 service workers do NOT have URL.createObjectURL.
 * We use a data: URI instead, which works in both service workers and popups.
 */
export function downloadCSV(csvString, filename, outputPath) {
  // Build a data: URI — works in service workers unlike createObjectURL
  const encoded         = encodeURIComponent('﻿' + csvString); // BOM for Excel UTF-8
  const url             = 'data:text/csv;charset=utf-8,' + encoded;

  const downloadFilename = outputPath
    ? `${outputPath.replace(/^\/+|\/+$/g, '')}/${filename}`
    : filename;

  chrome.downloads.download({
    url,
    filename: downloadFilename,
    saveAs:   false   // silent download — no "Save As" dialog
  }, downloadId => {
    if (chrome.runtime.lastError) {
      console.error('[Extractor] Download failed:', chrome.runtime.lastError.message, filename);
    } else {
      console.log('[Extractor] Download started — id:', downloadId, 'file:', downloadFilename);
    }
  });
}
