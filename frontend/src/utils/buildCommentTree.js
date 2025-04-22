// /home/justus/Nextcloud/intellacc.com/frontend/src/utils/buildCommentTree.js

/**
 * Builds a nested tree structure from a flat list of comments.
 * Assumes each comment has an `id` and `parentId` property.
 * 
 * @param {Array<Object>} comments - Flat array of comment objects.
 * @returns {Array<Object>} - Array of top-level comment objects, each with a `children` array property.
 */
export function buildCommentTree(comments) {
  if (!comments || comments.length === 0) {
    return [];
  }

  const commentsById = {};
  const tree = [];

  // First pass: index comments by ID and initialize children arrays
  comments.forEach(comment => {
    commentsById[comment.id] = { ...comment, children: [] };
  });

  // Second pass: build the tree structure
  comments.forEach(comment => {
    const currentCommentNode = commentsById[comment.id];
    if (comment.parentId && commentsById[comment.parentId]) {
      // This is a reply, add it to its parent's children array
      commentsById[comment.parentId].children.push(currentCommentNode);
    } else {
      // This is a top-level comment
      tree.push(currentCommentNode);
    }
  });

  // Optional: Sort comments/children by date if needed
  // tree.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // Object.values(commentsById).forEach(comment => {
  //   comment.children.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  // });

  return tree;
}
