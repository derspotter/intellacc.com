# VanJS Reference Documentation

Retrieved from Context7 for the Intellacc project.

## Core Concepts

### Reactive State with `van.state`

```javascript
const Counter = () => {
  const counter = van.state(0)
  return div(
    "❤️ ", counter, " ",
    button({onclick: () => ++counter.val}, "👍"),
    button({onclick: () => --counter.val}, "👎"),
  )
}

van.add(document.body, Counter())
```

- `van.state(initialValue)` creates a reactive state
- Access value with `.val` property
- Components re-render when state changes

## Input Handling Patterns

### IMPORTANT: Form Input Best Practices

**Problem**: If you bind input values to state AND render components conditionally based on state, changing the input triggers re-renders which recreate the input element, causing focus loss.

**Solution**: Use one of these patterns:

#### Pattern 1: Uncontrolled Inputs with Refs (Recommended for Forms)

```javascript
const LoginForm = () => {
  let emailInputRef = null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const email = emailInputRef.value; // Read directly from DOM
    // ... process email
  };

  return form({ onsubmit: handleSubmit },
    emailInputRef = input({
      id: 'email',
      type: 'email',
      placeholder: 'Enter email'
      // NO value binding, NO oninput handler
    }),
    button({ type: 'submit' }, 'Submit')
  );
};
```

#### Pattern 2: Show/Hide via CSS (Not Conditional Rendering)

```javascript
const MultiStageForm = () => {
  const stage = van.state('email');

  // Create ALL forms once, show/hide with CSS
  return div(
    // Email form - hidden when not active
    form({
      style: () => `display: ${stage.val === 'email' ? 'block' : 'none'}`
    },
      input({ id: 'email', type: 'email' })
    ),

    // Password form - hidden when not active
    form({
      style: () => `display: ${stage.val === 'password' ? 'block' : 'none'}`
    },
      input({ id: 'password', type: 'password' })
    )
  );
};
```

#### Pattern 3: Reactive Display (For Read-Only Values)

```javascript
const DisplayValue = () => {
  const name = van.state('');

  return div(
    input({
      oninput: (e) => { name.val = e.target.value; }
    }),
    // Use arrow function for reactive display
    p(() => `Hello, ${name.val}!`)
  );
};
```

### What NOT to Do

```javascript
// BAD: This causes input recreation on every keystroke
const BadForm = () => {
  const email = van.state('');

  return () => {  // Arrow function re-runs on state change!
    return form(
      input({
        value: email.val,  // Sets initial value
        oninput: (e) => { email.val = e.target.value; }  // Triggers re-render
      })
    );
  };
};
```

## Modal with Form Example

```typescript
const closed = van.state(false)
const formDom = form(
  div(input({type: "radio", name: "lang", value: "Zig", checked: true}), "Zig"),
  div(input({type: "radio", name: "lang", value: "Rust"}), "Rust"),
)

const onOk = () => {
  const lang = formDom.querySelector("input:checked").value
  alert(lang + " is a good language")
  closed.val = true
}

van.add(document.body, Modal({closed},
  p("What's your favorite programming language?"),
  formDom,
  button({onclick: onOk}, "Ok"),
))
```

## Terminal Input with History

```javascript
const Input = ({id, cwd}) => {
  let historyId = id

  const onkeydown = async e => {
    if (e.key === "Enter") {
      e.preventDefault()
      e.target.setAttribute("readonly", true)
      // Process command...
    } else if (e.key === "ArrowUp" && historyId > 1) {
      e.target.value = document.getElementById(--historyId).value
      const length = e.target.value.length
      setTimeout(() => e.target.setSelectionRange(length, length))
    }
  }

  return div(
    input({id, type: "text", placeholder: 'Type command...', onkeydown})
  )
}
```

## Key Takeaways

1. **Inputs in conditional renders** will lose focus - use CSS show/hide instead
2. **Read input values from DOM** at submit time, don't bind to state for forms
3. **Use arrow functions** `() => value` for reactive text display
4. **State updates trigger re-renders** of any arrow function that accesses the state
5. **Create elements once** and control visibility, don't recreate them
