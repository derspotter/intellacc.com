import { createSignal, onMount, For, Show } from 'solid-js';
import api from '../../services/api';

export default function AiFlaggedContent() {
  const [items, setItems] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [filterType, setFilterType] = createSignal('');

  const loadFlags = async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filterType()) params.content_type = filterType();
      const data = await api.admin.getAiFlags(params);
      setItems(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[AiFlaggedContent] Error:', err);
      setError(err?.data?.error || err?.message || 'Failed to load flagged content');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadFlags();
  });

  const renderPreview = (item) => {
    const content = item.content || item.user_bio || '';
    if (!content) return 'Content unavailable';
    if (content.length <= 140) return content;
    return `${content.slice(0, 140)}...`;
  };

  const formatProbability = (value) => {
    const num = Number(value);
    if (Number.isNaN(num)) return '--';
    return `${Math.round(num * 100)}%`;
  };

  return (
    <div class="settings-section ai-flagged-content">
      <h3 class="settings-section-title">AI Moderation</h3>
      <div class="ai-flags-toolbar" style={{ "margin-bottom": "1rem", "display": "flex", "gap": "1rem" }}>
        <select
          class="form-input ai-flags-filter"
          value={filterType()}
          onChange={(e) => {
            setFilterType(e.target.value);
            loadFlags();
          }}
        >
          <option value="">All content</option>
          <option value="post">Posts</option>
          <option value="comment">Comments</option>
          <option value="bio">Bios</option>
        </select>
        <button type="button" class="btn btn-secondary btn-sm" onClick={loadFlags}>
          Refresh
        </button>
      </div>

      <Show when={loading()}>
        <p>Loading flagged content...</p>
      </Show>
      
      <Show when={error()}>
        <p class="error-message">{error()}</p>
      </Show>

      <Show when={!loading() && !error() && items().length === 0}>
        <p>No flagged content found.</p>
      </Show>

      <Show when={!loading() && !error() && items().length > 0}>
        <table class="ai-flags-table" style={{ "width": "100%", "border-collapse": "collapse", "margin-top": "1rem" }}>
          <thead>
            <tr style={{ "text-align": "left", "border-bottom": "1px solid var(--border-color)" }}>
              <th style={{ "padding": "0.5rem" }}>Type</th>
              <th style={{ "padding": "0.5rem" }}>User</th>
              <th style={{ "padding": "0.5rem" }}>AI Probability</th>
              <th style={{ "padding": "0.5rem" }}>Preview</th>
              <th style={{ "padding": "0.5rem" }}>Analyzed</th>
            </tr>
          </thead>
          <tbody>
            <For each={items()}>
              {(item) => (
                <tr style={{ "border-bottom": "1px solid var(--border-color, #eee)" }}>
                  <td style={{ "padding": "0.5rem" }}>{item.content_type || '--'}</td>
                  <td style={{ "padding": "0.5rem" }}>{item.username || `User ${item.user_id}`}</td>
                  <td style={{ "padding": "0.5rem" }}>{formatProbability(item.ai_probability)}</td>
                  <td style={{ "padding": "0.5rem" }}>{renderPreview(item)}</td>
                  <td style={{ "padding": "0.5rem" }}>{item.analyzed_at ? new Date(item.analyzed_at).toLocaleString() : '--'}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}
