import { children } from 'solid-js';
import { skinState } from '../services/skinProvider';
import { setSkin } from '../services/skinProvider';

function SkinPill({ label, value, active, onClick }) {
  return (
    <button
      classList={{ active: active === value }}
      type="button"
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

export default function Layout(props) {
  const getChildren = children(() => props.children);

  return (
    <div class="app-shell">
      <header class="top-nav">
        <a href="#home" class="brand">Intellacc</a>
        <nav>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'home')}>
            Home
          </button>
        </nav>
        <div class="skin-toggle">
          <span>Skin:</span>
          <SkinPill label="Van" value="van" active={skinState()} onClick={setSkin} />
          <SkinPill
            label="Terminal"
            value="terminal"
            active={skinState()}
            onClick={setSkin}
          />
        </div>
      </header>
      <main>{getChildren()}</main>
    </div>
  );
}
