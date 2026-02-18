import { render } from 'solid-js/web';
import { initializeSkinProvider } from './services/skinProvider';
import './styles.css';
import App from './App';

const appEl = () => document.getElementById('app');

render(() => {
  initializeSkinProvider();
  return <App />;
}, appEl());
