import { encode, isObj, type OutMessage, type ResultMsg } from './proto.mts';
import type { AgentHubConfig } from './agent-sessions.mts';

/** Configured clients only. Never rewrite a reply's correlation fields or replicated data. */
export function agentEncoder({ tokenFile, steer }: AgentHubConfig): (message: OutMessage) => string {
  const quoted = JSON.stringify(tokenFile).slice(1, -1);
  const redact = (text: string) => (quoted === tokenFile ? text : text.replaceAll(quoted, '[redacted]'))
    .replaceAll(tokenFile, '[redacted]');
  return message => {
    if (message.t === 'welcome')
      return encode({ ...message, caps: { ...(isObj(message.caps) ? message.caps : {}), agentHub: { steer: steer === true } } });
    if (message.t === 'error' && typeof message.msg === 'string') return encode({ ...message, msg: redact(message.msg) });
    if (message.t === 'msg' && (message.level === 'warn' || message.level === 'error') && typeof message.text === 'string')
      return encode({ ...message, text: redact(message.text) });
    if (message.t === 'result') {
      const { error } = message as ResultMsg;
      if (error) return encode({ ...message, error: { ...error, report: redact(error.report), backtrace: error.backtrace.map(redact) } });
    }
    return encode(message);
  };
}
