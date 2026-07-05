import { createSignal, onCleanup, onMount, For } from 'solid-js';

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'aria-hidden': 'true'
};

const HomeIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M2 12 L12 3 L22 12" />
    <path d="M5 11 V21 H19 V11" />
    <path d="M10 21 V15 H14 V21" />
  </svg>
);

const PredictionsIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M3 21 L9 12 L13 15 L21 4" />
    <path d="M15 4 H21 V10" />
  </svg>
);

const NotificationsIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M12 3 L22 20 H2 Z" />
    <path d="M12 9 V14" />
    <path d="M12 16 V18" />
  </svg>
);

const MessagesIcon = () => (
  <svg {...ICON_PROPS}>
    <rect x="2" y="5" width="20" height="14" />
    <path d="M2 5 L12 13 L22 5" />
  </svg>
);

const MoreIcon = () => (
  <svg {...ICON_PROPS}>
    <rect x="4" y="4" width="6" height="6" />
    <rect x="14" y="4" width="6" height="6" />
    <rect x="4" y="14" width="6" height="6" />
    <rect x="14" y="14" width="6" height="6" />
  </svg>
);

const TABS = [
  { hash: 'home', label: 'Home', icon: HomeIcon },
  { hash: 'predictions', label: 'Markets', icon: PredictionsIcon },
  { hash: 'notifications', label: 'Alerts', icon: NotificationsIcon },
  { hash: 'messages', label: 'Messages', icon: MessagesIcon }
];

const currentRoute = () => (window.location.hash || '#home').slice(1).split('/')[0];

export default function MobileTabBar(props) {
  const [route, setRoute] = createSignal(currentRoute());
  const handleHashChange = () => setRoute(currentRoute());

  onMount(() => window.addEventListener('hashchange', handleHashChange));
  onCleanup(() => window.removeEventListener('hashchange', handleHashChange));

  return (
    <nav class="mobile-tab-bar" aria-label="Primary">
      <For each={TABS}>
        {(tab) => (
          <a
            href={`#${tab.hash}`}
            class="mobile-tab-item"
            classList={{ active: route() === tab.hash && !props.moreOpen }}
            aria-current={route() === tab.hash ? 'page' : undefined}
          >
            <tab.icon />
            <span>{tab.label}</span>
          </a>
        )}
      </For>
      <button
        type="button"
        class="mobile-tab-item"
        classList={{ active: props.moreOpen }}
        aria-expanded={props.moreOpen}
        onClick={() => props.onMoreToggle()}
      >
        <MoreIcon />
        <span>More</span>
      </button>
    </nav>
  );
}
