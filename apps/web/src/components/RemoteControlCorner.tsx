// Section 31.10 — floating chip lower-right of Center column. Visible only
// when /remote-control is active. Click opens the remote URL in a new tab.

import { useRemoteControl } from '@/hooks/use-remote-control';
import type { WsEnvelope } from '@/features/runtime/ws-types';

interface Props {
  events: WsEnvelope[];
}

export function RemoteControlCorner({ events }: Props) {
  const { active, url, bridgeSessionId } = useRemoteControl(events);
  if (!active) return null;

  const idDisplay = bridgeSessionId ? truncateId(bridgeSessionId) : null;

  const handleClick = () => {
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="pointer-events-none absolute bottom-2 right-3 z-20">
      <button
        type="button"
        onClick={handleClick}
        disabled={!url}
        className="pc-remote-indicator pointer-events-auto"
        title={url ? `Open ${url}` : 'Remote control active'}
      >
        <span className="pc-remote-dot" />
        <span>remote</span>
        {idDisplay ? <span className="pc-remote-id">{idDisplay}</span> : null}
      </button>
    </div>
  );
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-3)}`;
}
