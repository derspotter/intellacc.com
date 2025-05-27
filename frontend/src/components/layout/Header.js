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
  return header({ class: "header-box" });
}