import van from 'vanjs-core';
import messagingStore, { deriveMlsDiagnostics } from '../stores/messagingStore.js';
import { isLoggedInState } from '../services/auth.js';
import { isMlsEnabled } from '../services/mls/coreCryptoClient.js';

const {
  div,
  h1,
  h2,
  h3,
  p,
  span,
  table,
  thead,
  tbody,
  tr,
  th,
  td,
  select,
  option,
  button,
  ul,
  li
} = van.tags;

const formatTimestamp = (value) => {
  if (!value && value !== 0) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    try {
      const parsed = new Date(String(value));
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    } catch {}
    return String(value);
  }
  return date.toLocaleString();
};

const describeBoolean = (value, truthy = 'enabled', falsy = 'disabled') => {
  if (value == null) return 'unknown';
  return value ? truthy : falsy;
};

export default function MlsDiagnosticsPage() {
  const selectedConversation = van.state('all');

  const renderCredentialSection = () => () => {
    const credential = messagingStore.mlsCredential;
    if (!credential) {
      return div({ class: 'mls-card' }, [
        h2('Credential'),
        p('No MLS credential cached for this device yet.')
      ]);
    }

    let status = 'unknown';
    if (credential.expiresAt) {
      const expiresTs = Date.parse(credential.expiresAt);
      if (Number.isFinite(expiresTs)) {
        const remaining = expiresTs - Date.now();
        status = remaining <= 0 ? 'expired' : (remaining <= 7 * 24 * 60 * 60 * 1000 ? 'expiring' : 'valid');
      }
    }

    return div({ class: 'mls-card' }, [
      h2('Credential'),
      table({ class: 'mls-table' }, [
        tbody([
          tr([th('Status'), td(status)]),
          tr([th('Issued at'), td(formatTimestamp(credential.issuedAt))]),
          tr([th('Expires at'), td(formatTimestamp(credential.expiresAt))]),
          tr([th('Signer'), td(credential.signer?.id || '—')]),
          tr([th('Request ID'), td(credential.requestId ?? '—')])
        ])
      ])
    ]);
  };

  const renderConversationsSection = () => () => {
    const ids = messagingStore.conversationIds || [];
    if (ids.length === 0) {
      return div({ class: 'mls-card' }, [
        h2('Conversations'),
        p('No conversations found. Start a chat to populate diagnostics.')
      ]);
    }

    return div({ class: 'mls-card' }, [
      h2('Conversations'),
      table({ class: 'mls-table' }, [
        thead([
          tr([
            th('ID'),
            th('Name'),
            th('Encryption'),
            th('Epoch'),
            th('History'),
            th('Ciphersuite'),
            th('Last Update')
          ])
        ]),
        tbody(ids.map((id) => {
          const diag = deriveMlsDiagnostics(id);
          const conv = diag.conversation;
          return tr({ key: id }, [
            td(String(id)),
            td(conv?.displayName || conv?.other_user_username || `Conversation ${id}`),
            td(diag.encryptionMode || '—'),
            td(diag.epoch != null ? String(diag.epoch) : '—'),
            td(describeBoolean(diag.historySharingEnabled, 'enabled', 'disabled')),
            td(diag.ciphersuite || '—'),
            td(formatTimestamp(diag.lastUpdatedAt || conv?.updated_at || conv?.created_at))
          ]);
        }))
      ])
    ]);
  };

  const renderEventsSection = () => () => {
    const filter = selectedConversation.val;
    const events = messagingStore.mlsDiagnosticEvents || [];
    const filtered = filter === 'all' ? events : events.filter(event => event.conversationId === filter);
    const lastEvents = filtered.slice(-25).reverse();

    return div({ class: 'mls-card' }, [
      h2('Event Log'),
      div({ class: 'mls-toolbar' }, [
        div({ class: 'mls-filter' }, [
          span('Conversation:'),
          select({
            value: () => selectedConversation.val,
            onchange: (event) => { selectedConversation.val = event.target.value; }
          }, [
            option({ value: 'all' }, 'All conversations'),
            ...(messagingStore.conversationIds || []).map((id) => {
              const conv = messagingStore.conversationsById?.[id];
              const label = conv?.displayName || conv?.other_user_username || `Conversation ${id}`;
              return option({ value: String(id), key: id }, label);
            })
          ])
        ]),
        button({
          class: 'btn btn-secondary btn-xs',
          onclick: () => messagingStore.clearDiagnosticEvents()
        }, 'Clear log')
      ]),
      lastEvents.length === 0
        ? p('No diagnostic events recorded yet.')
        : ul({ class: 'mls-event-list' }, lastEvents.map((event) => li({ key: event.id }, [
            div({ class: `mls-event mls-event-${event.level}` }, [
              span({ class: 'mls-event-ts' }, formatTimestamp(event.timestamp)),
              span({ class: 'mls-event-level' }, event.level.toUpperCase()),
              span({ class: 'mls-event-message' }, event.message || '(no message)'),
              event.error ? span({ class: 'mls-event-error' }, ` • ${event.error}`) : null,
              event.conversationId ? span({ class: 'mls-event-meta' }, ` • convo ${event.conversationId}`) : null,
              event.data ? span({ class: 'mls-event-meta' }, ` • data ${JSON.stringify(event.data)}`) : null
            ])
          ])))
    ]);
  };

  return div({ class: 'mls-diagnostics-page' }, [
    h1('MLS Diagnostics'),
    () => {
      if (!isLoggedInState.val) {
        return div({ class: 'mls-card warning' }, [
          h3('Authentication required'),
          p('Log in to inspect MLS diagnostics for your conversations.')
        ]);
      }
      if (!isMlsEnabled()) {
        return div({ class: 'mls-card warning' }, [
          h3('MLS disabled'),
          p('Enable the VITE_ENABLE_MLS feature flag to access diagnostics.')
        ]);
      }
      return div({ class: 'mls-stack' }, [
        renderCredentialSection(),
        renderConversationsSection(),
        renderEventsSection()
      ]);
    }
  ]);
}
