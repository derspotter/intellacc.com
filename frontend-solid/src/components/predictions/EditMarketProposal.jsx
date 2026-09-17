import { createSignal, Show } from 'solid-js';
import { updateMarketQuestion } from '../../services/api';

export default function EditMarketProposal(props) {
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [saved, setSaved] = createSignal(false);
  const [title, setTitle] = createSignal('');
  const [details, setDetails] = createSignal('');
  const [category, setCategory] = createSignal('');
  const [closingDate, setClosingDate] = createSignal('');
  const open = () => {
    const proposal = props.submission;
    setTitle(proposal.title || '');
    setDetails(proposal.details || '');
    setCategory(proposal.category || '');
    const date = new Date(proposal.closing_date);
    setClosingDate(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    setError('');
    setSaved(false);
    setEditing(true);
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy()) return;
    setError('');
    const date = new Date(closingDate());
    if (!title().trim() || !details().trim()) { setError('Title and details are required'); return; }
    if (!Number.isFinite(date.getTime()) || date <= new Date()) { setError('Closing date must be in the future'); return; }
    setBusy(true);
    try {
      await updateMarketQuestion(props.submission.id, {
        title: title(), details: details(), category: category(), closing_date: date.toISOString()
      });
      setEditing(false);
      setSaved(true);
      await props.onSaved();
    } catch (err) {
      setError(err.message || 'Could not save proposal');
    } finally {
      setBusy(false);
    }
  };
  return <div>
    <Show when={!editing()}>
      <button type="button" class="button" onClick={open}>Edit proposal</button>
      <Show when={saved()}><p role="status">Proposal saved.</p></Show>
    </Show>
    <Show when={editing()}>
      <form class="market-question-form" onSubmit={save}>
        <p>You can edit this proposal until its first review. Your existing bond is retained.</p>
        <label>Title<input required value={title()} onInput={(e) => setTitle(e.currentTarget.value)} disabled={busy()} /></label>
        <label>Details<textarea required rows="4" value={details()} onInput={(e) => setDetails(e.currentTarget.value)} disabled={busy()} /></label>
        <label>Category<input value={category()} onInput={(e) => setCategory(e.currentTarget.value)} disabled={busy()} /></label>
        <label>Closing date (your local time)<input required type="datetime-local" value={closingDate()} onInput={(e) => setClosingDate(e.currentTarget.value)} disabled={busy()} /></label>
        <Show when={error()}><p role="alert">{error()}</p></Show>
        <div class="market-question-form-actions">
          <button type="submit" class="button" disabled={busy()}>{busy() ? 'Saving…' : 'Save changes'}</button>
          <button type="button" class="button" disabled={busy()} onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </form>
    </Show>
  </div>;
}
