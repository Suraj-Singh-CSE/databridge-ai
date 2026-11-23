import { formatDateTime, formatRelativeTime } from '@/lib/relative-time';

/** "2 hours ago", with the exact date and time in the tooltip and for assistive tech. */
export function TimeAgo({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelativeTime(iso)}
    </time>
  );
}
