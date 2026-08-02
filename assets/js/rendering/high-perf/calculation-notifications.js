/**
 * Observational calculation-notification settlement.
 *
 * Shared by the renderer and the spatial index. Notification delivery is
 * observational, so a failure here can never invalidate completed scientific or
 * GPU publication ownership -- that rule lives in settleCalculationNotification,
 * and it is why both owners settle through this one helper.
 */

function describeError(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function settleCalculationNotification(
  notifications,
  notificationId,
  method,
  ...args
) {
  try {
    if (!notifications.hasNotification(notificationId)) return false;
    notifications[method](notificationId, ...args);
    return true;
  } catch {
    // Calculation notifications are observational. Eviction, dismissal, or a
    // terminal UI delivery failure cannot invalidate completed scientific or
    // GPU publication ownership.
    return false;
  }
}

export {
  describeError,
  settleCalculationNotification,
};
