import { createSignal, onMount, For, Show } from 'solid-js';
import { getGroupMembers, removeGroupMember } from '../../services/api';

export default function GroupMembers(props) {
  const [members, setMembers] = createSignal([]);
  const [busy, setBusy] = createSignal(false);
  const load = async () => { try { const r = await getGroupMembers(props.group.slug); setMembers(r.members || []); } catch { setMembers([]); } };
  onMount(load);
  const kick = async (userId) => { setBusy(true); try { const r = await removeGroupMember(props.group.id, userId); props.onMemberRemoved?.(r.member_count); await load(); } catch {} finally { setBusy(false); } };
  return (
    <div class="group-members">
      <For each={members()}>
        {(m) => (
          <div class="group-member-row">
            <a class="group-member-name" href={`#user/${m.user_id}`}>@{m.username}</a>
            <Show when={m.role === 'owner'}><span class="group-chip">Owner</span></Show>
            <Show when={props.isOwner && m.role !== 'owner'}>
              <button type="button" class="group-market-unpin" onClick={() => kick(m.user_id)} disabled={busy()}>Remove</button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
