import { createSignal, For, onMount, Show } from 'solid-js';
import { getAdminMarketQueue, publishAdminMarket, rejectAdminMarket, getMarketState, resolveEvent, ruleOnAdminResolution } from '../../services/api';
import './adminMarketDashboard.css';

const date = (value) => value ? new Date(value).toLocaleString() : 'No date';
const expired = (item) => new Date(item.closing_date) <= new Date();

function DecisionPanel(props) {
  const item = props.item;
  const [choice, setChoice] = createSignal('');
  const [decision, setDecision] = createSignal('publish');
  const [outcomes, setOutcomes] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [acknowledged, setAcknowledged] = createSignal(false);
  const proposal = props.queue === 'proposals';
  const numeric = item.event_type === 'numeric' && !item.resolution_proposal;
  const binary = !item.event_type || item.event_type === 'binary';
  onMount(async () => {
    if (proposal || binary || numeric) return;
    setLoading(true);
    try {
      const state = await getMarketState(item.id);
      setOutcomes(state?.outcomes || []);
      if (!state?.outcomes?.length) setError('This market has no configured outcomes. Fix its outcomes before resolving.');
    } catch (err) { setError(err.message || 'Could not load outcomes'); }
    finally { setLoading(false); }
  });
  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (proposal && decision() === 'publish' && expired(item) && !acknowledged()) return;
    if (!proposal && (!choice() || (numeric && !Number.isFinite(Number(choice()))))) {
      setError('Choose a valid result before resolving.'); return;
    }
    setBusy(true);
    try {
      if (proposal) {
        if (decision() === 'publish') await publishAdminMarket(item.id, acknowledged());
        else await rejectAdminMarket(item.id);
      }
      else {
        const body = binary ? { outcome: choice() } : numeric ? { numerical_outcome: Number(choice()) } : { outcome_id: Number(choice()) };
        if (item.resolution_proposal) await ruleOnAdminResolution(item.resolution_proposal.id, body);
        else await resolveEvent(item.id, body);
      }
      props.onDone(proposal ? decision() === 'publish' ? 'Proposal published.' : 'Proposal rejected.' : 'Market resolved.');
    } catch (err) { setError(err.message || 'Action failed. Please refresh and try again.'); }
    finally { setBusy(false); }
  };
  return <section class="amd-decision" aria-label="Review market decision">
    <header><h3>{proposal ? 'Review proposal' : 'Resolve closed market'}</h3><button type="button" disabled={busy()} onClick={props.onClose}>Close</button></header>
    <h4>{item.title}</h4>
    <p>#{item.id} · {item.event_type || 'binary'} · Closing date: {date(item.closing_date)}</p>
    <div class="amd-details">{item.details || 'No resolution criteria supplied.'}</div>
    <Show when={item.resolution_proposal}><p>Community resolution: {item.resolution_proposal?.status}. Your ruling will also settle its review stakes.</p></Show>
    <Show when={proposal && item.outcome_rows?.length}><ul><For each={item.outcome_rows}>{(row) => <li>{row.label}</li>}</For></ul></Show>
    <form onSubmit={submit}>
      <Show when={proposal} fallback={<>
        <p>Check the resolution criteria and evidence before confirming. This settles participant balances.</p>
        <Show when={numeric} fallback={<label>Winning outcome
          <select required value={choice()} disabled={busy() || loading()} onChange={(e) => setChoice(e.currentTarget.value)}>
            <option value="">{loading() ? 'Loading outcomes…' : 'Choose outcome…'}</option>
            <Show when={binary} fallback={<For each={outcomes()}>{(row) => <option value={row.outcome_id}>{row.label}</option>}</For>}>
              <option value="yes">YES</option><option value="no">NO</option>
            </Show>
          </select>
        </label>}><label>Actual numeric result<input required type="number" step="any" value={choice()} onInput={(e) => setChoice(e.currentTarget.value)} disabled={busy()} /></label></Show>
      </>}>
        <label>Decision<select value={decision()} disabled={busy()} onChange={(e) => setDecision(e.currentTarget.value)}><option value="publish">Accept and publish</option><option value="reject">Reject proposal</option></select></label>
        <p>{decision() === 'publish' ? 'Publication returns the creator bond and pays the approval reward.' : 'Rejection forfeits the creator bond and does not create a market.'} Existing reviewer stakes are returned. This records an admin decision without adding a community vote.</p>
        <Show when={decision() === 'publish' && expired(item)}><label class="amd-warning"><input type="checkbox" checked={acknowledged()} onChange={(e) => setAcknowledged(e.currentTarget.checked)} /> This proposal has expired. Publish it as a closed market awaiting resolution.</label></Show>
      </Show>
      <Show when={error()}><p role="alert" class="amd-warning">{error()}</p></Show>
      <button class="amd-primary" type="submit" disabled={busy() || loading() || (proposal ? decision() === 'publish' && expired(item) && !acknowledged() : !choice())}>{busy() ? 'Saving…' : proposal ? decision() === 'publish' ? 'Confirm publication' : 'Confirm rejection' : 'Confirm resolution'}</button>
    </form>
  </section>;
}

