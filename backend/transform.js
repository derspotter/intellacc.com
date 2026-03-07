module.exports = function(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  // Add import: const asyncHandler = require('../utils/asyncHandler');
  const hasAsyncHandler = root.find(j.VariableDeclarator, { id: { name: 'asyncHandler' } }).length > 0;
  if (!hasAsyncHandler) {
    root.find(j.Program).get('body', 0).insertBefore(
      j.variableDeclaration('const', [
        j.variableDeclarator(
          j.identifier('asyncHandler'),
          j.callExpression(j.identifier('require'), [j.literal('../utils/asyncHandler')])
        )
      ])
    );
  }

  // Find all exports.xxx = async (req, res) => { ... }
  root.find(j.AssignmentExpression, {
    left: { type: 'MemberExpression', object: { name: 'exports' } },
    right: { type: 'ArrowFunctionExpression', async: true }
  }).forEach(path => {
    const arrowFunc = path.node.right;

    // Wrap in asyncHandler
    path.node.right = j.callExpression(j.identifier('asyncHandler'), [arrowFunc]);

    // Find try/catch blocks inside the arrow function's body
    j(arrowFunc.body).find(j.TryStatement).forEach(tryPath => {
      const tryBlock = tryPath.node.block;
      const catchClause = tryPath.node.handler;
      
      if (catchClause) {
        const catchBodyCode = j(catchClause.body).toSource();
        
        // If catch block contains ROLLBACK, keep try/catch but throw error
        if (catchBodyCode.includes("ROLLBACK")) {
          catchClause.body.body = [
            j.expressionStatement(
              j.awaitExpression(
                j.callExpression(
                  j.memberExpression(j.identifier('db'), j.identifier('query')),
                  [j.literal('ROLLBACK')]
                )
              )
            ),
            j.throwStatement(catchClause.param)
          ];
        } else {
          // If no ROLLBACK, just unwrap the try block entirely
          j(tryPath).replaceWith(tryBlock.body);
        }
      }
    });
  });

  return root.toSource();
};