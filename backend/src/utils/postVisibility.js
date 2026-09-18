// Shared SQL fragment for "can this viewer see this post": hidden posts are
// never visible, and posts by or to a blocked user are invisible to the other
// party. A NULL viewer id means an anonymous (or admin) viewer.
const buildPostVisibilityClauseForAlias = (postAlias = 'p', viewerIdParamName = '$3') => {
  return `
       ${postAlias}.is_hidden = FALSE
       AND (${viewerIdParamName}::int IS NULL OR NOT EXISTS (
         SELECT 1
         FROM user_blocks ub
         WHERE (ub.blocker_id = ${postAlias}.user_id AND ub.blocked_user_id = ${viewerIdParamName}::int)
            OR (ub.blocker_id = ${viewerIdParamName}::int AND ub.blocked_user_id = ${postAlias}.user_id)
       ))`;
};

const buildPostVisibilityClause = (viewerIdParamName = '$3') =>
  buildPostVisibilityClauseForAlias('p', viewerIdParamName);

module.exports = { buildPostVisibilityClauseForAlias, buildPostVisibilityClause };
