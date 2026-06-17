import { createSignal, onMount, For, Show } from 'solid-js';
import { getGroupMarkets, pinGroupMarket, unpinGroupMarket, getEvents } from '../../services/api';

const pct = (p) => (p == null ? '—' : `${Math.round(Number(p) * 100)}%`);
const day = (d) => (d ? new Date(d).toLocaleDateString() : '');

export default function GroupMarkets(props) {
  const [markets, setMarkets] = createSignal([]);
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal([]);
  const [busy, setBusy] = createSignal(false);

  const load = async () => { try { const r = await getGroupMarkets(props.group.slug); setMarkets(r.markets || []); } catch { setMarkets([]); } };
  onMount(load);

  const search = async () => {
    const text = q().trim();
    if (text.length < 2) { setResults([]); return; }
    try { const evs = await getEvents(text); setResults((Array.isArray(evs) ? evs : []).slice(0, 5)); } catch { setResults([]); }
  };
  const pin = async (eventId) => { setBusy(true); try { await pinGroupMarket(props.group.id, eventId); setQ(''); setResults([]); await load(); } catch {} finally { setBusy(false); } };
  const unpin = async (eventId) => { setBusy(true); try { await unpinGroupMarket(props.group.id, eventId); await load(); } catch {} finally { setBusy(false); } };

  return (
    <div class="group-markets">
      <Show when={props.isOwner}>
        <div class="group-markets-pin">
          <input class="group-create-input" value={q()} onInput={(e) => setQ(e.currentTarget.value)} onBlur={search} placeholder="Search a market to pin…" />
          <button type="button" class="button" onClick={search} disabled={busy()}>Search</button>
          <Show when={results().length > 0}>
            <div class="group-markets-results">
              <For each={results()}>
                {(ev) => (
                  <div class="group-markets-result">
                    <span class="group-markets-rtitle">{ev.title}</span>
                    <button type="button" class="group-join" onClick={() => pin(ev.id)} disabled={busy()}>Pin</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={markets().length === 0}><p class="groups-empty">No markets pinned yet.</p></Show>
      <div class="group-markets-list">
        <For each={markets()}>
          {(m) => (
            <div class="group-market-card">
              <a class="group-market-title" href={`#predictions/${m.event_id}`}>{m.title}</a>
              <div class="group-market-meta">
                <span>{m.outcome ? `Resolved: ${m.outcome}` : `Prob ${pct(m.market_prob)}`}</span>
                <span>{m.closing_date ? `Closes ${day(m.closing_date)}` : ''}</span>
                <Show when={props.isOwner}><button type="button" class="group-market-unpin" onClick={() => unpin(m.event_id)} disabled={busy()}>Unpin</button></Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
