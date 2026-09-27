// Stand-in for Apps Script's Utilities.formatDate for the one pattern the script uses.
function formatLocal(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
module.exports = { formatLocal, LOCAL_PATTERN: 'yyyy-MM-dd h:mm a' };
