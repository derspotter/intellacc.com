import van from 'vanjs-core';

const { div, h1, p, button, label, input } = van.tags;

// Placeholder for dark mode state and toggle function
// We'll implement this later
const isDarkMode = van.state(false); // Default to light mode

const toggleDarkMode = () => {
  isDarkMode.val = !isDarkMode.val;
  // In a real app, you'd also save this to localStorage
  // and apply/remove a class to the body or root element
  console.log("Dark mode toggled:", isDarkMode.val);
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  // Persist preference
  localStorage.setItem('darkMode', isDarkMode.val);
};

// Initialize dark mode from localStorage if available
const savedDarkMode = localStorage.getItem('darkMode');
if (savedDarkMode !== null) {
  isDarkMode.val = savedDarkMode === 'true';
  if (isDarkMode.val) {
    document.body.classList.add('dark-mode');
  }
}


export default function SettingsPage() {
  return div({ class: 'settings-page' },
    h1('Settings'),
    div({ class: 'setting-item' },
      label(
        input({ 
          type: 'checkbox', 
          checked: isDarkMode, 
          onchange: toggleDarkMode 
        }),
        ' Dark Mode'
      )
    )
  );
}
