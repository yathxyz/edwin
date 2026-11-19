import { encode, isObj, type OutMessage } from './proto.mts';
import type { AgentHubConfig } from './agent-sessions.mts';

/** Configured clients only. Mask paths even in Scheme conditions and correlation fields, without
 * changing the authoritative buffer, journal, or UTF-16 offsets of the decoded text. */
export function agentEncoder({ tokenFile, steer }: AgentHubConfig): (message: OutMessage) => string {
  const hidden = JSON.stringify(tokenFile).slice(1, -1), mask = '*'.repeat(tokenFile.length);
  return message => {
    const line = encode(message.t === 'welcome'
      ? { ...message, caps: { ...(isObj(message.caps) ? message.caps : {}), agentHub: { steer: steer === true } } }
      : message);
    return line.includes(hidden) ? line.replaceAll(hidden, mask) : line;
  };
}
