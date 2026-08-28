export const ACTIVITY_LEASE_HOLDER_PROTOCOL = 'devbridge/activity-lease-holder-v1';

export function activityLeaseHolderReadyLine() {
  return `${JSON.stringify(Object.freeze({ protocol: ACTIVITY_LEASE_HOLDER_PROTOCOL, ready: true }))}\n`;
}
