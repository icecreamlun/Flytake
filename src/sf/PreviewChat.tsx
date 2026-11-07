import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFlytake } from '../state/store';
import { approvePreview, startPreview, usePreview } from './preview';
import type { SfWorld } from './session';
import './PreviewChat.css';
import { followUpReply } from './chatReplies';

const EXAMPLE = "I'd like to film the Ferry Building.";

/** A fixed demo conversation around the existing flight; no generated routes or API calls. */
export function PreviewChat({ world }: { world: SfWorld | null }) {
  const phase = useFlytake(s => s.phase);
  const preparing = useFlytake(s => s.dronePreparing);
  const blackout = useFlytake(s => s.blackout);
  const active = usePreview(s => s.active);
  const approved = usePreview(s => s.approved);
  const completed = usePreview(s => s.completed);
  const reviewPending = usePreview(s => s.reviewPending);
  const approveButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [request, setRequest] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [previewPreparing, setPreviewPreparing] = useState(false);
  const [followUps, setFollowUps] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const messages = useRef<HTMLDivElement>(null);
  const wasActive = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const available = world != null && !active && !blackout && ((phase === 'drone' && !preparing) || phase === 'free');

  useEffect(() => {
    if (wasActive.current && !active && !approved) setOpen(true);
    wasActive.current = active;
  }, [active, approved]);
  useEffect(() => {
    if (open && available && !reviewPending) input.current?.focus();
  }, [open, available, reviewPending]);

  useEffect(() => {
    if (available && reviewPending && !approved) approveButton.current?.focus();
  }, [available, reviewPending, approved]);

  useEffect(() => {
    if (!previewPreparing) return;
    const timer = window.setTimeout(() => setPreviewPreparing(false), 2400);
    return () => window.clearTimeout(timer);
  }, [previewPreparing]);

  useEffect(() => {
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [followUps, previewPreparing, request, open, available]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || previewPreparing) return;
    if (request != null) {
      setFollowUps(previous => [...previous, { role: 'user', text }, { role: 'assistant', text: followUpReply(text, approved) }]);
      setDraft(''); setUnsupported(false);
      return;
    }
    if (!/\bferry\s+building\b/i.test(text)) { setUnsupported(true); return; }
    setRequest(text); setDraft(''); setUnsupported(false); setPreviewPreparing(true);
  }
  function watch() {
    if (!world) return;
    (document.activeElement as HTMLElement | null)?.blur();
    setOpen(false);
    startPreview(world);
  }
  function close() { setOpen(false); launcher.current?.focus(); }

  if (!available) return null;
  return <>
    {reviewPending && !approved && <div className="sf-review-backdrop" onKeyDownCapture={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); usePreview.setState({ reviewPending: false }); setOpen(true); }
      if (event.key === 'Tab') {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <section className="sf-review-card" role="dialog" aria-modal="true" aria-labelledby="sf-review-title" aria-describedby="sf-review-description">
        <span className="sf-chat-eyebrow mono">PREVIEW COMPLETE</span>
        <h2 id="sf-review-title">Keep this flight plan?</h2>
        <p id="sf-review-description">Approve the Ferry Building shot to show its route on the map and unlock Preview flight for replay.</p>
        <button ref={approveButton} className="pill pill-accent" onClick={() => { if (world) approvePreview(world); setOpen(true); }}>Approve & show route</button>
        <button className="pill pill-ghost" onClick={() => { usePreview.setState({ reviewPending: false }); setOpen(true); }}>Not now — return to chat</button>
      </section>
    </div>}
    <button ref={launcher} className="pill sf-chat-launcher" data-approved={approved} aria-expanded={open} aria-controls="sf-shot-chat" onClick={() => setOpen(!open)}>
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 8h8M8 12h5" stroke="currentColor" strokeWidth="1.5" /></svg>
      Plan a shot
    </button>
    {open && <section id="sf-shot-chat" className="sf-shot-chat" aria-label="Shot planning chat" onKeyDownCapture={event => {
      // Chat keys must not trigger drone controls, preview shortcuts or time-of-day changes.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.target instanceof HTMLTextAreaElement) { event.preventDefault(); event.target.form?.requestSubmit(); }
    }}>
      <header className="sf-chat-header"><div><span className="sf-chat-eyebrow mono">FLYTAKE</span><h2>Plan your shot</h2></div><button type="button" aria-label="Close shot chat" onClick={close}>×</button></header>
      <div className="sf-chat-messages" ref={messages} role="log" aria-live="polite">
        <div className="sf-chat-message"><span className="sf-chat-speaker">FLYTAKE</span><p>What would you like to film?</p><p className="sf-chat-muted">How about the Ferry Building? Capture the clock tower and waterfront in a one-minute flight.</p></div>
        {request && <>
          <div className="sf-chat-message sf-chat-user"><span className="sf-chat-speaker">YOU</span><p>{request}</p></div>
          {previewPreparing ? <div className="sf-chat-preparing" role="status" aria-live="polite"><span className="sf-chat-thinking" aria-hidden="true"><i /><i /><i /></span><p>Preparing your Ferry Building preview…</p></div> : <>
          <div className="sf-chat-message"><span className="sf-chat-speaker">FLYTAKE</span><p>{approved ? 'Your shot is approved. The route is now on the map, and Preview flight is ready whenever you want to watch again.' : completed ? 'How does that look? Approve this preview to keep its route on the map, or watch it again.' : 'Here’s a flight around the Ferry Building. Watch the one-minute preview, then approve it to save the route for this visit.'}</p></div>
          <div className="sf-chat-shot"><span className="sf-chat-eyebrow mono">FERRY BUILDING · 60 SECONDS</span><h3>A waterfront perspective</h3><p>The plaza, clock tower and bay, in one continuous flight.</p>
            <button className="pill pill-accent" onClick={watch}>{completed || approved ? '↻ Watch preview again' : '▶ Watch preview'}</button>
          </div>
          {completed && !approved && !active && <button className="pill pill-accent sf-chat-approve" onClick={() => world && approvePreview(world)}>✓ Approve preview</button>}
          {!completed && !active && <p className="sf-chat-note">Watch to the end to approve. You can exit and replay anytime.</p>}
          {approved && !active && <p className="sf-chat-success" role="status">✓ Approved · Find Preview flight in the top left.</p>}
          </>}
        </>}
        {unsupported && <div className="sf-chat-message" role="status"><p>Let’s start with the Ferry Building. Select the suggested request below to see a waterfront flight.</p></div>}
        {followUps.map((message, index) => <div key={index} className={'sf-chat-message' + (message.role === 'user' ? ' sf-chat-user' : '')}><span className="sf-chat-speaker">{message.role === 'user' ? 'YOU' : 'FLYTAKE'}</span><p>{message.text}</p></div>)}
      </div>
      <form className="sf-chat-compose" onSubmit={submit}>
        {!request && <button type="button" className="sf-chat-example" onClick={() => { setDraft(EXAMPLE); setUnsupported(false); input.current?.focus(); }}>{EXAMPLE} ↗</button>}
        <label className="visually-hidden" htmlFor="sf-shot-request">{request ? "Message about your flight plan" : "What would you like to film?"}</label>
        <textarea id="sf-shot-request" ref={input} rows={2} maxLength={500} value={draft} placeholder={request ? "Ask about your shot…" : "I’d like to film…"} onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="pill pill-accent sf-chat-send" disabled={!draft.trim() || previewPreparing}>{request ? "Send message →" : "Find my preview →"}</button>
      </form>
      <footer className="sf-chat-footer">Ferry Building · Your plan stays available until you refresh</footer>
    </section>}
  </>;
}
