export function formatUploadTimestamp(date: Date): string {
  const pad = (value: number, width = 2) =>
    String(value).padStart(width, '0')
  return [
    pad(date.getFullYear(), 4),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '_',
    pad(date.getMilliseconds(), 3),
  ].join('')
}
