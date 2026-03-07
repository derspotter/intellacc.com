const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'controllers', 'predictionsController.js');
let code = fs.readFileSync(filePath, 'utf8');

if (!code.includes('asyncHandler')) {
  code = `const asyncHandler = require('../utils/asyncHandler');\n\n` + code;
}

// Wrap exports.xxx = async (req, res) => ...
// into exports.xxx = asyncHandler(async (req, res) => ...)
code = code.replace(/exports\.(\w+)\s*=\s*async\s*\(([^)]+)\)\s*=>\s*\{/g, (match, p1, p2) => {
  return `exports.${p1} = asyncHandler(async (${p2}) => {`;
});

// The end of those functions need to be `});` instead of `};`
// Since we don't have an AST, we can find `  }\n};` and replace it
// Wait, regex might be tricky for nested braces. Let's just do targeted replacements for the known catch blocks.

const catchBlocksToReplace = [
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error fetching predictions:", err\);\n\s*res\.status\(500\)\.send\("Database error: " \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*\/\/ Check for unique constraint violation[\s\S]*?res\.status\(500\)\.json\(\{ message: "Database error: " \+ err\.message \}\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error creating event:", err\);\n\s*res\.status\(500\)\.send\("Database error: " \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\('Error setting event outcomes:', err\);\n\s*if \(err\.status\) \{\n\s*return res\.status\(err\.status\)\.json\(\{ message: err\.message \}\);\n\s*\}\n\s*return res\.status\(500\)\.send\('Database error: ' \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error fetching events:", err\);\n\s*res\.status\(500\)\.send\("Database error: " \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\('Error fetching event by id:', err\);\n\s*res\.status\(500\)\.send\('Database error: ' \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error resolving prediction:", err\);\n\s*res\.status\(500\)\.send\("Database error: " \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\('Error resolving event:', err\);\n\s*return res\.status\(500\)\.send\('Database error: ' \+ err\.message\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error getting assigned predictions:", err\);\n\s*res\.status\(500\)\.json\(\{ message: "Internal server error" \}\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error getting monthly betting stats:", err\);\n\s*res\.status\(500\)\.json\(\{ message: "Internal server error" \}\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error deleting all predictions:", err\);\n\s*res\.status\(500\)\.json\(\{ message: "Database error: " \+ err\.message \}\);\n\s*\}/g,
    replace: '}'
  },
  {
    regex: /\} catch \(err\) \{\n\s*console\.error\("Error fetching categories:", err\);\n\s*res\.status\(500\)\.json\(\{ message: "Database error: " \+ err\.message \}\);\n\s*\}/g,
    replace: '}'
  }
];

// Strip `try {` blocks
code = code.replace(/  try \{\n/g, '');

for (const block of catchBlocksToReplace) {
  code = code.replace(block.regex, '');
}

// For the rollback ones, we change it to throw err
code = code.replace(/\} catch \(err\) \{\n\s*await db\.query\('ROLLBACK'\);\n\s*console\.error\("Error placing bet:", err\);\n\s*res\.status\(500\)\.json\(\{ message: "Internal server error" \}\);\n\s*\}/g, `} catch (err) {\n    await db.query('ROLLBACK');\n    throw err;\n  }`);

code = code.replace(/\} catch \(err\) \{\n\s*await db\.query\('ROLLBACK'\); \/\/ Rollback on any error\n\s*console\.error\("Error assigning prediction:", err\);\n\s*res\.status\(500\)\.send\("Database error: " \+ err\.message\);\n\s*\}/g, `} catch (err) {\n    await db.query('ROLLBACK');\n    throw err;\n  }`);

// Finally, fix the endings of the asyncHandler wrappers
// Since every exports.xxx = asyncHandler(async (req, res) => { ends with };
// We need to change that }; to });
code = code.replace(/};\n(?=\/\/|$|exports)/g, '});\n');
// Quick hack: we can just find all matches of `exports.` and the preceding `};\n` and replace.
// But some `};` might be nested. 

fs.writeFileSync(filePath, code);
console.log('Refactoring complete.');