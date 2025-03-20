import van from 'vanjs-core';
const { header, div, a } = van.tags;
import { isLoggedInState } from '../../services/auth';
import Button from '../common/Button';
import { logout } from '../../services/auth';

/**
 * Application header component
 * @returns {HTMLElement} Header element
 */
export default function Header() {
  return header({ class: "header-box" }, [
    div({ class: "header-content" }, [
      div({ class: "header-item title" },
        a({
          href: "#home",
          style: "text-decoration: none; color: inherit;"
        }, "INTELLACC")
      ),
      div({ class: "header-item" }, ["Version", div({}, "v0.1.5")]),
      div({ class: "header-item" }, ["License", div({}, "MIT")]),
      div({ class: "subtitle" }, "A social network with prediction markets")
    ]),
  ]);
}