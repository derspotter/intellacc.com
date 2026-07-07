import { onCleanup, onMount, For } from 'solid-js';
import { SHORTCUTS, createFocusTrap, pushOverlay, popOverlay } from '../utils/keyboard';

// Keyboard-shortcut reference dialog, opened with `?`.
export default function ShortcutHelp(props) {
  let panel;
  let disposeTrap;

  onMount(() => {
    pushOverlay(props.onClose);
    disposeTrap = createFocusTrap(panel);
    panel.querySelector('button')?.focus();
  });

  onCleanup(() => {
    popOverlay();
    disposeTrap?.();
  });

  return (
    <div class="shortcut-help-backdrop" onClick={props.onClose}>
      <div
        class="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <table>
          <tbody>
            <For each={SHORTCUTS}>
              {(s) => (
                <tr>
                  <td class="shortcut-keys">{s.keys}</td>
                  <td>{s.action}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <button type="button" class="secondary" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
