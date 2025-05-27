// src/components/auth/SignUpForm.js
import van from 'vanjs-core';
const { div, h1, form, label, input, button, p, a } = van.tags;
import auth from '../../services/auth';

/**
 * Sign up form component with improved input handling
 */
const SignUpForm = () => {
  // Use separate state for each field
  const username = van.state('');
  const email = van.state('');
  const password = van.state('');
  const confirmPassword = van.state('');
  const submitting = van.state(false);
  const error = van.state('');
  
  // Validation state
  const validationErrors = van.state({});
  
  // Validate form
  const validateForm = () => {
    const errors = {};
    
    if (!username.val.trim()) {
      errors.username = 'Username is required';
    } else if (username.val.trim().length < 3) {
      errors.username = 'Username must be at least 3 characters';
    }
    
    if (!email.val.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.val)) {
      errors.email = 'Please enter a valid email address';
    }
    
    if (!password.val) {
      errors.password = 'Password is required';
    } else if (password.val.length < 6) {
      errors.password = 'Password must be at least 6 characters';
    }
    
    if (!confirmPassword.val) {
      errors.confirmPassword = 'Please confirm your password';
    } else if (password.val !== confirmPassword.val) {
      errors.confirmPassword = 'Passwords do not match';
    }
    
    validationErrors.val = errors;
    return Object.keys(errors).length === 0;
  };
  
  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Clear previous error
    error.val = '';
    
    // Validate form
    if (!validateForm()) {
      return;
    }
    
    submitting.val = true;
    
    try {
      // Call register function from auth service
      const result = await auth.register(username.val.trim(), email.val.trim(), password.val);
      
      if (result.success) {
        // Registration successful - user should be logged in automatically
        // The auth.register function handles login after successful registration
        // Redirect will happen automatically in the auth service
      } else {
        console.error('Registration failed:', result);
        error.val = result.error || 'Registration failed';
        submitting.val = false;
      }
    } catch (err) {
      console.error('Registration error:', err);
      error.val = err.message || 'Registration failed';
      submitting.val = false;
    }
  };
  
  // Add back the outer div for page styling
  return div({ class: "signup-page" }, 
    div({ class: "signup-container" }, [
      h1("Create Account"),
      
      // Show error message if present
      () => error.val ? 
        div({ class: "error-message" }, error.val) : null,
      
      form({ onsubmit: handleSubmit }, [
        div({ class: "form-group" }, [
          label({ for: "username" }, "Username"),
          input({
            id: "username",
            type: "text",
            onchange: (e) => { 
              username.val = e.target.value;
              // Clear validation error when user starts typing
              if (validationErrors.val.username) {
                const errors = { ...validationErrors.val };
                delete errors.username;
                validationErrors.val = errors;
              }
            },
            disabled: submitting.val,
            required: true,
            placeholder: "Choose a username"
          }),
          // Show validation error
          () => validationErrors.val.username ? 
            div({ class: "field-error" }, validationErrors.val.username) : null
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "email" }, "Email"),
          input({
            id: "email",
            type: "email",
            onchange: (e) => { 
              email.val = e.target.value;
              // Clear validation error when user starts typing
              if (validationErrors.val.email) {
                const errors = { ...validationErrors.val };
                delete errors.email;
                validationErrors.val = errors;
              }
            },
            disabled: submitting.val,
            required: true,
            placeholder: "Enter your email"
          }),
          // Show validation error
          () => validationErrors.val.email ? 
            div({ class: "field-error" }, validationErrors.val.email) : null
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "password" }, "Password"),
          input({
            id: "password",
            type: "password",
            onchange: (e) => { 
              password.val = e.target.value;
              // Clear validation error when user starts typing
              if (validationErrors.val.password) {
                const errors = { ...validationErrors.val };
                delete errors.password;
                validationErrors.val = errors;
              }
            },
            disabled: submitting.val,
            required: true,
            placeholder: "Choose a password"
          }),
          // Show validation error
          () => validationErrors.val.password ? 
            div({ class: "field-error" }, validationErrors.val.password) : null
        ]),
        
        div({ class: "form-group" }, [
          label({ for: "confirmPassword" }, "Confirm Password"),
          input({
            id: "confirmPassword",
            type: "password",
            onchange: (e) => { 
              confirmPassword.val = e.target.value;
              // Clear validation error when user starts typing
              if (validationErrors.val.confirmPassword) {
                const errors = { ...validationErrors.val };
                delete errors.confirmPassword;
                validationErrors.val = errors;
              }
            },
            disabled: submitting.val,
            required: true,
            placeholder: "Confirm your password"
          }),
          // Show validation error
          () => validationErrors.val.confirmPassword ? 
            div({ class: "field-error" }, validationErrors.val.confirmPassword) : null
        ]),
        
        div({ class: "form-actions" }, [
          button({
            type: "submit",
            disabled: submitting.val,
            class: "btn-primary"
          }, () => submitting.val ? "Creating Account..." : "Create Account"),
          
          p({ class: "login-link" }, [
            "Already have an account? ",
            a({ 
              href: "#login"
            }, "Sign in here")
          ])
        ])
      ])
    ])
  );
};

export default SignUpForm;
