# Plan: Style "Edit Profile" Button

**Objective:** Change the "Edit Profile" button to have a blue background and white text using a reusable approach.

**Chosen Approach:** Modify the `Button.js` component to accept a `variant` prop (Plan 2).

**Steps:**

1.  **Modify `frontend/src/components/common/Button.js`:**
    *   Add an optional `variant` prop to the function signature.
    *   Update the `class` attribute logic to include a variant-specific class (e.g., `button-primary` when `variant="primary"`).
    *   Example logic: `class: \`button ${variant ? \`button-\${variant}\` : ''} ${className}\``.trim()`

2.  **Modify `frontend/styles.css`:**
    *   Add new CSS rules for the primary button variant after the generic `button` styles (around line 479).
    *   ```css
      /* Button Variants */
      .button-primary {
        background-color: var(--blue-bg);
        color: white;
        border: none;
      }

      .button-primary:hover {
        opacity: 0.9;
      }
      ```

3.  **Modify `frontend/src/components/profile/ProfileCard.js`:**
    *   Locate the "Edit Profile" `Button` component usage (lines 30-33).
    *   Add the `variant="primary"` prop to it.
    *   Keep the existing `className="edit-profile-button"` for potential non-styling uses.
    *   Example: `<Button onclick={onEdit} className="edit-profile-button" variant="primary">Edit Profile</Button>`

**Diagram:**

```mermaid
graph LR
    A[ProfileCard.js] -- Renders --> B(Button Component with variant="primary");
    B -- Adds class --> C(.button-primary);
    D[Button.js] -- Defines logic --> B;
    E[styles.css] -- Defines styles for --> C;
    E -- Sets --> F{background-color: var(--blue-bg)};
    E -- Sets --> G{color: white};
    E -- Sets --> H{border: none};
    E -- Sets hover --> I{opacity: 0.9};
```

**Next Step:** Switch to "Code" mode to implement these changes.