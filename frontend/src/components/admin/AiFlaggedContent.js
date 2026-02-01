/**
 * Admin view for AI-flagged content
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h3, p, button, select, option, table, thead, tbody, tr, th, td } = van.tags;

export default function AiFlaggedContent() {
  const items = van.state([]);
  const loading = van.state(true);
  const error = van.state('');
  const filterType = van.state('');

  const loadFlags = async () => {
    loading.val = true;
    error.val = '';
    try {
      const params = {};
      if (filterType.val) params.content_type = filterType.val;
      const data = await api.admin.getAiFlags(params);
      items.val = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[AiFlaggedContent] Error:', err);
      error.val = err.data?.error || err.message || 'Failed to load flagged content';
    } finally {
      loading.val = false;
    }
  };

  loadFlags();

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

  return div({ class: 'settings-section ai-flagged-content' },
    h3({ class: 'settings-section-title' }, 'AI Moderation'),
    div({ class: 'ai-flags-toolbar' },
      select({
        class: 'form-input ai-flags-filter',
        onchange: (e) => {
          filterType.val = e.target.value;
          loadFlags();
        }
      },
        option({ value: '' }, 'All content'),
        option({ value: 'post' }, 'Posts'),
        option({ value: 'comment' }, 'Comments'),
        option({ value: 'bio' }, 'Bios')
      ),
      button({ type: 'button', class: 'btn btn-secondary btn-sm', onclick: loadFlags }, 'Refresh')
    ),
    () => {
      if (loading.val) return p('Loading flagged content...');
      if (error.val) return p({ class: 'error-message' }, error.val);
      if (!items.val.length) return p('No flagged content found.');

      return table({ class: 'ai-flags-table' },
        thead(
          tr(
            th('Type'),
            th('User'),
            th('AI Probability'),
            th('Preview'),
            th('Analyzed')
          )
        ),
        tbody(
          items.val.map(item => tr(
            td(item.content_type || '--'),
            td(item.username || `User ${item.user_id}`),
            td(formatProbability(item.ai_probability)),
            td(renderPreview(item)),
            td(item.analyzed_at ? new Date(item.analyzed_at).toLocaleString() : '--')
          ))
        )
      );
    }
  );
}
