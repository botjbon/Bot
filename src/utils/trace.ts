export function traceFlow(tag: string, info?: any) {
  try {
    const payload = { t: tag, ts: Date.now(), info: info || null };
    // keep logs concise but machine-readable
    console.log('[TRACE]', JSON.stringify(payload));
  } catch (e) {
    try { console.log('[TRACE] could not serialize trace', tag); } catch(_){}
  }
}

export default traceFlow;
