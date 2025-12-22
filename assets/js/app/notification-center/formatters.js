/**
 * @fileoverview Formatting helpers for NotificationCenter UI text.
 *
 * These utilities are intentionally dependency-free and safe to call in hot
 * paths like progress updates.
 *
 * @module notification-center/formatters
 */

/**
 * Format bytes to a human-readable size.
 * @param {number} bytes
 * @param {number} [decimals=1]
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1) return bytes.toFixed(decimals) + ' B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Format a duration in milliseconds.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Format a large number into a compact string (K/M/B).
 * @param {number} n
 * @returns {string}
 */
export function formatCompactNumber(n) {
  const value = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(value)) return String(n ?? '');
  if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B';
  if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
  return String(value);
}

