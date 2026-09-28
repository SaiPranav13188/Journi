// "₹23,350" — Indian digit grouping, matching the app's formatMoney for INR.
export function formatInr(amount) {
  return `₹${Math.round(Number(amount) || 0).toLocaleString('en-IN')}`;
}
