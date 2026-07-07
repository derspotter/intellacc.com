import { createSignal, Show } from 'solid-js';
import { joinGroup, leaveGroup } from '../../services/api';
import { isAuthenticated } from '../../services/auth';
import { activateOnKey } from '../../utils/keyboard';

export default function GroupCard(props) {
  const [member, setMember] = createSignal(!!props.group.is_member);
  const [count, setCount] = createSignal(Number(props.group.member_count) || 0);
  const [busy, setBusy] = createSignal(false);

  const open = () => { window.location.hash = `#group/${props.group.slug}`; };

  const toggle = async (e) => {
    e.stopPropagation();
    if (!isAuthenticated() || busy()) return;
    setBusy(true);
    try {
      const res = member() ? await leaveGroup(props.group.id) : await joinGroup(props.group.id);
      setMember(res.is_member);
      setCount(res.member_count);
    } catch { /* ignore; leave state unchanged */ }
    finally { setBusy(false); }
  };

  return (
    <div
      class="group-card"
      role="button"
      tabindex="0"
      onClick={open}
      onKeyDown={(e) => { if (e.target === e.currentTarget) activateOnKey(open)(e); }}
    >
      <div class="group-card-top">
        <span class="group-card-name">{props.group.name}</span>
        <span class="group-chip">{props.group.topic_name}</span>
      </div>
      <Show when={props.group.description}>
        <p class="group-card-desc">{props.group.description}</p>
      </Show>
      <div class="group-card-meta">
        <span class="group-card-members">{count()} member{count() === 1 ? '' : 's'}</span>
        <Show when={isAuthenticated()}>
          <button type="button" class={`group-join ${member() ? 'joined' : ''}`} onClick={toggle} disabled={busy()}>
            {member() ? 'Joined' : 'Join'}
          </button>
        </Show>
      </div>
    </div>
  );
}