export default function AdminMarketDashboard() {
  const [queue, setQueue] = createSignal('proposals');
  const [summary, setSummary] = createSignal(null);
  const [items, setItems] = createSignal([]);
  const [total, setTotal] = createSignal(0);
  const [offset, setOffset] = createSignal(0);
  const [search, setSearch] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [selected, setSelected] = createSignal(null);
  let requestId = 0;
  const load = async () => {
    const id = ++requestId;
    setLoading(true); setError('');
    try {
      const data = await getAdminMarketQueue({ queue: queue(), search: search().trim(), offset: offset(), limit: 25 });
      if (id !== requestId) return;
      setSummary(data.summary); setItems(data.items); setTotal(data.total);
      if (!data.items.length && offset() > 0) { setOffset(Math.max(0, offset() - 25)); await load(); }
    } catch (err) { if (id === requestId) { setItems([]); setError(err.message || 'Could not load queues'); } }
    finally { if (id === requestId) setLoading(false); }
  };
  const switchQueue = (value) => { setQueue(value); setOffset(0); setSelected(null); setSearch(''); void load(); };
  onMount(load);
  return <section class="admin-market-dashboard" aria-label="Admin market overview">
    <header class="amd-header"><div><h2>Market operations</h2><p>Publish proposals before they close. Resolve markets whose trading has ended.</p></div><button onClick={() => { setSelected(null); void load(); }} disabled={loading()}>Refresh</button></header>
    <div class="amd-summary">
      <button classList={{ active: queue() === 'proposals' }} onClick={() => switchQueue('proposals')} aria-pressed={queue() === 'proposals'}><strong>{summary()?.proposals ?? '—'}</strong><span>Proposals to publish</span></button>
      <button classList={{ active: queue() === 'closed' }} onClick={() => switchQueue('closed')} aria-pressed={queue() === 'closed'}><strong>{summary()?.closed ?? '—'}</strong><span>Closed markets to resolve</span></button>
      <div class="amd-warning"><strong>{summary()?.expired_proposals ?? '—'}</strong><span>Proposals past their deadline</span></div>
    </div>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={selected()} keyed>{(item) => <DecisionPanel item={item} queue={queue()} onClose={() => setSelected(null)} onDone={(message) => { setSelected(null); setNotice(message); void load(); }} />}</Show>
    <form class="amd-search" onSubmit={(e) => { e.preventDefault(); setOffset(0); setSelected(null); void load(); }}><label for="amd-search">Search title or ID</label><input id="amd-search" type="search" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} /><button disabled={loading()}>Search</button></form>
    <Show when={error()}><p role="alert" class="amd-warning">{error()} <button onClick={load}>Retry</button></p></Show>
    <Show when={!loading()} fallback={<p role="status">Loading queue…</p>}>
      <Show when={!error()}>
        <p class="amd-count">{total()} {queue() === 'proposals' ? 'pending proposals' : 'closed, unresolved markets'}{search().trim() ? ' matching your search' : ''}. Oldest closing dates first. Only visible markets are included.</p>
        <Show when={items().length} fallback={<p>No {queue() === 'proposals' ? 'pending proposals' : 'closed markets awaiting resolution'}{search().trim() ? ' match your search' : ''}.</p>}>
          <div class="amd-list"><For each={items()}>{(item) => <article class="amd-row">
            <div><h3>{item.title}</h3><p>#{item.id} · {item.event_type || 'binary'} · {queue() === 'proposals' ? `Proposed by ${item.creator_username}` : 'Trading closed'}</p><p>Closing date: <time>{date(item.closing_date)}</time></p>
              <Show when={queue() === 'proposals'}><span classList={{ 'amd-warning': expired(item) }}>{expired(item) ? 'Overdue · ' : new Date(item.closing_date) - Date.now() < 172800000 ? 'Closes within 48 hours · ' : ''}{item.approvals} approvals · {item.rejections} rejections</span></Show>
              <Show when={item.hidden_at}><span class="amd-badge">Hidden from public listings</span></Show><Show when={item.resolution_proposal}><span class="amd-badge">Community review: {item.resolution_proposal?.status}</span></Show>
            </div><div class="amd-actions"><Show when={queue() === 'closed'}><a href={`#predictions/${item.id}`}>Open market</a></Show><button class="amd-primary" onClick={() => { setSelected(item); setNotice(''); document.querySelector('.admin-market-dashboard')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>{queue() === 'proposals' ? 'Review proposal' : 'Review & resolve'}</button></div>
          </article>}</For></div>
          <nav class="amd-pagination" aria-label="Queue pages"><button disabled={offset() === 0} onClick={() => { setOffset(Math.max(0, offset() - 25)); void load(); }}>Previous</button><span>{offset() + 1}–{Math.min(offset() + 25, total())} of {total()}</span><button disabled={offset() + 25 >= total()} onClick={() => { setOffset(offset() + 25); void load(); }}>Next</button></nav>
        </Show>
      </Show>
    </Show>
  </section>;
}
