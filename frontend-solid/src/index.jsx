/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.jsx'

const root = document.getElementById('root')

console.log("%c SOLID APP INITIALIZING ", "background: #222; color: #bada55; font-size: 20px");

render(() => <App />, root)
