/**
 * @fileoverview NotificationCenter constants.
 *
 * Kept in a dedicated module so NotificationCenter can stay small and focused.
 *
 * @module notification-center/constants
 */

export const NotificationType = {
  INFO: 'info',
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  LOADING: 'loading',
  PROGRESS: 'progress'
};

// Category icons (unicode, no external dependencies).
// `registerCategory()` mutates this object at runtime to add new categories.
export const CategoryIcons = {
  download: '↓',
  upload: '↑',
  calculation: '◐',
  spatial: '⊞',
  render: '◉',
  session: '⚙',
  data: '◈',
  connectivity: '⤲',
  filter: '⧩',
  highlight: '★',
  selection: '◇',
  lasso: '⌒',
  benchmark: '⏱',
  knn: '⋈',
  view: '◫',
  dimension: '⊡',
  default: '●'
};

